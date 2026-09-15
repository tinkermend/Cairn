import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DebugCheckpoint, DebugOverlay, Step } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  claimRun,
  continueRunDebug,
  createRunWithSnapshot,
  createScenarioWithVersion,
  createTrialRunFromDraft,
  enterRunHolding,
  finishAttemptTx,
  getRun,
  listRunEventsAfter,
  loadRunDetail,
  registerWorker,
  saveScenarioDraft,
  schemaFor,
  settleLeaselessRun,
  startAttempt,
  stopRunDebug,
  updateRunDebugOverlay,
} from '../test-entry.js'
import { newId } from '../id.js'

const echoStep: Step = {
  id: '00000000-0000-4000-8000-000000000071',
  name: '第一步',
  type: 'echo',
  effectType: 'READ_ONLY',
  outputKey: 'result',
  input: { value: 'test' },
}

const secondStep: Step = {
  id: '00000000-0000-4000-8000-000000000072',
  name: '第二步',
  type: 'echo',
  effectType: 'READ_ONLY',
  outputKey: 'result2',
  input: { value: 'test2' },
}

describe.each(DRIVERS)('%s 编写调试与 HOLDING 状态', { timeout: 30_000 }, (driver) => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `debug_${driver}`)
    actorId = newId()
    targetId = newId()
    const { consoleAccounts, targets } = schemaFor(handle.db)
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'debug_author',
      email: `debug-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `dbg-${driver}-${actorId.slice(0, 8)}`,
      name: '调试夹具',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  beforeEach(async () => {
    // Cancel all runs AND revoke all leases to ensure clean state between tests
    const { runs, runLeases } = schemaFor(handle.db)
    await handle.db
      .update(runLeases)
      .set({ status: 'REVOKED', releasedAt: new Date(), releaseReason: 'test_reset' })
    await handle.db.update(runs).set({ status: 'CANCELLED' })
  })

  it('正式运行拒绝非 runThrough 模式，试跑默认 holdOnFailure', async () => {
    const actor = { id: actorId, email: 'author@example.com' }
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `formal-${newId().slice(0, 8)}`,
      actor,
      steps: [echoStep],
    })

    // Formal run rejects holdOnFailure
    await expect(
      createRunWithSnapshot(handle.db, {
        scenarioId: scenario.id,
        scenarioVersionId: scenario.latestVersionId,
        actor: { kind: 'console', id: actorId },
        debugMode: 'holdOnFailure',
      }),
    ).rejects.toMatchObject({ code: 'DEBUG_MODE_NOT_ALLOWED' })

    // Formal run defaults to runThrough
    const formal = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      actor: { kind: 'console', id: actorId },
    })
    expect(formal.detail.debugMode).toBe('runThrough')

    // Create a draft for trial run
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      actor,
      document: {
        schemaVersion: 1,
        steps: [echoStep, secondStep],
      },
    })

    // Trial run defaults to holdOnFailure
    const trial = await createTrialRunFromDraft(handle.db, scenario.id, {
      revision: 2,
      actor,
    })
    expect(trial.detail.debugMode).toBe('holdOnFailure')

    // Trial run accepts explicit holdAfterEach
    const trialHoldAfterEach = await createTrialRunFromDraft(handle.db, scenario.id, {
      revision: 2,
      actor,
      debugMode: 'holdAfterEach',
    })
    expect(trialHoldAfterEach.detail.debugMode).toBe('holdAfterEach')
  })

  it('进入 HOLDING 记录检查点并支持临时覆盖层更新', async () => {
    const actor = { id: actorId, email: 'author@example.com' }
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `hold-${newId().slice(0, 8)}`,
      actor,
      steps: [echoStep, secondStep],
    })
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      actor,
      document: {
        schemaVersion: 1,
        steps: [echoStep, secondStep],
      },
    })
    const trial = await createTrialRunFromDraft(handle.db, scenario.id, {
      revision: 2,
      actor,
    })

    const workerId = `w-${newId()}`
    const instanceId = newId()
    await registerWorker(handle.db, { workerId, instanceId, capacity: 1, lostAfterSeconds: 60 })
    const grant = await claimRun(handle, { workerId, instanceId, leaseTtlSeconds: 60 })
    expect(grant).not.toBeNull()
    expect(grant!.runId).toBe(trial.detail.id)

    const checkpoint: DebugCheckpoint = {
      mode: 'holdOnFailure',
      reason: 'step_failed',
      stepId: echoStep.id,
      stepOrdinal: 0,
      contextKeys: [],
      sessionGeneration: 1,
      fencingToken: String(grant!.fencingToken),
      overlayRevision: 0,
    }

    const entered = await enterRunHolding(handle.db, {
      runId: trial.detail.id,
      grant: grant!,
      checkpoint,
    })
    expect(entered).toBe(true)

    const detail = await loadRunDetail(handle.db, trial.detail.id)
    expect(detail?.status).toBe('HOLDING')
    expect(detail?.checkpoint).toMatchObject({
      reason: 'step_failed',
      stepId: echoStep.id,
    })

    // Update debug overlay
    const overlay: DebugOverlay = {
      revision: 1,
      stepOverrides: {
        [echoStep.id]: {
          target: {
            framePath: [],
            candidates: [{ by: 'testId', value: 'btn-retry' }],
          },
        },
      },
    }
    const withOverlay = await updateRunDebugOverlay(handle.db, trial.detail.id, overlay)
    expect(withOverlay.debugOverlay).toMatchObject(overlay)

    // Events contain run.holding
    const events = await listRunEventsAfter(handle.db, trial.detail.id, 0, 50)
    expect(events.map((e) => e.type)).toContain('run.holding')
  })

  it('在 HOLDING 状态下重试失败步骤原子恢复 RUNNING 并递增 attemptNo', async () => {
    const actor = { id: actorId, email: 'author@example.com' }
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `retry-${newId().slice(0, 8)}`,
      actor,
      steps: [echoStep],
    })
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      actor,
      document: {
        schemaVersion: 1,
        steps: [echoStep],
      },
    })
    const trial = await createTrialRunFromDraft(handle.db, scenario.id, {
      revision: 2,
      actor,
    })

    const workerId = `w-${newId()}`
    const instanceId = newId()
    await registerWorker(handle.db, { workerId, instanceId, capacity: 1, lostAfterSeconds: 60 })
    const grant = await claimRun(handle, { workerId, instanceId, leaseTtlSeconds: 60 })
    expect(grant).not.toBeNull()
    const stepRunId = trial.detail.stepRuns[0]!.id

    // Attempt 1 starts
    const att1 = await startAttempt(handle.db, {
      runId: trial.detail.id,
      stepRunId,
      inputPayload: { value: '1' },
      grant: grant!,
    })
    expect(att1?.attemptNo).toBe(1)

    // Attempt 1 fails, run enters HOLDING
    const checkpoint: DebugCheckpoint = {
      mode: 'holdOnFailure',
      reason: 'step_failed',
      stepId: echoStep.id,
      stepOrdinal: 0,
      contextKeys: [],
      sessionGeneration: 1,
      fencingToken: String(grant!.fencingToken),
      overlayRevision: 0,
    }
    await finishAttemptTx(handle.db, {
      runId: trial.detail.id,
      attemptId: att1!.attemptId,
      attemptStatus: 'FAILED',
      stepRunStatus: 'FAILED',
      runStatus: 'HOLDING',
      checkpoint,
      grant: grant!,
      error: {
        code: 'ASSERT_FAILED',
        category: 'EXECUTOR',
        retryable: false,
        safeMessage: '断言失败',
      },
    })

    const afterFail = await getRun(handle.db, trial.detail.id)
    expect(afterFail.status).toBe('HOLDING')
    expect(afterFail.stepRuns[0]?.status).toBe('FAILED')

    // Retry step under HOLDING -> should succeed and move run back to RUNNING
    const att2 = await startAttempt(handle.db, {
      runId: trial.detail.id,
      stepRunId,
      inputPayload: { value: 'retry-val' },
      grant: grant!,
    })
    expect(att2).not.toBeNull()
    expect(att2?.attemptNo).toBe(2)

    const afterRetry = await getRun(handle.db, trial.detail.id)
    expect(afterRetry.status).toBe('RUNNING')
    expect(afterRetry.stepRuns[0]?.status).toBe('RUNNING')

    const events = await listRunEventsAfter(handle.db, trial.detail.id, 0, 50)
    expect(events.map((e) => e.type)).toContain('run.debug_resumed')
  })

  it('stopRunDebug 终结调试会话并释放租约', async () => {
    const actor = { id: actorId, email: 'author@example.com' }
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `stop-${newId().slice(0, 8)}`,
      actor,
      steps: [echoStep, secondStep],
    })
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      actor,
      document: {
        schemaVersion: 1,
        steps: [echoStep, secondStep],
      },
    })
    const trial = await createTrialRunFromDraft(handle.db, scenario.id, {
      revision: 2,
      actor,
    })

    const workerId = `w-${newId()}`
    const instanceId = newId()
    await registerWorker(handle.db, { workerId, instanceId, capacity: 1, lostAfterSeconds: 60 })
    const grant = await claimRun(handle, { workerId, instanceId, leaseTtlSeconds: 60 })
    expect(grant).not.toBeNull()

    const checkpoint: DebugCheckpoint = {
      mode: 'holdOnFailure',
      reason: 'step_failed',
      stepId: echoStep.id,
      stepOrdinal: 0,
      contextKeys: [],
      sessionGeneration: 1,
      fencingToken: String(grant!.fencingToken),
      overlayRevision: 0,
    }
    await enterRunHolding(handle.db, {
      runId: trial.detail.id,
      grant: grant!,
      checkpoint,
    })

    const stopped = await stopRunDebug(handle.db, trial.detail.id, actor)
    expect(stopped.status).toBe('CANCELLED')
    expect(stopped.lease).toBeNull()

    const events = await listRunEventsAfter(handle.db, trial.detail.id, 0, 50)
    expect(events.map((e) => e.type)).toContain('run.debug_stopped')
  })

  it('HOLDING 状态下租约丢失 settleLeaselessRun 终结为 FAILED (DEBUG_WORKER_LOST)', async () => {
    const actor = { id: actorId, email: 'author@example.com' }
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `lost-${newId().slice(0, 8)}`,
      actor,
      steps: [echoStep],
    })
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      actor,
      document: {
        schemaVersion: 1,
        steps: [echoStep],
      },
    })
    const trial = await createTrialRunFromDraft(handle.db, scenario.id, {
      revision: 2,
      actor,
    })

    const workerId = `w-${newId()}`
    const instanceId = newId()
    await registerWorker(handle.db, { workerId, instanceId, capacity: 1, lostAfterSeconds: 60 })
    const grant = await claimRun(handle, { workerId, instanceId, leaseTtlSeconds: 60 })
    expect(grant).not.toBeNull()

    const checkpoint: DebugCheckpoint = {
      mode: 'holdOnFailure',
      reason: 'step_failed',
      stepId: echoStep.id,
      stepOrdinal: 0,
      contextKeys: [],
      sessionGeneration: 1,
      fencingToken: String(grant!.fencingToken),
      overlayRevision: 0,
    }
    await enterRunHolding(handle.db, {
      runId: trial.detail.id,
      grant: grant!,
      checkpoint,
    })

    // Settle leaseless run when in HOLDING
    const outcome = await settleLeaselessRun(handle.db, {
      runId: trial.detail.id,
      maxRecoveries: 3,
    })
    expect(outcome).toBe('failed')

    const detail = await getRun(handle.db, trial.detail.id)
    expect(detail.status).toBe('FAILED')

    const events = await listRunEventsAfter(handle.db, trial.detail.id, 0, 50)
    expect(events.map((e) => e.type)).toContain('run.debug_stopped')
  })

  it('continueRunDebug 在失败步拒绝，stop 后未跑步保持 PENDING', async () => {
    const actor = { id: actorId, email: 'author@example.com' }
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `cont-${newId().slice(0, 8)}`,
      actor,
      steps: [echoStep, secondStep],
    })
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      actor,
      document: { schemaVersion: 1, steps: [echoStep, secondStep] },
    })
    const trial = await createTrialRunFromDraft(handle.db, scenario.id, { revision: 2, actor })
    const workerId = `w-${newId()}`
    const instanceId = newId()
    await registerWorker(handle.db, { workerId, instanceId, capacity: 1, lostAfterSeconds: 60 })
    const grant = await claimRun(handle, { workerId, instanceId, leaseTtlSeconds: 60 })
    const stepRunId = trial.detail.stepRuns[0]!.id
    const att1 = await startAttempt(handle.db, {
      runId: trial.detail.id,
      stepRunId,
      inputPayload: { value: '1' },
      grant: grant!,
    })
    const checkpoint: DebugCheckpoint = {
      mode: 'holdOnFailure',
      reason: 'step_failed',
      stepId: echoStep.id,
      stepOrdinal: 0,
      contextKeys: [],
      sessionGeneration: 1,
      fencingToken: String(grant!.fencingToken),
      overlayRevision: 0,
    }
    await finishAttemptTx(handle.db, {
      runId: trial.detail.id,
      attemptId: att1!.attemptId,
      attemptStatus: 'FAILED',
      stepRunStatus: 'FAILED',
      runStatus: 'HOLDING',
      checkpoint,
      grant: grant!,
      error: {
        code: 'ASSERT_FAILED',
        category: 'EXECUTOR',
        retryable: false,
        safeMessage: '断言失败',
      },
    })
    await expect(continueRunDebug(handle.db, { runId: trial.detail.id, grant: grant! })).rejects.toMatchObject({
      code: 'STEP_CANNOT_RETRY',
    })
    const stopped = await stopRunDebug(handle.db, trial.detail.id, actor)
    expect(stopped.status).toBe('FAILED')
    expect(stopped.stepRuns[1]?.status).toBe('PENDING')
    expect(stopped.stepRuns.some((item) => item.status === 'SKIPPED')).toBe(false)
  })
})
