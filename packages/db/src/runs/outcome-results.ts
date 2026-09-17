import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  aggregateRunOutcomeStatus,
  aggregateStepRunOutcomeStatus,
  deriveRuntimeInvariantResults,
  effectTypeSchema,
  isHaltedRunStatus,
  type EffectType,
  type JsonValue,
  type OutcomeOnViolation,
  type OutcomeProvenance,
  type OutcomeScope,
  type OutcomeSeverity,
  type OutcomeStatus,
  type OutcomeVerdict,
  type RuntimeInvariantAuthFact,
  type RuntimeInvariantErrorSurfaceFact,
  type RuntimeInvariantWindow,
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

function attemptErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function errorSurfaceFromOutput(output: unknown): { probed: boolean; matches: { role: string; text: string }[] } | null {
  if (!output || typeof output !== 'object' || !('errorSurface' in output)) return null
  const raw = (output as { errorSurface?: unknown }).errorSurface
  if (!raw || typeof raw !== 'object') return null
  const probed = (raw as { probed?: unknown }).probed === true
  const matches = Array.isArray((raw as { matches?: unknown }).matches)
    ? ((raw as { matches: { role?: unknown; text?: unknown }[] }).matches)
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          role: typeof item.role === 'string' ? item.role : 'alert',
          text: typeof item.text === 'string' ? item.text : '',
        }))
    : []
  return { probed, matches }
}

function authFactFromCheckpoint(raw: unknown): RuntimeInvariantAuthFact {
  if (!raw || typeof raw !== 'object') return null
  const checkpoint = raw as {
    status?: unknown
    autoRecoveriesUsed?: unknown
    manualRecoveriesUsed?: unknown
    nextStepId?: unknown
    unrecoverableCode?: unknown
  }
  if (typeof checkpoint.status !== 'string') return null
  return {
    status: checkpoint.status,
    autoRecoveriesUsed: typeof checkpoint.autoRecoveriesUsed === 'number' ? checkpoint.autoRecoveriesUsed : 0,
    manualRecoveriesUsed: typeof checkpoint.manualRecoveriesUsed === 'number' ? checkpoint.manualRecoveriesUsed : 0,
    nextStepId: typeof checkpoint.nextStepId === 'string' ? checkpoint.nextStepId : null,
    unrecoverableCode: typeof checkpoint.unrecoverableCode === 'string' ? checkpoint.unrecoverableCode : null,
  }
}

async function syncRuntimeInvariantResultsTx(
  tx: Db,
  input: {
    runId: string
    snapshot: RunSnapshot
    now: Date
    runFinished: boolean
    runStatus?: string | null
    authCheckpoint: RuntimeInvariantAuthFact
  },
): Promise<void> {
  const invariants = input.snapshot.runtimeInvariantManifest?.entries ?? []
  if (invariants.length === 0) return

  const { outcomeResults, stepRuns, attempts } = schemaFor(tx)
  const stepRows = await tx
    .select({
      stepRunId: stepRuns.id,
      stepId: stepRuns.stepId,
      attemptId: attempts.id,
      attemptStatus: attempts.status,
      error: attempts.error,
      output: attempts.output,
    })
    .from(stepRuns)
    .innerJoin(attempts, eq(attempts.stepRunId, stepRuns.id))
    .where(eq(stepRuns.runId, input.runId))
    .orderBy(asc(attempts.startedAt))

  const ceilingByStep = new Map<string, { moduleId: string; ceiling: EffectType }>()
  for (const entry of input.snapshot.moduleManifest?.entries ?? []) {
    for (const stepId of entry.expandedStepIds) {
      ceilingByStep.set(stepId, { moduleId: entry.moduleId, ceiling: entry.effectCeiling })
    }
  }
  const stepById = new Map(input.snapshot.steps.map((step) => [step.id, step]))

  const windows: RuntimeInvariantWindow[] = []
  const errorSurfaces: RuntimeInvariantErrorSurfaceFact[] = []
  for (const row of stepRows) {
    const step = stepById.get(row.stepId)
    const effect = effectTypeSchema.safeParse(step?.effectType)
    windows.push({
      stepId: row.stepId,
      stepRunId: row.stepRunId,
      attemptId: row.attemptId,
      stepType: step?.type ?? 'echo',
      effectType: effect.success ? effect.data : 'READ_ONLY',
      status: row.attemptStatus,
      errorCode: attemptErrorCode(row.error),
      moduleId: ceilingByStep.get(row.stepId)?.moduleId ?? null,
      moduleEffectCeiling: ceilingByStep.get(row.stepId)?.ceiling ?? null,
    })
    const surface = errorSurfaceFromOutput(row.output)
    if (surface) {
      errorSurfaces.push({
        attemptId: row.attemptId,
        stepRunId: row.stepRunId,
        stepId: row.stepId,
        probed: surface.probed,
        matches: surface.matches,
      })
    }
  }

  const derived = deriveRuntimeInvariantResults({
    invariants,
    windows,
    authCheckpoint: input.authCheckpoint,
    errorSurfaces,
    runFinished: input.runFinished,
    runStatus: input.runStatus,
  })

  for (const item of derived) {
    const [existing] = await tx
      .select({ id: outcomeResults.id })
      .from(outcomeResults)
      .where(
        and(eq(outcomeResults.attemptId, item.attemptId), eq(outcomeResults.contractId, item.contractId)),
      )
      .limit(1)
    if (existing) continue
    await tx.insert(outcomeResults).values({
      id: newId(),
      runId: input.runId,
      stepRunId: item.stepRunId,
      attemptId: item.attemptId,
      contractId: item.contractId,
      scope: item.scope,
      meaning: item.meaning,
      severity: item.severity,
      onViolation: item.onViolation,
      provenance: item.provenance,
      verdict: item.verdict,
      expected: item.expected,
      actual: item.actual,
      details: item.details,
      evaluatedAt: input.now,
      createdAt: input.now,
    })
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
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1)
  await syncRuntimeInvariantResultsTx(tx, {
    runId,
    snapshot,
    now,
    runFinished: run ? isHaltedRunStatus(run.status) : false,
    runStatus: run?.status,
    authCheckpoint: authFactFromCheckpoint(run?.authCheckpoint),
  })

  const hasOutcome = Boolean(snapshot.outcomeManifest?.entries.length)
  const hasInvariant = Boolean(snapshot.runtimeInvariantManifest?.entries.length)
  if (!hasOutcome && !hasInvariant) {
    await tx.update(runs).set({ outcomeStatus: 'NOT_EVALUATED', updatedAt: now }).where(eq(runs.id, runId))
    return 'NOT_EVALUATED'
  }

  const rows = await tx
    .select({ contractId: outcomeResults.contractId, verdict: outcomeResults.verdict })
    .from(outcomeResults)
    .where(eq(outcomeResults.runId, runId))
    .orderBy(asc(outcomeResults.evaluatedAt))

  const outcomeStatus = aggregateRunOutcomeStatus(
    snapshot.outcomeManifest,
    rows,
    snapshot.runtimeInvariantManifest,
  )
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
    if (
      !snapshot.outcomeManifest?.entries.length &&
      !snapshot.runtimeInvariantManifest?.entries.length
    ) {
      if (row.outcomeStatus !== 'NOT_EVALUATED') {
        await db.update(runs).set({ outcomeStatus: 'NOT_EVALUATED', updatedAt: now }).where(eq(runs.id, row.id))
        updated++
      }
      continue
    }

    const newStatus = await db.transaction((tx) =>
      recalculateRunOutcomeTx(tx as unknown as Db, row.id, snapshot, now),
    )
    if (newStatus !== row.outcomeStatus) updated++
  }

  return { scanned, updated }
}
