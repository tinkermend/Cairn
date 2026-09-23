import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import {
  claimReliabilityEvaluation,
  loadReliabilityIncrementalData,
  reconcileHangingIncidents,
  requestReliabilityEvaluation,
  writeReliabilityEvaluation,
} from '../reliability/evaluations.js'
import { getReliabilityOverview } from '../reliability/metrics.js'
import { RELIABILITY_ERROR_CODES } from '@cairn/shared'

describe.each(DRIVERS)('%s reliability evaluations and checkpoint domain operations', (driver) => {
  let handle: DbHandle
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver)
    const t = schemaFor(handle.db)
    targetId = newId()

    await handle.db.insert(t.targets).values({
      id: targetId,
      code: `target-${targetId.slice(0, 8)}`,
      name: '可靠性测试目标',
      entryUrl: 'https://example.com',
      status: 'active',
      sessionPolicy: { maxLifetimeSeconds: 3600, idleTimeoutSeconds: 300, maxTotalSessions: 5, accountStrategy: 'exclusive' },
      resolutionPolicy: { timeoutMs: 5000, retryLimit: 2, fallbackPriority: ['map', 'ai'] },
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('claims evaluation slot and increments fencing token', async () => {
    const claim1 = await claimReliabilityEvaluation(handle.db, {
      workerId: 'worker-1',
      targetId,
      ttlMs: 5000,
    })

    expect(claim1).not.toBeNull()
    expect(claim1?.targetId).toBe(targetId)
    expect(claim1?.fencingToken).toBe(1)
    expect(claim1?.watermarkVector.runCompletedSeq).toBe(0)

    // Second immediate claim by another worker should be rejected (lease active)
    const claim2 = await claimReliabilityEvaluation(handle.db, {
      workerId: 'worker-2',
      targetId,
      ttlMs: 5000,
    })
    expect(claim2).toBeNull()
  })

  it('writes evaluation and advances watermark in atomic transaction', async () => {
    await requestReliabilityEvaluation(handle.db, targetId)
    const claim = await claimReliabilityEvaluation(handle.db, {
      workerId: 'worker-1',
      targetId,
      ttlMs: 10_000,
    })
    expect(claim).not.toBeNull()
    const fencingToken = claim!.fencingToken

    const evalResult = await writeReliabilityEvaluation(handle.db, {
      targetId,
      fencingToken,
      scopeDigest: `target:${targetId}`,
      watermarkVector: { runCompletedSeq: 100, mapCommittedSeq: 0, validationSeq: 0 },
      rulesEvaluated: 2,
      breachesCount: 1,
      result: { breaches: [{ ruleCode: 'FALLBACK_RATE_SPIKE', severity: 'P3' }] },
      coverageGaps: [],
      featureWindows: [
        {
          targetId,
          scopeDigest: `target:${targetId}`,
          windowType: 'hourly',
          windowStart: new Date(Date.now() - 3600000).toISOString(),
          windowEnd: new Date().toISOString(),
          metricVersion: '1.0',
          sampleCount: 20,
          primaryHitCount: 15,
          fallbackCount: 5,
          retryStepCount: 1,
          ewmaLatencyMs: 150,
          ewmaSuccessRate: 0.95,
          stats: { primaryHitRate: 0.75, fallbackRate: 0.25 },
        },
      ],
      sparseSignals: [
        {
          targetId,
          kind: 'resolution_fallback',
          severity: 'WARN',
          subjectRef: { kind: 'scenario_step', id: 's-1' },
          sourceRef: { kind: 'attempt', id: 'a-1' },
          occurredAt: new Date().toISOString(),
          scopeDigest: `target:${targetId}`,
          availability: 'available',
        },
      ],
      incidents: [
        {
          groupingKey: `target:${targetId}::drift`,
          scopeDigest: `target:${targetId}`,
          severity: 'P3',
          status: 'DETECTED',
          title: '定位退化',
          summary: '检测到备用定位激增',
          evidenceScores: { supportingScore: 60, counterScore: 20, supportingFactors: ['高回退率'], counterFactors: [] },
          firstSeenAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          members: [{ memberRef: 'a-1', memberType: 'attempt' }],
        },
      ],
    })

    expect(evalResult.id).toBeDefined()
    expect(evalResult.watermarkVector.runCompletedSeq).toBe(100)

    // Overview reflects latest data
    const overview = await getReliabilityOverview(handle.db, targetId)
    expect(overview.targetId).toBe(targetId)
    expect(overview.activeIncidentsCount).toBeGreaterThanOrEqual(1)
    expect(overview.watermarkVector?.runCompletedSeq).toBe(100)
    expect(overview.latestWindows.length).toBe(1)
  })

  it('rejects writeReliabilityEvaluation if fencing token is stale', async () => {
    await expect(
      writeReliabilityEvaluation(handle.db, {
        targetId,
        fencingToken: 999999, // wrong token
        scopeDigest: `target:${targetId}`,
        watermarkVector: { runCompletedSeq: 200, mapCommittedSeq: 0, validationSeq: 0 },
        rulesEvaluated: 1,
        breachesCount: 0,
        result: {},
        coverageGaps: [],
        featureWindows: [],
        sparseSignals: [],
        incidents: [],
      }),
    ).rejects.toThrow('评估租约已失效或被抢占')
  })

  it('reconciles hanging incidents from OBSERVING to ACTION_REQUIRED', async () => {
    const t = schemaFor(handle.db)
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000) // 20 days ago

    const [inserted] = await handle.db
      .insert(t.reliabilityIncidents)
      .values({
        targetId,
        groupingKey: `hanging-inc-${newId()}`,
        scopeDigest: `target:${targetId}`,
        severity: 'P3',
        status: 'OBSERVING',
        memberCount: 1,
        firstSeenAt: oldDate,
        lastSeenAt: oldDate,
        title: '观察超期事件',
        summary: '样本不足长期挂起',
        evidenceScores: { supportingScore: 10, counterScore: 0, supportingFactors: [], counterFactors: [] },
        revision: 1,
        createdAt: oldDate,
        updatedAt: oldDate,
      })
      .returning()

    const { reconciledCount } = await reconcileHangingIncidents(handle.db, {
      targetId,
      observationTimeoutDays: 14,
    })

    expect(reconciledCount).toBeGreaterThanOrEqual(1)

    const [updated] = await handle.db
      .select()
      .from(t.reliabilityIncidents)
      .where(schemaFor(handle.db).reliabilityIncidents.id.eq ? (t.reliabilityIncidents.id as any).eq(inserted.id) : undefined as any)

    // Query by id directly
    const rows = await handle.db.select().from(t.reliabilityIncidents)
    const reconciled = rows.find((r) => r.id === inserted.id)
    expect(reconciled?.status).toBe('ACTION_REQUIRED')
    expect(reconciled?.actionRequiredReason).toBe('insufficient_observation_samples')
  })

  it('requestReliabilityEvaluation resets lease for immediate claim', async () => {
    const res = await requestReliabilityEvaluation(handle.db, targetId)
    expect(res.requested).toBe(true)

    const claim = await claimReliabilityEvaluation(handle.db, {
      workerId: 'worker-immediate',
      targetId,
    })
    expect(claim).not.toBeNull()
  })
})
