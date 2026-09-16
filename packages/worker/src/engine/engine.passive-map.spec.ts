import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  claimSessionUse,
  claimRun,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getRun,
  newId,
  openIsolatedDb,
  readMapFacts,
  registerWorker,
  requireCreatedSession,
  setSessionProbe,
  setSessionStatus,
  consoleAccounts,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import * as db from '@cairn/db'
import {
  isAiStepType,
  mapGapObservation,
  mapObservationShell,
  mapRunFactKey,
  stepUsesBrowser,
  type BrowserCommandResult,
  type MapObservation,
  type SessionGrant,
  type Step,
} from '@cairn/shared'
import { WORKER_TEST_PROTOCOLS } from '../__tests__/worker-protocols.js'
import { ExecutionEngine } from './engine.js'
import type { BrowserPort, PassiveMapObservationPort } from './ports.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_pmap`

function clickStep(id: string): Extract<Step, { type: 'click' }> {
  return {
    id,
    name: '点击',
    type: 'click',
    effectType: 'READ_ONLY',
    input: {
      target: {
        framePath: [],
        candidates: [{ by: 'text', value: '查询' }],
      },
    },
  }
}

describe('ExecutionEngine 被动地图采集', { timeout: 60_000 }, () => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let accountId: string
  let workerId: string
  let workerInstanceId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    targetId = newId()
    accountId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'passive-map',
      email: `pmap-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `pmap-${SCHEMA.slice(-8)}`,
      name: '被动采集',
      entryUrl: 'https://shop.example.com/',
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: '店员',
      username: 'clerk',
      status: 'active',
    })
    workerId = `pmap-${SCHEMA.slice(-8)}`
    workerInstanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 8,
      maxSessions: 16,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function claimThis(runId: string) {
    await handle.pool.query(
      `UPDATE runs SET status = 'CANCELLED', finished_at = COALESCE(finished_at, now()), updated_at = now()
        WHERE status IN ('QUEUED', 'RECOVERING') AND id <> $1`,
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

  async function queue(steps: Step[], policy?: { enabled: boolean; phaseBudgetMs?: number }) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `pmap-${newId()}`,
      steps,
      actor: { id: actorId },
    })
    return createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
      mapCapturePolicy: policy
        ? { enabled: policy.enabled, schemaVersion: 1, ...(policy.phaseBudgetMs ? { phaseBudgetMs: policy.phaseBudgetMs } : {}) }
        : undefined,
    })
  }

  async function openLease(runId: string, fencingToken: number): Promise<SessionGrant> {
    const account = newId()
    await handle.db.insert(targetAccounts).values({
      id: account,
      targetId,
      displayName: `lease-${account}`,
      username: `u-${account}`,
      status: 'active',
    })
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: account },
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: workerInstanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
    })
    await setSessionProbe(handle.db, {
      sessionId: session.id,
      ownerWorkerId: workerId,
      health: 'HEALTHY',
      authState: 'AUTHENTICATED',
    })
    const lease = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: account },
      owner: { kind: 'RUN', runId, runFencingToken: fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: workerId,
      holderInstanceId: workerInstanceId,
      leaseTtlSeconds: 60,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    if (!lease.ok) throw new Error(lease.message ?? lease.code)
    return {
      sessionId: session.id,
      leaseId: lease.grant.leaseId,
      generation: lease.grant.generation,
      sessionFencingToken: lease.grant.sessionFencingToken,
      expiresAt: lease.grant.expiresAt,
    }
  }

  function shell(input: {
    runId: string
    stepRunId: string
    attemptId: string
    phase: 'before_action' | 'after_action'
  }): MapObservation {
    const key = mapRunFactKey(input)
    return mapObservationShell({
      id: randomUUID(),
      targetId,
      sourceType: 'formal_run',
      sourceRef: {
        sourceType: 'formal_run',
        runId: input.runId,
        stepRunId: input.stepRunId,
        attemptId: input.attemptId,
      },
      phase: input.phase,
      dedupeKey: key,
      captureStatus: 'observed',
      completeness: 'partial',
      truncated: true,
      topUrlPattern: 'https://shop.example.com/orders',
    })
  }

  function mapPort(log: string[]): PassiveMapObservationPort {
    return {
      async capture(request) {
        log.push(`${request.phase}:${Date.now()}`)
        return {
          observation: shell({
            runId: request.runId,
            stepRunId: request.stepRunId,
            attemptId: request.attemptId,
            phase: request.phase,
          }),
        }
      },
    }
  }

  function browserPort(executes: number[], created: { detail: { id: string } }): BrowserPort {
    return {
      async acquire(_run, grant) {
        return { ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }
      },
      async execute() {
        executes.push(Date.now())
        return { ok: true, output: {} } satisfies BrowserCommandResult
      },
      async release() {},
    }
  }

  it('OMB01 before 先于 execute，after 与 Attempt 同事务', async () => {
    const created = await queue([clickStep(newId())], { enabled: true })
    const log: string[] = []
    const executes: number[] = []
    const engine = new ExecutionEngine(handle, browserPort(executes, created))
    engine.mapObservation = mapPort(log)
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })
    expect(executes).toHaveLength(1)
    expect(log[0]?.startsWith('before_action')).toBe(true)
    expect(Number(log[0]!.split(':')[1])).toBeLessThanOrEqual(executes[0]!)
    const page = await readMapFacts(handle.db, { targetId })
    const ours = page.facts.filter(
      (fact) =>
        fact.type === 'observation' &&
        fact.observation.sourceRef.sourceType === 'formal_run' &&
        fact.observation.sourceRef.runId === created.detail.id,
    )
    expect(
      ours.some(
        (fact) =>
          fact.type === 'observation' &&
          fact.observation.phase === 'before_action' &&
          fact.observation.captureStatus === 'observed',
      ),
    ).toBe(true)
    expect(
      ours.some(
        (fact) =>
          fact.type === 'observation' &&
          fact.observation.phase === 'after_action' &&
          fact.observation.captureStatus === 'observed',
      ),
    ).toBe(true)
  })

  it('OMB02 采集超时只写缺口，动作仍只执行一次', async () => {
    const created = await queue([clickStep(newId())], { enabled: true, phaseBudgetMs: 20 })
    const executes: number[] = []
    const engine = new ExecutionEngine(handle, browserPort(executes, created))
    engine.mapObservation = {
      async capture(request) {
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) {
            resolve()
            return
          }
          request.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return {
          gap: mapGapObservation({
            id: randomUUID(),
            targetId,
            sourceType: request.sourceType,
            sourceRef: {
              sourceType: request.sourceType,
              runId: request.runId,
              stepRunId: request.stepRunId,
              attemptId: request.attemptId,
            },
            phase: request.phase,
            dedupeKey: mapRunFactKey({
              runId: request.runId,
              attemptId: request.attemptId,
              phase: request.phase,
            }),
            reason: 'TIME_BUDGET',
          }),
        }
      },
    }
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })
    expect(executes).toHaveLength(1)
    const page = await readMapFacts(handle.db, { targetId })
    const ours = page.facts.filter(
      (fact) =>
        fact.type === 'observation' &&
        fact.observation.sourceRef.sourceType === 'formal_run' &&
        fact.observation.sourceRef.runId === created.detail.id,
    )
    expect(
      ours.some(
        (fact) =>
          fact.type === 'observation' &&
          fact.observation.captureReason === 'TIME_BUDGET',
      ),
    ).toBe(true)
  })

  it('OMB03 finishAttempt 失败只重试持久化', async () => {
    const created = await queue([clickStep(newId())], { enabled: true })
    const executes: number[] = []
    let calls = 0
    vi.spyOn(db, 'finishAttempt').mockImplementationOnce(async () => {
      calls += 1
      throw new Error('lost reply')
    })
    const engine = new ExecutionEngine(handle, browserPort(executes, created))
    engine.mapObservation = mapPort([])
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })
    expect(executes).toHaveLength(1)
    expect(calls).toBe(1)
    expect((await getRun(handle.db, created.detail.id)).status).toBe('SUCCEEDED')
  })

  it('OMB11 AI 步骤只落不完整观察', async () => {
    const { capturePhaseObservation } = await import('../map/passive-capture.js')
    const runId = randomUUID()
    const stepRunId = randomUUID()
    const attemptId = randomUUID()
    const ready = shell({ runId, stepRunId, attemptId, phase: 'after_action' })
    const captured = await capturePhaseObservation({
      port: { async capture() { return { observation: ready } } },
      request: {
        grant: {
          leaseId: randomUUID(),
          runId,
          holderWorkerId: 'w',
          fencingToken: 1,
          expiresAt: new Date().toISOString(),
        },
        runId,
        stepRunId,
        attemptId,
        phase: 'after_action',
        targetId,
        policy: {
          enabled: true,
          schemaVersion: 1,
          collectorVersion: 'map-collector@1',
          redactionRevision: 'map-redaction@1',
          maxNodes: 100,
          maxBytes: 65536,
          phaseBudgetMs: 250,
          runBudgetMs: 2000,
          captureScreenshots: false,
        },
        sourceType: 'formal_run',
        condition: {
          targetId,
          accountBinding: { presence: 'unknown' },
          unknownFields: ['targetAccount', 'permissionProfile', 'workspace', 'locale', 'viewport', 'featureVersion'],
        },
        remainingStepMs: 10_000,
        runBudgetUsedMs: 0,
        stepType: 'ai_extract',
        sessionGrant: {
          sessionId: randomUUID(),
          leaseId: randomUUID(),
          generation: 1,
          sessionFencingToken: 1,
          expiresAt: new Date().toISOString(),
        },
      },
      budget: { usedMs: 0 },
    })
    expect(isAiStepType('ai_extract')).toBe(true)
    expect(stepUsesBrowser('ai_extract')).toBe(true)
    expect(captured.observation.captureReason, captured.observation.captureStatus).toBeUndefined()
    expect(captured.observation.captureStatus).toBe('observed')
    expect(captured.observation.completeness).toBe('none')
    expect(captured.observation.semanticSummary.predicates.some((item) => item.name === 'aiStepResultOnly')).toBe(
      true,
    )
  })

  it('OMB12 策略关闭时业务成功且无地图行', async () => {
    const created = await queue(
      [
        {
          id: newId(),
          name: '回显',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 'ok' },
        },
      ],
      { enabled: false },
    )
    const engine = new ExecutionEngine(handle)
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })
    const page = await readMapFacts(handle.db, { targetId })
    expect(
      page.facts.some(
        (fact) =>
          fact.type === 'observation' &&
          fact.observation.sourceRef.sourceType !== 'recorder' &&
          'runId' in fact.observation.sourceRef &&
          fact.observation.sourceRef.runId === created.detail.id,
      ),
    ).toBe(false)
  })
})
