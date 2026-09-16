import { createHash, randomBytes } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import {
  SESSION_MAINTENANCE_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  canonicalJson,
  isSessionIdleOnlyKind,
  isSessionLeaseClaimKind,
  isSessionMaintenanceKind,
  platformConfigDocumentSchema,
  type PlatformSessionScheduling,
  type RunPlacement,
  type RunStatus,
  type SessionAcquireReason,
  type SessionGrant,
  type SessionLeaseOwnerKind,
  type SessionLeasePurpose,
  type SessionOperationKind,
  type SessionOperationOrigin,
  type SessionProfileCleanup,
  type SessionProfileState,
  type SessionReusePolicy,
} from '@cairn/shared'
import { assertMaintenanceAuthorized, assertSessionActorPermission } from './access.js'
import { appendSessionEvent } from './maintenance.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import {
  afterSeconds,
  atomic,
  clockNow,
  databaseNow,
  insertRows,
  locked,
  schemaFor,
  updateRows,
} from '../native.js'
import { getOrCreatePlatformConfig } from '../platform-config/store.js'
import { appendRunEvents } from '../observe/events.js'
import { conflict, isUniqueViolation } from '../runs/errors.js'
import { sha256Hex } from '../runs/digest.js'
import { countFailedRecoveries, lockRunRow, releaseRunLeaseTx, verifyRunLeaseForWrite, type WorkerRecord } from '../leases/leases.js'
import { skipRemainingStepRunsTx } from '../runs/step-status.js'
import type {
  BrowserSessionRow,
  SessionLeaseRow,
  SessionOperationRow,
  SessionProfileRow,
} from '../records.js'
import {
  SessionDomainError,
  createSession,
  findLiveSession,
  isClaimable,
  profileKeyFor,
  type SessionKey,
  type SessionRecord,
} from './sessions.js'

async function lockSession(tx: Db, sessionId: string): Promise<BrowserSessionRow | null> {
  const { browserSessions } = schemaFor(tx)
  const [row] = await locked(tx, tx.select().from(browserSessions).where(eq(browserSessions.id, sessionId)))
  return row ?? null
}

export type OccupancyOwner =
  { kind: 'RUN'; runId: string; runFencingToken: number } | { kind: 'SESSION_OPERATION'; operationId: string }

export type ClaimSessionUseInput = {
  key: SessionKey
  owner: OccupancyOwner
  purpose: 'EXECUTION' | 'MAINTENANCE'
  holderWorkerId: string
  holderInstanceId: string
  leaseTtlSeconds: number
  reusePolicy: SessionReusePolicy
  idleTtlSeconds: number
  maxLifetimeSeconds: number
  touchLastUsed?: boolean
}

export type ClaimSessionUseResult =
  | {
      ok: true
      grant: SessionGrant
      session: SessionRecord
      created: boolean
      acquireReason: SessionAcquireReason
      profileFallback: boolean
      schedulingRevision: number
    }
  | {
      ok: false
      code:
        | 'SESSION_BUSY'
        | 'SESSION_NOT_CLAIMABLE'
        | 'SESSION_CAPACITY_EXCEEDED'
        | 'SESSION_TARGET_MISSING'
        | 'SESSION_POLICY_INVALID'
      message?: string
    }

export type PlacementFacts = {
  waitReason: RunPlacement['waitReason']
  occupyingRunId: string | null
  occupyingOperationId: string | null
  targetWorkerId: string | null
  profileAffinityUntil: string | null
}

export async function readSessionScheduling(
  db: Db,
): Promise<{ scheduling: PlatformSessionScheduling; revision: number }> {
  const current = await getOrCreatePlatformConfig(db)
  const document = platformConfigDocumentSchema.parse(current.document)
  return { scheduling: document.sessionScheduling, revision: current.revision }
}

export async function lockWorkerRow(tx: Db, workerId: string) {
  const { workers } = schemaFor(tx)
  const [row] = await locked(tx, tx.select().from(workers).where(eq(workers.id, workerId)))
  return row ?? null
}

async function lockOperationRow(tx: Db, operationId: string): Promise<SessionOperationRow | null> {
  const { sessionOperations } = schemaFor(tx)
  const [row] = await locked(
    tx,
    tx.select().from(sessionOperations).where(eq(sessionOperations.id, operationId)),
  )
  return row ?? null
}

function toGrant(lease: SessionLeaseRow): SessionGrant {
  return {
    sessionId: lease.sessionId,
    leaseId: lease.id,
    generation: lease.sessionGeneration,
    sessionFencingToken: lease.sessionFencingToken,
    expiresAt: lease.expiresAt.toISOString(),
    purpose: lease.purpose,
    ownerKind: lease.ownerKind,
    runId: lease.runId,
    operationId: lease.operationId,
  }
}

export async function findActiveLeaseRow(db: Db, sessionId: string): Promise<SessionLeaseRow | null> {
  const { sessionLeases } = schemaFor(db)
  const [row] = await db
    .select()
    .from(sessionLeases)
    .where(and(eq(sessionLeases.sessionId, sessionId), eq(sessionLeases.status, 'ACTIVE')))
    .limit(1)
  return row ?? null
}

export async function findAuthWaitLeaseForRun(db: Db, runId: string): Promise<SessionLeaseRow | null> {
  const { sessionLeases } = schemaFor(db)
  const [row] = await db
    .select()
    .from(sessionLeases)
    .where(
      and(
        eq(sessionLeases.runId, runId),
        eq(sessionLeases.purpose, 'AUTH_WAIT'),
        eq(sessionLeases.status, 'ACTIVE'),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function findAuthWaitLeaseForOperation(
  db: Db,
  operationId: string,
): Promise<SessionLeaseRow | null> {
  const { sessionLeases } = schemaFor(db)
  const [row] = await db
    .select()
    .from(sessionLeases)
    .where(
      and(
        eq(sessionLeases.operationId, operationId),
        eq(sessionLeases.purpose, 'AUTH_WAIT'),
        eq(sessionLeases.status, 'ACTIVE'),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function getSessionOperation(db: Db, operationId: string): Promise<SessionOperationRow | null> {
  const { sessionOperations } = schemaFor(db)
  const [row] = await db
    .select()
    .from(sessionOperations)
    .where(eq(sessionOperations.id, operationId))
    .limit(1)
  return row ?? null
}

export async function markSessionOperationWaitingForAuth(
  db: Db,
  input: { operationId: string; workerId: string },
): Promise<boolean> {
  const { sessionOperations } = schemaFor(db)
  const now = new Date()
  const [row] = await updateRows(
    db,
    sessionOperations,
    { status: 'WAITING_FOR_AUTH', updatedAt: now },
    and(
      eq(sessionOperations.id, input.operationId),
      eq(sessionOperations.ownerWorkerId, input.workerId),
      inArray(sessionOperations.status, ['RUNNING', 'WAITING_FOR_AUTH']),
    ),
    { id: sessionOperations.id },
  )
  return row !== undefined
}

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

async function writeSessionProfile(
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

async function transferProfileLocation(
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

export async function evaluateRunSessionEligibility(
  db: Db,
  input: {
    run: { id: string; createdAt: Date; targetId: string; targetAccountId: string | null }
    workerId: string
    instanceId: string
    maxSessions: number
    scheduling: PlatformSessionScheduling
  },
): Promise<{ eligible: boolean; fallback: boolean; facts: PlacementFacts }> {
  const empty: PlacementFacts = {
    waitReason: null,
    occupyingRunId: null,
    occupyingOperationId: null,
    targetWorkerId: null,
    profileAffinityUntil: null,
  }
  if (!input.run.targetAccountId) return { eligible: true, fallback: false, facts: empty }
  const key = { targetId: input.run.targetId, targetAccountId: input.run.targetAccountId }
  const live = await findLiveSession(db, key)
  if (live) {
    if (live.status === 'LOST') {
      return { eligible: false, fallback: false, facts: { ...empty, waitReason: 'SESSION_LOST' } }
    }
    const lease = await findActiveLeaseRow(db, live.id)
    if (lease) {
      if (lease.purpose === 'EXECUTION') {
        return {
          eligible: false,
          fallback: false,
          facts: { ...empty, waitReason: 'SESSION_IN_USE_BY_RUN', occupyingRunId: lease.runId },
        }
      }
      if (lease.purpose === 'MAINTENANCE') {
        return {
          eligible: false,
          fallback: false,
          facts: { ...empty, waitReason: 'SESSION_IN_MAINTENANCE', occupyingOperationId: lease.operationId },
        }
      }
      return {
        eligible: false,
        fallback: false,
        facts: {
          ...empty,
          waitReason: 'SESSION_WAITING_FOR_AUTH',
          occupyingRunId: lease.runId,
          occupyingOperationId: lease.operationId,
        },
      }
    }
    if (live.status === 'CREATING' || live.status === 'CLOSING') {
      return { eligible: false, fallback: false, facts: empty }
    }
    const owned =
      live.status === 'OPEN' &&
      live.health !== 'UNHEALTHY' &&
      live.ownerWorkerId === input.workerId &&
      live.ownerWorkerInstanceId === input.instanceId
    return { eligible: owned, fallback: false, facts: empty }
  }

  const { browserSessions, workers } = schemaFor(db)
  const occupied = await db
    .select({ id: browserSessions.id })
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.ownerWorkerId, input.workerId),
        inArray(browserSessions.status, ['CREATING', 'OPEN', 'CLOSING']),
      ),
    )
  if (occupied.length >= input.maxSessions) {
    return {
      eligible: false,
      fallback: false,
      facts: { ...empty, waitReason: 'WORKER_SESSION_CAPACITY', targetWorkerId: input.workerId },
    }
  }

  const profile = await getSessionProfile(db, key)
  if (!profile || profile.state !== 'PRESENT' || !profile.locationWorkerId) {
    return { eligible: true, fallback: false, facts: empty }
  }
  if (profile.locationWorkerId === input.workerId) {
    return { eligible: true, fallback: false, facts: empty }
  }
  const [origin] = await db.select().from(workers).where(eq(workers.id, profile.locationWorkerId)).limit(1)
  const originReady = origin?.status === 'READY'
  if (!origin || !originReady) {
    return { eligible: true, fallback: true, facts: empty }
  }
  const until = new Date(input.run.createdAt.getTime() + input.scheduling.profileAffinityWaitSeconds * 1000)
  const now = await clockNow(db)
  if (now.getTime() < until.getTime()) {
    return {
      eligible: false,
      fallback: false,
      facts: {
        ...empty,
        waitReason: 'PROFILE_AFFINITY_WAIT',
        targetWorkerId: profile.locationWorkerId,
        profileAffinityUntil: until.toISOString(),
      },
    }
  }
  return { eligible: true, fallback: true, facts: empty }
}

export async function computeOccupancyPlacement(
  db: Db,
  run: {
    status: RunStatus
    createdAt: Date
    targetId: string
    targetAccountId: string | null
    hasActiveLease: boolean
  },
): Promise<RunPlacement> {
  const base = {
    sessionId: null as string | null,
    ownerWorkerId: null as string | null,
    sessionStatus: null as RunPlacement['sessionStatus'],
    waitReason: null as RunPlacement['waitReason'],
    occupyingRunId: null as string | null,
    occupyingOperationId: null as string | null,
    targetWorkerId: null as string | null,
    profileAffinityUntil: null as string | null,
    generation: null as number | null,
    acquireReason: null as RunPlacement['acquireReason'],
    profileFallback: null as boolean | null,
  }
  if (
    run.status === 'SUCCEEDED' ||
    run.status === 'FAILED' ||
    run.status === 'CANCELLED' ||
    run.status === 'NEEDS_REVIEW' ||
    run.status === 'WAITING_FOR_AUTH' ||
    !run.targetAccountId
  ) {
    return { state: 'not_applicable', ...base }
  }
  if (run.hasActiveLease) return { state: 'claimed', ...base }

  const key = { targetId: run.targetId, targetAccountId: run.targetAccountId }
  const live = await findLiveSession(db, key)
  if (live) {
    const withSession = {
      ...base,
      sessionId: live.id,
      ownerWorkerId: live.ownerWorkerId,
      sessionStatus: live.status,
      generation: live.generation,
    }
    if (live.status === 'LOST') return { state: 'session_lost', ...withSession, waitReason: 'SESSION_LOST' }
    const lease = await findActiveLeaseRow(db, live.id)
    if (lease?.purpose === 'EXECUTION') {
      return {
        state: 'owner_required',
        ...withSession,
        waitReason: 'SESSION_IN_USE_BY_RUN',
        occupyingRunId: lease.runId,
      }
    }
    if (lease?.purpose === 'MAINTENANCE') {
      return {
        state: 'owner_required',
        ...withSession,
        waitReason: 'SESSION_IN_MAINTENANCE',
        occupyingOperationId: lease.operationId,
      }
    }
    if (lease?.purpose === 'AUTH_WAIT') {
      return {
        state: 'owner_required',
        ...withSession,
        waitReason: 'SESSION_WAITING_FOR_AUTH',
        occupyingRunId: lease.runId,
        occupyingOperationId: lease.operationId,
      }
    }
    if (live.status === 'CREATING' || live.status === 'CLOSING') {
      return { state: 'session_not_ready', ...withSession }
    }
    const { workers, runLeases } = schemaFor(db)
    const [owner] = await db
      .select({ capacity: workers.capacity })
      .from(workers)
      .where(eq(workers.id, live.ownerWorkerId))
      .limit(1)
    if (owner) {
      const [held] = await db
        .select({ n: sql<number>`count(*)` })
        .from(runLeases)
        .where(
          and(
            eq(runLeases.holderWorkerId, live.ownerWorkerId),
            eq(runLeases.status, 'ACTIVE'),
            sql`${runLeases.expiresAt} > ${databaseNow(db)}`,
          ),
        )
      if (Number(held?.n ?? 0) >= owner.capacity) {
        return {
          state: 'owner_at_capacity',
          ...withSession,
          waitReason: 'WORKER_SESSION_CAPACITY',
          targetWorkerId: live.ownerWorkerId,
        }
      }
    }
    return { state: 'owner_required', ...withSession }
  }

  let scheduling: PlatformSessionScheduling
  try {
    ;({ scheduling } = await readSessionScheduling(db))
  } catch {
    return { state: 'claimable', ...base, waitReason: 'NO_ELIGIBLE_WORKER' }
  }
  const profile = await getSessionProfile(db, key)
  if (profile?.state === 'PRESENT' && profile.locationWorkerId) {
    const { workers } = schemaFor(db)
    const [origin] = await db.select().from(workers).where(eq(workers.id, profile.locationWorkerId)).limit(1)
    if (origin?.status === 'READY') {
      const until = new Date(run.createdAt.getTime() + scheduling.profileAffinityWaitSeconds * 1000)
      const now = await clockNow(db)
      if (now.getTime() < until.getTime()) {
        return {
          state: 'owner_required',
          ...base,
          ownerWorkerId: profile.locationWorkerId,
          targetWorkerId: profile.locationWorkerId,
          waitReason: 'PROFILE_AFFINITY_WAIT',
          profileAffinityUntil: until.toISOString(),
        }
      }
    }
  }
  const { workers } = schemaFor(db)
  const ready = await db.select({ id: workers.id }).from(workers).where(eq(workers.status, 'READY')).limit(1)
  if (!ready.length) return { state: 'claimable', ...base, waitReason: 'NO_ELIGIBLE_WORKER' }
  return { state: 'claimable', ...base }
}

async function insertLease(
  tx: Db,
  input: {
    sessionId: string
    generation: number
    fencingToken: number
    owner: OccupancyOwner
    purpose: SessionLeasePurpose
    holderWorkerId: string
    leaseTtlSeconds: number
    waitDeadlineAt?: Date | null
  },
): Promise<SessionLeaseRow> {
  const { sessionLeases } = schemaFor(tx)
  const ownerKind: SessionLeaseOwnerKind = input.owner.kind
  const [lease] = await insertRows(tx, sessionLeases, {
    id: newId(),
    sessionId: input.sessionId,
    sessionGeneration: input.generation,
    sessionFencingToken: input.fencingToken,
    runId: input.owner.kind === 'RUN' ? input.owner.runId : null,
    operationId: input.owner.kind === 'SESSION_OPERATION' ? input.owner.operationId : null,
    runFencingToken: input.owner.kind === 'RUN' ? input.owner.runFencingToken : null,
    purpose: input.purpose,
    ownerKind,
    holderWorkerId: input.holderWorkerId,
    status: 'ACTIVE',
    expiresAt: afterSeconds(tx, input.leaseTtlSeconds),
    waitDeadlineAt: input.waitDeadlineAt ?? null,
  })
  return lease!
}

async function bumpSessionFence(
  tx: Db,
  sessionId: string,
  touchLastUsed = true,
): Promise<BrowserSessionRow | null> {
  const { browserSessions } = schemaFor(tx)
  const [bumped] = await updateRows(
    tx,
    browserSessions,
    {
      fencingToken: sql`${browserSessions.fencingToken} + 1`,
      ...(touchLastUsed ? { lastUsedAt: databaseNow(tx) } : {}),
      updatedAt: databaseNow(tx),
    },
    eq(browserSessions.id, sessionId),
    {
      id: browserSessions.id,
      generation: browserSessions.generation,
      fencingToken: browserSessions.fencingToken,
      status: browserSessions.status,
      health: browserSessions.health,
      targetId: browserSessions.targetId,
      targetAccountId: browserSessions.targetAccountId,
      ownerWorkerId: browserSessions.ownerWorkerId,
      ownerWorkerInstanceId: browserSessions.ownerWorkerInstanceId,
    },
  )
  return bumped as BrowserSessionRow | null
}

export async function claimSessionUse(db: Db, input: ClaimSessionUseInput): Promise<ClaimSessionUseResult> {
  if (input.purpose === 'EXECUTION' && input.owner.kind !== 'RUN') {
    return { ok: false, code: 'SESSION_NOT_CLAIMABLE', message: 'EXECUTION 只能由 Run 持有' }
  }
  if (
    input.purpose === 'EXECUTION' &&
    input.owner.kind === 'RUN' &&
    (!Number.isInteger(input.owner.runFencingToken) || input.owner.runFencingToken < 1)
  ) {
    return { ok: false, code: 'SESSION_NOT_CLAIMABLE', message: 'EXECUTION 必须带有效 Run fencing' }
  }
  if (input.purpose === 'MAINTENANCE' && input.owner.kind !== 'SESSION_OPERATION') {
    return { ok: false, code: 'SESSION_NOT_CLAIMABLE', message: 'MAINTENANCE 只能由会话操作持有' }
  }
  if (input.maxLifetimeSeconds <= input.idleTtlSeconds) {
    return {
      ok: false,
      code: 'SESSION_POLICY_INVALID',
      message: 'maxLifetimeSeconds 必须大于 idleTtlSeconds',
    }
  }
  try {
    return await atomic(db, async (tx) => {
      const worker = await lockWorkerRow(tx, input.holderWorkerId)
      if (!worker || worker.instanceId !== input.holderInstanceId || worker.status !== 'READY') {
        return { ok: false as const, code: 'SESSION_NOT_CLAIMABLE' as const, message: 'Worker 不可领取' }
      }
      if (!worker.protocolCapabilities?.includes(SESSION_OCCUPANCY_PROTOCOL)) {
        return {
          ok: false as const,
          code: 'SESSION_NOT_CLAIMABLE' as const,
          message: 'Worker 未声明占用协议',
        }
      }
      const { targetAccounts, sessionOperations: operations } = schemaFor(tx)
      await locked(
        tx,
        tx
          .select({ id: targetAccounts.id })
          .from(targetAccounts)
          .where(eq(targetAccounts.id, input.key.targetAccountId)),
      )
      const [reserved] = await tx
        .select({ id: operations.id })
        .from(operations)
        .where(
          and(
            eq(operations.targetId, input.key.targetId),
            eq(operations.targetAccountId, input.key.targetAccountId),
            eq(operations.status, 'RUNNING'),
            inArray(operations.kind, ['CLOSE', 'RESTART', 'RESET_PROFILE']),
          ),
        )
        .limit(1)
      if (reserved && (input.owner.kind !== 'SESSION_OPERATION' || input.owner.operationId !== reserved.id)) {
        return { ok: false as const, code: 'SESSION_BUSY' as const, message: '会话正在关闭或重建' }
      }
      if (input.owner.kind === 'RUN') {
        const run = await lockRunRow(tx, input.owner.runId)
        if (!run) return { ok: false as const, code: 'SESSION_NOT_CLAIMABLE' as const }
      } else {
        const operation = await lockOperationRow(tx, input.owner.operationId)
        if (!operation || operation.status !== 'RUNNING') {
          return { ok: false as const, code: 'SESSION_NOT_CLAIMABLE' as const }
        }
      }

      const { scheduling, revision } = await readSessionScheduling(tx)
      const live = await findLiveSession(tx, input.key)
      if (live) {
        const session = await lockSession(tx, live.id)
        if (!session) return { ok: false as const, code: 'SESSION_NOT_CLAIMABLE' as const }
        if (session.status === 'CLOSING' || session.status === 'LOST') {
          return { ok: false as const, code: 'SESSION_BUSY' as const, message: '会话正在关闭或已失联' }
        }
        if (session.status !== 'OPEN' && session.status !== 'CREATING') {
          return { ok: false as const, code: 'SESSION_NOT_CLAIMABLE' as const }
        }
        if (
          session.ownerWorkerId !== input.holderWorkerId ||
          session.ownerWorkerInstanceId !== input.holderInstanceId
        ) {
          return { ok: false as const, code: 'SESSION_BUSY' as const, message: '会话属于其他 Worker' }
        }
        if (session.status === 'OPEN' && !isClaimable(session)) {
          return { ok: false as const, code: 'SESSION_NOT_CLAIMABLE' as const }
        }
        const existing = await findActiveLeaseRow(tx, session.id)
        if (existing) {
          const sameOwner =
            (input.owner.kind === 'RUN' &&
              existing.runId === input.owner.runId &&
              existing.holderWorkerId === input.holderWorkerId) ||
            (input.owner.kind === 'SESSION_OPERATION' && existing.operationId === input.owner.operationId)
          if (sameOwner && existing.purpose === input.purpose) {
            return {
              ok: true as const,
              grant: toGrant(existing),
              session: (await findLiveSession(tx, input.key))!,
              created: false,
              acquireReason: 'reused' as const,
              profileFallback: false,
              schedulingRevision: revision,
            }
          }
          return { ok: false as const, code: 'SESSION_BUSY' as const }
        }
        const bumped = await bumpSessionFence(tx, session.id, input.touchLastUsed !== false)
        if (!bumped) return { ok: false as const, code: 'SESSION_NOT_CLAIMABLE' as const }
        const lease = await insertLease(tx, {
          sessionId: bumped.id,
          generation: bumped.generation,
          fencingToken: bumped.fencingToken,
          owner: input.owner,
          purpose: input.purpose,
          holderWorkerId: input.holderWorkerId,
          leaseTtlSeconds: input.leaseTtlSeconds,
        })
        return {
          ok: true as const,
          grant: toGrant(lease),
          session: (await findLiveSession(tx, input.key))!,
          created: false,
          acquireReason: 'reused' as const,
          profileFallback: false,
          schedulingRevision: revision,
        }
      }

      const occupied = await countUnclosedForWorker(tx, input.holderWorkerId)
      if (occupied >= worker.maxSessions) {
        return {
          ok: false as const,
          code: 'SESSION_CAPACITY_EXCEEDED' as const,
          message: '本 Worker 会话数已达上限',
        }
      }
      const created = await createSession(tx, {
        key: input.key,
        ownerWorkerId: input.holderWorkerId,
        ownerWorkerInstanceId: input.holderInstanceId,
        reusePolicy: input.reusePolicy,
        idleTtlSeconds: input.idleTtlSeconds,
        maxLifetimeSeconds: input.maxLifetimeSeconds,
      })
      if (!created.ok) return { ok: false as const, code: created.code, message: created.message }
      const session = await lockSession(tx, created.session.id)
      if (!session) return { ok: false as const, code: 'SESSION_NOT_CLAIMABLE' as const }
      const bumped = await bumpSessionFence(tx, session.id, input.touchLastUsed !== false)
      if (!bumped) return { ok: false as const, code: 'SESSION_NOT_CLAIMABLE' as const }
      const lease = await insertLease(tx, {
        sessionId: bumped.id,
        generation: bumped.generation,
        fencingToken: bumped.fencingToken,
        owner: input.owner,
        purpose: input.purpose,
        holderWorkerId: input.holderWorkerId,
        leaseTtlSeconds: input.leaseTtlSeconds,
      })
      const profile = await getSessionProfile(tx, input.key)
      let profileFallback = false
      if (
        profile?.state === 'PRESENT' &&
        profile.locationWorkerId &&
        profile.locationWorkerId !== input.holderWorkerId
      ) {
        await transferProfileLocation(
          tx,
          input.key,
          profile.locationWorkerId,
          input.holderWorkerId,
          profile.revision,
        )
        profileFallback = true
      } else if (!profile) {
        await upsertSessionProfile(tx, {
          key: input.key,
          workerId: input.holderWorkerId,
          revision: 1,
          state: 'PRESENT',
        })
      }
      void scheduling
      const liveAfter = (await findLiveSession(tx, input.key))!
      return {
        ok: true as const,
        grant: toGrant(lease),
        session: liveAfter,
        created: true,
        acquireReason: 'created' as const,
        profileFallback,
        schedulingRevision: revision,
      }
    })
  } catch (error) {
    if (error instanceof SessionDomainError) {
      if (error.code === 'SESSION_BUSY') return { ok: false, code: 'SESSION_BUSY', message: error.message }
      if (error.code === 'SESSION_TARGET_MISSING' || error.code === 'SESSION_POLICY_INVALID') {
        return { ok: false, code: error.code, message: error.message }
      }
      return { ok: false, code: 'SESSION_NOT_CLAIMABLE', message: error.message }
    }
    if (isUniqueViolation(error)) {
      return { ok: false, code: 'SESSION_BUSY', message: '同键会话或租约冲突' }
    }
    throw error
  }
}

async function countUnclosedForWorker(db: Db, workerId: string): Promise<number> {
  const { browserSessions } = schemaFor(db)
  const rows = await db
    .select({ id: browserSessions.id })
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.ownerWorkerId, workerId),
        inArray(browserSessions.status, ['CREATING', 'OPEN', 'CLOSING']),
      ),
    )
  return rows.length
}

export async function transitionSessionUse(
  db: Db,
  input: {
    sessionId: string
    fromPurpose: SessionLeasePurpose
    toPurpose: SessionLeasePurpose | 'RELEASE'
    owner: OccupancyOwner
    holderWorkerId: string
    holderInstanceId: string
    leaseTtlSeconds: number
    waitSeconds?: number
    runGrant?: {
      runId: string
      leaseId: string
      fencingToken: number
      holderWorkerId: string
      expiresAt: string
    }
    reason?: string
  },
): Promise<SessionGrant | null> {
  return atomic(db, async (tx) => {
    const worker = await lockWorkerRow(tx, input.holderWorkerId)
    if (!worker || worker.instanceId !== input.holderInstanceId) return null
    if (input.owner.kind === 'RUN') {
      const run = await lockRunRow(tx, input.owner.runId)
      if (input.toPurpose === 'AUTH_WAIT' && (!run || run.status !== 'RUNNING' || run.cancelRequestedAt ||
          !input.runGrant || !(await verifyRunLeaseForWrite(tx, input.runGrant)))) return null
    }
    else await lockOperationRow(tx, input.owner.operationId)
    const session = await lockSession(tx, input.sessionId)
    if (!session || session.status !== 'OPEN' || session.ownerWorkerInstanceId !== input.holderInstanceId) return null
    const current = await findActiveLeaseRow(tx, input.sessionId)
    if (
      !current ||
      current.purpose !== input.fromPurpose ||
      current.holderWorkerId !== input.holderWorkerId ||
      (input.owner.kind === 'RUN' ? current.runId !== input.owner.runId : current.operationId !== input.owner.operationId) ||
      (input.fromPurpose === 'EXECUTION' && input.owner.kind === 'RUN' && current.runFencingToken !== input.owner.runFencingToken)
    ) {
      return null
    }
    const { sessionLeases, browserSessions, runs } = schemaFor(tx)
    const now = await clockNow(tx)
    await updateRows(
      tx,
      sessionLeases,
      { status: 'RELEASED', releasedAt: now, releaseReason: input.reason ?? `transition_${input.toPurpose}` },
      and(eq(sessionLeases.id, current.id), eq(sessionLeases.status, 'ACTIVE')),
    )
    const bumped = await bumpSessionFence(tx, input.sessionId)
    if (!bumped) return null

    if (input.toPurpose === 'RELEASE') {
      await updateRows(
        tx,
        browserSessions,
        {
          authControlActorId: null,
          authControlTokenHash: null,
          authControlExpiresAt: null,
          authControlPageId: null,
          updatedAt: now,
        },
        eq(browserSessions.id, input.sessionId),
      )
      if (input.owner.kind === 'RUN') {
        await updateRows(
          tx,
          runs,
          { status: 'RECOVERING', updatedAt: now },
          and(eq(runs.id, input.owner.runId), eq(runs.status, 'WAITING_FOR_AUTH')),
        )
        await appendRunEvents(tx, input.owner.runId, [
          { type: 'run.auth_resumed', payload: { status: 'RECOVERING' } },
        ])
      }
      return null
    }

    let waitDeadlineAt: Date | null = null
    if (input.toPurpose === 'AUTH_WAIT') {
      const seconds = input.waitSeconds
      if (!seconds || seconds < 1) throw conflict('SESSION_POLICY_INVALID', 'AUTH_WAIT 必须冻结等待截止')
      waitDeadlineAt = new Date(now.getTime() + seconds * 1000)
    }
    const next = await insertLease(tx, {
      sessionId: input.sessionId,
      generation: bumped.generation,
      fencingToken: bumped.fencingToken,
      owner: input.owner,
      purpose: input.toPurpose,
      holderWorkerId: input.holderWorkerId,
      leaseTtlSeconds: input.leaseTtlSeconds,
      waitDeadlineAt,
    })
    if (input.toPurpose === 'AUTH_WAIT') {
      await updateRows(
        tx,
        browserSessions,
        {
          // Changing occupancy cannot invent an authentication observation.
          authControlActorId: null,
          authControlTokenHash: null,
          authControlExpiresAt: null,
          authControlPageId: null,
          updatedAt: now,
        },
        eq(browserSessions.id, input.sessionId),
      )
      if (input.owner.kind === 'RUN' && input.runGrant) {
        await updateRows(
          tx,
          runs,
          { status: 'WAITING_FOR_AUTH', updatedAt: now },
          and(eq(runs.id, input.owner.runId), eq(runs.status, 'RUNNING')),
        )
        await releaseRunLeaseTx(tx, input.runGrant, 'waiting_for_auth')
        await appendRunEvents(tx, input.owner.runId, [
          { type: 'run.auth_wait', payload: { status: 'WAITING_FOR_AUTH' } },
        ])
      }
    }
    return toGrant(next)
  })
}

export async function renewSessionUse(
  db: Db,
  input: { leaseId: string; holderWorkerId: string; leaseTtlSeconds: number },
): Promise<SessionLeaseRow | null> {
  const { browserSessions, sessionLeases } = schemaFor(db)
  const [row] = await updateRows(
    db,
    sessionLeases,
    {
      expiresAt: afterSeconds(db, input.leaseTtlSeconds),
      heartbeatAt: databaseNow(db),
    },
    and(
      eq(sessionLeases.id, input.leaseId),
      eq(sessionLeases.holderWorkerId, input.holderWorkerId),
      eq(sessionLeases.status, 'ACTIVE'),
      sql`${sessionLeases.expiresAt} > ${databaseNow(db)}`,
      sql`EXISTS (SELECT 1 FROM ${browserSessions} s WHERE s.id = ${sessionLeases.sessionId}
      AND s.status IN ('OPEN', 'CREATING') AND s.generation = ${sessionLeases.sessionGeneration})`,
    ),
  )
  return row ?? null
}

export async function releaseSessionUse(
  db: Db,
  input: { leaseId: string; holderWorkerId: string; reason: string },
): Promise<'released' | 'already' | 'unknown'> {
  const { sessionLeases } = schemaFor(db)
  const [updated] = await updateRows(
    db,
    sessionLeases,
    { status: 'RELEASED', releasedAt: new Date(), releaseReason: input.reason },
    and(
      eq(sessionLeases.id, input.leaseId),
      eq(sessionLeases.holderWorkerId, input.holderWorkerId),
      eq(sessionLeases.status, 'ACTIVE'),
    ),
    { id: sessionLeases.id },
  )
  if (updated) return 'released'
  const [row] = await db.select().from(sessionLeases).where(eq(sessionLeases.id, input.leaseId)).limit(1)
  if (!row) return 'unknown'
  if (row.status !== 'ACTIVE') return 'already'
  return 'unknown'
}

export async function recoverSessionOperations(db: Db): Promise<number> {
  return atomic(db, async (tx) => {
    const { sessionOperations, workers, browserSessions, runs } = schemaFor(tx)
    const now = await clockNow(tx)
    const active = await tx
      .select()
      .from(sessionOperations)
      .where(inArray(sessionOperations.status, ['RUNNING', 'WAITING_FOR_AUTH']))
    let recovered = 0
    for (const op of active) {
      if (!isSessionMaintenanceKind(op.kind)) continue
      if (typeof op.kindParams?.reusedRunId === 'string' && op.kind !== 'REFRESH_LOGIN_PAGE') {
        const [run] = await tx.select().from(runs).where(eq(runs.id, op.kindParams.reusedRunId)).limit(1)
        if (run && run.status !== 'WAITING_FOR_AUTH') {
          const success = ['QUEUED', 'RUNNING', 'HOLDING', 'SUCCEEDED'].includes(run.status)
          const status = success ? 'SUCCEEDED' : 'FAILED'
          if (
            await finishSessionOperation(tx, {
              operationId: op.id,
              workerId: op.ownerWorkerId ?? '',
              status,
              errorCode: success ? undefined : 'OPERATION_INTERRUPTED',
            })
          ) {
            await appendSessionEvent(tx, {
              key: op,
              type: 'operation.finished',
              operationId: op.id,
              runId: run.id,
              payload: { status },
            })
            recovered += 1
          }
          continue
        }
      }
      const [worker] = await tx
        .select()
        .from(workers)
        .where(eq(workers.id, op.ownerWorkerId ?? ''))
        .limit(1)
      if (
        worker &&
        worker.instanceId === op.ownerWorkerInstanceId &&
        ['READY', 'DRAINING'].includes(worker.status) &&
        worker.heartbeatExpiresAt &&
        worker.heartbeatExpiresAt > now
      )
        continue
      const unknown = op.kindParams?.loginSubmitted === true
      const errorCode = unknown ? 'OUTCOME_UNKNOWN' : 'OPERATION_INTERRUPTED'
      if (
        !(await finishSessionOperation(tx, {
          operationId: op.id,
          workerId: op.ownerWorkerId ?? '',
          status: 'FAILED',
          errorCode,
        }))
      )
        continue
      if (unknown && op.expectedSessionId)
        await updateRows(
          tx,
          browserSessions,
          { authState: 'UNKNOWN', updatedAt: now },
          eq(browserSessions.id, op.expectedSessionId),
        )
      await appendSessionEvent(tx, {
        key: op,
        type: 'operation.finished',
        sessionId: op.expectedSessionId,
        operationId: op.id,
        payload: { status: 'FAILED', errorCode, attemptId: `${op.id}:${op.attemptNo}` },
      })
      recovered += 1
    }
    return recovered
  })
}

export async function markMaintenanceLoginSubmitted(
  db: Db,
  operationId: string,
  workerInstanceId: string,
  submitted = true,
): Promise<void> {
  const { sessionOperations } = schemaFor(db)
  const op = await getSessionOperation(db, operationId)
  if (!op || op.ownerWorkerInstanceId !== workerInstanceId || op.status !== 'RUNNING')
    throw conflict('OPERATION_INTERRUPTED', '操作已失效')
  await updateRows(
    db,
    sessionOperations,
    { kindParams: { ...op.kindParams, loginSubmitted: submitted }, updatedAt: new Date() },
    and(
      eq(sessionOperations.id, operationId),
      eq(sessionOperations.ownerWorkerInstanceId, workerInstanceId),
      eq(sessionOperations.status, 'RUNNING'),
    ),
  )
}

export async function reapSessionLeases(
  db: Db,
  input: { limit?: number; maxRecoveries?: number } = {},
): Promise<number> {
  await recoverSessionOperations(db)
  const limit = input.limit ?? 100
  const maxRecoveries = input.maxRecoveries ?? 3
  const expiredOperations: string[] = []
  const { sessionLeases } = schemaFor(db)
  // Read candidates without locks, then serialize the account before taking
  // owner → Session → SessionLease, as cancellation and auth completion do.
  const candidates = await db.select().from(sessionLeases).where(and(
    eq(sessionLeases.status, 'ACTIVE'),
    or(sql`${sessionLeases.expiresAt} <= ${databaseNow(db)}`,
      and(eq(sessionLeases.purpose, 'AUTH_WAIT'), sql`${sessionLeases.waitDeadlineAt} <= ${databaseNow(db)}`)),
  )).orderBy(sessionLeases.expiresAt, sessionLeases.id).limit(limit)
  let count = 0
  for (const candidate of candidates) {
    const settled = await atomic(db, async (tx) => {
      const { sessionLeases, browserSessions, sessionOperations, targetAccounts } = schemaFor(tx)
      const [scope] = await tx.select({ accountId: browserSessions.targetAccountId }).from(browserSessions).where(eq(browserSessions.id, candidate.sessionId))
      if (scope) await locked(tx, tx.select({ id: targetAccounts.id }).from(targetAccounts).where(eq(targetAccounts.id, scope.accountId)))
      if (candidate.runId) await lockRunRow(tx, candidate.runId)
      if (candidate.operationId) await lockOperationRow(tx, candidate.operationId)
      await lockSession(tx, candidate.sessionId)
      const [lease] = await locked(tx, tx.select().from(sessionLeases).where(eq(sessionLeases.id, candidate.id)))
      if (!lease || lease.status !== 'ACTIVE') return false
      const now = await clockNow(tx)
      const holderExpired = lease.expiresAt.getTime() <= now.getTime()
      const deadlineExpired = lease.purpose === 'AUTH_WAIT' && lease.waitDeadlineAt && lease.waitDeadlineAt.getTime() <= now.getTime()
      if (!holderExpired && !deadlineExpired) return false
      if (lease.purpose === 'AUTH_WAIT' && holderExpired) {
        await expireAuthWaitHolderLost(tx, lease, now, maxRecoveries)
      } else if (lease.purpose === 'AUTH_WAIT' && deadlineExpired) {
        await expireAuthWaitDeadline(tx, lease, now)
      } else {
        await updateRows(
          tx,
          sessionLeases,
          { status: 'EXPIRED', releasedAt: now, releaseReason: 'lease_expired' },
          and(eq(sessionLeases.id, lease.id), eq(sessionLeases.status, 'ACTIVE')),
        )
        if (lease.purpose === 'MAINTENANCE' && lease.operationId) {
          const op = await getSessionOperation(tx, lease.operationId)
          const unknown = op?.kindParams?.loginSubmitted === true
          if (unknown)
            await updateRows(
              tx,
              browserSessions,
              { authState: 'UNKNOWN', updatedAt: now },
              eq(browserSessions.id, lease.sessionId),
            )
          await updateRows(
            tx,
            sessionOperations,
            {
              status: 'FAILED',
              errorCode: unknown ? 'OUTCOME_UNKNOWN' : 'OPERATION_INTERRUPTED',
              finishedAt: now,
              updatedAt: now,
            },
            and(
              eq(sessionOperations.id, lease.operationId),
              inArray(sessionOperations.status, ['RUNNING', 'WAITING_FOR_AUTH']),
            ),
          )
        }
      }
      return true
    })
    if (settled) {
      count += 1
      if (candidate.operationId) expiredOperations.push(candidate.operationId)
    }
  }
  for (const id of expiredOperations) {
    const op = await getSessionOperation(db, id)
    if (op && isSessionMaintenanceKind(op.kind) && op.status === 'FAILED')
      await appendSessionEvent(db, {
        key: op,
        type: 'operation.finished',
        operationId: id,
        sessionId: op.expectedSessionId,
        payload: { status: op.status, errorCode: op.errorCode, attemptId: `${op.id}:${op.attemptNo}` },
      })
  }
  return count
}

async function expireAuthWaitHolderLost(
  tx: Db,
  lease: SessionLeaseRow,
  now: Date,
  maxRecoveries: number,
): Promise<void> {
  const { sessionLeases, browserSessions, runs, sessionOperations, workers, runLeases } = schemaFor(tx)
  await updateRows(
    tx,
    sessionLeases,
    { status: 'EXPIRED', releasedAt: now, releaseReason: 'auth_wait_holder_lost' },
    and(eq(sessionLeases.id, lease.id), eq(sessionLeases.status, 'ACTIVE')),
  )
  await updateRows(
    tx,
    browserSessions,
    {
      authHoldRunId: null,
      authHoldExpiresAt: null,
      authHoldWorkerId: null, authHoldWorkerInstanceId: null, authHoldSessionGeneration: null,
      authControlEpoch: sql`${browserSessions.authControlEpoch} + 1`,
      authControlActorId: null,
      authControlTokenHash: null,
      authControlExpiresAt: null,
      authControlPageId: null,
      updatedAt: now,
      version: sql`${browserSessions.version} + 1`,
    },
    eq(browserSessions.id, lease.sessionId),
  )
  // The Worker heartbeat reaper may already have isolated this session as LOST.
  // Control cleanup above still applies; never turn a CLOSED instance back into LOST.
  await updateRows(tx, browserSessions, { status: 'LOST', closeReason: 'auth_wait_holder_lost' },
    and(eq(browserSessions.id, lease.sessionId), inArray(browserSessions.status, ['OPEN', 'CREATING', 'CLOSING'])))
  if (lease.ownerKind === 'RUN' && lease.runId) {
    await lockRunRow(tx, lease.runId)
    const [counted] = await tx
      .select({ id: runLeases.id })
      .from(runLeases)
      .where(
        and(
          eq(runLeases.runId, lease.runId),
          or(
            eq(runLeases.status, 'ACTIVE'),
            and(eq(runLeases.status, 'RELEASED'), eq(runLeases.releaseReason, 'waiting_for_auth')),
          ),
        ),
      )
      .orderBy(desc(runLeases.fencingToken))
      .limit(1)
    if (counted) {
      await updateRows(
        tx,
        runLeases,
        { status: 'EXPIRED', releasedAt: now, releaseReason: 'auth_wait_holder_lost' },
        eq(runLeases.id, counted.id),
      )
    } else {
      const [token] = await tx
        .select({ t: sql<number>`COALESCE(MAX(${runLeases.fencingToken}), 0) + 1` })
        .from(runLeases)
        .where(eq(runLeases.runId, lease.runId))
      await insertRows(tx, runLeases, {
        id: newId(),
        runId: lease.runId,
        fencingToken: Number(token?.t ?? 1),
        holderWorkerId: lease.holderWorkerId,
        status: 'EXPIRED',
        expiresAt: now,
        releasedAt: now,
        releaseReason: 'auth_wait_holder_lost',
      })
    }
    const failed = await countFailedRecoveries(tx, lease.runId)
    if (failed >= maxRecoveries) {
      await updateRows(
        tx,
        runs,
        { status: 'NEEDS_REVIEW', updatedAt: now },
        and(eq(runs.id, lease.runId), eq(runs.status, 'WAITING_FOR_AUTH')),
      )
      await appendRunEvents(tx, lease.runId, [
        { type: 'run.status_changed', payload: { status: 'NEEDS_REVIEW', reason: 'auth_wait_holder_lost' } },
      ])
    } else {
      await updateRows(
        tx,
        runs,
        { status: 'RECOVERING', updatedAt: now },
        and(eq(runs.id, lease.runId), eq(runs.status, 'WAITING_FOR_AUTH')),
      )
      await appendRunEvents(tx, lease.runId, [
        { type: 'run.status_changed', payload: { status: 'RECOVERING', reason: 'auth_wait_holder_lost' } },
      ])
    }
  }
  if (lease.ownerKind === 'SESSION_OPERATION' && lease.operationId) {
    await updateRows(
      tx,
      sessionOperations,
      { status: 'FAILED', errorCode: 'auth_wait_holder_lost', finishedAt: now, updatedAt: now },
      and(
        eq(sessionOperations.id, lease.operationId),
        inArray(sessionOperations.status, ['RUNNING', 'WAITING_FOR_AUTH']),
      ),
    )
  }
  void workers
}

async function expireAuthWaitDeadline(tx: Db, lease: SessionLeaseRow, now: Date): Promise<void> {
  const { sessionLeases, browserSessions, runs, sessionOperations, evidences } = schemaFor(tx)
  await updateRows(
    tx,
    sessionLeases,
    { status: 'EXPIRED', releasedAt: now, releaseReason: 'auth_wait_deadline' },
    and(eq(sessionLeases.id, lease.id), eq(sessionLeases.status, 'ACTIVE')),
  )
  await updateRows(
    tx,
    browserSessions,
    {
      // A human-control deadline says nothing about the target's login state.
      authHoldRunId: null,
      authHoldExpiresAt: null,
      authControlEpoch: sql`${browserSessions.authControlEpoch} + 1`,
      authControlActorId: null,
      authControlTokenHash: null,
      authControlExpiresAt: null,
      authControlPageId: null,
      updatedAt: now,
    },
    eq(browserSessions.id, lease.sessionId),
  )
  if (lease.ownerKind === 'RUN' && lease.runId) {
    const run = await lockRunRow(tx, lease.runId)
    if (run?.status === 'WAITING_FOR_AUTH') {
      const [moved] = await updateRows(
        tx,
        runs,
        { status: 'FAILED', finishedAt: now, updatedAt: now },
        and(eq(runs.id, lease.runId), eq(runs.status, 'WAITING_FOR_AUTH')),
      )
      if (moved) {
        await tx.insert(evidences).values({
          id: newId(),
          runId: lease.runId,
          type: 'error',
          schemaVersion: 1,
          payload: {
            code: 'SESSION_AUTH_TIMEOUT',
            category: 'INFRASTRUCTURE',
            retryable: false,
            safeMessage: '等待人工认证超时',
          },
          createdAt: now,
        })
        await skipRemainingStepRunsTx(tx, lease.runId, now)
        await appendRunEvents(tx, lease.runId, [
          { type: 'run.status_changed', payload: { status: 'FAILED' } },
          { type: 'evidence.recorded', payload: { type: 'error', status: 'available' } },
        ])
      }
    }
  }
  if (lease.ownerKind === 'SESSION_OPERATION' && lease.operationId) {
    await updateRows(
      tx,
      sessionOperations,
      { status: 'FAILED', errorCode: 'SESSION_AUTH_TIMEOUT', finishedAt: now, updatedAt: now },
      and(
        eq(sessionOperations.id, lease.operationId),
        inArray(sessionOperations.status, ['RUNNING', 'WAITING_FOR_AUTH']),
      ),
    )
  }
}

export async function requestSessionOperation(
  db: Db,
  input: {
    key: SessionKey
    kind: SessionOperationKind
    kindParams?: Record<string, unknown>
    origin: SessionOperationOrigin
    idempotencyKey: string
    expectedSessionId?: string | null
    expectedGeneration?: number | null
  },
): Promise<{ operation: SessionOperationRow; created: boolean }> {
  const { scheduling, revision } = await readSessionScheduling(db)
  const digest = sha256Hex(
    canonicalJson({
      kind: input.kind,
      kindParams: input.kindParams ?? {},
      origin: input.origin,
      expectedSessionId: input.expectedSessionId ?? null,
      expectedGeneration: input.expectedGeneration ?? null,
    }),
  )
  return atomic(db, async (tx) => {
    const { sessionOperations } = schemaFor(tx)
    const now = await clockNow(tx)
    const [existing] = await tx
      .select()
      .from(sessionOperations)
      .where(
        and(
          eq(sessionOperations.targetId, input.key.targetId),
          eq(sessionOperations.targetAccountId, input.key.targetAccountId),
          eq(sessionOperations.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1)
    if (existing) {
      if (existing.contentDigest !== digest) {
        throw conflict('OPERATION_IDEMPOTENCY_CONFLICT', '同幂等键内容不一致')
      }
      return { operation: existing, created: false }
    }
    const [row] = await insertRows(tx, sessionOperations, {
      id: newId(),
      targetId: input.key.targetId,
      targetAccountId: input.key.targetAccountId,
      kind: input.kind,
      kindParams: input.kindParams ?? {},
      origin: input.origin,
      status: 'QUEUED',
      expectedSessionId: input.expectedSessionId ?? null,
      expectedGeneration: input.expectedGeneration ?? null,
      idempotencyKey: input.idempotencyKey,
      contentDigest: digest,
      secretRefs: [],
      platformConfigRevision: revision,
      queueDeadlineAt: new Date(now.getTime() + scheduling.operationQueueTimeoutSeconds * 1000),
      attemptNo: 0,
      createdAt: now,
      updatedAt: now,
    })
    return { operation: row!, created: true }
  })
}

export type ClaimedSessionOperation = {
  operation: SessionOperationRow
  grant: SessionGrant | null
  session: SessionRecord | null
  reusedRunId: string | null
}

export async function claimSessionOperation(
  db: Db,
  input: { workerId: string; instanceId: string; leaseTtlSeconds: number },
): Promise<ClaimedSessionOperation | null> {
  return atomic(db, async (tx) => {
    const worker = await lockWorkerRow(tx, input.workerId)
    if (!worker || worker.instanceId !== input.instanceId || worker.status !== 'READY') return null
    if (!worker.protocolCapabilities?.includes(SESSION_OCCUPANCY_PROTOCOL)) return null
    const hasMaintenance = Boolean(worker.protocolCapabilities?.includes(SESSION_MAINTENANCE_PROTOCOL))
    const { sessionOperations, runs } = schemaFor(tx)
    const now = await clockNow(tx)
    const expired = await tx
      .select()
      .from(sessionOperations)
      .where(and(eq(sessionOperations.status, 'QUEUED'), lte(sessionOperations.queueDeadlineAt, now)))
      .limit(20)
    for (const row of expired) {
      const { targetAccounts } = schemaFor(tx)
      await locked(
        tx,
        tx
          .select({ id: targetAccounts.id })
          .from(targetAccounts)
          .where(eq(targetAccounts.id, row.targetAccountId)),
      )
      const [expiredRow] = await updateRows(
        tx,
        sessionOperations,
        { status: 'FAILED', errorCode: 'OPERATION_QUEUE_EXPIRED', finishedAt: now, updatedAt: now },
        and(eq(sessionOperations.id, row.id), eq(sessionOperations.status, 'QUEUED')),
      )
      if (expiredRow)
        await appendSessionEvent(tx, {
          key: row,
          type: 'operation.finished',
          operationId: row.id,
          payload: { status: 'FAILED', errorCode: 'OPERATION_QUEUE_EXPIRED' },
        })
    }
    const candidates = await tx
      .select()
      .from(sessionOperations)
      .where(and(eq(sessionOperations.status, 'QUEUED'), gt(sessionOperations.queueDeadlineAt, now)))
      .orderBy(asc(sessionOperations.createdAt), asc(sessionOperations.id))
      .limit(20)
    for (const snapshot of candidates) {
      if (isSessionMaintenanceKind(snapshot.kind) && !hasMaintenance) continue
      const { targetAccounts } = schemaFor(tx)
      await locked(
        tx,
        tx
          .select({ id: targetAccounts.id })
          .from(targetAccounts)
          .where(eq(targetAccounts.id, snapshot.targetAccountId)),
      )
      const candidate = await lockOperationRow(tx, snapshot.id)
      if (!candidate || candidate.status !== 'QUEUED' || candidate.queueDeadlineAt <= now) continue
      if (isSessionMaintenanceKind(candidate.kind)) {
        try {
          await assertMaintenanceAuthorized(tx, candidate)
        } catch {
          await updateRows(
            tx,
            sessionOperations,
            { status: 'FAILED', errorCode: 'AUTH_CONFIGURATION_REVOKED', finishedAt: now, updatedAt: now },
            eq(sessionOperations.id, candidate.id),
          )
          await appendSessionEvent(tx, {
            key: candidate,
            type: 'operation.finished',
            operationId: candidate.id,
            payload: { status: 'FAILED', errorCode: 'AUTH_CONFIGURATION_REVOKED' },
          })
          continue
        }
      }

      if (candidate.origin === 'BACKGROUND') {
        const [queuedRun] = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              inArray(runs.status, ['QUEUED', 'RECOVERING']),
              eq(runs.targetId, candidate.targetId),
              eq(runs.targetAccountId, candidate.targetAccountId),
              isNull(runs.deletedAt),
            ),
          )
          .limit(1)
        if (queuedRun) continue
        const liveBusy = await findLiveSession(tx, {
          targetId: candidate.targetId,
          targetAccountId: candidate.targetAccountId,
        })
        if (liveBusy && (await findActiveLeaseRow(tx, liveBusy.id))) continue
      }
      if (candidate.expectedSessionId) {
        const live = await findLiveSession(tx, {
          targetId: candidate.targetId,
          targetAccountId: candidate.targetAccountId,
        })
        if (
          !live ||
          live.id !== candidate.expectedSessionId ||
          (candidate.expectedGeneration != null && live.generation !== candidate.expectedGeneration)
        ) {
          await updateRows(
            tx,
            sessionOperations,
            { status: 'FAILED', errorCode: 'SESSION_GENERATION_CHANGED', finishedAt: now, updatedAt: now },
            and(eq(sessionOperations.id, candidate.id), eq(sessionOperations.status, 'QUEUED')),
          )
          await appendSessionEvent(tx, {
            key: candidate,
            type: 'operation.finished',
            operationId: candidate.id,
            payload: { status: 'FAILED', errorCode: 'SESSION_GENERATION_CHANGED' },
          })
          continue
        }
      }
      const [moved] = await updateRows(
        tx,
        sessionOperations,
        {
          status: 'RUNNING',
          ownerWorkerId: input.workerId,
          ownerWorkerInstanceId: input.instanceId,
          claimToken: randomBytes(16).toString('hex'),
          attemptNo: candidate.attemptNo + 1,
          updatedAt: now,
        },
        and(eq(sessionOperations.id, candidate.id), eq(sessionOperations.status, 'QUEUED')),
      )
      if (!moved) continue

      const key = { targetId: candidate.targetId, targetAccountId: candidate.targetAccountId }
      if (candidate.kind === 'LOGIN' || candidate.kind === 'REFRESH_LOGIN_PAGE') {
        const live = await findLiveSession(tx, key)
        const existing = live ? await findActiveLeaseRow(tx, live.id) : null
        if (existing?.purpose === 'AUTH_WAIT' && live) {
          if (live.ownerWorkerId !== input.workerId || live.ownerWorkerInstanceId !== input.instanceId) {
            await rollbackClaim(tx, candidate, now)
            continue
          }
          if (candidate.kind === 'REFRESH_LOGIN_PAGE') {
            return { operation: moved, grant: toGrant(existing), session: live, reusedRunId: existing.runId }
          }
          if (!existing.runId) {
            await rollbackClaim(tx, candidate, now)
            continue
          }
          await updateRows(
            tx,
            sessionOperations,
            {
              status: 'WAITING_FOR_AUTH',
              kindParams: { ...candidate.kindParams, reusedRunId: existing.runId },
              updatedAt: now,
            },
            eq(sessionOperations.id, candidate.id),
          )
          const waiting = await getSessionOperation(tx, candidate.id)
          return {
            operation: waiting ?? moved,
            grant: toGrant(existing),
            session: live,
            reusedRunId: existing.runId,
          }
        }
      }

      if (isSessionIdleOnlyKind(candidate.kind)) {
        const live = await findLiveSession(tx, key)
        if (candidate.kind !== 'RESET_PROFILE' && (!live || live.status !== 'OPEN')) {
          await updateRows(
            tx,
            sessionOperations,
            {
              status: 'FAILED',
              errorCode: 'SESSION_NOT_CLAIMABLE',
              finishedAt: now,
              updatedAt: now,
            },
            eq(sessionOperations.id, candidate.id),
          )
          continue
        }
        if (
          live &&
          (live.ownerWorkerId !== input.workerId || live.ownerWorkerInstanceId !== input.instanceId)
        ) {
          await rollbackClaim(tx, candidate, now)
          continue
        }
        if (live) {
          await lockSession(tx, live.id)
          const existing = await findActiveLeaseRow(tx, live.id)
          if (existing) {
            await updateRows(
              tx,
              sessionOperations,
              { status: 'FAILED', errorCode: 'SESSION_OPERATION_CONFLICT', finishedAt: now, updatedAt: now },
              eq(sessionOperations.id, candidate.id),
            )
            await appendSessionEvent(tx, {
              key: candidate,
              type: 'operation.finished',
              operationId: candidate.id,
              payload: {
                status: 'FAILED',
                errorCode: 'SESSION_OPERATION_CONFLICT',
                occupyingRunId: existing.runId,
              },
            })
            continue
          }
          if (live.status === 'OPEN') {
            const { browserSessions } = schemaFor(tx)
            await updateRows(
              tx,
              browserSessions,
              {
                status: 'CLOSING',
                closeReason: 'session_operation',
                version: sql`${browserSessions.version} + 1`,
                updatedAt: now,
              },
              eq(browserSessions.id, live.id),
            )
          }
        }
        return { operation: moved, grant: null, session: live, reusedRunId: null }
      }

      if (
        ['VERIFY_AUTH', 'RENEW_AUTH', 'REFRESH_LOGIN_PAGE'].includes(candidate.kind) &&
        !candidate.expectedSessionId
      ) {
        await updateRows(
          tx,
          sessionOperations,
          { status: 'FAILED', errorCode: 'SESSION_NOT_CLAIMABLE', finishedAt: now, updatedAt: now },
          eq(sessionOperations.id, candidate.id),
        )
        continue
      }
      if (candidate.kind === 'VALIDATE_AUTH_PROFILE' || isSessionLeaseClaimKind(candidate.kind)) {
        const claimed = await claimSessionUse(tx, {
          key,
          owner: { kind: 'SESSION_OPERATION', operationId: candidate.id },
          purpose: 'MAINTENANCE',
          holderWorkerId: input.workerId,
          holderInstanceId: input.instanceId,
          leaseTtlSeconds: input.leaseTtlSeconds,
          reusePolicy: 'NEW_PAGE',
          idleTtlSeconds: 600,
          maxLifetimeSeconds: 14_400,
          touchLastUsed: !['VERIFY_AUTH', 'RENEW_AUTH'].includes(candidate.kind),
        })
        if (!claimed.ok) {
          await rollbackClaim(tx, candidate, now)
          continue
        }
        await bindOperationSession(tx, moved.id, claimed.session.id, claimed.session.generation)
        return {
          operation: {
            ...moved,
            expectedSessionId: claimed.session.id,
            expectedGeneration: claimed.session.generation,
          },
          grant: claimed.grant,
          session: claimed.session,
          reusedRunId: null,
        }
      }

      await rollbackClaim(tx, candidate, now)
    }
    return null
  })
}

async function rollbackClaim(tx: Db, candidate: SessionOperationRow, now: Date): Promise<void> {
  const { sessionOperations } = schemaFor(tx)
  await updateRows(
    tx,
    sessionOperations,
    {
      status: 'QUEUED',
      ownerWorkerId: null,
      ownerWorkerInstanceId: null,
      claimToken: null,
      attemptNo: candidate.attemptNo,
      updatedAt: now,
    },
    eq(sessionOperations.id, candidate.id),
  )
}

export async function finishSessionOperation(
  db: Db,
  input: {
    operationId: string
    workerId: string
    status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
    workerInstanceId?: string
    claimToken?: string
    authControl?: { sessionId: string; token: string; actorId: string; generation: number; epoch: number }
    errorCode?: string
  },
): Promise<boolean> {
  return atomic(db, async (tx) => {
    const initial = await getSessionOperation(tx, input.operationId)
    if (!initial) return false
    const { targetAccounts } = schemaFor(tx)
    await locked(
      tx,
      tx
        .select({ id: targetAccounts.id })
        .from(targetAccounts)
        .where(eq(targetAccounts.id, initial.targetAccountId)),
    )
    const operation = await lockOperationRow(tx, input.operationId)
    if (!operation) return false
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(operation.status)) return false
    if (operation.ownerWorkerId && operation.ownerWorkerId !== input.workerId) return false
    if (input.workerInstanceId && operation.ownerWorkerInstanceId !== input.workerInstanceId) return false
    if (input.claimToken && operation.claimToken !== input.claimToken) return false
    if (input.authControl) {
      const c = input.authControl
      await assertSessionActorPermission(tx, c.actorId, 'session:control')
      const session = await lockSession(tx, c.sessionId)
      if (
        !session ||
        session.generation !== c.generation ||
        session.authControlEpoch !== c.epoch ||
        session.authControlActorId !== c.actorId ||
        session.authControlTokenHash !== createHash('sha256').update(c.token).digest('hex') ||
        !session.authControlExpiresAt ||
        session.authControlExpiresAt.getTime() <= (await clockNow(tx)).getTime()
      )
        return false
      const lease = await findActiveLeaseRow(tx, session.id)
      if (lease?.operationId !== input.operationId || lease.purpose !== 'AUTH_WAIT') return false
      const checkedAt = await clockNow(tx)
      if (lease.expiresAt <= checkedAt || (lease.waitDeadlineAt && lease.waitDeadlineAt <= checkedAt)) return false
    }
    const now = await clockNow(tx)
    const { sessionOperations, sessionLeases } = schemaFor(tx)
    const [moved] = await updateRows(
      tx,
      sessionOperations,
      {
        status: input.status,
        errorCode: input.errorCode ?? null,
        finishedAt: now,
        updatedAt: now,
      },
      and(
        eq(sessionOperations.id, input.operationId),
        inArray(sessionOperations.status, ['QUEUED', 'RUNNING', 'WAITING_FOR_AUTH']),
      ),
    )
    if (!moved) return false
    const [lease] = await tx
      .select()
      .from(sessionLeases)
      .where(and(eq(sessionLeases.operationId, input.operationId), eq(sessionLeases.status, 'ACTIVE')))
      .limit(1)
    if (lease) {
      await updateRows(
        tx,
        sessionLeases,
        { status: 'RELEASED', releasedAt: now, releaseReason: `operation_${input.status.toLowerCase()}` },
        eq(sessionLeases.id, lease.id),
      )
    }
    if (input.authControl) {
      const { browserSessions } = schemaFor(tx)
      await updateRows(
        tx,
        browserSessions,
        {
          authControlActorId: null,
          authControlTokenHash: null,
          authControlExpiresAt: null,
          authControlPageId: null,
        },
        eq(browserSessions.id, input.authControl.sessionId),
      )
    }
    return true
  })
}

export function occupancyGrantFromLease(lease: SessionLeaseRow): SessionGrant {
  return toGrant(lease)
}

export function contentDigestFor(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : canonicalJson(value))
    .digest('hex')
}

export function workerHasOccupancyProtocol(
  worker: Pick<WorkerRecord, 'id'> & { protocolCapabilities?: string[] },
): boolean {
  return Boolean(worker.protocolCapabilities?.includes(SESSION_OCCUPANCY_PROTOCOL))
}

export function workerHasMaintenanceProtocol(
  worker: Pick<WorkerRecord, 'id'> & { protocolCapabilities?: string[] },
): boolean {
  return Boolean(worker.protocolCapabilities?.includes(SESSION_MAINTENANCE_PROTOCOL))
}

export function toSessionOperationDto(row: SessionOperationRow) {
  return {
    id: row.id,
    targetId: row.targetId,
    targetAccountId: row.targetAccountId,
    kind: row.kind,
    origin: row.origin,
    status: row.status,
    expectedSessionId: row.expectedSessionId,
    expectedGeneration: row.expectedGeneration,
    ownerWorkerId: row.ownerWorkerId,
    attemptNo: row.attemptNo,
    queueDeadlineAt: row.queueDeadlineAt.toISOString(),
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }
}

export { profileKeyFor }

export async function bindOperationSession(
  db: Db,
  operationId: string,
  sessionId: string,
  generation: number,
): Promise<void> {
  const { sessionOperations } = schemaFor(db)
  await updateRows(
    db,
    sessionOperations,
    { expectedSessionId: sessionId, expectedGeneration: generation },
    and(eq(sessionOperations.id, operationId), eq(sessionOperations.status, 'RUNNING')),
  )
}

/** Restart owns an idle reservation. It must not acquire a MAINTENANCE lease. */
export async function recreateSessionForOperation(
  db: Db,
  input: { operationId: string; workerId: string; instanceId: string },
) {
  return atomic(db, async (tx) => {
    const worker = await lockWorkerRow(tx, input.workerId)
    const op = await getSessionOperation(tx, input.operationId)
    if (
      !worker ||
      worker.status !== 'READY' ||
      worker.instanceId !== input.instanceId ||
      !op ||
      op.status !== 'RUNNING' ||
      op.kind !== 'RESTART' ||
      op.ownerWorkerInstanceId !== input.instanceId ||
      !op.expectedSessionId
    )
      throw conflict('OPERATION_INTERRUPTED', '重启操作已失效')
    const { targetAccounts, browserSessions } = schemaFor(tx)
    await locked(
      tx,
      tx
        .select({ id: targetAccounts.id })
        .from(targetAccounts)
        .where(eq(targetAccounts.id, op.targetAccountId)),
    )
    await assertMaintenanceAuthorized(tx, op)
    const previous = await lockSession(tx, op.expectedSessionId)
    if (!previous || previous.status !== 'CLOSED' || previous.generation !== op.expectedGeneration)
      throw conflict('SESSION_GENERATION_CHANGED', '旧实例未确认停止')
    const occupied = await tx
      .select({ id: browserSessions.id })
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.ownerWorkerId, worker.id),
          inArray(browserSessions.status, ['CREATING', 'OPEN', 'CLOSING']),
        ),
      )
    if (occupied.length >= worker.maxSessions) throw conflict('SESSION_CAPACITY_EXCEEDED', '节点会话容量已满')
    const created = await createSession(tx, {
      key: op,
      ownerWorkerId: worker.id,
      ownerWorkerInstanceId: input.instanceId,
      reusePolicy: previous.reusePolicy,
      idleTtlSeconds: previous.idleTtlSeconds,
      maxLifetimeSeconds: previous.maxLifetimeSeconds,
    })
    if (created.ok) await bindOperationSession(tx, op.id, created.session.id, created.session.generation)
    return created
  })
}
