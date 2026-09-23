import {
  claimReliabilityEvaluation,
  loadReliabilityIncrementalData,
  reconcileHangingIncidents,
  writeReliabilityEvaluation,
  type Database,
} from '@cairn/db'
import {
  DEFAULT_RELIABILITY_POLICY,
  type FeatureWindowDto,
  type ReliabilityPolicyDto,
  type ReliabilitySignalDto,
  type WatermarkVector,
} from '@cairn/shared'
import { computeGroupingFingerprint } from './grouping-fingerprint.js'
import {
  computeEvidenceScores,
  computeWindowMetrics,
  evaluateReliabilityRules,
  type StepResolutionSample,
} from './calculator.js'

export interface ConsumeReliabilityResult {
  processed: boolean
  targetId?: string
  sampleCount?: number
  breachesCount?: number
  incidentCount?: number
}

export async function processReliabilityIncrement(
  db: Database,
  input: {
    workerId: string
    targetId?: string
    policy?: ReliabilityPolicyDto
    batchLimit?: number
  },
): Promise<ConsumeReliabilityResult> {
  const policy = input.policy ?? DEFAULT_RELIABILITY_POLICY
  const batchLimit = input.batchLimit ?? 200

  // 1. Claim evaluation slot
  const claimed = await claimReliabilityEvaluation(db, {
    workerId: input.workerId,
    targetId: input.targetId,
    ttlMs: 60_000,
  })
  if (!claimed) {
    return { processed: false }
  }

  // 2. Fetch completed runs and step runs for this target after last watermark
  const afterSeq = claimed.watermarkVector.runCompletedSeq
  const { maxEventSeq, runRows, stepRows } = await loadReliabilityIncrementalData(db, {
    targetId: claimed.targetId,
    afterEventSeq: afterSeq,
    limit: batchLimit,
  })

  const samples: StepResolutionSample[] = []
  const sparseSignals: Array<Omit<ReliabilitySignalDto, 'id' | 'createdAt'>> = []

  if (runRows.length > 0) {
    // Group by stepRun to detect retries
    const attemptsByStep = new Map<string, typeof stepRows>()
    for (const row of stepRows) {
      const list = attemptsByStep.get(row.stepRunId) ?? []
      list.push(row)
      attemptsByStep.set(row.stepRunId, list)
    }

    const runMap = new Map(runRows.map((r) => [r.id, r]))

    for (const [stepRunId, rows] of attemptsByStep) {
      const firstRow = rows[0]!
      const parentRun = runMap.get(firstRow.runId)
      const hasRetry = rows.length > 1
      const lastAttempt = rows[rows.length - 1]!
      const isFallback = rows.some(
        (r) =>
          r.decisionKind === 'map_fallback' ||
          r.decisionKind === 'ai_fallback' ||
          (r.reasonCode && r.reasonCode.includes('fallback')),
      )
      const isSuccess = lastAttempt.attemptStatus === 'SUCCEEDED'
      const isPrimaryHit = !isFallback && isSuccess
      const durationMs =
        firstRow.finishedAt && firstRow.startedAt
          ? firstRow.finishedAt.getTime() - firstRow.startedAt.getTime()
          : 0
      const scopeDigest = `target:${claimed.targetId}`

      const errorFamily = lastAttempt.attemptError
        ? typeof lastAttempt.attemptError === 'object' &&
          lastAttempt.attemptError !== null &&
          'message' in lastAttempt.attemptError
          ? String((lastAttempt.attemptError as { message?: unknown }).message).slice(0, 32)
          : JSON.stringify(lastAttempt.attemptError).slice(0, 32)
        : undefined

      const sample: StepResolutionSample = {
        stepRunId,
        attemptId: lastAttempt.attemptId ?? stepRunId,
        targetId: claimed.targetId,
        scopeDigest,
        isPrimaryHit,
        isFallback,
        hasRetry,
        durationMs,
        success: isSuccess,
        errorFamily,
        subjectRef: {
          kind: 'scenario_step',
          id: stepRunId,
          stepId: stepRunId,
          scenarioId: parentRun?.scenarioId ?? undefined,
        },
      }
      samples.push(sample)

      // Emit sparse signal only on anomaly (fallback, failure, retry)
      if (isFallback || !isSuccess || hasRetry) {
        sparseSignals.push({
          targetId: claimed.targetId,
          kind: isFallback ? 'resolution_fallback' : !isSuccess ? 'resolution_drift' : 'resolution_slow',
          severity: !isSuccess ? 'ERROR' : isFallback ? 'WARN' : 'INFO',
          subjectRef: sample.subjectRef,
          sourceRef: {
            kind: 'attempt',
            id: lastAttempt.attemptId ?? stepRunId,
            runId: firstRow.runId,
            stepRunId,
          },
          occurredAt: (parentRun?.createdAt ?? new Date()).toISOString(),
          value: durationMs,
          unit: 'ms',
          scopeDigest,
          groupingKey: computeGroupingFingerprint({
            targetId: claimed.targetId,
            accountId: parentRun?.targetAccountId ?? undefined,
            errorFamily: sample.errorFamily,
          }),
          availability: 'available',
        })
      }
    }
  }

  // 3. Compute window metrics
  const metrics = computeWindowMetrics(samples, 0, 1.0, policy.ewmaAlpha)
  const breaches = evaluateReliabilityRules(metrics, policy)

  const now = new Date()
  const windowStart = new Date(now.getTime() - 3600 * 1000)
  const featureWindows: Array<Omit<FeatureWindowDto, 'id' | 'updatedAt'>> = [
    {
      targetId: claimed.targetId,
      scopeDigest: `target:${claimed.targetId}`,
      windowType: 'hourly',
      windowStart: windowStart.toISOString(),
      windowEnd: now.toISOString(),
      metricVersion: '1.0',
      sampleCount: metrics.sampleCount,
      primaryHitCount: metrics.primaryHitCount,
      fallbackCount: metrics.fallbackCount,
      retryStepCount: metrics.retryStepCount,
      ewmaLatencyMs: metrics.ewmaLatencyMs,
      ewmaSuccessRate: metrics.ewmaSuccessRate,
      stats: {
        primaryHitRate: metrics.primaryHitRate,
        fallbackRate: metrics.fallbackRate,
        p95LatencyMs: metrics.p95LatencyMs,
        medianLatencyMs: metrics.medianLatencyMs,
      },
    },
  ]

  // 4. Cluster incidents if breaches or severe sparse signals found
  const incidentMap = new Map<string, any>()
  if (breaches.length > 0 || sparseSignals.length > 0) {
    for (const sig of sparseSignals) {
      const gKey = sig.groupingKey ?? `target:${claimed.targetId}::general`
      const existing = incidentMap.get(gKey)
      const evidence = computeEvidenceScores({
        breachesCount: breaches.length,
        supportingSamplesCount: sparseSignals.length,
        counterSamplesCount: metrics.primaryHitCount,
      })

      if (!existing) {
        incidentMap.set(gKey, {
          groupingKey: gKey,
          scopeDigest: `target:${claimed.targetId}`,
          severity: breaches.some((b) => b.severity === 'P2') ? 'P2' : 'P3',
          status: 'DETECTED',
          title: `目标系统资产退化警告 (${sig.kind})`,
          summary: breaches.map((b) => b.message).join('； ') || '检测到异常 Fallback 与重试频发',
          evidenceScores: evidence,
          firstSeenAt: sig.occurredAt,
          lastSeenAt: sig.occurredAt,
          members: [{ memberRef: sig.sourceRef.id, memberType: sig.sourceRef.kind }],
        })
      } else {
        existing.members.push({ memberRef: sig.sourceRef.id, memberType: sig.sourceRef.kind })
        existing.lastSeenAt = sig.occurredAt
      }
    }
  }

  // 5. Atomic submit
  const nextWatermark: WatermarkVector = {
    runCompletedSeq: maxEventSeq,
    mapCommittedSeq: claimed.watermarkVector.mapCommittedSeq,
    validationSeq: claimed.watermarkVector.validationSeq,
  }

  await writeReliabilityEvaluation(db, {
    targetId: claimed.targetId,
    fencingToken: claimed.fencingToken,
    scopeDigest: `target:${claimed.targetId}`,
    watermarkVector: nextWatermark,
    rulesEvaluated: 3,
    breachesCount: breaches.length,
    result: { breaches, metrics },
    coverageGaps: [],
    featureWindows,
    sparseSignals,
    incidents: Array.from(incidentMap.values()),
  })

  // 6. Periodic sweep for dead/hanging states
  await reconcileHangingIncidents(db, {
    targetId: claimed.targetId,
    observationTimeoutDays: policy.observationWindowDays,
  })

  return {
    processed: true,
    targetId: claimed.targetId,
    sampleCount: samples.length,
    breachesCount: breaches.length,
    incidentCount: incidentMap.size,
  }
}
