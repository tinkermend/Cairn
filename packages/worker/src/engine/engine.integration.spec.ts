import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  browserSessions,
  claimQueuedRun,
  computeSnapshotDigest,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getRun,
  listRunEvidence,
  newId,
  openIsolatedDb,
  requestRunCancel,
  runs,
  stepRuns,
  targets,
  type DbHandle,
} from '@cairn/db'
import { DEFAULT_EXECUTOR_VERSIONS, DEFAULT_SESSION_POLICY, runSnapshotSchema, type Step } from '@cairn/shared'
import { ExecutionEngine } from './engine.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_eng`

const ids = {
  echo1: '00000000-0000-4000-8000-000000000071',
  delay: '00000000-0000-4000-8000-000000000072',
  echo2: '00000000-0000-4000-8000-000000000073',
  fail: '00000000-0000-4000-8000-000000000074',
  echoP: '00000000-0000-4000-8000-000000000075',
}

describe('ExecutionEngine（集成）', { timeout: 30_000 }, () => {
  let handle: DbHandle
  let engine: ExecutionEngine
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    engine = new ExecutionEngine(handle)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'engine-tester',
      email: `eng-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `eng-${SCHEMA.slice(-8)}`,
      name: '引擎夹具',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  /** 等到该 Run 的第一个 Attempt 落库：取消要打在步骤进行中，不能靠固定 sleep 猜。 */
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

  async function createAndRun(name: string, steps: Step[], input?: Record<string, string>) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name,
      steps,
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      input,
      actor: { id: actorId },
    })
    const claimed = await claimQueuedRun(handle)
    expect(claimed?.id).toBe(created.detail.id)
    await engine.execute(created.detail.id)
    return getRun(handle.db, created.detail.id)
  }

  it('Echo → Delay → Echo 传递输出', async () => {
    const detail = await createAndRun('链路', [
      {
        id: ids.echo1,
        name: '写',
        type: 'echo',
        effectType: 'READ_ONLY',
        outputKey: 'greeting',
        input: { value: 'hello' },
      },
      {
        id: ids.delay,
        name: '等',
        type: 'delay',
        effectType: 'READ_ONLY',
        input: { durationMs: 20 },
      },
      {
        id: ids.echo2,
        name: '读',
        type: 'echo',
        effectType: 'READ_ONLY',
        outputKey: 'again',
        input: { from: 'greeting' },
      },
    ])
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.context.greeting).toBe('hello')
    expect(detail.context.again).toBe('hello')
    expect(detail.stepRuns[2]?.attempts[0]?.output).toBe('hello')
    expect(detail.stepRuns.every((step) => step.status === 'SUCCEEDED')).toBe(true)
    expect(detail.snapshot.digest).toBe(computeSnapshotDigest(detail.snapshot))
    const evidence = await listRunEvidence(handle.db, detail.id)
    expect(evidence.items.some((item) => item.type === 'output')).toBe(true)
    expect(evidence.items.some((item) => item.type === 'screenshot' || item.type === 'trace')).toBe(false)
    expect(
      evidence.items
        .filter((item) => item.type === 'output')
        .every((item) => item.payload !== undefined && !item.objectKey),
    ).toBe(true)
  })

  it('RF04 惰性启动：Echo 链路不产生 browser_sessions，快照带平台默认 sessionPolicy', async () => {
    const detail = await createAndRun('惰性', [
      {
        id: newId(),
        name: 'echo',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { value: 1 },
      },
    ])
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.snapshot.sessionPolicy).toEqual(DEFAULT_SESSION_POLICY)
    const sessions = await handle.db.select({ id: browserSessions.id }).from(browserSessions)
    expect(sessions).toEqual([])
    // Engine 本期不调用 BrowserPort；无 playwright import 由 boundary 卡住
  })

  it('参数化 from 用 input 执行', async () => {
    const detail = await createAndRun(
      '参数化',
      [
        {
          id: ids.echoP,
          name: '回显单号',
          type: 'echo',
          effectType: 'READ_ONLY',
          outputKey: 'echoed',
          input: { from: 'orderId' },
        },
      ],
      { orderId: 'A-1' },
    )
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.stepRuns[0]?.attempts[0]?.output).toBe('A-1')
  })

  it('Fail 可重试两次后失败即停', async () => {
    const detail = await createAndRun('失败', [
      {
        id: ids.fail,
        name: '注入失败',
        type: 'fail',
        effectType: 'READ_ONLY',
        policy: { retryLimit: 1 },
        input: { message: 'boom', category: 'EXECUTOR', retryable: true },
      },
      {
        id: ids.echo2,
        name: '不会跑到',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { value: 1 },
      },
    ])
    expect(detail.status).toBe('FAILED')
    expect(detail.stepRuns[0]?.attempts).toHaveLength(2)
    expect(detail.stepRuns[1]?.status).toBe('SKIPPED')
    const evidence = await listRunEvidence(handle.db, detail.id)
    expect(evidence.items.some((item) => item.type === 'screenshot' || item.type === 'trace')).toBe(false)
  })

  it('SIDE_EFFECT + UNKNOWN 进入 NEEDS_REVIEW', async () => {
    const detail = await createAndRun('未知副作用', [
      {
        id: ids.fail,
        name: '失联',
        type: 'fail',
        effectType: 'SIDE_EFFECT',
        policy: { retryLimit: 2 },
        input: { message: '已发出', category: 'UNKNOWN', retryable: true },
      },
      {
        id: ids.echo1,
        name: '后续',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { value: 1 },
      },
    ])
    expect(detail.status).toBe('NEEDS_REVIEW')
    expect(detail.stepRuns[0]?.attempts).toHaveLength(1)
    expect(detail.stepRuns[1]?.status).toBe('PENDING')
  })

  it('Delay 大于步骤超时 → TIMEOUT', async () => {
    const detail = await createAndRun('超时', [
      {
        id: ids.delay,
        name: '睡过头',
        type: 'delay',
        effectType: 'READ_ONLY',
        policy: { timeoutMs: 15 },
        input: { durationMs: 80 },
      },
    ])
    expect(detail.status).toBe('FAILED')
    expect(detail.stepRuns[0]?.attempts[0]?.error?.category).toBe('TIMEOUT')
  })

  it('QUEUED 取消后领取不到', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '取消队列',
      steps: [
        {
          id: ids.echo1,
          name: '回显',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 1 },
        },
      ],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const cancelled = await requestRunCancel(handle.db, created.detail.id, { id: actorId })
    expect(cancelled.status).toBe('CANCELLED')
    expect(await claimQueuedRun(handle)).toBeNull()
  })

  it('SIDE_EFFECT Delay 被 abort → NEEDS_REVIEW', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '中止副作用',
      steps: [
        {
          id: ids.delay,
          name: '副作用等待',
          type: 'delay',
          effectType: 'SIDE_EFFECT',
          input: { durationMs: 5_000 },
        },
      ],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    await claimQueuedRun(handle)
    const controller = new AbortController()
    const running = engine.execute(created.detail.id, { signal: controller.signal })
    await waitForFirstAttempt(created.detail.id)
    controller.abort()
    await running
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('NEEDS_REVIEW')
    expect(detail.stepRuns[0]?.attempts).toHaveLength(1)
  })

  it('SIDE_EFFECT Delay 超时 → NEEDS_REVIEW，不重试', async () => {
    const detail = await createAndRun('副作用超时', [
      {
        id: ids.delay,
        name: '副作用等待',
        type: 'delay',
        effectType: 'SIDE_EFFECT',
        policy: { timeoutMs: 15, retryLimit: 2 },
        input: { durationMs: 80 },
      },
    ])
    expect(detail.status).toBe('NEEDS_REVIEW')
    expect(detail.stepRuns[0]?.attempts).toHaveLength(1)
    expect(detail.stepRuns[0]?.attempts[0]?.error?.category).toBe('TIMEOUT')
  })

  it('from=constructor 不得取到 Object 构造函数', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '构造函数陷阱',
      steps: [
        {
          id: ids.echoP,
          name: '读 constructor',
          type: 'echo',
          effectType: 'READ_ONLY',
          outputKey: 'got',
          input: { from: 'constructor' },
        },
      ],
      actor: { id: actorId },
    })
    const runId = newId()
    const snapshot = runSnapshotSchema.parse({
      schemaVersion: 1,
      runId,
      targetId,
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      steps: [
        {
          id: ids.echoP,
          name: '读 constructor',
          type: 'echo',
          effectType: 'READ_ONLY',
          outputKey: 'got',
          input: { from: 'constructor' },
        },
      ],
      input: {},
      createdAt: new Date().toISOString(),
      executorVersions: { ...DEFAULT_EXECUTOR_VERSIONS },
    })
    const digest = computeSnapshotDigest(snapshot)
    await handle.db.insert(runs).values({
      id: runId,
      targetId,
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      createdByConsoleAccountId: actorId,
      status: 'QUEUED',
      snapshot: { ...snapshot, digest },
      snapshotDigest: digest,
      context: {},
    })
    await handle.db.insert(stepRuns).values({
      id: newId(),
      runId,
      stepId: ids.echoP,
      ordinal: 0,
      status: 'PENDING',
    })
    await claimQueuedRun(handle)
    await engine.execute(runId)
    const detail = await getRun(handle.db, runId)
    expect(detail.status).toBe('FAILED')
    expect(detail.stepRuns[0]?.attempts[0]?.error?.category).toBe('VALIDATION')
    expect(typeof detail.stepRuns[0]?.attempts[0]?.output).not.toBe('function')
  })

  it('RUNNING 中取消：在途步骤被中止，不出现迟到的 SUCCEEDED', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '运行中取消',
      steps: [
        {
          id: ids.delay,
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
    await claimQueuedRun(handle)

    const running = engine.execute(created.detail.id, { cancelPollMs: 20 })
    await waitForFirstAttempt(created.detail.id)
    await requestRunCancel(handle.db, created.detail.id, { id: actorId })
    await running

    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.cancelRequested).toBe(true)
    expect(detail.status).toBe('CANCELLED')
    expect(detail.stepRuns.map((step) => step.status)).toEqual(['CANCELLED'])
    expect(detail.stepRuns[0]?.attempts.map((attempt) => attempt.status)).toEqual(['CANCELLED'])
    expect(detail.context).toEqual({})
  })

  it('执行器抛出的非中止异常记为 EXECUTOR，并按次数重试', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '执行器异常',
      steps: [
        {
          id: ids.delay,
          name: '抛错步骤',
          type: 'delay',
          effectType: 'IDEMPOTENT',
          policy: { retryLimit: 1 },
          input: { durationMs: 10 },
        },
      ],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    await claimQueuedRun(handle)

    await engine.execute(created.detail.id, {
      clock: {
        now: () => Date.now(),
        sleep: async () => {
          throw new Error('executor blew up')
        },
      },
    })

    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.stepRuns[0]?.attempts).toHaveLength(2)
    expect(detail.stepRuns[0]?.attempts[0]?.error?.category).toBe('EXECUTOR')
    expect(detail.stepRuns[0]?.status).toBe('FAILED')
    expect(detail.status).toBe('FAILED')
  })

  it('步骤都已终结但 Run 仍停在 RUNNING 时补写成功', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '补写成功',
      steps: [
        {
          id: ids.echo1,
          name: '回显',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 1 },
        },
      ],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    await claimQueuedRun(handle)
    await handle.pool.query(
      `UPDATE step_runs SET status = 'SUCCEEDED', finished_at = now() WHERE run_id = $1`,
      [created.detail.id],
    )

    await engine.execute(created.detail.id)

    expect((await getRun(handle.db, created.detail.id)).status).toBe('SUCCEEDED')
  })

  it('非法 Snapshot → FAILED，StepRun 全部 SKIPPED', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '坏快照',
      steps: [
        {
          id: ids.echo1,
          name: '回显',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 1 },
        },
      ],
      actor: { id: actorId },
    })
    const runId = newId()
    await handle.db.insert(runs).values({
      id: runId,
      targetId,
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      createdByConsoleAccountId: actorId,
      status: 'QUEUED',
      snapshot: { not: 'a snapshot' } as never,
      snapshotDigest: 'invalid',
      context: {},
    })
    await handle.db.insert(stepRuns).values({
      id: newId(),
      runId,
      stepId: ids.echo1,
      ordinal: 0,
      status: 'PENDING',
    })
    await claimQueuedRun(handle)
    await engine.execute(runId)
    const { rows: runRows } = await handle.pool.query<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1`,
      [runId],
    )
    const { rows: stepRows } = await handle.pool.query<{ status: string }>(
      `SELECT status FROM step_runs WHERE run_id = $1`,
      [runId],
    )
    expect(runRows[0]?.status).toBe('FAILED')
    expect(stepRows.map((row) => row.status)).toEqual(['SKIPPED'])
  })
})
