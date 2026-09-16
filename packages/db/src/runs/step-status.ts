import { schemaFor } from '../native.js'
import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../client.js'
import { stepRuns } from '../schema/execution.js'

export async function skipStepRunsTx(
  tx: Db,
  runId: string,
  stepIds: readonly string[],
  now: Date,
): Promise<{ id: string; stepId: string }[]> {
  if (stepIds.length === 0) return []
  const { stepRuns } = schemaFor(tx)
  const pending = await tx
    .select({ id: stepRuns.id, stepId: stepRuns.stepId })
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, 'PENDING'), inArray(stepRuns.stepId, [...stepIds])))
  if (pending.length > 0) {
    await tx
      .update(stepRuns)
      .set({ status: 'SKIPPED', finishedAt: now })
      .where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, 'PENDING'), inArray(stepRuns.stepId, [...stepIds])))
  }
  return pending
}

export async function skipRemainingStepRunsTx(
  tx: Db,
  runId: string,
  now: Date,
): Promise<{ id: string; stepId: string }[]> {
  const { stepRuns } = schemaFor(tx)
  const pending = await tx
    .select({ id: stepRuns.id, stepId: stepRuns.stepId })
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, 'PENDING')))
  if (pending.length > 0) {
    await tx
      .update(stepRuns)
      .set({ status: 'SKIPPED', finishedAt: now })
      .where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, 'PENDING')))
  }
  return pending
}

export async function cancelPendingStepRunsTx(tx: Db, runId: string, now: Date): Promise<void> {
  const { stepRuns } = schemaFor(tx)
  await tx
    .update(stepRuns)
    .set({ status: 'CANCELLED', finishedAt: now })
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, 'PENDING')))
}
