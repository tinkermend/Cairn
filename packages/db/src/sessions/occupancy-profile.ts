import { and, eq } from 'drizzle-orm'
import type { SessionProfileCleanup, SessionProfileState } from '@cairn/shared'
import type { Db } from '../client.js'
import { atomic, clockNow } from '../native.js'
import type { SessionProfileRow } from '../records.js'
import { schemaFor } from '../native.js'
import type { SessionKey } from './sessions.js'

export async function getSessionProfile(db: Db, key: SessionKey): Promise<SessionProfileRow | null> {
  const { sessionProfiles } = schemaFor(db)
  const [row] = await db
    .select()
    .from(sessionProfiles)
    .where(
      and(
        eq(sessionProfiles.targetId, key.targetId),
        eq(sessionProfiles.targetAccountId, key.targetAccountId),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function writeSessionProfile(
  db: Db,
  key: SessionKey,
  values: {
    revision: number
    locationWorkerId: string | null
    state: SessionProfileState
    pendingCleanups: SessionProfileCleanup[]
    updatedAt: Date
  },
  options?: { create?: boolean; expectedRevision?: number },
): Promise<SessionProfileRow | null> {
  const { sessionProfiles } = schemaFor(db)
  const existing = await getSessionProfile(db, key)
  if (!existing) {
    if (!options?.create) return null
    await db.insert(sessionProfiles).values({
      targetId: key.targetId,
      targetAccountId: key.targetAccountId,
      ...values,
    })
    return getSessionProfile(db, key)
  }
  const conditions = [
    eq(sessionProfiles.targetId, key.targetId),
    eq(sessionProfiles.targetAccountId, key.targetAccountId),
  ]
  if (options?.expectedRevision !== undefined) {
    conditions.push(eq(sessionProfiles.revision, options.expectedRevision))
  }
  await db
    .update(sessionProfiles)
    .set(values)
    .where(and(...conditions))
  const row = await getSessionProfile(db, key)
  if (options?.expectedRevision !== undefined && row?.revision === options.expectedRevision) {
    return null
  }
  return row
}

export async function upsertSessionProfile(
  db: Db,
  input: {
    key: SessionKey
    workerId: string
    state?: 'ABSENT' | 'PRESENT'
    revision?: number
  },
): Promise<SessionProfileRow> {
  const now = await clockNow(db)
  const existing = await getSessionProfile(db, input.key)
  const row = await writeSessionProfile(
    db,
    input.key,
    {
      revision: input.revision ?? existing?.revision ?? 1,
      locationWorkerId: input.workerId,
      state: input.state ?? existing?.state ?? 'PRESENT',
      pendingCleanups: existing?.pendingCleanups ?? [],
      updatedAt: now,
    },
    { create: true },
  )
  return row ?? existing!
}

export async function invalidateSessionProfile(db: Db, key: SessionKey): Promise<SessionProfileRow | null> {
  return atomic(db, async (tx) => {
    const current = await getSessionProfile(tx, key)
    if (!current) return null
    const now = await clockNow(tx as unknown as Db)
    const pending = [...current.pendingCleanups]
    if (current.locationWorkerId) {
      pending.push({ workerId: current.locationWorkerId, revision: current.revision })
    }
    return writeSessionProfile(
      tx,
      key,
      {
        revision: current.revision + 1,
        state: 'ABSENT',
        locationWorkerId: null,
        pendingCleanups: pending,
        updatedAt: now,
      },
      { expectedRevision: current.revision },
    )
  })
}

export async function transferProfileLocation(
  tx: Db,
  key: SessionKey,
  fromWorkerId: string | null,
  toWorkerId: string,
  previousRevision: number,
): Promise<void> {
  const now = await clockNow(tx)
  const pending = fromWorkerId ? [{ workerId: fromWorkerId, revision: previousRevision }] : []
  await writeSessionProfile(
    tx,
    key,
    {
      locationWorkerId: toWorkerId,
      revision: previousRevision + 1,
      state: 'PRESENT',
      pendingCleanups: pending,
      updatedAt: now,
    },
    { create: true },
  )
}
