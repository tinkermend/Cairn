import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import {
  DEFAULT_PERIODIC_SLOT_FAILURE_RETRY_MS,
  DEFAULT_PERIODIC_SLOT_LEASE_TTL_MS,
  isPeriodicSlotMode,
  isPeriodicSlotName,
  nextPeriodicSlotDueAt,
  type PeriodicSlotMode,
  type PeriodicSlotName,
  type PeriodicSlotOutcome,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, databaseNow, driverOf, insertIgnoreRows, schemaFor, updateRows } from '../native.js'
import { badRequest } from '../runs/errors.js'

export type PeriodicSlotRequest = {
  name: PeriodicSlotName
  mode: PeriodicSlotMode
  intervalMs: number
  leaseTtlMs?: number
  owner?: string
}

export type PeriodicSlotClaim = {
  name: PeriodicSlotName
  mode: PeriodicSlotMode
  claimSeq: number
  intervalMs: number
}

export type PeriodicSlotSkipReason = 'not_due' | 'mode_mismatch' | 'lease_held'

export type PeriodicSlotSkip = {
  name: PeriodicSlotName
  reason: PeriodicSlotSkipReason
}

export type PeriodicSlotRecord = {
  name: PeriodicSlotName
  mode: PeriodicSlotMode
  nextDueAt: Date
  claimSeq: number
  leaseOwner: string | null
  leaseUntil: Date | null
  intervalMs: number | null
  lastStartedAt: Date | null
  lastFinishedAt: Date | null
  lastDurationMs: number | null
  lastOutcome: PeriodicSlotOutcome | null
  lastErrorClass: string | null
  lastOwner: string | null
}

function assertRequests(requests: PeriodicSlotRequest[]): void {
  const seen = new Set<string>()
  for (const request of requests) {
    if (!isPeriodicSlotName(request.name)) {
      throw badRequest('PERIODIC_SLOT_UNKNOWN', '未知的周期槽位', { name: request.name })
    }
    if (!isPeriodicSlotMode(request.mode)) {
      throw badRequest('PERIODIC_SLOT_MODE', '周期槽位 mode 不合法', { name: request.name })
    }
    if (!Number.isFinite(request.intervalMs) || request.intervalMs <= 0) {
      throw badRequest('PERIODIC_SLOT_INTERVAL', '周期槽位 intervalMs 必须为正整数', { name: request.name })
    }
    if (seen.has(request.name)) {
      throw badRequest('PERIODIC_SLOT_DUPLICATE', '同一批不得重复领取同一槽位', { name: request.name })
    }
    seen.add(request.name)
  }
}

function toRecord(row: {
  name: string
  mode: string
  nextDueAt: Date
  claimSeq: number
  leaseOwner: string | null
  leaseUntil: Date | null
  intervalMs: number | null
  lastStartedAt: Date | null
  lastFinishedAt: Date | null
  lastDurationMs: number | null
  lastOutcome: string | null
  lastErrorClass: string | null
  lastOwner: string | null
}): PeriodicSlotRecord | null {
  if (!isPeriodicSlotName(row.name) || !isPeriodicSlotMode(row.mode)) return null
  return {
    name: row.name,
    mode: row.mode,
    nextDueAt: row.nextDueAt,
    claimSeq: row.claimSeq,
    leaseOwner: row.leaseOwner,
    leaseUntil: row.leaseUntil,
    intervalMs: row.intervalMs,
    lastStartedAt: row.lastStartedAt,
    lastFinishedAt: row.lastFinishedAt,
    lastDurationMs: row.lastDurationMs,
    lastOutcome: row.lastOutcome === 'ok' || row.lastOutcome === 'failed' ? row.lastOutcome : null,
    lastErrorClass: row.lastErrorClass,
    lastOwner: row.lastOwner,
  }
}

async function ensureSlotRows(db: Db, requests: PeriodicSlotRequest[], now: Date): Promise<void> {
  const { periodicSlots } = schemaFor(db)
  const names = requests.map((request) => request.name)
  const existing = await db
    .select({ name: periodicSlots.name })
    .from(periodicSlots)
    .where(inArray(periodicSlots.name, names))
  const present = new Set(existing.map((row) => row.name))
  const missing = requests.filter((request) => !present.has(request.name))
  if (missing.length === 0) return
  await insertIgnoreRows(
    db,
    periodicSlots,
    missing.map((request) => ({
      name: request.name,
      mode: request.mode,
      nextDueAt: now,
      claimSeq: 0,
      intervalMs: request.intervalMs,
    })),
  )
}

function durationSinceStarted(db: Db) {
  const { periodicSlots } = schemaFor(db)
  const start = periodicSlots.lastStartedAt
  if (driverOf(db) === 'mysql') {
    return sql`GREATEST(0, COALESCE(CAST(TIMESTAMPDIFF(MICROSECOND, ${start}, ${databaseNow(db)}) / 1000 AS SIGNED), 0))`
  }
  return sql`GREATEST(0, COALESCE(FLOOR(EXTRACT(EPOCH FROM (${databaseNow(db)} - ${start})) * 1000), 0))`
}

export async function claimDuePeriodicSlots(
  db: Db,
  requests: PeriodicSlotRequest[],
): Promise<{ claimed: PeriodicSlotClaim[]; skipped: PeriodicSlotSkip[] }> {
  if (requests.length === 0) return { claimed: [], skipped: [] }
  assertRequests(requests)
  const now = await clockNow(db)
  await ensureSlotRows(db, requests, now)
  const { periodicSlots } = schemaFor(db)
  const rows = await db
    .select()
    .from(periodicSlots)
    .where(
      inArray(
        periodicSlots.name,
        requests.map((request) => request.name),
      ),
    )
  const byName = new Map(rows.map((row) => [row.name, row]))
  const skipped: PeriodicSlotSkip[] = []
  const due: PeriodicSlotRequest[] = []
  for (const request of requests) {
    let row = byName.get(request.name)
    if (!row) {
      await ensureSlotRows(db, [request], now)
      const [created] = await db.select().from(periodicSlots).where(eq(periodicSlots.name, request.name)).limit(1)
      row = created
    }
    if (!row) {
      skipped.push({ name: request.name, reason: 'not_due' })
      continue
    }
    if (row.mode !== request.mode) {
      skipped.push({ name: request.name, reason: 'mode_mismatch' })
      continue
    }
    if (row.nextDueAt.getTime() > now.getTime()) {
      skipped.push({ name: request.name, reason: 'not_due' })
      continue
    }
    if (
      request.mode === 'single_flight' &&
      row.leaseUntil != null &&
      row.leaseUntil.getTime() > now.getTime()
    ) {
      skipped.push({ name: request.name, reason: 'lease_held' })
      continue
    }
    due.push(request)
  }

  const claimed: PeriodicSlotClaim[] = []
  for (const request of due) {
    const nextDueAt = nextPeriodicSlotDueAt(now, request.intervalMs)
    const owner = request.owner ?? null
    const leaseTtlMs = request.leaseTtlMs ?? DEFAULT_PERIODIC_SLOT_LEASE_TTL_MS
    const duePredicate = and(eq(periodicSlots.name, request.name), eq(periodicSlots.mode, request.mode), sql`${periodicSlots.nextDueAt} <= ${now}`)
    const predicate =
      request.mode === 'single_flight'
        ? and(duePredicate, or(isNull(periodicSlots.leaseUntil), sql`${periodicSlots.leaseUntil} <= ${now}`))
        : duePredicate
    const [updated] = await updateRows(
      db,
      periodicSlots,
      {
        nextDueAt,
        claimSeq: sql`${periodicSlots.claimSeq} + 1`,
        intervalMs: request.intervalMs,
        lastStartedAt: now,
        lastOwner: owner,
        leaseOwner: request.mode === 'single_flight' ? owner : null,
        leaseUntil: request.mode === 'single_flight' ? new Date(now.getTime() + leaseTtlMs) : null,
      },
      predicate,
      { claimSeq: periodicSlots.claimSeq, mode: periodicSlots.mode },
    )
    if (!updated) {
      skipped.push({
        name: request.name,
        reason: request.mode === 'single_flight' ? 'lease_held' : 'not_due',
      })
      continue
    }
    claimed.push({
      name: request.name,
      mode: request.mode,
      claimSeq: updated.claimSeq,
      intervalMs: request.intervalMs,
    })
  }
  return { claimed, skipped }
}

export async function finishPeriodicSlot(
  db: Db,
  input: {
    name: PeriodicSlotName
    claimSeq: number
    outcome: PeriodicSlotOutcome
    errorClass?: string | null
    failureRetryMs?: number
  },
): Promise<boolean> {
  if (!isPeriodicSlotName(input.name)) {
    throw badRequest('PERIODIC_SLOT_UNKNOWN', '未知的周期槽位', { name: input.name })
  }
  const now = await clockNow(db)
  const { periodicSlots } = schemaFor(db)
  const retryAt = new Date(now.getTime() + (input.failureRetryMs ?? DEFAULT_PERIODIC_SLOT_FAILURE_RETRY_MS))
  const nextDueAt =
    input.outcome === 'failed'
      ? sql`CASE WHEN ${periodicSlots.nextDueAt} > ${retryAt} THEN ${retryAt} ELSE ${periodicSlots.nextDueAt} END`
      : undefined
  const [updated] = await updateRows(
    db,
    periodicSlots,
    {
      leaseOwner: null,
      leaseUntil: null,
      lastFinishedAt: now,
      lastDurationMs: durationSinceStarted(db),
      lastOutcome: input.outcome,
      lastErrorClass: input.outcome === 'failed' ? (input.errorClass ?? 'Error').slice(0, 64) : null,
      ...(nextDueAt ? { nextDueAt } : {}),
    },
    and(eq(periodicSlots.name, input.name), eq(periodicSlots.claimSeq, input.claimSeq)),
    { claimSeq: periodicSlots.claimSeq },
  )
  return Boolean(updated)
}

export async function readPeriodicSlots(db: Db, names?: PeriodicSlotName[]): Promise<PeriodicSlotRecord[]> {
  const { periodicSlots } = schemaFor(db)
  const rows =
    names && names.length > 0
      ? await db.select().from(periodicSlots).where(inArray(periodicSlots.name, names))
      : await db.select().from(periodicSlots)
  return rows.map(toRecord).filter((row): row is PeriodicSlotRecord => row != null)
}
