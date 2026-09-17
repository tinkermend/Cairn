import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  SESSION_OCCUPANCY_PROTOCOL,
  type SessionAcquireReason,
  type SessionGrant,
  type SessionLeaseOwnerKind,
  type SessionLeasePurpose,
  type SessionReclaimMode,
  type SessionReusePolicy,
} from '@cairn/shared'
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
import { appendRunEvents } from '../observe/events.js'
import { conflict, isUniqueViolation } from '../runs/errors.js'
import { lockRunRow, releaseRunLeaseTx, verifyRunLeaseForWrite } from '../leases/leases.js'
import type { BrowserSessionRow, SessionLeaseRow } from '../records.js'
import {
  SessionDomainError,
  createSession,
  findLiveSession,
  isClaimable,
  type SessionKey,
  type SessionRecord,
} from './sessions.js'
import { lockOperationRow, lockSession, lockWorkerRow, toGrant } from './occupancy-tx.js'
import { findActiveLeaseRow, readSessionScheduling } from './occupancy-read.js'
import { getSessionProfile, transferProfileLocation, upsertSessionProfile } from './occupancy-profile.js'

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
  reclaimMode?: SessionReclaimMode
  keepAliveSeconds?: number | null
  authProbeIntervalSeconds?: number | null
  evictionPriority?: number
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

export async function insertLease(
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

export async function bumpSessionFence(
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
        reclaimMode: input.reclaimMode,
        keepAliveSeconds: input.keepAliveSeconds,
        authProbeIntervalSeconds: input.authProbeIntervalSeconds,
        evictionPriority: input.evictionPriority,
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

export async function countUnclosedForWorker(db: Db, workerId: string): Promise<number> {
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
