import { and, eq } from 'drizzle-orm'
import type { Db } from '../client.js'
import { stepRuns } from '../schema/execution.js'

export async function skipRemainingStepRunsTx(tx: Db, runId: string, now: Date): Promise<void> {
  await tx
    .update(stepRuns)
    .set({ status: 'SKIPPED', finishedAt: now })
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, 'PENDING')))
}

export async function cancelPendingStepRunsTx(tx: Db, runId: string, now: Date): Promise<void> {
  await tx
    .update(stepRuns)
    .set({ status: 'CANCELLED', finishedAt: now })
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, 'PENDING')))
}
