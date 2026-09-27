import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import {
  RELIABILITY_ERROR_CODES,
  type EvidenceScores,
  type FeatureWindowDto,
  type IncidentSeverity,
  type IncidentStatus,
  type ReliabilityEvaluationDto,
  type ReliabilityIncidentDto,
  type ReliabilitySignalDto,
  type WatermarkVector,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { assertTargetPermission, lockConsoleAuthorization } from '../console/target-authorization.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor, updateRows } from '../native.js'
import { conflict, notFound } from '../runs/errors.js'

export interface ClaimReliabilityEvaluationInput {
  workerId: string
  ttlMs?: number
  targetId?: string
}

export interface ClaimedEvaluation {
  targetId: string
  watermarkVector: WatermarkVector
  fencingToken: number
  leaseOwner: string
  leaseExpiresAt: Date
}

export async function claimReliabilityEvaluation(
  db: Db,
  input: ClaimReliabilityEvaluationInput,
): Promise<ClaimedEvaluation | null> {
  const ttlMs = input.ttlMs ?? 60_000
  return atomic(db, async (tx) => {
    const { reliabilityCheckpoints, targets } = schemaFor(tx)
    const now = await clockNow(tx)
    const leaseExpiresAt = new Date(now.getTime() + ttlMs)

    // Ensure active targets have checkpoint rows
    const targetRows = await tx
      .select({ id: targets.id, status: targets.status })
      .from(targets)
      .where(input.targetId ? eq(targets.id, input.targetId) : eq(targets.status, 'active'))

    for (const t of targetRows) {
      const [existing] = await tx
        .select({ targetId: reliabilityCheckpoints.targetId })
        .from(reliabilityCheckpoints)
        .where(eq(reliabilityCheckpoints.targetId, t.id))
      if (!existing) {
        await tx.insert(reliabilityCheckpoints).values({
          targetId: t.id,
          watermarkVector: { runCompletedSeq: 0, mapCommittedSeq: 0, validationSeq: 0 },
          fencingToken: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
      }
    }

    // Find claimable checkpoint
    const whereCond = and(
      input.targetId ? eq(reliabilityCheckpoints.targetId, input.targetId) : sql`1=1`,
      or(
        isNull(reliabilityCheckpoints.leaseExpiresAt),
        lte(reliabilityCheckpoints.leaseExpiresAt, now),
      ),
    )

    const candidates = await tx
      .select()
      .from(reliabilityCheckpoints)
      .where(whereCond)
      .orderBy(reliabilityCheckpoints.updatedAt)
      .limit(1)

    if (!candidates.length) return null

    const candidate = candidates[0]!
    const [lockedRow] = await locked(
      tx,
      tx.select().from(reliabilityCheckpoints).where(eq(reliabilityCheckpoints.targetId, candidate.targetId)),
    )
    if (!lockedRow) return null
    if (lockedRow.leaseExpiresAt && lockedRow.leaseExpiresAt.getTime() > now.getTime()) {
      return null
    }

    const nextFencingToken = Number(lockedRow.fencingToken) + 1
    await tx
      .update(reliabilityCheckpoints)
      .set({
        fencingToken: nextFencingToken,
        leaseOwner: input.workerId,
        leaseExpiresAt,
        updatedAt: now,
      })
      .where(eq(reliabilityCheckpoints.targetId, candidate.targetId))

    return {
      targetId: candidate.targetId,
      watermarkVector: (lockedRow.watermarkVector as WatermarkVector) ?? {
        runCompletedSeq: 0,
        mapCommittedSeq: 0,
        validationSeq: 0,
      },
      fencingToken: nextFencingToken,
      leaseOwner: input.workerId,
      leaseExpiresAt,
    }
  })
}

export interface WriteReliabilityEvaluationInput {
  targetId: string
  fencingToken: number
  scopeDigest: string
  watermarkVector: WatermarkVector
  rulesEvaluated: number
  breachesCount: number
  result: Record<string, unknown>
  coverageGaps?: string[]
  featureWindows?: Array<Omit<FeatureWindowDto, 'id' | 'updatedAt'> & { id?: string }>
  sparseSignals?: Array<Omit<ReliabilitySignalDto, 'id' | 'createdAt'> & { id?: string }>
  incidents?: Array<{
    id?: string
    groupingKey: string
    scopeDigest: string
    severity: IncidentSeverity
    status: IncidentStatus
    actionRequiredReason?: string
    title: string
    summary: string
    rootCauseHypothesis?: string
    evidenceScores: EvidenceScores
    firstSeenAt: string
    lastSeenAt: string
    members?: Array<{ memberRef: string; memberType: string }>
  }>
}

export async function writeReliabilityEvaluation(
  db: Db,
  input: WriteReliabilityEvaluationInput,
): Promise<ReliabilityEvaluationDto> {
  return atomic(db, async (tx) => {
    const {
      reliabilityCheckpoints,
      reliabilityEvaluations,
      featureWindows,
      reliabilitySignals,
      reliabilityIncidents,
      reliabilityIncidentMembers,
    } = schemaFor(tx)
    const now = await clockNow(tx)

    // 1. Verify fencing token
    const [checkpoint] = await tx
      .select()
      .from(reliabilityCheckpoints)
      .where(eq(reliabilityCheckpoints.targetId, input.targetId))
    if (!checkpoint || Number(checkpoint.fencingToken) !== input.fencingToken) {
      throw conflict(RELIABILITY_ERROR_CODES.EVALUATION_LEASE_EXPIRED, '评估租约已失效或被抢占')
    }

    // 2. Fetch generation
    const [lastEval] = await tx
      .select({ generation: reliabilityEvaluations.generation })
      .from(reliabilityEvaluations)
      .where(eq(reliabilityEvaluations.targetId, input.targetId))
      .orderBy(desc(reliabilityEvaluations.generation))
      .limit(1)
    const generation = (lastEval?.generation ?? 0) + 1

    // 3. Insert evaluation record
    const evalId = newId()
    await tx.insert(reliabilityEvaluations).values({
      id: evalId,
      targetId: input.targetId,
      scopeDigest: input.scopeDigest,
      watermarkVector: input.watermarkVector,
      generation,
      rulesEvaluated: input.rulesEvaluated,
      breachesCount: input.breachesCount,
      result: input.result,
      coverageGaps: input.coverageGaps ?? [],
      createdAt: now,
    })

    // 4. Update or Insert FeatureWindows (Bucketing)
    if (input.featureWindows && input.featureWindows.length > 0) {
      for (const w of input.featureWindows) {
        const start = new Date(w.windowStart)
        const end = new Date(w.windowEnd)
        const [existing] = await tx
          .select({ id: featureWindows.id })
          .from(featureWindows)
          .where(
            and(
              eq(featureWindows.targetId, input.targetId),
              eq(featureWindows.scopeDigest, w.scopeDigest),
              eq(featureWindows.windowType, w.windowType),
              eq(featureWindows.windowStart, start),
            ),
          )
        if (existing) {
          await tx
            .update(featureWindows)
            .set({
              sampleCount: w.sampleCount,
              primaryHitCount: w.primaryHitCount,
              fallbackCount: w.fallbackCount,
              retryStepCount: w.retryStepCount,
              ewmaLatencyMs: w.ewmaLatencyMs,
              ewmaSuccessRate: w.ewmaSuccessRate,
              stats: w.stats,
              updatedAt: now,
            })
            .where(eq(featureWindows.id, existing.id))
        } else {
          await tx.insert(featureWindows).values({
            id: w.id ?? newId(),
            targetId: input.targetId,
            scopeDigest: w.scopeDigest,
            windowType: w.windowType,
            windowStart: start,
            windowEnd: end,
            metricVersion: w.metricVersion ?? '1.0',
            sampleCount: w.sampleCount,
            primaryHitCount: w.primaryHitCount,
            fallbackCount: w.fallbackCount,
            retryStepCount: w.retryStepCount,
            ewmaLatencyMs: w.ewmaLatencyMs,
            ewmaSuccessRate: w.ewmaSuccessRate,
            stats: w.stats,
            createdAt: now,
            updatedAt: now,
          })
        }
      }
    }

    // 5. Insert sparse signals (Sparse Ledger)
    if (input.sparseSignals && input.sparseSignals.length > 0) {
      for (const s of input.sparseSignals) {
        await tx.insert(reliabilitySignals).values({
          id: s.id ?? newId(),
          targetId: input.targetId,
          kind: s.kind,
          severity: s.severity ?? 'WARN',
          subjectRef: s.subjectRef,
          sourceRef: s.sourceRef,
          occurredAt: new Date(s.occurredAt),
          commitPosition: s.commitPosition,
          value: s.value,
          unit: s.unit,
          scopeDigest: s.scopeDigest,
          groupingKey: s.groupingKey,
          availability: s.availability ?? 'available',
          metadata: s.metadata,
          createdAt: now,
        })
      }
    }

    // 6. Update or create incidents
    if (input.incidents && input.incidents.length > 0) {
      for (const inc of input.incidents) {
        const [existing] = await tx
          .select()
          .from(reliabilityIncidents)
          .where(
            and(
              eq(reliabilityIncidents.targetId, input.targetId),
              eq(reliabilityIncidents.groupingKey, inc.groupingKey),
              inArray(reliabilityIncidents.status, ['DETECTED', 'DIAGNOSING', 'ACTION_REQUIRED', 'VERIFYING', 'OBSERVING']),
            ),
          )
          .limit(1)

        let incidentId: string
        if (existing) {
          incidentId = existing.id
          await tx
            .update(reliabilityIncidents)
            .set({
              severity: inc.severity,
              memberCount: existing.memberCount + (inc.members?.length ?? 1),
              lastSeenAt: new Date(inc.lastSeenAt),
              title: inc.title,
              summary: inc.summary,
              rootCauseHypothesis: inc.rootCauseHypothesis ?? existing.rootCauseHypothesis,
              evidenceScores: inc.evidenceScores,
              revision: existing.revision + 1,
              updatedAt: now,
            })
            .where(eq(reliabilityIncidents.id, existing.id))
        } else {
          incidentId = inc.id ?? newId()
          await tx.insert(reliabilityIncidents).values({
            id: incidentId,
            targetId: input.targetId,
            groupingKey: inc.groupingKey,
            scopeDigest: inc.scopeDigest,
            severity: inc.severity,
            status: inc.status,
            actionRequiredReason: inc.actionRequiredReason,
            memberCount: inc.members?.length ?? 1,
            firstSeenAt: new Date(inc.firstSeenAt),
            lastSeenAt: new Date(inc.lastSeenAt),
            title: inc.title,
            summary: inc.summary,
            rootCauseHypothesis: inc.rootCauseHypothesis,
            evidenceScores: inc.evidenceScores,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          })
        }

        // Add member relations
        if (inc.members && inc.members.length > 0) {
          for (const m of inc.members) {
            const [memberExists] = await tx
              .select({ id: reliabilityIncidentMembers.id })
              .from(reliabilityIncidentMembers)
              .where(
                and(
                  eq(reliabilityIncidentMembers.incidentId, incidentId),
                  eq(reliabilityIncidentMembers.memberRef, m.memberRef),
                ),
              )
            if (!memberExists) {
              await tx.insert(reliabilityIncidentMembers).values({
                id: newId(),
                incidentId,
                memberRef: m.memberRef,
                memberType: m.memberType,
                joinedAt: now,
              })
            }
          }
        }
      }
    }

    // 7. Update checkpoint watermark and release lease
    await tx
      .update(reliabilityCheckpoints)
      .set({
        watermarkVector: input.watermarkVector,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(reliabilityCheckpoints.targetId, input.targetId))

    return {
      id: evalId,
      targetId: input.targetId,
      scopeDigest: input.scopeDigest,
      watermarkVector: input.watermarkVector,
      generation,
      rulesEvaluated: input.rulesEvaluated,
      breachesCount: input.breachesCount,
      result: input.result,
      coverageGaps: input.coverageGaps ?? [],
      createdAt: now.toISOString(),
    }
  })
}

export async function reconcileHangingIncidents(
  db: Db,
  input: { targetId?: string; observationTimeoutDays?: number },
): Promise<{ reconciledCount: number }> {
  const timeoutDays = input.observationTimeoutDays ?? 14
  return atomic(db, async (tx) => {
    const { reliabilityIncidents } = schemaFor(tx)
    const now = await clockNow(tx)
    const cutoff = new Date(now.getTime() - timeoutDays * 24 * 60 * 60 * 1000)

    // 1. OBSERVING incidents that exceeded observation timeout
    const whereObserving = and(
      input.targetId ? eq(reliabilityIncidents.targetId, input.targetId) : sql`1=1`,
      eq(reliabilityIncidents.status, 'OBSERVING'),
      lte(reliabilityIncidents.updatedAt, cutoff),
    )

    const hangingObserving = await tx
      .select({ id: reliabilityIncidents.id, revision: reliabilityIncidents.revision })
      .from(reliabilityIncidents)
      .where(whereObserving)

    for (const row of hangingObserving) {
      await tx
        .update(reliabilityIncidents)
        .set({
          status: 'ACTION_REQUIRED',
          actionRequiredReason: 'insufficient_observation_samples',
          revision: row.revision + 1,
          updatedAt: now,
        })
        .where(eq(reliabilityIncidents.id, row.id))
    }

    return { reconciledCount: hangingObserving.length }
  })
}

export async function requestReliabilityEvaluation(
  db: Db,
  targetId: string,
  actorId?: string,
): Promise<{ targetId: string; requested: boolean }> {
  return atomic(db, async (tx) => {
    if (actorId) await lockConsoleAuthorization(tx, actorId)
    if (actorId) await assertTargetPermission(tx, actorId, targetId, 'reliability:configure')
    const { reliabilityCheckpoints } = schemaFor(tx)
    const now = await clockNow(tx)
    const [existing] = await tx
      .select({ targetId: reliabilityCheckpoints.targetId })
      .from(reliabilityCheckpoints)
      .where(eq(reliabilityCheckpoints.targetId, targetId))

    if (!existing) {
      await tx.insert(reliabilityCheckpoints).values({
        targetId,
        watermarkVector: { runCompletedSeq: 0, mapCommittedSeq: 0, validationSeq: 0 },
        fencingToken: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
    } else {
      await tx
        .update(reliabilityCheckpoints)
        .set({
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(reliabilityCheckpoints.targetId, targetId))
    }
    return { targetId, requested: true }
  })
}

export interface LoadReliabilityIncrementalDataInput {
  targetId: string
  afterEventSeq: number
  limit?: number
}

export interface ReliabilityIncrementalRunItem {
  id: string
  eventSeq: number
  targetAccountId: string | null
  scenarioId: string
  scenarioVersionId: string
  status: string
  outcomeStatus: string | null
  createdAt: Date
}

export interface ReliabilityIncrementalStepItem {
  stepRunId: string
  runId: string
  name: string | null
  status: string
  outcomeStatus: string | null
  startedAt: Date | null
  finishedAt: Date | null
  attemptId: string | null
  attemptNo: number | null
  attemptStatus: string | null
  attemptError: unknown | null
  decisionKind: string | null
  reasonCode: string | null
}

export interface ReliabilityIncrementalData {
  maxEventSeq: number
  runRows: ReliabilityIncrementalRunItem[]
  stepRows: ReliabilityIncrementalStepItem[]
}

export async function loadReliabilityIncrementalData(
  db: Db,
  input: LoadReliabilityIncrementalDataInput,
): Promise<ReliabilityIncrementalData> {
  const { runs, stepRuns, attempts, resolutionDecisions } = schemaFor(db)
  const limit = input.limit ?? 200

  const runRows = await db
    .select({
      id: runs.id,
      eventSeq: runs.eventSeq,
      targetAccountId: runs.targetAccountId,
      scenarioId: runs.scenarioId,
      scenarioVersionId: runs.scenarioVersionId,
      status: runs.status,
      outcomeStatus: runs.outcomeStatus,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .where(
      and(
        eq(runs.targetId, input.targetId),
        inArray(runs.status, ['SUCCEEDED', 'FAILED', 'CANCELLED']),
        sql`${runs.eventSeq} > ${input.afterEventSeq}`,
      ),
    )
    .orderBy(runs.eventSeq)
    .limit(limit)

  let maxEventSeq = input.afterEventSeq
  const runIds = runRows.map((r) => {
    if (r.eventSeq > maxEventSeq) maxEventSeq = r.eventSeq
    return r.id
  })

  let stepRows: ReliabilityIncrementalStepItem[] = []
  if (runIds.length > 0) {
    stepRows = await db
      .select({
        stepRunId: stepRuns.id,
        runId: stepRuns.runId,
        name: stepRuns.name,
        status: stepRuns.status,
        outcomeStatus: stepRuns.outcomeStatus,
        startedAt: stepRuns.startedAt,
        finishedAt: stepRuns.finishedAt,
        attemptId: attempts.id,
        attemptNo: attempts.attemptNo,
        attemptStatus: attempts.status,
        attemptError: attempts.error,
        decisionKind: resolutionDecisions.decisionKind,
        reasonCode: resolutionDecisions.reasonCode,
      })
      .from(stepRuns)
      .leftJoin(attempts, eq(attempts.stepRunId, stepRuns.id))
      .leftJoin(resolutionDecisions, eq(resolutionDecisions.attemptId, attempts.id))
      .where(inArray(stepRuns.runId, runIds))
  }

  return {
    maxEventSeq,
    runRows,
    stepRows,
  }
}
