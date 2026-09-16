import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  mapObservationSchema,
  mapVerificationSchema,
  type MapFactBatchItem,
  type MapObservation,
  type MapVerification,
  type Step,
} from '@cairn/shared'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { forceGrantForRun, seedWorker } from './lease-harness.js'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  finishAttempt,
  readMapFacts,
  reconcileOrphanAttempts,
  requestRunCancel,
  setMapFactWriteOpen,
  startAttempt,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

const echoA: Step = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: '回显甲',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'a' },
}
const echoB: Step = {
  id: '00000000-0000-4000-8000-0000000000a2',
  name: '回显乙',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'b' },
}

describe.each(DRIVERS)('%s 收口地图事实', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let worker: { workerId: string; instanceId: string }

  beforeAll(async () => {
    handle = await openContractDb(driver, `finmap_${Date.now().toString(36)}`)
    const { consoleAccounts, targets } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'finish-map',
      email: `finmap-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `finmap-${targetId.slice(0, 8)}`,
      name: '收口地图',
      entryUrl: 'https://shop.example',
    })
    worker = await seedWorker(handle, `finmap-${newId()}`)
  })

  afterAll(async () => {
    await handle?.close()
  })

  afterEach(() => {
    setMapFactWriteOpen(true)
  })

  async function queued(steps: Step[] = [echoA, echoB]) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `finmap-${newId()}`,
      steps,
      actor: { id: actorId },
    })
    return createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
      mapCapturePolicy: { enabled: true, schemaVersion: 1 },
    })
  }

  function observation(input: {
    runId: string
    stepRunId: string
    attemptId?: string
    phase?: MapObservation['phase']
    captureStatus?: MapObservation['captureStatus']
  }): MapObservation {
    const key = input.phase === 'step_skipped'
      ? `run:${input.runId}:skip:${input.stepRunId}`
      : `run:${input.runId}:${input.attemptId ?? 'none'}:${input.phase ?? 'after'}`
    return mapObservationSchema.parse({
      id: newId(),
      schemaVersion: 1,
      targetId,
      dedupeKey: key,
      observedAt: '2026-09-16T00:00:00.000Z',
      collectorVersion: 'map-collector@1',
      sourceType: 'formal_run',
      sourceRef: {
        sourceType: 'formal_run',
        runId: input.runId,
        stepRunId: input.stepRunId,
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      },
      phase: input.phase ?? 'after_action',
      localSequence: 0,
      sourceEventKey: key,
      conditionSnapshot: {
        targetId,
        accountBinding: { presence: 'unknown' },
        unknownFields: ['targetAccount', 'permissionProfile', 'workspace', 'locale', 'viewport', 'featureVersion'],
      },
      topUrlPattern: 'https://shop.example/orders',
      framePath: [],
      originChain: ['https://shop.example'],
      surfaceCapability: { frames: 'ok', a11y: 'unknown', canvas: 'unknown', shadow: 'unknown' },
      regionRefs: [{ key: 'action', kind: 'action_object' }],
      nodeSetKind: 'unknown',
      completeness: 'none',
      truncated: true,
      missingReasons: input.captureStatus === 'observed' ? [] : ['NOT_APPLICABLE'],
      semanticSummary: { predicates: [] },
      stateSummary: { regions: {} },
      structuralSummary: { nodeCount: 0, truncated: true },
      evidenceRefs: [],
      captureStatus: input.captureStatus ?? 'observed',
    })
  }

  function verification(
    observationIds: string[],
    input: { runId: string; stepRunId: string; attemptId: string; dimension: MapVerification['dimension']; verdict: MapVerification['verdict'] },
  ): MapVerification {
    const key = `ver:${input.dimension}:${input.attemptId}`
    return mapVerificationSchema.parse({
      id: newId(),
      schemaVersion: 1,
      targetId,
      dedupeKey: key,
      observationIds,
      actionRef: { attemptId: input.attemptId, stepRunId: input.stepRunId },
      dimension: input.dimension,
      verdict: input.verdict,
      claim: { proposition: `${input.dimension} ${input.verdict}` },
      evidenceRefs: [],
      evaluatedAt: '2026-09-16T00:01:00.000Z',
      evaluatorVersion: 'rule@1',
      verificationSource: {
        kind: 'rule',
        runId: input.runId,
        stepRunId: input.stepRunId,
        attemptId: input.attemptId,
        ruleRef: 'fixture',
        sourceEventKey: key,
        sourceVersion: 'rule@1',
      },
    })
  }

  it('OMB04 持有 grant 的孤儿收口补 PROCESS_LOST after', async () => {
    const created = await queued([echoA])
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant,
    })
    expect(started).not.toBeNull()
    const outcome = await reconcileOrphanAttempts(handle.db, { grant })
    expect(outcome).toBe('continue')
    const page = await readMapFacts(handle.db, { targetId })
    const after = page.facts.filter(
      (fact) =>
        fact.type === 'observation' &&
        fact.observation.phase === 'after_action' &&
        fact.observation.sourceRef.sourceType === 'formal_run' &&
        'attemptId' in fact.observation.sourceRef &&
        fact.observation.sourceRef.attemptId === started!.attemptId,
    )
    expect(after).toHaveLength(1)
    expect(after[0]!.type === 'observation' && after[0]!.observation.captureReason).toBe('PROCESS_LOST')
  })

  it('OMB05 取消改写不保留 action/business 成功评价', async () => {
    const created = await queued([echoA])
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const stepRunId = created.detail.stepRuns[0]!.id
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId,
      inputPayload: 'hello',
      grant,
    })
    await requestRunCancel(handle.db, created.detail.id, { id: actorId })
    const observed = observation({
      runId: created.detail.id,
      stepRunId,
      attemptId: started!.attemptId,
      captureStatus: 'observed',
    })
    const facts: MapFactBatchItem[] = [
      { type: 'observation', observation: observed },
      {
        type: 'verification',
        verification: verification([observed.id], {
          runId: created.detail.id,
          stepRunId,
          attemptId: started!.attemptId,
          dimension: 'action',
          verdict: 'confirmed',
        }),
      },
      {
        type: 'verification',
        verification: verification([observed.id], {
          runId: created.detail.id,
          stepRunId,
          attemptId: started!.attemptId,
          dimension: 'locator',
          verdict: 'confirmed',
        }),
      },
    ]
    const result = await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: started!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: 'hello',
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
      mapFacts: facts,
    })
    expect(result.cancelled).toBe(true)
    const page = await readMapFacts(handle.db, { targetId })
    const vers = page.facts.filter(
      (fact) =>
        fact.type === 'verification' &&
        fact.verification.verificationSource.kind === 'rule' &&
        fact.verification.verificationSource.runId === created.detail.id,
    )
    expect(vers.some((fact) => fact.type === 'verification' && fact.verification.dimension === 'action')).toBe(
      false,
    )
    expect(vers.some((fact) => fact.type === 'verification' && fact.verification.dimension === 'locator')).toBe(
      true,
    )
  })

  it('OMB06 夹具显式 locator 确认与 business 拒绝并存', async () => {
    const created = await queued([echoA])
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const stepRunId = created.detail.stepRuns[0]!.id
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId,
      inputPayload: 'hello',
      grant,
    })
    const observed = observation({
      runId: created.detail.id,
      stepRunId,
      attemptId: started!.attemptId,
      captureStatus: 'observed',
    })
    await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: started!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: 'hello',
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
      mapFacts: [
        { type: 'observation', observation: observed },
        {
          type: 'verification',
          verification: verification([observed.id], {
            runId: created.detail.id,
            stepRunId,
            attemptId: started!.attemptId,
            dimension: 'locator',
            verdict: 'confirmed',
          }),
        },
        {
          type: 'verification',
          verification: verification([observed.id], {
            runId: created.detail.id,
            stepRunId,
            attemptId: started!.attemptId,
            dimension: 'business',
            verdict: 'rejected',
          }),
        },
      ],
    })
    const page = await readMapFacts(handle.db, { targetId })
    const vers = page.facts
      .filter(
        (fact) =>
          fact.type === 'verification' &&
          fact.verification.verificationSource.kind === 'rule' &&
          fact.verification.verificationSource.runId === created.detail.id,
      )
      .map((fact) => {
        if (fact.type !== 'verification') throw new Error('expected verification')
        return fact.verification
      })
    expect(vers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: 'locator', verdict: 'confirmed' }),
        expect.objectContaining({ dimension: 'business', verdict: 'rejected' }),
      ]),
    )
    expect(JSON.stringify(vers)).not.toMatch(/importance/i)
  })

  it('OMB07 skipRemaining 写 step_skipped 且不造 Attempt', async () => {
    const created = await queued()
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const first = created.detail.stepRuns[0]!
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: first.id,
      inputPayload: 'hello',
      grant,
    })
    await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: started!.attemptId,
      attemptStatus: 'FAILED',
      error: { code: 'FAIL', category: 'EXECUTOR', retryable: false, safeMessage: '失败' },
      stepRunStatus: 'FAILED',
      runStatus: 'FAILED',
      skipRemaining: true,
      grant,
    })
    const { attempts, stepRuns } = schemaFor(handle.db)
    const attemptRows = await handle.db.select().from(attempts)
    const stepRows = await handle.db.select().from(stepRuns)
    const skipped = stepRows.filter((row) => row.runId === created.detail.id && row.status === 'SKIPPED')
    expect(skipped).toHaveLength(1)
    expect(attemptRows.filter((row) => row.stepRunId === skipped[0]!.id)).toHaveLength(0)
    const page = await readMapFacts(handle.db, { targetId })
    const skipObs = page.facts.filter(
      (fact) => fact.type === 'observation' && fact.observation.phase === 'step_skipped',
    )
    expect(skipObs).toHaveLength(1)
    expect(skipObs[0]!.type === 'observation' && skipObs[0]!.observation.captureReason).toBe('NOT_APPLICABLE')
    expect(skipObs[0]!.type === 'observation' && 'attemptId' in skipObs[0]!.observation.sourceRef).toBe(false)
  })

  it('地图 DomainError 不回滚已裁决 Attempt', async () => {
    const created = await queued([echoA])
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant,
    })
    setMapFactWriteOpen(false)
    const result = await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: started!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: 'hello',
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
      mapFacts: [
        {
          type: 'observation',
          observation: observation({
            runId: created.detail.id,
            stepRunId: created.detail.stepRuns[0]!.id,
            attemptId: started!.attemptId,
          }),
        },
      ],
    })
    expect(result.updated).toBe(true)
    const page = await readMapFacts(handle.db, { targetId })
    expect(
      page.facts.some(
        (fact) =>
          fact.type === 'observation' &&
          fact.observation.sourceRef.sourceType === 'formal_run' &&
          'runId' in fact.observation.sourceRef &&
          fact.observation.sourceRef.runId === created.detail.id &&
          fact.observation.phase === 'after_action',
      ),
    ).toBe(false)
  })

  it('injectFailure 在地图写入之后仍整单回滚', async () => {
    const created = await queued([echoA])
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant,
    })
    const before = await readMapFacts(handle.db, { targetId })
    await expect(
      finishAttempt(handle.db, {
        runId: created.detail.id,
        attemptId: started!.attemptId,
        attemptStatus: 'SUCCEEDED',
        output: 'hello',
        stepRunStatus: 'SUCCEEDED',
        runStatus: 'SUCCEEDED',
        grant,
        mapFacts: [
          {
            type: 'observation',
            observation: observation({
              runId: created.detail.id,
              stepRunId: created.detail.stepRuns[0]!.id,
              attemptId: started!.attemptId,
            }),
          },
        ],
        injectFailure: new Error('injected after map'),
      }),
    ).rejects.toThrow('injected after map')
    const after = await readMapFacts(handle.db, { targetId })
    expect(after.facts).toHaveLength(before.facts.length)
  })
})
