import { and, asc, eq, inArray, isNull, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { readableSessionTargets } from '../console/target-authorization.js'
import {
  accountSessionBucket,
  activeDetectionReady,
  deriveAccountSessionStatus,
  matchesOverviewFilter,
  matchesSystemOverviewFilter,
  worstAccountSessionStatus,
  type AccountSessionOverviewItem,
  type AccountSessionStatus,
  type SessionOverviewFilter,
  type SessionOverviewResponse,
  type SessionSystemOverviewFilter,
  type SessionSystemOverviewItem,
  type SessionSystemOverviewResponse,
  type AccountSessionDetail,
  retentionQuota,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, databaseNow, schemaFor } from '../native.js'
import { notFound } from '../runs/errors.js'
import { readRetentionConfig } from './session-retention.js'
import { loadCurrentAuthProfile } from './auth-profile.js'
import type { SessionOperationRow } from '../records.js'
import type { SessionLeaseRow } from '../schema/session.js'
import type { SessionKey, SessionRecord } from './sessions.js'

const LIVE_SESSION_STATUSES = ['CREATING', 'OPEN', 'CLOSING', 'LOST'] as const
const ACTIVE_OPERATION_STATUSES = ['QUEUED', 'RUNNING', 'WAITING_FOR_AUTH'] as const

type OccupancyLive = Pick<
  SessionRecord,
  | 'id'
  | 'status'
  | 'generation'
  | 'authState'
  | 'identityState'
  | 'observedTier'
  | 'retainUntil'
  | 'reclaimMode'
  | 'keepAliveUntil'
  | 'nextAuthCheckAt'
  | 'lastAuthCheckedAt'
  | 'lastAuthSuccessAt'
  | 'lastExpectedIdentity'
  | 'authValidUntil'
  | 'ownerWorkerId'
  | 'authControlActorId'
  | 'authControlExpiresAt'
>

export type OccupancyFacts = {
  live: OccupancyLive | null
  lease: SessionLeaseRow | null
  holding: boolean
  activeOp: SessionOperationRow | null
}

type OverviewAccountRow = {
  targetId: string
  targetName: string
  targetCode: string
  targetStatus: 'active' | 'disabled'
  targetAccountId: string
  accountDisplayName: string
  accountUsername: string
  accountStatus: 'active' | 'disabled'
}

type SystemTargetRow = {
  targetId: string
  targetName: string
  targetCode: string
  targetStatus: 'active' | 'disabled'
}

/** Test seam: keyed occupancy loads used to hydrate the current page. */
export const sessionOverviewReadStats = {
  occupancyKeyCounts: [] as number[],
  reset() {
    this.occupancyKeyCounts = []
  },
}

function emptyOccupancy(): OccupancyFacts {
  return { live: null, lease: null, holding: false, activeOp: null }
}

export function accountFactKey(targetId: string, targetAccountId: string) {
  return `${targetId}:${targetAccountId}`
}

function preferActiveOperation(
  current: SessionOperationRow | null,
  next: SessionOperationRow,
): SessionOperationRow {
  if (!current) return next
  const rank = (status: string) => (status === 'WAITING_FOR_AUTH' ? 0 : 1)
  const delta = rank(next.status) - rank(current.status)
  if (delta !== 0) return delta < 0 ? next : current
  return next.createdAt > current.createdAt ? next : current
}

function asCount(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function parseOffsetCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  const offset = Number(cursor)
  return Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
}

function nextOffsetCursor(offset: number, limit: number, hasMore: boolean): string | undefined {
  return hasMore ? String(offset + limit) : undefined
}

function containsInsensitive(column: SQLWrapper, needle: string): SQL {
  return sql`lower(${column}) like ${`%${needle.trim().toLowerCase()}%`}`
}

async function loadOccupancyFactsForAccountKeys(
  db: Db,
  keys: readonly SessionKey[],
  track: boolean,
): Promise<Map<string, OccupancyFacts>> {
  if (track) sessionOverviewReadStats.occupancyKeyCounts.push(keys.length)
  const facts = new Map<string, OccupancyFacts>(
    keys.map((key) => [accountFactKey(key.targetId, key.targetAccountId), emptyOccupancy()]),
  )
  if (keys.length === 0) return facts

  const { browserSessions, sessionLeases, runs, sessionOperations } = schemaFor(db)
  const accountIds = [...new Set(keys.map((key) => key.targetAccountId))]
  const liveRows = await db
    .select()
    .from(browserSessions)
    .where(
      and(
        inArray(browserSessions.targetAccountId, accountIds),
        inArray(browserSessions.status, LIVE_SESSION_STATUSES),
      ),
    )
  const liveByAccount = new Map<string, (typeof liveRows)[number]>()
  for (const row of liveRows) {
    const key = accountFactKey(row.targetId, row.targetAccountId)
    if (facts.has(key) && !liveByAccount.has(key)) liveByAccount.set(key, row)
  }

  const liveIds = [...liveByAccount.values()].map((row) => row.id)
  const liveAccountIds = [...new Set([...liveByAccount.values()].map((row) => row.targetAccountId))]
  const leaseRows = liveIds.length
    ? await db
        .select()
        .from(sessionLeases)
        .where(and(inArray(sessionLeases.sessionId, liveIds), eq(sessionLeases.status, 'ACTIVE')))
    : []
  const leaseBySession = new Map<string, SessionLeaseRow>()
  for (const row of leaseRows) {
    if (!leaseBySession.has(row.sessionId)) leaseBySession.set(row.sessionId, row)
  }

  const holdingRows = liveAccountIds.length
    ? await db
        .select({ targetId: runs.targetId, targetAccountId: runs.targetAccountId })
        .from(runs)
        .where(
          and(
            inArray(runs.targetAccountId, liveAccountIds),
            eq(runs.status, 'HOLDING'),
            isNull(runs.deletedAt),
          ),
        )
    : []
  const holdingKeys = new Set(
    holdingRows.flatMap((row) => {
      if (!row.targetId || !row.targetAccountId) return []
      const key = accountFactKey(row.targetId, row.targetAccountId)
      return liveByAccount.has(key) ? [key] : []
    }),
  )

  const opRows = await db
    .select()
    .from(sessionOperations)
    .where(
      and(
        inArray(sessionOperations.targetAccountId, accountIds),
        inArray(sessionOperations.status, ACTIVE_OPERATION_STATUSES),
      ),
    )
  const opByAccount = new Map<string, SessionOperationRow>()
  for (const row of opRows) {
    const key = accountFactKey(row.targetId, row.targetAccountId)
    if (!facts.has(key)) continue
    opByAccount.set(key, preferActiveOperation(opByAccount.get(key) ?? null, row))
  }

  for (const [key, live] of liveByAccount) {
    const current = facts.get(key)
    if (!current) continue
    current.live = {
      id: live.id,
      status: live.status,
      generation: live.generation,
      authState: live.authState,
      identityState: live.identityState,
      observedTier: live.observedTier,
      retainUntil: live.retainUntil ?? null,
      reclaimMode: live.reclaimMode,
      keepAliveUntil: live.keepAliveUntil ?? null,
      nextAuthCheckAt: live.nextAuthCheckAt ?? null,
      lastAuthCheckedAt: live.lastAuthCheckedAt,
      lastAuthSuccessAt: live.lastAuthSuccessAt,
      lastExpectedIdentity: live.lastExpectedIdentity,
      authValidUntil: live.authValidUntil,
      ownerWorkerId: live.ownerWorkerId,
      authControlActorId: live.authControlActorId,
      authControlExpiresAt: live.authControlExpiresAt,
    }
    current.lease = leaseBySession.get(live.id) ?? null
    current.holding = holdingKeys.has(key)
  }
  for (const [key, activeOp] of opByAccount) {
    const current = facts.get(key)
    if (current) current.activeOp = activeOp
  }
  return facts
}

export async function loadOccupancyFactsForAccounts(
  db: Db,
  keys: readonly SessionKey[],
): Promise<Map<string, OccupancyFacts>> {
  return loadOccupancyFactsForAccountKeys(db, keys, true)
}

export async function loadOccupancyFacts(db: Db, key: SessionKey): Promise<OccupancyFacts> {
  return (await loadOccupancyFactsForAccountKeys(db, [key], false)).get(
    accountFactKey(key.targetId, key.targetAccountId),
  )!
}

export function statusFromFacts(input: OccupancyFacts): AccountSessionStatus {
  return deriveAccountSessionStatus({
    liveStatus: input.live?.status ?? null,
    authState: input.live?.authState ?? null,
    identityState: input.live?.identityState ?? null,
    leasePurpose: input.lease?.purpose ?? null,
    occupyingRunId: input.lease?.runId ?? null,
    occupyingOperationId: input.lease?.operationId ?? input.activeOp?.id ?? null,
    holding: input.holding,
  })
}

async function loadOccupancyFactsForActiveAccounts(db: Db): Promise<Map<string, OccupancyFacts>> {
  const { browserSessions, sessionLeases, runs, sessionOperations, targets, targetAccounts } = schemaFor(db)
  const liveRows = await db
    .select({ session: browserSessions })
    .from(browserSessions)
    .innerJoin(targetAccounts, eq(targetAccounts.id, browserSessions.targetAccountId))
    .innerJoin(targets, eq(targets.id, browserSessions.targetId))
    .where(
      and(
        inArray(browserSessions.status, LIVE_SESSION_STATUSES),
        isNull(targetAccounts.deletedAt),
        isNull(targets.deletedAt),
      ),
    )
  const opRows = await db
    .select({ operation: sessionOperations })
    .from(sessionOperations)
    .innerJoin(targetAccounts, eq(targetAccounts.id, sessionOperations.targetAccountId))
    .innerJoin(targets, eq(targets.id, sessionOperations.targetId))
    .where(
      and(
        inArray(sessionOperations.status, ACTIVE_OPERATION_STATUSES),
        isNull(targetAccounts.deletedAt),
        isNull(targets.deletedAt),
      ),
    )

  const keys = new Map<string, SessionKey>()
  for (const { session } of liveRows) {
    keys.set(accountFactKey(session.targetId, session.targetAccountId), {
      targetId: session.targetId,
      targetAccountId: session.targetAccountId,
    })
  }
  for (const { operation } of opRows) {
    keys.set(accountFactKey(operation.targetId, operation.targetAccountId), {
      targetId: operation.targetId,
      targetAccountId: operation.targetAccountId,
    })
  }
  if (keys.size === 0) return new Map()
  return loadOccupancyFactsForAccountKeys(db, [...keys.values()], false)
}

function systemSearchCondition(name: SQLWrapper, code: SQLWrapper, search: string | undefined) {
  if (!search?.trim()) return undefined
  return or(containsInsensitive(name, search), containsInsensitive(code, search))
}

function accountNameSearchCondition(displayName: SQLWrapper, username: SQLWrapper, search: string | undefined) {
  if (!search?.trim()) return undefined
  return or(containsInsensitive(displayName, search), containsInsensitive(username, search))
}

async function loadOverviewAccounts(
  db: Db,
  input: {
    targetId?: string
    targetIds?: readonly string[]
    search?: string
    accountNameOnly?: boolean
    offset?: number
    limit?: number
  },
): Promise<OverviewAccountRow[]> {
  if (input.targetIds && input.targetIds.length === 0) return []
  const { targets, targetAccounts } = schemaFor(db)
  const search = input.accountNameOnly
    ? accountNameSearchCondition(targetAccounts.displayName, targetAccounts.username, input.search)
    : input.search?.trim()
      ? or(
          containsInsensitive(targets.name, input.search),
          containsInsensitive(targetAccounts.displayName, input.search),
          containsInsensitive(targetAccounts.username, input.search),
        )
      : undefined
  const query = db
    .select({
      targetId: targets.id,
      targetName: targets.name,
      targetCode: targets.code,
      targetStatus: targets.status,
      targetAccountId: targetAccounts.id,
      accountDisplayName: targetAccounts.displayName,
      accountUsername: targetAccounts.username,
      accountStatus: targetAccounts.status,
    })
    .from(targetAccounts)
    .innerJoin(targets, eq(targets.id, targetAccounts.targetId))
    .where(
      and(
        isNull(targets.deletedAt),
        isNull(targetAccounts.deletedAt),
        input.targetId ? eq(targets.id, input.targetId) : undefined,
        input.targetIds ? inArray(targets.id, [...input.targetIds]) : undefined,
        search,
      ),
    )
    .orderBy(asc(targets.name), asc(targetAccounts.displayName), asc(targetAccounts.id))
  const limited = input.limit != null ? query.limit(input.limit).offset(input.offset ?? 0) : query
  return limited
}

async function pageSystemTargets(
  db: Db,
  input: { search?: string; offset: number; limit: number },
): Promise<SystemTargetRow[]> {
  const { targets, targetAccounts } = schemaFor(db)
  return db
    .select({
      targetId: targets.id,
      targetName: targets.name,
      targetCode: targets.code,
      targetStatus: targets.status,
    })
    .from(targets)
    .innerJoin(targetAccounts, eq(targetAccounts.targetId, targets.id))
    .where(
      and(
        isNull(targets.deletedAt),
        isNull(targetAccounts.deletedAt),
        systemSearchCondition(targets.name, targets.code, input.search),
      ),
    )
    .groupBy(targets.id, targets.name, targets.code, targets.status)
    .orderBy(asc(targets.name), asc(targets.id))
    .limit(input.limit)
    .offset(input.offset)
}

async function countVisibleAccounts(db: Db, input: { targetId?: string; search?: string; accountNameOnly?: boolean }) {
  const { targets, targetAccounts } = schemaFor(db)
  const search = input.accountNameOnly
    ? accountNameSearchCondition(targetAccounts.displayName, targetAccounts.username, input.search)
    : input.search?.trim()
      ? or(
          containsInsensitive(targets.name, input.search),
          containsInsensitive(targetAccounts.displayName, input.search),
          containsInsensitive(targetAccounts.username, input.search),
        )
      : undefined
  const [row] = await db
    .select({
      systems: sql`count(distinct ${targets.id})`,
      accounts: sql`count(${targetAccounts.id})`,
    })
    .from(targetAccounts)
    .innerJoin(targets, eq(targets.id, targetAccounts.targetId))
    .where(
      and(
        isNull(targets.deletedAt),
        isNull(targetAccounts.deletedAt),
        input.targetId ? eq(targets.id, input.targetId) : undefined,
        search,
      ),
    )
  return { systems: asCount(row?.systems), accounts: asCount(row?.accounts) }
}

function emptyAccountSummary() {
  return {
    total: 0,
    available: 0,
    needsCheck: 0,
    needsLogin: 0,
    identityMismatch: 0,
    maintenance: 0,
    executing: 0,
    lost: 0,
    unprepared: 0,
    retained: 0,
  }
}

function bumpAccountSummary(
  summary: ReturnType<typeof emptyAccountSummary>,
  status: AccountSessionStatus,
  retained: boolean,
) {
  summary.total += 1
  if (status === 'ready') summary.available += 1
  if (status === 'needs_check') summary.needsCheck += 1
  if (status === 'needs_login') summary.needsLogin += 1
  if (status === 'identity_mismatch') summary.identityMismatch += 1
  if (status === 'maintenance') summary.maintenance += 1
  if (status === 'executing') summary.executing += 1
  if (status === 'lost') summary.lost += 1
  if (status === 'unprepared') summary.unprepared += 1
  if (retained) summary.retained += 1
}

function isRetained(facts: OccupancyFacts, now: Date) {
  return Boolean(facts.live?.retainUntil && facts.live.retainUntil.getTime() > now.getTime())
}

function primaryAction(status: AccountSessionStatus): string {
  if (status === 'unprepared') return 'PREPARE'
  if (status === 'needs_check') return 'VERIFY_AUTH'
  if (status === 'needs_login' || status === 'identity_mismatch') return 'LOGIN'
  if (status === 'lost') return 'dispose'
  if (status === 'maintenance' || status === 'executing') return 'view'
  return 'VERIFY_AUTH'
}

function toAccountOverviewItem(account: OverviewAccountRow, facts: OccupancyFacts, now: Date): AccountSessionOverviewItem {
  const status = statusFromFacts(facts)
  return {
    targetId: account.targetId,
    targetName: account.targetName,
    targetAccountId: account.targetAccountId,
    accountDisplayName: account.accountDisplayName,
    accountUsername: account.accountUsername,
    accountStatus: account.accountStatus,
    status,
    retained: isRetained(facts, now),
    sessionId: facts.live?.id ?? null,
    generation: facts.live?.generation ?? null,
    instanceStatus: facts.live?.status ?? null,
    authState: facts.live?.authState ?? null,
    identityState: facts.live?.identityState ?? null,
    observedTier: facts.live?.observedTier ?? null,
    occupyingRunId: facts.lease?.runId ?? null,
    occupyingOperationId: facts.lease?.operationId ?? facts.activeOp?.id ?? null,
    retainUntil: facts.live?.retainUntil?.toISOString() ?? null,
    lastAuthCheckedAt: facts.live?.lastAuthCheckedAt?.toISOString() ?? null,
    lastAuthSuccessAt: facts.live?.lastAuthSuccessAt?.toISOString() ?? null,
    ownerWorkerId: facts.live?.ownerWorkerId ?? null,
    primaryAction: primaryAction(status),
  }
}

function addAccountToSystem(
  systems: Map<string, SessionSystemOverviewItem>,
  account: Pick<OverviewAccountRow, 'targetId' | 'targetName' | 'targetCode' | 'targetStatus'>,
  facts: OccupancyFacts,
  now: Date,
) {
  const status = statusFromFacts(facts)
  const retained = isRetained(facts, now)
  const bucket = accountSessionBucket(status)
  const current = systems.get(account.targetId)
  if (!current) {
    systems.set(account.targetId, {
      targetId: account.targetId,
      targetName: account.targetName,
      targetCode: account.targetCode,
      targetStatus: account.targetStatus,
      accountTotal: 1,
      readyCount: bucket === 'ready' ? 1 : 0,
      problemCount: bucket === 'problem' ? 1 : 0,
      unpreparedCount: bucket === 'unprepared' ? 1 : 0,
      busyCount: bucket === 'busy' ? 1 : 0,
      retainedCount: retained ? 1 : 0,
      worstStatus: status,
    })
    return
  }
  current.accountTotal += 1
  if (bucket === 'ready') current.readyCount += 1
  if (bucket === 'problem') current.problemCount += 1
  if (bucket === 'unprepared') current.unpreparedCount += 1
  if (bucket === 'busy') current.busyCount += 1
  if (retained) current.retainedCount += 1
  current.worstStatus = worstAccountSessionStatus(current.worstStatus, status)
}

function compareSystemRow(left: SessionSystemOverviewItem, right: SessionSystemOverviewItem) {
  if (left.targetName < right.targetName) return -1
  if (left.targetName > right.targetName) return 1
  return left.targetId < right.targetId ? -1 : left.targetId > right.targetId ? 1 : 0
}

function summarizeFromActiveFacts(totals: { systems: number; accounts: number }, active: Map<string, OccupancyFacts>) {
  const summary = {
    systems: totals.systems,
    readyAccounts: 0,
    problemAccounts: 0,
    unpreparedAccounts: 0,
  }
  for (const facts of active.values()) {
    const bucket = accountSessionBucket(statusFromFacts(facts))
    if (bucket === 'ready') summary.readyAccounts += 1
    if (bucket === 'problem') summary.problemAccounts += 1
    if (bucket === 'unprepared') summary.unpreparedAccounts += 1
  }
  summary.unpreparedAccounts += Math.max(0, totals.accounts - active.size)
  return summary
}

function loadAccountSummary(
  accounts: OverviewAccountRow[],
  factsByAccount: Map<string, OccupancyFacts>,
  now: Date,
) {
  const summary = emptyAccountSummary()
  for (const account of accounts) {
    const facts = factsByAccount.get(accountFactKey(account.targetId, account.targetAccountId)) ?? emptyOccupancy()
    bumpAccountSummary(summary, statusFromFacts(facts), isRetained(facts, now))
  }
  return summary
}

export async function listAccountSessionOverview(
  db: Db,
  input: {
    search?: string
    filter?: SessionOverviewFilter
    targetId?: string
    cursor?: string
    limit?: number
  },
  actorId?: string,
): Promise<SessionOverviewResponse> {
  const targetIds = actorId ? await readableSessionTargets(db, actorId) : undefined
  sessionOverviewReadStats.reset()
  const limit = input.limit ?? 20
  const offset = parseOffsetCursor(input.cursor)
  const scoped = Boolean(input.targetId)
  const now = await clockNow(db)

  if (input.filter) {
    const accounts = await loadOverviewAccounts(db, {
      targetIds,
      targetId: input.targetId,
      search: scoped ? undefined : input.search,
    })
    const factsByAccount = await loadOccupancyFactsForAccounts(
      db,
      accounts.map((account) => ({ targetId: account.targetId, targetAccountId: account.targetAccountId })),
    )
    const summary = loadAccountSummary(accounts, factsByAccount, now)
    const items = accounts
      .filter((account) => !scoped || !input.search || accountNameMatches(account, input.search))
      .map((account) =>
        toAccountOverviewItem(
          account,
          factsByAccount.get(accountFactKey(account.targetId, account.targetAccountId)) ?? emptyOccupancy(),
          now,
        ),
      )
      .filter((item) => matchesOverviewFilter(item.status, item.retained, input.filter))
    const page = items.slice(offset, offset + limit)
    return {
      items: page,
      nextCursor: nextOffsetCursor(offset, limit, offset + limit < items.length),
      summary,
      asOf: now.toISOString(),
    }
  }

  const summaryAccounts = await loadOverviewAccounts(db, {
    targetIds,
    targetId: input.targetId,
    search: scoped ? undefined : input.search,
  })
  const factsByAccount = await loadOccupancyFactsForAccounts(
    db,
    summaryAccounts.map((account) => ({ targetId: account.targetId, targetAccountId: account.targetAccountId })),
  )
  const summary = loadAccountSummary(summaryAccounts, factsByAccount, now)
  const itemRows = await loadOverviewAccounts(db, {
    targetIds,
    targetId: input.targetId,
    search: input.search,
    accountNameOnly: scoped,
    offset,
    limit: limit + 1,
  })
  const hasMore = itemRows.length > limit
  const page = itemRows.slice(0, limit).map((account) =>
    toAccountOverviewItem(
      account,
      factsByAccount.get(accountFactKey(account.targetId, account.targetAccountId)) ?? emptyOccupancy(),
      now,
    ),
  )
  return {
    items: page,
    nextCursor: nextOffsetCursor(offset, limit, hasMore),
    summary,
    asOf: now.toISOString(),
  }
}

function accountNameMatches(
  account: Pick<OverviewAccountRow, 'accountDisplayName' | 'accountUsername'>,
  search: string,
) {
  const needle = search.trim().toLowerCase()
  return (
    account.accountDisplayName.toLowerCase().includes(needle) ||
    account.accountUsername.toLowerCase().includes(needle)
  )
}

export async function listSessionSystemOverview(
  db: Db,
  input: { search?: string; filter?: SessionSystemOverviewFilter; cursor?: string; limit?: number },
  actorId?: string,
): Promise<SessionSystemOverviewResponse> {
  sessionOverviewReadStats.reset()
  const limit = input.limit ?? 20
  const offset = parseOffsetCursor(input.cursor)
  const now = await clockNow(db)
  const targetIds = actorId ? await readableSessionTargets(db, actorId) : undefined
  if (targetIds) {
    const accounts = await loadOverviewAccounts(db, { targetIds })
    const facts = await loadOccupancyFactsForAccounts(db, accounts)
    const systems = new Map<string, SessionSystemOverviewItem>()
    for (const account of accounts) addAccountToSystem(systems, account, facts.get(accountFactKey(account.targetId, account.targetAccountId)) ?? emptyOccupancy(), now)
    const needle = input.search?.trim().toLowerCase()
    const filtered = [...systems.values()].filter((item) => (!needle || item.targetName.toLowerCase().includes(needle) || item.targetCode.toLowerCase().includes(needle)) && matchesSystemOverviewFilter(item, input.filter)).sort(compareSystemRow)
    return { items: filtered.slice(offset, offset + limit), nextCursor: nextOffsetCursor(offset, limit, offset + limit < filtered.length),
      summary: summarizeFromActiveFacts({ systems: systems.size, accounts: accounts.length }, facts), asOf: now.toISOString() }
  }
  const totals = await countVisibleAccounts(db, {})
  const activeFacts = await loadOccupancyFactsForActiveAccounts(db)
  const summary = summarizeFromActiveFacts(totals, activeFacts)

  if (input.filter) {
    const accounts = await loadOverviewAccounts(db, {})
    const systems = new Map<string, SessionSystemOverviewItem>()
    for (const account of accounts) {
      const facts = activeFacts.get(accountFactKey(account.targetId, account.targetAccountId)) ?? emptyOccupancy()
      addAccountToSystem(systems, account, facts, now)
    }
    const needle = input.search?.trim().toLowerCase()
    const filtered = [...systems.values()]
      .filter((item) => {
        if (needle && !item.targetName.toLowerCase().includes(needle) && !item.targetCode.toLowerCase().includes(needle)) {
          return false
        }
        return matchesSystemOverviewFilter(item, input.filter)
      })
      .sort(compareSystemRow)
    const page = filtered.slice(offset, offset + limit)
    return {
      items: page,
      nextCursor: nextOffsetCursor(offset, limit, offset + limit < filtered.length),
      summary,
      asOf: now.toISOString(),
    }
  }

  const targetRows = await pageSystemTargets(db, {
    search: input.search,
    offset,
    limit: limit + 1,
  })
  const hasMore = targetRows.length > limit
  const pageTargets = targetRows.slice(0, limit)
  const accounts = await loadOverviewAccounts(db, { targetIds: pageTargets.map((row) => row.targetId) })
  const factsByAccount = await loadOccupancyFactsForAccounts(
    db,
    accounts.map((account) => ({ targetId: account.targetId, targetAccountId: account.targetAccountId })),
  )
  const systems = new Map<string, SessionSystemOverviewItem>()
  for (const account of accounts) {
    const facts = factsByAccount.get(accountFactKey(account.targetId, account.targetAccountId)) ?? emptyOccupancy()
    addAccountToSystem(systems, account, facts, now)
  }
  return {
    items: pageTargets.flatMap((target) => {
      const item = systems.get(target.targetId)
      return item ? [item] : []
    }),
    nextCursor: nextOffsetCursor(offset, limit, hasMore),
    summary,
    asOf: now.toISOString(),
  }
}

function actionsFor(status: AccountSessionStatus, retained: boolean, detectionReady: boolean) {
  const idle =
    status === 'ready' ||
    status === 'needs_check' ||
    status === 'needs_login' ||
    status === 'identity_mismatch'
  const verifyReason = !detectionReady
    ? '未配置主动检测，将在下次使用时按登录页判断'
    : idle
      ? null
      : '当前不能检查登录'
  const renewReason = !detectionReady
    ? '未配置主动检测，无法续登'
    : status === 'ready'
      ? null
      : '仅就绪会话可续登'
  return [
    {
      kind: 'PREPARE',
      enabled: status === 'unprepared',
      disabledReason: status !== 'unprepared' ? '已有会话或不适用' : null,
    },
    { kind: 'VERIFY_AUTH', enabled: idle && detectionReady, disabledReason: verifyReason },
    {
      kind: 'LOGIN',
      enabled: idle || status === 'unprepared',
      disabledReason: idle || status === 'unprepared' ? null : '当前不能登录',
    },
    {
      kind: 'RENEW_AUTH',
      enabled: status === 'ready' && detectionReady,
      disabledReason: renewReason,
    },
    {
      kind: 'retention',
      enabled: idle && !retained,
      disabledReason: idle ? (retained ? '已在保留中' : null) : '需要空闲实例',
    },
    { kind: 'CLOSE', enabled: idle, disabledReason: idle ? null : '仅空闲实例可关闭' },
    { kind: 'RESTART', enabled: idle, disabledReason: idle ? null : '仅空闲实例可重启' },
    {
      kind: 'RESET_PROFILE',
      enabled: idle || status === 'unprepared',
      disabledReason:
        status === 'lost' ? '失联实例须先处置' : idle || status === 'unprepared' ? null : '当前不能清除登录数据',
    },
  ]
}

export async function getAccountSessionDetail(db: Db, key: SessionKey): Promise<AccountSessionDetail> {
  const { targets, targetAccounts, sessionRetentionIntents, workers } = schemaFor(db)
  const [account] = await db
    .select({
      targetId: targets.id,
      targetName: targets.name,
      targetAccountId: targetAccounts.id,
      accountDisplayName: targetAccounts.displayName,
      accountUsername: targetAccounts.username,
      accountStatus: targetAccounts.status,
      hasPassword: targetAccounts.secretId,
      expectedIdentity: targetAccounts.expectedIdentity,
      currentAuthProfileRevision: targets.currentAuthProfileRevision,
    })
    .from(targetAccounts)
    .innerJoin(targets, eq(targets.id, targetAccounts.targetId))
    .where(and(eq(targetAccounts.id, key.targetAccountId), eq(targetAccounts.targetId, key.targetId)))
    .limit(1)
  if (!account) throw notFound('TARGET_ACCOUNT_NOT_FOUND', '目标账号不存在')
  const profile = await loadCurrentAuthProfile(db, key.targetId)
  const facts = await loadOccupancyFacts(db, key)
  const now = await clockNow(db)
  const retained = Boolean(facts.live?.retainUntil && facts.live.retainUntil.getTime() > now.getTime())
  const status = statusFromFacts(facts)
  const [intent] = await db
    .select()
    .from(sessionRetentionIntents)
    .where(
      and(
        eq(sessionRetentionIntents.targetId, key.targetId),
        eq(sessionRetentionIntents.targetAccountId, key.targetAccountId),
      ),
    )
    .limit(1)
  let quotaUsed = 0
  let quotaLimit = 0
  if (facts.live) {
    const [worker] = await db.select().from(workers).where(eq(workers.id, facts.live.ownerWorkerId)).limit(1)
    const { retention } = await readRetentionConfig(db)
    quotaLimit = retentionQuota(worker?.maxSessions ?? 0, retention.reservedFreeSlotsPerWorker)
    const { browserSessions } = schemaFor(db)
    const rows = await db
      .select({ id: browserSessions.id })
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.ownerWorkerId, facts.live.ownerWorkerId),
          inArray(browserSessions.status, ['CREATING', 'OPEN']),
          sql`${browserSessions.retainUntil} > ${databaseNow(db)}`,
        ),
      )
    quotaUsed = rows.length
  }
  return {
    targetId: account.targetId,
    targetName: account.targetName,
    targetAccountId: account.targetAccountId,
    accountDisplayName: account.accountDisplayName,
    accountUsername: account.accountUsername,
    accountStatus: account.accountStatus,
    hasPassword: Boolean(account.hasPassword),
    expectedIdentity: account.expectedIdentity,
    authCapability: facts.live?.observedTier ?? 'LEGACY',
    status,
    retained,
    session: facts.live
      ? {
          id: facts.live.id,
          status: facts.live.status,
          generation: facts.live.generation,
          ownerWorkerId: facts.live.ownerWorkerId,
          authState: facts.live.authState,
          identityState: facts.live.identityState,
          observedTier: facts.live.observedTier,
          lastAuthCheckedAt: facts.live.lastAuthCheckedAt?.toISOString() ?? null,
          lastAuthSuccessAt: facts.live.lastAuthSuccessAt?.toISOString() ?? null,
          authValidUntil: facts.live.authValidUntil?.toISOString() ?? null,
          lastExpectedIdentity: facts.live.lastExpectedIdentity,
          retainUntil: facts.live.retainUntil?.toISOString() ?? null,
          reclaimMode: facts.live.reclaimMode,
          keepAliveUntil: facts.live.keepAliveUntil?.toISOString() ?? null,
          nextAuthCheckAt: facts.live.nextAuthCheckAt?.toISOString() ?? null,
        }
      : null,
    occupancy: facts.lease
      ? {
          purpose: facts.lease.purpose,
          occupyingRunId: facts.lease.runId,
          occupyingOperationId: facts.lease.operationId,
        }
      : null,
    retention: intent
      ? {
          retainUntil: intent.retainUntil.toISOString(),
          reason: intent.reason,
          quotaUsed,
          quotaLimit,
          workerId: facts.live?.ownerWorkerId ?? null,
          platformConfigRevision: intent.platformConfigRevision,
        }
      : null,
    currentOperation: facts.activeOp
      ? {
          id: facts.activeOp.id,
          kind: facts.activeOp.kind,
          status: facts.activeOp.status,
          reusedRunId:
            typeof facts.activeOp.kindParams?.reusedRunId === 'string'
              ? facts.activeOp.kindParams.reusedRunId
              : null,
        }
      : null,
    actions: actionsFor(
      status,
      retained,
      activeDetectionReady({
        definition: profile?.definition ?? null,
        validation: profile?.validation ?? null,
      }),
    ),
    asOf: now.toISOString(),
  }
}
