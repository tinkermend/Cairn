import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import type { ConsoleIdentity, Target, TargetAccount } from '../records.js'

export async function findLocalIdentity(db: Db, login: string): Promise<ConsoleIdentity | null> {
  const { consoleIdentities } = schemaFor(db)
  const [row] = await db
    .select()
    .from(consoleIdentities)
    .where(
      and(
        eq(consoleIdentities.provider, 'local'),
        sql`lower(${consoleIdentities.subject}) = ${login.trim().toLowerCase()}`,
      ),
    )
    .limit(1)
  return row ?? null
}
export async function touchLocalIdentity(db: Db, id: string): Promise<void> {
  const { consoleIdentities } = schemaFor(db)
  await db
    .update(consoleIdentities)
    .set({ lastUsedAt: new Date() })
    .where(eq(consoleIdentities.id, id))
}
export async function loadTargetForExecution(db: Db, id: string): Promise<Target | null> {
  const { targets } = schemaFor(db)
  const [row] = await db
    .select()
    .from(targets)
    .where(and(eq(targets.id, id), isNull(targets.deletedAt)))
    .limit(1)
  return row ?? null
}
export async function loadAccountForExecution(db: Db, id: string): Promise<TargetAccount | null> {
  const { targetAccounts } = schemaFor(db)
  const [row] = await db
    .select()
    .from(targetAccounts)
    .where(and(eq(targetAccounts.id, id), isNull(targetAccounts.deletedAt)))
    .limit(1)
  return row ?? null
}
