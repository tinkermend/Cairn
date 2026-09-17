import { and, eq, inArray, sql } from 'drizzle-orm'
import type { PlatformSessionScheduling, RunPlacement, RunStatus } from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, databaseNow, schemaFor } from '../native.js'
import { findLiveSession } from './sessions.js'
import { findActiveLeaseRow, leaseWaitFacts, readSessionScheduling, type PlacementFacts } from './occupancy-read.js'
import { getSessionProfile } from './occupancy-profile.js'

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
      const wait = leaseWaitFacts(lease) ?? {
        waitReason: 'SESSION_WAITING_FOR_AUTH' as const,
        occupyingRunId: lease.runId,
        occupyingOperationId: lease.operationId,
        targetWorkerId: null,
        profileAffinityUntil: null,
      }
      return { eligible: false, fallback: false, facts: { ...empty, ...wait } }
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
    const wait = leaseWaitFacts(lease)
    if (wait) {
      return { state: 'owner_required', ...withSession, ...wait }
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
