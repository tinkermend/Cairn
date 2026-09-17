import { asc, eq, inArray } from 'drizzle-orm'
import {
  aggregateRunOutcomeStatus,
  aggregateStepRunOutcomeStatus,
  type JsonValue,
  type OutcomeOnViolation,
  type OutcomeProvenance,
  type OutcomeScope,
  type OutcomeSeverity,
  type OutcomeStatus,
  type OutcomeVerdict,
  type RunSnapshot,
} from '@cairn/shared'
import type { Db, DbHandle } from '../client.js'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import type { RunRow } from '../schema/execution.js'

export type OutcomeResultInsertItem = {
  contractId: string
  scope: OutcomeScope
  meaning: string
  severity: OutcomeSeverity
  onViolation: OutcomeOnViolation
  provenance: OutcomeProvenance
  verdict: OutcomeVerdict
  expected?: JsonValue | null
  actual?: JsonValue | null
  evidenceId?: string | null
  details?: Record<string, JsonValue> | null
  evaluatedAt: Date
}

/**
 * 在 Attempt 完成同事务内原子写入该 Attempt 的 Outcome 结果，并更新对应 stepRun 的 outcome_status。
 */
export async function saveStepOutcomeResultsTx(
  tx: Db,
  input: {
    runId: string
    stepRunId: string
    attemptId: string
    results?: OutcomeResultInsertItem[]
    snapshot: RunSnapshot
    now: Date
  },
): Promise<void> {
  const { outcomeResults, stepRuns } = schemaFor(tx)

  if (input.results && input.results.length > 0) {
    for (const item of input.results) {
      await tx.insert(outcomeResults).values({
        id: newId(),
        runId: input.runId,
        stepRunId: input.stepRunId,
        attemptId: input.attemptId,
        contractId: item.contractId,
        scope: item.scope,
        meaning: item.meaning,
        severity: item.severity,
        onViolation: item.onViolation,
        provenance: item.provenance,
        verdict: item.verdict,
        expected: item.expected ?? null,
        actual: item.actual ?? null,
        evidenceId: item.evidenceId ?? null,
        details: item.details ?? null,
        evaluatedAt: item.evaluatedAt,
        createdAt: input.now,
      })
    }
  }

  // 计算并更新 StepRun outcome_status
  const manifest = input.snapshot.outcomeManifest
  if (manifest && manifest.entries.length > 0) {
    const [stepRun] = await tx
      .select({ stepId: stepRuns.stepId })
      .from(stepRuns)
      .where(eq(stepRuns.id, input.stepRunId))
      .limit(1)

    if (stepRun) {
      const stepContracts = manifest.entries
        .filter((e) => e.stepId === stepRun.stepId)
        .map((e) => ({ id: e.contractId, severity: e.severity }))

      if (stepContracts.length > 0) {
        const rows = await tx
          .select({ contractId: outcomeResults.contractId, verdict: outcomeResults.verdict })
          .from(outcomeResults)
          .where(eq(outcomeResults.stepRunId, input.stepRunId))
          .orderBy(asc(outcomeResults.evaluatedAt))

        const stepOutcome = aggregateStepRunOutcomeStatus(stepContracts, rows)
        await tx
          .update(stepRuns)
          .set({ outcomeStatus: stepOutcome })
          .where(eq(stepRuns.id, input.stepRunId))
      }
    }
  }
}

/**
 * 重新聚合 Run 级结果轴并在事务内写入 runs.outcome_status。
 */
export async function recalculateRunOutcomeTx(
  tx: Db,
  runId: string,
  snapshot: RunSnapshot,
  now: Date,
): Promise<OutcomeStatus> {
  const { outcomeResults, runs } = schemaFor(tx)
  const manifest = snapshot.outcomeManifest

  if (!manifest || manifest.entries.length === 0) {
    await tx.update(runs).set({ outcomeStatus: 'NOT_EVALUATED', updatedAt: now }).where(eq(runs.id, runId))
    return 'NOT_EVALUATED'
  }

  const rows = await tx
    .select({ contractId: outcomeResults.contractId, verdict: outcomeResults.verdict })
    .from(outcomeResults)
    .where(eq(outcomeResults.runId, runId))
    .orderBy(asc(outcomeResults.evaluatedAt))

  const outcomeStatus = aggregateRunOutcomeStatus(manifest, rows)
  await tx.update(runs).set({ outcomeStatus, updatedAt: now }).where(eq(runs.id, runId))
  return outcomeStatus
}

/**
 * Settler 调用的独立入口：加载 Run 并在事务内完成聚合写入。
 */
export async function settleRunOutcome(
  db: DbHandle | Db,
  runId: string,
  runRow?: RunRow | null,
): Promise<OutcomeStatus> {
  const underlyingDb = 'db' in db ? db.db : db
  const { runs } = schemaFor(underlyingDb)

  let row = runRow
  if (!row) {
    const [found] = await underlyingDb.select().from(runs).where(eq(runs.id, runId)).limit(1)
    row = found
  }
  if (!row) return 'NOT_EVALUATED'

  const snapshot = row.snapshot as RunSnapshot
  return underlyingDb.transaction((tx) =>
    recalculateRunOutcomeTx(tx as unknown as Db, runId, snapshot, new Date()),
  )
}

/**
 * 后台定时补算任务：扫描终态但 outcome_status 缺失或需重算的 Run。
 */
export async function backfillOutcomeResults(db: Db): Promise<{ scanned: number; updated: number }> {
  const { runs, outcomeResults } = schemaFor(db)
  const candidateRows = await db
    .select()
    .from(runs)
    .where(inArray(runs.status, ['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW']))
    .limit(100)

  let scanned = 0
  let updated = 0
  const now = new Date()

  for (const row of candidateRows) {
    scanned++
    const snapshot = row.snapshot as RunSnapshot
    if (!snapshot.outcomeManifest || snapshot.outcomeManifest.entries.length === 0) {
      if (row.outcomeStatus !== 'NOT_EVALUATED') {
        await db.update(runs).set({ outcomeStatus: 'NOT_EVALUATED', updatedAt: now }).where(eq(runs.id, row.id))
        updated++
      }
      continue
    }

    const rows = await db
      .select({ contractId: outcomeResults.contractId, verdict: outcomeResults.verdict })
      .from(outcomeResults)
      .where(eq(outcomeResults.runId, row.id))

    const newStatus = aggregateRunOutcomeStatus(snapshot.outcomeManifest, rows)
    if (newStatus !== row.outcomeStatus) {
      await db.update(runs).set({ outcomeStatus: newStatus, updatedAt: now }).where(eq(runs.id, row.id))
      updated++
    }
  }

  return { scanned, updated }
}
