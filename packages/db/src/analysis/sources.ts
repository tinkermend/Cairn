import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { sha256Hex } from '../runs/digest.js'
import type { AnalysisSourceScope } from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, insertIgnoreRows, insertRows, locked, schemaFor } from '../native.js'

export function analysisScopeDigest(input: {
  targetId: string
  mode: string
  source: AnalysisSourceScope
  strategyVersion: string
}): string {
  return sha256Hex({
    targetId: input.targetId,
    mode: input.mode,
    source: { ...input.source, scenarioIds: input.source.scenarioIds?.length ? [...input.source.scenarioIds].sort() : undefined, suiteIds: input.source.suiteIds?.length ? [...input.source.suiteIds].sort() : undefined },
    strategyVersion: input.strategyVersion,
  })
}

export async function indexRunForAnalysis(db: Db, input: { targetId: string; runId: string }): Promise<number> {
  return atomic(db, async tx => {
  const { analysisCommitSeq, analysisSourceIndex, runs, stepRuns, attempts, evidences } = schemaFor(tx)
  const [run] = await locked(tx, tx.select({ id: runs.id, targetId: runs.targetId, status: runs.status, scenarioId: runs.scenarioId, scenarioVersionId: runs.scenarioVersionId, eventSeq: runs.eventSeq, outcomeStatus: runs.outcomeStatus, evidenceStatus: runs.evidenceStatus, finishedAt: runs.finishedAt, deletedAt: runs.deletedAt }).from(runs).where(eq(runs.id, input.runId)))
  if (!run || run.targetId !== input.targetId || run.deletedAt || !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)) return 0
  const revision = Math.max(1, run.eventSeq)
  const [existing] = await tx.select().from(analysisSourceIndex).where(and(eq(analysisSourceIndex.sourceId, run.id), eq(analysisSourceIndex.sourceType, 'run'), eq(analysisSourceIndex.sourceRevision, revision))).limit(1)
  if (existing?.snapshot) return existing.committedSeq
  const stepRows = await tx.select({ stepRunId: stepRuns.id, name: stepRuns.name, status: stepRuns.status, outcomeStatus: stepRuns.outcomeStatus, attemptId: attempts.id, error: attempts.error, output: attempts.output }).from(stepRuns).leftJoin(attempts, eq(attempts.stepRunId, stepRuns.id)).where(eq(stepRuns.runId, run.id)).orderBy(stepRuns.ordinal, attempts.attemptNo).limit(101)
  const evidenceRows = await tx.select({ evidenceId: evidences.id, type: evidences.type, status: evidences.status }).from(evidences).where(eq(evidences.runId, run.id)).orderBy(evidences.id).limit(101)
  const snapshot = {
    runId: run.id, scenarioId: run.scenarioId, scenarioVersionId: run.scenarioVersionId,
    status: run.status, outcomeStatus: run.outcomeStatus, evidenceStatus: run.evidenceStatus,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    steps: stepRows.slice(0, 100).map(step => ({ ...step, error: boundedFact(step.error), output: boundedFact(step.output) })),
    evidences: evidenceRows.slice(0, 100),
    coverageGaps: [...(stepRows.length > 100 ? ['STEP_SAMPLE_LIMIT'] : []), ...(evidenceRows.length > 100 ? ['EVIDENCE_SAMPLE_LIMIT'] : [])],
  }
  if (existing) {
    await tx.update(analysisSourceIndex).set({ snapshot }).where(eq(analysisSourceIndex.id, existing.id))
    return existing.committedSeq
  }
  await insertIgnoreRows(tx, analysisCommitSeq, { targetId: input.targetId, seq: 0, updatedAt: new Date() })
  const [current] = await locked(
    tx,
    tx
      .select()
      .from(analysisCommitSeq)
      .where(eq(analysisCommitSeq.targetId, input.targetId)),
  )
  const next = (current?.seq ?? 0) + 1
  await tx
    .update(analysisCommitSeq)
    .set({ seq: next, updatedAt: new Date() })
    .where(eq(analysisCommitSeq.targetId, input.targetId))

  await insertIgnoreRows(tx, analysisSourceIndex, {
    id: newId(),
    targetId: input.targetId,
    sourceType: 'run',
    sourceId: input.runId,
    sourceRevision: revision,
    snapshot,
    committedSeq: next,
    runId: input.runId,
    createdAt: new Date(),
  })
  return next
  })
}

// Source snapshots include facts, never the credential-bearing RunSnapshot.
function boundedFact(value: unknown): string | null {
  if (value == null) return null
  return JSON.stringify(value, (key, item) => /password|secret|token|authorization|cookie/i.test(key) ? '[REDACTED]' : item).slice(0, 1200)
}

export async function backfillAnalysisSources(db: Db, targetId: string, limit = 100) {
  const { runs, analysisSourceIndex: sources } = schemaFor(db)
  const rows = await db.select({ id: runs.id }).from(runs)
    .where(and(eq(runs.targetId, targetId), isNull(runs.deletedAt), inArray(runs.status, ['SUCCEEDED', 'FAILED', 'CANCELLED']),
      sql`NOT EXISTS (SELECT 1 FROM ${sources} WHERE ${sources.runId} = ${runs.id} AND ${sources.sourceRevision} >= CASE WHEN ${runs.eventSeq} > 0 THEN ${runs.eventSeq} ELSE 1 END AND ${sources.snapshot} IS NOT NULL)`))
    .orderBy(runs.finishedAt, runs.id).limit(limit)
  for (const run of rows) await indexRunForAnalysis(db, { targetId, runId: run.id })
  return rows.length
}

export async function listAnalysisSourcesAfter(
  db: Db,
  input: { targetId: string; afterSeq: number; throughSeq?: number; limit: number; source: AnalysisSourceScope },
) {
  const { analysisSourceIndex, runs, suiteRuns } = schemaFor(db)
  const rows = await db
    .select({
      source: analysisSourceIndex,
      runStatus: runs.status,
      scenarioId: runs.scenarioId,
      finishedAt: runs.finishedAt,
    })
    .from(analysisSourceIndex)
    .leftJoin(runs, eq(runs.id, analysisSourceIndex.runId))
    .where(
      and(
        eq(analysisSourceIndex.targetId, input.targetId),
        sql`${analysisSourceIndex.committedSeq} > ${input.afterSeq}`,
        input.throughSeq === undefined ? undefined : sql`${analysisSourceIndex.committedSeq} <= ${input.throughSeq}`,
        isNull(runs.deletedAt),
        inArray(runs.status, ['SUCCEEDED', 'FAILED', 'CANCELLED']),
        input.source.scenarioIds?.length ? inArray(runs.scenarioId, input.source.scenarioIds) : undefined,
        input.source.suiteIds?.length ? sql`EXISTS (SELECT 1 FROM ${suiteRuns} WHERE ${suiteRuns.id} = ${runs.suiteRunId} AND ${inArray(suiteRuns.suiteId, input.source.suiteIds)})` : undefined,
        input.source.includeFailures ? undefined : eq(runs.status, 'SUCCEEDED'),
      ),
    )
    .orderBy(analysisSourceIndex.committedSeq)
    .limit(input.limit)
  return rows
}
