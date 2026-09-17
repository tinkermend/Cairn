import { Logger } from '@nestjs/common'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as dbApi from '@cairn/db'
import {
  claimRun,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getRun,
  newId,
  openIsolatedDb,
  registerWorker,
  requestRunCancel,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import { PROCESS_LOG_EVENTS, type Step } from '@cairn/shared'
import { WORKER_TEST_PROTOCOLS } from '../__tests__/worker-protocols.js'
import { ExecutionEngine } from './engine.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_englog`

type LogLine = { level: string; event: string; fields: Record<string, unknown> }

function captureProcessLogs() {
  const lines: LogLine[] = []
  const take = (level: string) => (first: unknown, second?: unknown) => {
    if (first && typeof first === 'object' && typeof second === 'string') {
      lines.push({ level, event: second, fields: { ...(first as Record<string, unknown>) } })
    }
  }
  const spies = [
    vi.spyOn(Logger.prototype, 'log').mockImplementation(take('info') as never),
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(take('warn') as never),
    vi.spyOn(Logger.prototype, 'error').mockImplementation(take('error') as never),
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(take('debug') as never),
  ]
  return {
    lines,
    restore() {
      for (const spy of spies) spy.mockRestore()
    },
  }
}

describe('ExecutionEngine 进程日志', { timeout: 30_000 }, () => {
  let handle: DbHandle
  let engine: ExecutionEngine
  let actorId: string
  let targetId: string
  let workerId: string
  let workerInstanceId: string
  let logs: ReturnType<typeof captureProcessLogs> | undefined

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    engine = new ExecutionEngine(handle)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'engine-log-tester',
      email: `eng-log-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `englog-${SCHEMA.slice(-8)}`,
      name: '引擎日志夹具',
      entryUrl: 'https://example.com',
    })
    workerId = `englog-${SCHEMA.slice(-8)}`
    workerInstanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 8,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  afterEach(() => {
    logs?.restore()
    logs = undefined
  })

  async function waitForFirstAttempt(runId: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const live = await getRun(handle.db, runId)
      if (live.stepRuns.some((step) => step.attempts.length > 0)) return
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 10)
      await promise
    }
    throw new Error('Attempt 未在预期时间内开始')
  }

  async function claimThis(runId: string) {
    await handle.pool.query(
      `UPDATE runs
          SET status = 'CANCELLED',
              finished_at = COALESCE(finished_at, now()),
              updated_at = now()
        WHERE status IN ('QUEUED', 'RECOVERING')
          AND id <> $1`,
      [runId],
    )
    const grant = await claimRun(handle, {
      workerId,
      instanceId: workerInstanceId,
      leaseTtlSeconds: 30,
    })
    expect(grant?.runId).toBe(runId)
    return grant!
  }

  async function createAndExecute(name: string, steps: Step[]) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name,
      steps,
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const grant = await claimThis(created.detail.id)
    logs = captureProcessLogs()
    await engine.execute(created.detail.id, { grant })
    return { detail: await getRun(handle.db, created.detail.id), grant, lines: logs.lines }
  }

  it('PL01 Echo→Delay 成功路径带齐 run/attempt 事件', async () => {
    const echoId = newId()
    const delayId = newId()
    const { detail, grant, lines } = await createAndExecute('日志成功', [
      {
        id: echoId,
        name: '写',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { value: 'hello' },
      },
      {
        id: delayId,
        name: '等',
        type: 'delay',
        effectType: 'READ_ONLY',
        input: { durationMs: 10 },
      },
    ])
    expect(detail.status).toBe('SUCCEEDED')
    const started = lines.filter((line) => line.event === PROCESS_LOG_EVENTS.runStarted)
    const finished = lines.filter((line) => line.event === PROCESS_LOG_EVENTS.runFinished)
    const attemptStarted = lines.filter((line) => line.event === PROCESS_LOG_EVENTS.attemptStarted)
    const attemptFinished = lines.filter((line) => line.event === PROCESS_LOG_EVENTS.attemptFinished)
    expect(started).toHaveLength(1)
    expect(finished).toHaveLength(1)
    expect(finished[0]?.fields.exit).toBe('completed')
    expect(finished[0]?.fields.runId).toBe(detail.id)
    expect(finished[0]?.fields.workerId).toBe(grant.holderWorkerId)
    expect(finished[0]?.fields.leaseId).toBe(grant.leaseId)
    expect(attemptStarted).toHaveLength(2)
    expect(attemptFinished).toHaveLength(2)
    for (const line of [...attemptStarted, ...attemptFinished]) {
      expect(line.fields.runId).toBe(detail.id)
      expect(line.fields.stepRunId).toBeTruthy()
      expect(line.fields.attemptId).toBeTruthy()
      expect(line.fields).not.toHaveProperty('input')
    }
    expect(new Set(attemptFinished.map((line) => line.fields.attemptId))).toEqual(
      new Set(detail.stepRuns.flatMap((step) => step.attempts.map((attempt) => attempt.id))),
    )
  })

  it('PL02 Fail 步骤 finished 带 code 且 exit=failed', async () => {
    const failId = newId()
    const { detail, lines } = await createAndExecute('日志失败', [
      {
        id: failId,
        name: '注入失败',
        type: 'fail',
        effectType: 'READ_ONLY',
        policy: { retryLimit: 0 },
        input: { message: 'boom', category: 'EXECUTOR', retryable: false },
      },
    ])
    expect(detail.status).toBe('FAILED')
    const attemptFinished = lines.filter((line) => line.event === PROCESS_LOG_EVENTS.attemptFinished)
    expect(attemptFinished).toHaveLength(1)
    expect(attemptFinished[0]?.fields.attemptStatus).toBe('FAILED')
    expect(attemptFinished[0]?.fields.code).toBeTruthy()
    expect(lines.find((line) => line.event === PROCESS_LOG_EVENTS.runFinished)?.fields.exit).toBe('failed')
  })

  it('PL03 运行中取消记 exit=cancelled，不停机伪装', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '日志取消',
      steps: [
        {
          id: newId(),
          name: '慢步骤',
          type: 'delay',
          effectType: 'READ_ONLY',
          input: { durationMs: 5_000 },
        },
      ],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const grant = await claimThis(created.detail.id)
    logs = captureProcessLogs()
    const running = engine.execute(created.detail.id, { grant, cancelPollMs: 20 })
    await waitForFirstAttempt(created.detail.id)
    await requestRunCancel(handle.db, created.detail.id, { id: actorId })
    await running
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('CANCELLED')
    expect(logs.lines.find((line) => line.event === PROCESS_LOG_EVENTS.runFinished)?.fields.exit).toBe(
      'cancelled',
    )
  })

  it('快照前早退不打 run.started / run.finished', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '日志早退',
      steps: [
        {
          id: newId(),
          name: '写',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 'skip' },
        },
      ],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const grant = await claimThis(created.detail.id)
    await handle.pool.query(`UPDATE runs SET status = 'CANCELLED', finished_at = now(), updated_at = now() WHERE id = $1`, [
      created.detail.id,
    ])
    logs = captureProcessLogs()
    await engine.execute(created.detail.id, { grant })
    expect(logs.lines.filter((line) => line.event === PROCESS_LOG_EVENTS.runStarted)).toHaveLength(0)
    expect(logs.lines.filter((line) => line.event === PROCESS_LOG_EVENTS.runFinished)).toHaveLength(0)
  })

  it('PL08 执行器抛错日志带齐 run/step/attempt', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '日志执行器异常',
      steps: [
        {
          id: newId(),
          name: '抛错步骤',
          type: 'delay',
          effectType: 'IDEMPOTENT',
          policy: { retryLimit: 0 },
          input: { durationMs: 10 },
        },
      ],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const grant = await claimThis(created.detail.id)
    logs = captureProcessLogs()
    await engine.execute(created.detail.id, {
      grant,
      clock: {
        now: () => Date.now(),
        sleep: async () => {
          throw new Error('executor blew up')
        },
      },
    })
    const thrown = logs.lines.find((line) => line.event === '执行器抛出异常')
    expect(thrown?.fields.runId).toBe(created.detail.id)
    expect(thrown?.fields.stepRunId).toBeTruthy()
    expect(thrown?.fields.attemptId).toBeTruthy()
    expect(thrown?.fields.stepType).toBe('delay')
  })

  it('ES-C1/C5 证据收尾抛错时 execute 不抛、exit 不变', async () => {
    const settle = vi.spyOn(dbApi, 'settleRunEvidence').mockRejectedValue(new Error('evidence boom'))
    try {
      const { detail, lines } = await createAndExecute('收尾故障', [
        {
          id: newId(),
          name: '写',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 'ok' },
        },
      ])
      expect(detail.status).toBe('SUCCEEDED')
      expect(lines.find((line) => line.event === PROCESS_LOG_EVENTS.runFinished)?.fields.exit).toBe('completed')
      expect(settle).toHaveBeenCalled()
      expect(lines.some((line) => line.event === '证据收尾失败' && line.fields.settler === 'evidence')).toBe(true)
    } finally {
      settle.mockRestore()
    }
  })

  it('ES-C5 取消、停机让位、执行器抛错仍走收尾，停机不写 CANCELLED', async () => {
    const settle = vi.spyOn(dbApi, 'settleRunEvidence')
    const delayStep = {
      id: newId(),
      name: '慢步骤',
      type: 'delay' as const,
      effectType: 'READ_ONLY' as const,
      input: { durationMs: 5_000 },
    }
    try {
      const cancelledScenario = await createScenarioWithVersion(handle.db, {
        targetId,
        name: '收尾-库内取消',
        steps: [delayStep],
        actor: { id: actorId },
      })
      const cancelledRun = await createRunWithSnapshot(handle.db, {
        scenarioId: cancelledScenario.id,
        actor: { id: actorId },
      })
      const cancelledGrant = await claimThis(cancelledRun.detail.id)
      logs = captureProcessLogs()
      const cancelling = engine.execute(cancelledRun.detail.id, { grant: cancelledGrant, cancelPollMs: 20 })
      await waitForFirstAttempt(cancelledRun.detail.id)
      await requestRunCancel(handle.db, cancelledRun.detail.id, { id: actorId })
      await expect(cancelling).resolves.toBeUndefined()
      const cancelled = await getRun(handle.db, cancelledRun.detail.id)
      expect(cancelled.status).toBe('CANCELLED')
      expect(logs.lines.find((line) => line.event === PROCESS_LOG_EVENTS.runFinished)?.fields.exit).toBe(
        'cancelled',
      )
      expect(settle).toHaveBeenCalled()
      settle.mockClear()
      logs.restore()

      const yieldedScenario = await createScenarioWithVersion(handle.db, {
        targetId,
        name: '收尾-停机让位',
        steps: [{ ...delayStep, id: newId() }],
        actor: { id: actorId },
      })
      const yieldedRun = await createRunWithSnapshot(handle.db, {
        scenarioId: yieldedScenario.id,
        actor: { id: actorId },
      })
      const yieldedGrant = await claimThis(yieldedRun.detail.id)
      logs = captureProcessLogs()
      const controller = new AbortController()
      const yielding = engine.execute(yieldedRun.detail.id, {
        grant: yieldedGrant,
        signal: controller.signal,
        cancelPollMs: 20,
      })
      await waitForFirstAttempt(yieldedRun.detail.id)
      controller.abort()
      await expect(yielding).resolves.toBeUndefined()
      const yielded = await getRun(handle.db, yieldedRun.detail.id)
      expect(yielded.status).toBe('RUNNING')
      expect(yielded.cancelRequested).toBe(false)
      expect(logs.lines.find((line) => line.event === PROCESS_LOG_EVENTS.runFinished)?.fields.exit).toBe(
        'yielded',
      )
      expect(settle).toHaveBeenCalled()
      settle.mockClear()
      logs.restore()

      const thrownScenario = await createScenarioWithVersion(handle.db, {
        targetId,
        name: '收尾-执行器抛错',
        steps: [
          {
            id: newId(),
            name: '抛错步骤',
            type: 'delay',
            effectType: 'IDEMPOTENT',
            policy: { retryLimit: 0 },
            input: { durationMs: 10 },
          },
        ],
        actor: { id: actorId },
      })
      const thrownRun = await createRunWithSnapshot(handle.db, {
        scenarioId: thrownScenario.id,
        actor: { id: actorId },
      })
      const thrownGrant = await claimThis(thrownRun.detail.id)
      logs = captureProcessLogs()
      await expect(
        engine.execute(thrownRun.detail.id, {
          grant: thrownGrant,
          clock: {
            now: () => Date.now(),
            sleep: async () => {
              throw new Error('executor blew up')
            },
          },
        }),
      ).resolves.toBeUndefined()
      expect(settle).toHaveBeenCalled()
    } finally {
      settle.mockRestore()
    }
  })
})
