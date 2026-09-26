import type { StepSkipReason } from '@cairn/shared'
import { schemaFor } from '../native.js'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../client.js'
import { stepRuns } from '../schema/execution.js'

export async function skipStepRunsTx(
  tx: Db,
  runId: string,
  stepIds: readonly string[],
  now: Date,
  reason: StepSkipReason,
  scopePath?: string,
): Promise<{ id: string; stepId: string; scopePath: string; skipReason: StepSkipReason }[]> {
  if (stepIds.length === 0) return []
  const { stepRuns } = schemaFor(tx)
  const conditions = [
    eq(stepRuns.runId, runId),
    eq(stepRuns.status, 'PENDING'),
    inArray(stepRuns.stepId, [...stepIds]),
    ...(scopePath !== undefined ? [eq(stepRuns.scopePath, scopePath)] : []),
  ]
  const pending = await tx
    .select({ id: stepRuns.id, stepId: stepRuns.stepId, scopePath: stepRuns.scopePath })
    .from(stepRuns)
    .where(and(...conditions))
  if (pending.length > 0) {
    await tx
      .update(stepRuns)
      .set({ status: 'SKIPPED', skipReason: reason, finishedAt: now })
      .where(and(...conditions))
  }
  return pending.map((item) => ({ ...item, skipReason: reason }))
}

export async function skipRemainingStepRunsTx(
  tx: Db,
  runId: string,
  now: Date,
  reason: StepSkipReason = 'run_halted',
): Promise<{ id: string; stepId: string; scopePath: string; skipReason: StepSkipReason }[]> {
  const { stepRuns, stepIterations } = schemaFor(tx)
  const pending = await tx
    .select({ id: stepRuns.id, stepId: stepRuns.stepId, scopePath: stepRuns.scopePath })
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, 'PENDING')))
  if (pending.length > 0) {
    await tx
      .update(stepRuns)
      .set({ status: 'SKIPPED', skipReason: reason, finishedAt: now })
      .where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, 'PENDING')))
  }
  await tx
    .update(stepIterations)
    .set({ status: 'SKIPPED', finishedAt: now, updatedAt: now })
    .where(and(eq(stepIterations.runId, runId), inArray(stepIterations.status, ['PENDING', 'RUNNING'])))
  await settleIdleRunningStepRunsTx(tx, runId, 'FAILED', now)
  return pending.map((item) => ({ ...item, skipReason: reason }))
}

/** 运行期批量跳过要带上原因，SSE 观察方才能不必等下一次全量读取。 */
export function skippedStepRunEvents(
  skipped: readonly { id: string; skipReason: StepSkipReason; scopePath?: string }[],
): { type: 'step_run.finished'; stepRunId: string; scopePath?: string; payload: { status: 'SKIPPED'; skipReason: StepSkipReason } }[] {
  return skipped.map((item) => ({
    type: 'step_run.finished' as const,
    stepRunId: item.id,
    ...(item.scopePath ? { scopePath: item.scopePath } : {}),
    payload: { status: 'SKIPPED' as const, skipReason: item.skipReason },
  }))
}

export async function cancelPendingStepRunsTx(tx: Db, runId: string, now: Date): Promise<void> {
  const { stepRuns, stepIterations } = schemaFor(tx)
  await tx
    .update(stepRuns)
    .set({ status: 'CANCELLED', finishedAt: now })
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, 'PENDING')))
  await tx
    .update(stepIterations)
    .set({ status: 'CANCELLED', finishedAt: now, updatedAt: now })
    .where(and(eq(stepIterations.runId, runId), inArray(stepIterations.status, ['PENDING', 'RUNNING'])))
  await settleIdleRunningStepRunsTx(tx, runId, 'CANCELLED', now)
}

/**
 * Run 停下时，仍停在 RUNNING 却没有在途尝试的记录（典型是正在逐项的循环头）不会再被推进，
 * 按停下的方式收尾，免得终态 Run 里还挂着「运行中」的步骤。
 */
async function settleIdleRunningStepRunsTx(
  tx: Db,
  runId: string,
  status: 'FAILED' | 'CANCELLED',
  now: Date,
): Promise<void> {
  const { stepRuns, attempts } = schemaFor(tx)
  await tx
    .update(stepRuns)
    .set({ status, finishedAt: now })
    .where(
      and(
        eq(stepRuns.runId, runId),
        eq(stepRuns.status, 'RUNNING'),
        sql`NOT EXISTS (SELECT 1 FROM ${attempts} WHERE ${attempts.stepRunId} = ${stepRuns.id} AND ${attempts.status} = 'RUNNING')`,
      ),
    )
}
