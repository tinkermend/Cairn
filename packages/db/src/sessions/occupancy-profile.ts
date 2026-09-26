import { and, eq } from 'drizzle-orm'
import type { SessionProfileCleanup, SessionProfileState } from '@cairn/shared'
import type { Db } from '../client.js'
import { atomic, clockNow } from '../native.js'
import type { SessionProfileRow } from '../records.js'
import { schemaFor } from '../native.js'
import { profileKeyFrom, type SessionProfileKey } from './account-session-concurrency.js'
import type { SessionKey } from './sessions.js'
import { clearSessionStateSnapshot } from './session-snapshots.js'

function resolveProfileKey(key: SessionKey | SessionProfileKey): SessionProfileKey {
  return 'accountSlot' in key && key.accountSlot != null ? key : profileKeyFrom(key, 1)
}

export async function getSessionProfile(
  db: Db,
  key: SessionKey | SessionProfileKey,
): Promise<SessionProfileRow | null> {
  const profileKey = resolveProfileKey(key)
  const { sessionProfiles } = schemaFor(db)
  const [row] = await db
    .select()
    .from(sessionProfiles)
    .where(
      and(
        eq(sessionProfiles.targetId, profileKey.targetId),
        eq(sessionProfiles.targetAccountId, profileKey.targetAccountId),
        eq(sessionProfiles.accountSlot, profileKey.accountSlot),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function writeSessionProfile(
  db: Db,
  key: SessionKey | SessionProfileKey,
  values: {
    revision: number
    locationWorkerId: string | null
    state: SessionProfileState
    pendingCleanups: SessionProfileCleanup[]
    updatedAt: Date
  },
  options?: { create?: boolean; expectedRevision?: number },
): Promise<SessionProfileRow | null> {
  const profileKey = resolveProfileKey(key)
  const { sessionProfiles } = schemaFor(db)
  const existing = await getSessionProfile(db, profileKey)
  if (!existing) {
    if (!options?.create) return null
    await db.insert(sessionProfiles).values({
      targetId: profileKey.targetId,
      targetAccountId: profileKey.targetAccountId,
      accountSlot: profileKey.accountSlot,
      ...values,
    })
    return getSessionProfile(db, profileKey)
  }
  const conditions = [
    eq(sessionProfiles.targetId, profileKey.targetId),
    eq(sessionProfiles.targetAccountId, profileKey.targetAccountId),
    eq(sessionProfiles.accountSlot, profileKey.accountSlot),
  ]
  if (options?.expectedRevision !== undefined) {
    conditions.push(eq(sessionProfiles.revision, options.expectedRevision))
  }
  await db
    .update(sessionProfiles)
    .set(values)
    .where(and(...conditions))
  const row = await getSessionProfile(db, profileKey)
  if (options?.expectedRevision !== undefined && row?.revision === options.expectedRevision) {
    return null
  }
  return row
}

export async function upsertSessionProfile(
  db: Db,
  input: {
    key: SessionKey | SessionProfileKey
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

export async function invalidateSessionProfile(
  db: Db,
  key: SessionKey | SessionProfileKey,
): Promise<SessionProfileRow | null> {
  return atomic(db, async (tx) => {
    await clearSessionStateSnapshot(tx, key).catch(() => {})
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
  key: SessionKey | SessionProfileKey,
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
