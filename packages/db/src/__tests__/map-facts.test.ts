import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  RECORDER_SOURCE_VERSION,
  mapObservationSchema,
  mapVerificationSchema,
  type MapFactCaller,
  type MapObservation,
  type MapVerification,
  type Step,
} from '@cairn/shared'
import { expose } from '../database.js'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { latestLogicalVersion } from '../migrate.js'
import { exportDatabase, importDatabase } from '../transfer.js'
import { forceGrantForRun, seedWorker } from './lease-harness.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  appendMapFacts,
  appendMapObservation,
  appendMapVerification,
  captureMapWatermark,
  createRecordingDraft,
  createRunWithSnapshot,
  createScenarioWithVersion,
  deleteRecordingDraft,
  deleteRun,
  expireMapFactContents,
  getMapFact,
  isMapFactWriteOpen,
  mapFactTestHooks,
  previewMapFactRetention,
  readMapFacts,
  setMapFactWriteOpen,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000c1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s 地图事实账本', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle & { env: import('@cairn/shared').DbEnv }
  let actorId: string
  let targetId: string
  let otherTargetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `map_${Date.now().toString(36)}`)
    const { consoleAccounts, targets } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    otherTargetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'map-facts',
      email: `map-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values([
      { id: targetId, code: `map-${targetId}`, name: '地图夹具', entryUrl: 'https://shop.example' },
      {
        id: otherTargetId,
        code: `map-b-${otherTargetId}`,
        name: '另一目标',
        entryUrl: 'https://other.example',
      },
    ])
  })

  afterAll(async () => {
    await handle?.close()
  })

  afterEach(() => {
    mapFactTestHooks.beforeUpdateHead = null
    setMapFactWriteOpen(true)
  })

  function consoleCaller(): MapFactCaller {
    return { kind: 'console', actorId }
  }

  function observation(overrides: Record<string, unknown> = {}): MapObservation {
    const id = (overrides.id as string | undefined) ?? newId()
    const key = (overrides.dedupeKey as string | undefined) ?? `obs:${id}:before:0`
    return mapObservationSchema.parse({
      id,
      schemaVersion: 1,
      targetId,
      dedupeKey: key,
      observedAt: '2026-09-16T00:00:00.000Z',
      collectorVersion: 'map-collector@1',
      sourceType: 'user_confirmed',
      sourceRef: {
        sourceType: 'user_confirmed',
        actorId,
        decisionId: newId(),
        scope: 'orders.search',
      },
      phase: 'before_action',
      localSequence: 0,
      sourceEventKey: key,
      conditionSnapshot: {
        targetId,
        accountBinding: { presence: 'anonymous' },
        unknownFields: ['permissionProfile', 'workspace', 'locale', 'viewport', 'featureVersion'],
      },
      topUrlPattern: 'https://shop.example/orders',
      framePath: [],
      originChain: ['https://shop.example'],
      surfaceCapability: { frames: 'ok', a11y: 'ok', canvas: 'unknown', shadow: 'ok' },
      regionRefs: [{ key: 'action', kind: 'action_object' }],
      nodeSetKind: 'action_object',
      completeness: 'partial',
      truncated: true,
      missingReasons: ['TRUNCATED'],
      semanticSummary: { predicates: [{ name: 'ready', value: true }] },
      stateSummary: { regions: {} },
      structuralSummary: { nodeCount: 4, truncated: true },
      evidenceRefs: [],
      captureStatus: 'observed',
      ...overrides,
    })
  }

  function verification(
    observationIds: string[],
    overrides: Record<string, unknown> = {},
  ): MapVerification {
    const id = (overrides.id as string | undefined) ?? newId()
    const key = (overrides.dedupeKey as string | undefined) ?? `ver:${id}`
    return mapVerificationSchema.parse({
      id,
      schemaVersion: 1,
      targetId,
      dedupeKey: key,
      observationIds,
      dimension: 'locator',
      verdict: 'confirmed',
      claim: { proposition: '定位唯一命中' },
      evidenceRefs: [],
      evaluatedAt: '2026-09-16T00:01:00.000Z',
      evaluatorVersion: 'rule@1',
      verificationSource: {
        kind: 'user_confirmed',
        actorId,
        decisionId: newId(),
        sourceEventKey: key,
        sourceVersion: 'rule@1',
      },
      ...overrides,
    })
  }

  async function queuedRun() {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `map-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    return createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
  }

  it('OMA01 合法观察可写入，水位从 1 开始', async () => {
    const created = await appendMapObservation(handle.db, { caller: consoleCaller(), observation: observation() })
    expect(created).toMatchObject({ outcome: 'created', ingestSeq: expect.any(Number) })
    const watermark = await captureMapWatermark(handle.db, targetId)
    expect(watermark.committedSeq).toBeGreaterThanOrEqual(created.ingestSeq)
  })

  it('OMA02 同键同正文并发 20 次只落一条', async () => {
    const fact = observation({ dedupeKey: `conc-${newId().slice(0, 8)}-same` })
    const started = Date.now()
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        appendMapObservation(handle.db, { caller: consoleCaller(), observation: { ...fact, id: newId() } }),
      ),
    )
    const elapsed = Date.now() - started
    const ids = new Set(results.map((item) => item.id))
    const seqs = new Set(results.map((item) => item.ingestSeq))
    expect(ids.size).toBe(1)
    expect(seqs.size).toBe(1)
    expect(results.every((item) => item.payloadDigest === results[0]!.payloadDigest)).toBe(true)
    const { mapObservations } = schemaFor(handle.db)
    const rows = await handle.db
      .select()
      .from(mapObservations)
      .where(eq(mapObservations.dedupeKey, fact.dedupeKey))
    expect(rows).toHaveLength(1)
    expect(elapsed).toBeLessThan(15_000)
  })

  it('OMA03 同键不同正文冲突且不覆盖', async () => {
    const key = `conflict-${newId().slice(0, 8)}`
    const first = await appendMapObservation(handle.db, {
      caller: consoleCaller(),
      observation: observation({ dedupeKey: key, sourceEventKey: key }),
    })
    await expect(
      appendMapObservation(handle.db, {
        caller: consoleCaller(),
        observation: observation({
          dedupeKey: key,
          sourceEventKey: key,
          semanticSummary: { predicates: [{ name: 'ready', value: false }] },
        }),
      }),
    ).rejects.toMatchObject({ code: 'MAP_FACT_IDEMPOTENCY_CONFLICT' })
    const loaded = await getMapFact(handle.db, {
      targetId,
      factType: 'observation',
      factId: first.id,
    })
    expect(loaded.type === 'observation' && loaded.observation.semanticSummary.predicates[0]?.value).toBe(
      true,
    )
  })

  it('OMA04 跨目标评价整单拒绝且无悬空关联', async () => {
    const local = await appendMapObservation(handle.db, { caller: consoleCaller(), observation: observation() })
    const { mapVerificationRefs, mapVerifications } = schemaFor(handle.db)
    const beforeRefs = await handle.db.select().from(mapVerificationRefs)
    const beforeVers = await handle.db.select().from(mapVerifications)
    await expect(
      appendMapVerification(handle.db, {
        caller: consoleCaller(),
        verification: verification([local.id], { targetId: otherTargetId }),
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/MAP_TARGET/) })
    expect(await handle.db.select().from(mapVerificationRefs)).toHaveLength(beforeRefs.length)
    expect(await handle.db.select().from(mapVerifications)).toHaveLength(beforeVers.length)
  })

  it('OMA05 更新收件头前失败则整单回滚，重试成功', async () => {
    const fact = observation({ dedupeKey: `rollback-${newId().slice(0, 8)}` })
    const before = await captureMapWatermark(handle.db, targetId)
    mapFactTestHooks.beforeUpdateHead = () => {
      throw new Error('injected before head')
    }
    await expect(appendMapObservation(handle.db, { caller: consoleCaller(), observation: fact })).rejects.toThrow(
      /injected before head/,
    )
    expect(await captureMapWatermark(handle.db, targetId)).toEqual(before)
    mapFactTestHooks.beforeUpdateHead = null
    const created = await appendMapObservation(handle.db, { caller: consoleCaller(), observation: fact })
    expect(created.outcome).toBe('created')
    expect((await captureMapWatermark(handle.db, targetId)).committedSeq).toBe(before.committedSeq + 1)
  })

  it('OMA06 迟到评价用新 ingest_seq，固定水位看不到它', async () => {
    const observed = await appendMapObservation(handle.db, {
      caller: consoleCaller(),
      observation: observation({ observedAt: '2026-09-15T00:00:00.000Z' }),
    })
    const frozen = await captureMapWatermark(handle.db, targetId)
    const late = await appendMapVerification(handle.db, {
      caller: consoleCaller(),
      verification: verification([observed.id], { evaluatedAt: '2026-09-16T12:00:00.000Z' }),
    })
    expect(late.ingestSeq).toBeGreaterThan(frozen.committedSeq)
    const first = await readMapFacts(handle.db, { targetId, afterSeq: frozen.committedSeq - 1, throughSeq: frozen.committedSeq })
    expect(first.facts.some((fact) => fact.type === 'verification' && fact.verification.id === late.id)).toBe(
      false,
    )
    const second = await readMapFacts(handle.db, { targetId, afterSeq: frozen.committedSeq })
    expect(second.facts.some((fact) => fact.type === 'verification' && fact.verification.id === late.id)).toBe(
      true,
    )
  })

  it('OMA07 丢回包后同键恢复，不重复计数', async () => {
    const fact = observation()
    const first = await appendMapObservation(handle.db, { caller: consoleCaller(), observation: fact })
    const again = await appendMapObservation(handle.db, {
      caller: consoleCaller(),
      observation: { ...fact, id: newId() },
    })
    expect(again).toMatchObject({
      outcome: 'duplicate',
      id: first.id,
      ingestSeq: first.ingestSeq,
      payloadDigest: first.payloadDigest,
    })
  })

  it('OMA08 过期运行租约不能写入运行事实', async () => {
    const created = await queuedRun()
    const worker = await seedWorker(handle, `map-${newId().slice(0, 8)}`)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId, 30)
    const { runLeases } = schemaFor(handle.db)
    await handle.db
      .update(runLeases)
      .set({ status: 'EXPIRED', releasedAt: new Date() })
      .where(eq(runLeases.id, grant.leaseId))
    const stepRunId = created.detail.stepRuns[0]!.id
    await expect(
      appendMapObservation(handle.db, {
        caller: { kind: 'run', grant },
        observation: observation({
          sourceType: 'formal_run',
          sourceRef: { sourceType: 'formal_run', runId: created.detail.id, stepRunId },
          phase: 'step_skipped',
          captureStatus: 'skipped',
          captureReason: 'NOT_APPLICABLE',
        }),
      }),
    ).rejects.toMatchObject({ code: 'MAP_FACT_STALE_OWNER' })
  })

  it('OMA09 缺失对象指针可保存，过期基线不能当完整差分', async () => {
    const baseline = await appendMapObservation(handle.db, {
      caller: consoleCaller(),
      observation: observation({
        semanticSummary: { predicates: [{ name: 'baseline', value: true }] },
      }),
    })
    await expireMapFactContents(handle.db, { targetId, olderThan: new Date('2099-01-01T00:00:00.000Z') })
    const expired = await getMapFact(handle.db, {
      targetId,
      factType: 'observation',
      factId: baseline.id,
    })
    expect(expired.contentAvailability).toBe('expired')
    await expect(
      appendMapObservation(handle.db, {
        caller: consoleCaller(),
        observation: observation({
          baselineRef: { kind: 'observation', observationId: baseline.id },
          evidenceRefs: [{ kind: 'object', availability: 'missing', missingReason: 'OBJECT_MISSING' }],
        }),
      }),
    ).rejects.toMatchObject({ code: 'MAP_BASELINE_UNAVAILABLE' })
    const preview = await previewMapFactRetention(handle.db, {
      targetId,
      olderThan: new Date('2099-01-01T00:00:00.000Z'),
    })
    expect(preview.observationContents).toBe(0)
  })

  it('OMA10 未知版本、敏感字段、超上限与写入关闭被拒绝', async () => {
    await expect(
      appendMapObservation(handle.db, {
        caller: consoleCaller(),
        observation: { ...observation(), schemaVersion: 2 } as unknown as MapObservation,
      }),
    ).rejects.toMatchObject({ code: 'MAP_SCHEMA_UNSUPPORTED' })
    await expect(
      appendMapObservation(handle.db, {
        caller: consoleCaller(),
        observation: observation({ stateSummary: { regions: { password: 'x' } } }),
      }),
    ).rejects.toMatchObject({ code: 'MAP_FACT_SENSITIVE_CONTENT' })
    await expect(
      appendMapObservation(handle.db, {
        caller: consoleCaller(),
        observation: observation({ stateSummary: { regions: { body: 'n'.repeat(70_000) } } }),
      }),
    ).rejects.toMatchObject({ code: 'MAP_FACT_TOO_LARGE' })
    setMapFactWriteOpen(false)
    expect(isMapFactWriteOpen()).toBe(false)
    await expect(
      appendMapObservation(handle.db, { caller: consoleCaller(), observation: observation() }),
    ).rejects.toMatchObject({ code: 'MAP_WRITE_CLOSED' })
    setMapFactWriteOpen(true)
    const created = await appendMapObservation(handle.db, { caller: consoleCaller(), observation: observation() })
    expect(created.outcome).toBe('created')
  })

  it('OMA11 导出再导入保留 digest、关联和水位', async () => {
    const observed = await appendMapObservation(handle.db, { caller: consoleCaller(), observation: observation() })
    await appendMapVerification(handle.db, {
      caller: consoleCaller(),
      verification: verification([observed.id]),
    })
    const now = new Date()
    const { browserSessions, runLeases, runs, sessionLeases, workers } = schemaFor(handle.db)
    await handle.db.update(runLeases).set({ status: 'RELEASED', releasedAt: now })
    await handle.db.update(sessionLeases).set({ status: 'RELEASED', releasedAt: now })
    await handle.db.update(runs).set({ status: 'SUCCEEDED', finishedAt: now, updatedAt: now })
    await handle.db.update(workers).set({ status: 'STOPPED', stoppedAt: now, updatedAt: now })
    await handle.db.update(browserSessions).set({ status: 'CLOSED', closedAt: now, updatedAt: now, closeReason: 'map-export' })
    const watermark = await captureMapWatermark(handle.db, targetId)
    const transferOptions = {
      writersStopped: true as const,
      allowMillisecondPrecisionLoss: true,
      verifyObject: async () => undefined,
    }
    const archive = await exportDatabase(expose(handle), handle.env, transferOptions)
    expect(archive.logicalVersion).toBe(latestLogicalVersion())
    expect(archive.tables.mapObservations?.some((row) => row.id === observed.id)).toBe(true)
    expect(
      archive.tables.mapFactReceipts?.some(
        (row) => row.factId === observed.id && row.payloadDigest === observed.payloadDigest,
      ),
    ).toBe(true)
    expect(archive.tables.mapIngestHeads?.some((row) => row.committedSeq === watermark.committedSeq)).toBe(
      true,
    )
    expect(
      archive.tables.mapVerificationRefs?.some((row) => row.observationId === observed.id),
    ).toBe(true)
    const replica = await openContractDb(driver, `map_imp_${Date.now().toString(36)}`)
    try {
      const imported = await importDatabase(expose(replica), replica.env, archive, transferOptions)
      expect(imported.counts.mapObservations).toBeGreaterThanOrEqual(1)
      expect(imported.counts.mapVerificationRefs).toBeGreaterThanOrEqual(1)
      const restored = await getMapFact(replica.db, {
        targetId,
        factType: 'observation',
        factId: observed.id,
      })
      expect(restored.payloadDigest).toBe(observed.payloadDigest)
      expect((await captureMapWatermark(replica.db, targetId)).committedSeq).toBe(watermark.committedSeq)
    } finally {
      await replica.close()
    }
  })

  it('OMA12 删除运行或录制后地图历史仍可读且来源标 deleted', async () => {
    const created = await queuedRun()
    const worker = await seedWorker(handle, `del-${newId().slice(0, 8)}`)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId, 30)
    const stepRunId = created.detail.stepRuns[0]!.id
    const written = await appendMapObservation(handle.db, {
      caller: { kind: 'run', grant },
      observation: observation({
        sourceType: 'formal_run',
        sourceRef: { sourceType: 'formal_run', runId: created.detail.id, stepRunId },
        phase: 'step_skipped',
        captureStatus: 'skipped',
        captureReason: 'NOT_APPLICABLE',
      }),
    })
    const { runLeases, runs } = schemaFor(handle.db)
    const now = new Date()
    await handle.db.update(runLeases).set({ status: 'RELEASED', releasedAt: now }).where(eq(runLeases.id, grant.leaseId))
    await handle.db
      .update(runs)
      .set({ status: 'SUCCEEDED', finishedAt: now, updatedAt: now })
      .where(eq(runs.id, created.detail.id))
    await deleteRun(handle.db, created.detail.id, { id: actorId })
    const afterDelete = await getMapFact(handle.db, {
      targetId,
      factType: 'observation',
      factId: written.id,
    })
    expect(afterDelete.sourceAvailability).toBe('deleted')
    expect(afterDelete.type === 'observation' && afterDelete.observation.sourceRef).toMatchObject({
      runId: created.detail.id,
    })

    const recording = await createRecordingDraft(
      handle.db,
      {
        targetId,
        recordingId: newId(),
        sourceVersion: RECORDER_SOURCE_VERSION,
        idempotencyKey: `map-${newId()}`,
        events: [{ name: 'navigate', url: 'https://shop.example', signals: [], pageAlias: 'page', framePath: [] }],
      },
      { id: actorId },
    )
    const recorded = await appendMapObservation(handle.db, {
      caller: { kind: 'service', serviceId: newId() },
      observation: observation({
        sourceType: 'recorder',
        sourceRef: {
          sourceType: 'recorder',
          recordingId: recording.detail.recordingId,
          sourceVersion: RECORDER_SOURCE_VERSION,
          originalEventIndex: 0,
        },
      }),
    })
    await deleteRecordingDraft(handle.db, recording.detail.id, { id: actorId })
    const afterRecording = await getMapFact(handle.db, {
      targetId,
      factType: 'observation',
      factId: recorded.id,
    })
    expect(afterRecording.sourceAvailability).toBe('deleted')
  })

  it('同批观察与评价一起提交，混合读取按 seq 排列', async () => {
    const obs = observation()
    const results = await appendMapFacts(handle.db, {
      caller: consoleCaller(),
      facts: [
        { type: 'observation', observation: obs },
        { type: 'verification', verification: verification([obs.id]) },
      ],
    })
    expect(results.map((item) => item.factType)).toEqual(['observation', 'verification'])
    expect(results[1]!.ingestSeq).toBe(results[0]!.ingestSeq + 1)
    const page = await readMapFacts(handle.db, {
      targetId,
      afterSeq: results[0]!.ingestSeq - 1,
      throughSeq: results[1]!.ingestSeq,
    })
    expect(page.facts.map((fact) => fact.type)).toEqual(['observation', 'verification'])
  })
})
