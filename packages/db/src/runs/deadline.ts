import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm'
import type { Db } from '../client.js'
import { atomic, clockNow, locked, schemaFor } from '../native.js'
import { appendRunEvents } from '../observe/events.js'
import type { ScanBatchResult } from '../runtime/scan-batch.js'
import { settleRunCancellationTx } from './recover.js'
import { lockRunAccountScope } from './lock-scope.js'

/** Same cancellation path for queued, waiting and recovering work; unknown effects stay reviewable. */
export async function expireRunDeadlines(
  db: Db,
  runId?: string,
): Promise<ScanBatchResult> {
  const { runs } = schemaFor(db)
  const due = (now: Date, id?: string) =>
    and(
      lte(runs.deadlineAt, now),
      isNull(runs.cancelRequestedAt),
      inArray(runs.status, [
        'QUEUED',
        'RUNNING',
        'RECOVERING',
        'WAITING_FOR_AUTH',
      ]),
      id ? eq(runs.id, id) : undefined,
    )
  // Candidate reads hold no Run locks. Settle separately so cancellation,
  // auth completion and lease expiry all take Account before Run.
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(due(await clockNow(db), runId))
    .orderBy(asc(runs.id))
    .limit(runId ? 1 : 200)
  let expired = 0
  for (const row of rows) {
    const settled = await atomic(db, async (tx) => {
      await lockRunAccountScope(tx, row.id)
      const now = await clockNow(tx)
      const [current] = await locked(
        tx,
        tx.select({ id: runs.id }).from(runs).where(due(now, row.id)),
      )
      if (!current) return false
      await tx
        .update(runs)
        .set({
          cancelRequestedAt: now,
          cancelReason: 'RUN_DEADLINE_EXCEEDED',
          updatedAt: now,
        })
        .where(eq(runs.id, row.id))
      await appendRunEvents(tx, row.id, [
        {
          type: 'run.cancel_requested',
          payload: { reason: 'RUN_DEADLINE_EXCEEDED' },
        },
      ])
      await settleRunCancellationTx(tx, row.id, now)
      return true
    })
    if (settled) expired += 1
  }
  return { settled: expired, scanned: rows.length }
}
