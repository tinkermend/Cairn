import { eq } from 'drizzle-orm'
import type { Db } from '../client.js'
import { locked, schemaFor } from '../native.js'

/** Cancellation and AUTH_WAIT completion serialize before taking the Run lock. */
export async function lockRunAccountScope(
  tx: Db,
  runId: string,
): Promise<void> {
  const { runs, targetAccounts } = schemaFor(tx)
  const [scope] = await tx
    .select({ accountId: runs.targetAccountId })
    .from(runs)
    .where(eq(runs.id, runId))
  if (scope?.accountId) {
    await locked(
      tx,
      tx
        .select({ id: targetAccounts.id })
        .from(targetAccounts)
        .where(eq(targetAccounts.id, scope.accountId)),
    )
  }
}
