import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm'
import type { Db } from '../client.js'
import { atomic, clockNow, locked, schemaFor } from '../native.js'
import { appendRunEvents } from '../observe/events.js'
import { settleRunCancellationTx } from './recover.js'

/** Same cancellation path for queued, waiting and recovering work; unknown effects stay reviewable. */
export async function expireRunDeadlines(db: Db, runId?: string): Promise<number> {
  return atomic(db, async (tx) => {
    const { runs } = schemaFor(tx),
      now = await clockNow(tx)
    const rows = await locked(
      tx,
      tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            lte(runs.deadlineAt, now),
            isNull(runs.cancelRequestedAt),
            inArray(runs.status, ['QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_FOR_AUTH']),
            runId ? eq(runs.id, runId) : undefined,
          ),
        )
        .orderBy(asc(runs.id))
        .limit(runId ? 1 : 200),
    )
    for (const row of rows) {
      await tx
        .update(runs)
        .set({
          cancelRequestedAt: now,
          cancelReason: 'RUN_DEADLINE_EXCEEDED',
          updatedAt: now,
        })
        .where(eq(runs.id, row.id))
      await appendRunEvents(tx, row.id, [
        { type: 'run.cancel_requested', payload: { reason: 'RUN_DEADLINE_EXCEEDED' } },
      ])
      await settleRunCancellationTx(tx, row.id, now)
    }
    return rows.length
  })
}
