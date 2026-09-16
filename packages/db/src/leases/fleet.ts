import { and, asc, desc, eq, gt, inArray, like, ne, sql } from 'drizzle-orm'
import {
  evaluateWorkerRegistration,
  handleMismatchState,
  heartbeatFresh,
  workerDetailResponseSchema,
  workerListQuerySchema,
  workerListResponseSchema,
  workerSessionListQuerySchema,
  type WorkerDetailResponse,
  type WorkerListQueryInput,
  type WorkerListResponse,
  type WorkerNetworkMode,
  type WorkerSessionListQuery,
  type WorkerSlotCounts,
  type WorkerSummary,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, schemaFor } from '../native.js'
import { failure } from '../runs/errors.js'
import { findSessionByAuthHoldRun } from '../sessions/auth-control.js'
import { findLiveSession, getSessionById, toSessionDto, type SessionRecord } from '../sessions/sessions.js'
import { notFound } from '../runs/errors.js'
import { getWorkerById, type WorkerRecord } from './leases.js'

export type WorkerRouteResolution = {
  asOf: Date
  runId: string
  runStatus: string
  session: SessionRecord | null
  worker: WorkerRecord | null
  associationLive: boolean
}

function authWaitLeaseLive(
  lease: { purpose: string; expiresAt: Date; waitDeadlineAt: Date | null },
  asOf: Date,
): boolean {
  if (lease.purpose !== 'AUTH_WAIT') return false
  if (lease.expiresAt.getTime() <= asOf.getTime()) return false
  if (lease.waitDeadlineAt && lease.waitDeadlineAt.getTime() <= asOf.getTime()) return false
  return true
}

export async function resolveWorkerRoute(db: Db, runId: string): Promise<WorkerRouteResolution> {
  return db.transaction(async (tx) => {
    const asOf = await clockNow(tx as unknown as Db)
    const { runs, sessionLeases } = schemaFor(tx)
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1)
    if (!run) throw notFound('RUN_NOT_FOUND', '运行不存在')
    const held = await findSessionByAuthHoldRun(tx as unknown as Db, runId)
    const [lease] = await tx
      .select()
      .from(sessionLeases)
      .where(and(eq(sessionLeases.runId, runId), eq(sessionLeases.status, 'ACTIVE')))
      .limit(1)
    const holdLive = Boolean(lease && authWaitLeaseLive(lease, asOf))
    const leaseLive = Boolean(
      lease &&
        lease.purpose !== 'AUTH_WAIT' &&
        lease.expiresAt.getTime() > asOf.getTime(),
    )
    const leased = lease ? await getSessionById(tx as unknown as Db, lease.sessionId) : null
    let session = (holdLive ? held : null) ?? leased ?? held
    // 续跑后占用已清、新租约尚未领取：仍要把画面转到这个账号上的活会话。
    if (!session && run.status === 'RECOVERING' && run.targetAccountId) {
      const recovering = await findLiveSession(tx as unknown as Db, {
        targetId: run.targetId,
        targetAccountId: run.targetAccountId,
      })
      if (recovering?.status === 'OPEN') session = recovering
    }
    const worker = session ? await getWorkerById(tx as unknown as Db, session.ownerWorkerId) : null
    return {
      asOf,
      runId: run.id,
      runStatus: run.status,
      session,
      worker,
      associationLive: holdLive || leaseLive || (run.status === 'RECOVERING' && session?.status === 'OPEN'),
    }
  })
}

function encodeWorkerCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url')
}

function decodeWorkerCursor(cursor: string): string {
  try {
    const id = Buffer.from(cursor, 'base64url').toString('utf8')
    if (!id) throw new Error('bad cursor')
    return id
  } catch {
    throw failure('bad_request', { code: 'INVALID_CURSOR', message: '游标无效' })
  }
}

function emptyCounts(): WorkerSlotCounts {
  return {
    occupiedSlots: 0,
    lostOccupied: 0,
    executingSlots: 0,
    running: 0,
    holding: 0,
    waitingForAuth: 0,
    leftoverAuthHolds: 0,
    expiredLeaseResidue: 0,
    runCapacityUsed: 0,
  }
}

export function summarizeWorker(input: {
  worker: WorkerRecord
  asOf: Date
  counts: WorkerSlotCounts
  networkMode: WorkerNetworkMode
  envEndpoint?: string
  canSeeEndpoint: boolean
}): WorkerSummary {
  const fresh = heartbeatFresh({ heartbeatExpiresAt: input.worker.heartbeatExpiresAt, asOf: input.asOf })
  const route = evaluateWorkerRegistration({
    workerStatus: input.worker.status,
    heartbeatExpiresAt: input.worker.heartbeatExpiresAt,
    lostAfterSeconds: input.worker.lostAfterSeconds,
    internalBaseUrl: input.worker.internalBaseUrl,
    asOf: input.asOf,
    networkMode: input.networkMode,
    envEndpoint: input.envEndpoint,
  })
  const mismatchState = handleMismatchState({
    liveHandleCount: input.worker.liveHandleCount,
    sampledSlotCount: input.worker.sampledSlotCount,
    handleMismatchStreak: input.worker.handleMismatchStreak,
    heartbeatFresh: fresh,
  })
  return {
    workerId: input.worker.id,
    instanceId: input.worker.instanceId,
    status: input.worker.status,
    heartbeatAt: input.worker.heartbeatAt.toISOString(),
    lostAfterSeconds: input.worker.lostAfterSeconds,
    heartbeatExpiresAt: input.worker.heartbeatExpiresAt?.toISOString() ?? null,
    heartbeatFresh: fresh,
    capacity: input.worker.capacity,
    maxSessions: input.worker.maxSessions,
    counts: input.counts,
    handleSample: {
      liveHandleCount: input.worker.liveHandleCount,
      sampledSlotCount: input.worker.sampledSlotCount,
      handleMismatchStreak: input.worker.handleMismatchStreak,
      handleSampledAt: input.worker.handleSampledAt?.toISOString() ?? null,
      mismatchState,
    },
    routeAvailability: route.availability,
    routeReason: route.reason,
    endpointSource: route.endpointSource,
    internalEndpoint:
      input.canSeeEndpoint && route.endpoint
        ? {
            baseUrl: new URL(route.endpoint).origin,
            host: new URL(route.endpoint).hostname,
            port: new URL(route.endpoint).port
              ? Number(new URL(route.endpoint).port)
              : new URL(route.endpoint).protocol === 'https:'
                ? 443
                : 80,
            protocol: new URL(route.endpoint).protocol === 'https:' ? 'https' : 'http',
          }
        : null,
  }
}

async function countForWorkers(
  db: Db,
  workerIds: string[],
  asOf: Date,
): Promise<Map<string, WorkerSlotCounts>> {
  const out = new Map<string, WorkerSlotCounts>()
  for (const id of workerIds) out.set(id, emptyCounts())
  if (workerIds.length === 0) return out
  const { browserSessions, sessionLeases, runLeases, runs, workers } = schemaFor(db)

  const sessions = await db
    .select()
    .from(browserSessions)
    .where(and(inArray(browserSessions.ownerWorkerId, workerIds), ne(browserSessions.status, 'CLOSED')))
  const sessionIds = sessions.map((row) => row.id)
  const leases =
    sessionIds.length === 0
      ? []
      : await db
          .select()
          .from(sessionLeases)
          .where(and(inArray(sessionLeases.sessionId, sessionIds), eq(sessionLeases.status, 'ACTIVE')))
  const leaseBySession = new Map(leases.map((lease) => [lease.sessionId, lease]))
  const runIds = [...new Set(leases.map((lease) => lease.runId).filter((id): id is string => Boolean(id)))]
  const holdRunIds = [
    ...new Set(
      leases.flatMap((lease) =>
        lease.purpose === 'AUTH_WAIT' && lease.runId ? [lease.runId] : [],
      ),
    ),
  ]
  const allRunIds = [...new Set([...runIds, ...holdRunIds])]
  const runRows =
    allRunIds.length === 0
      ? []
      : await db.select().from(runs).where(inArray(runs.id, allRunIds))
  const runById = new Map(runRows.map((row) => [row.id, row]))
  const activeRunLeases = await db
    .select()
    .from(runLeases)
    .where(and(inArray(runLeases.holderWorkerId, workerIds), eq(runLeases.status, 'ACTIVE')))
  const workerRows = await db.select().from(workers).where(inArray(workers.id, workerIds))
  const workerById = new Map(workerRows.map((row) => [row.id, row]))

  for (const lease of activeRunLeases) {
    if (lease.expiresAt.getTime() <= asOf.getTime()) continue
    const counts = out.get(lease.holderWorkerId)
    if (counts) counts.runCapacityUsed += 1
  }

  const seen = new Set<string>()
  for (const session of sessions) {
    if (seen.has(session.id)) continue
    seen.add(session.id)
    const counts = out.get(session.ownerWorkerId)
    if (!counts) continue
    const occupancy = session.status === 'CREATING' || session.status === 'OPEN' || session.status === 'CLOSING'
    if (session.status === 'LOST') counts.lostOccupied += 1
    if (!occupancy) continue
    counts.occupiedSlots += 1
    const lease = leaseBySession.get(session.id)
    if (lease && lease.expiresAt.getTime() <= asOf.getTime()) counts.expiredLeaseResidue += 1
    const worker = workerById.get(session.ownerWorkerId)
    const boundHold = Boolean(lease && authWaitLeaseLive(lease, asOf))
    const leftoverHold = Boolean(
      lease?.purpose === 'AUTH_WAIT' &&
        lease.waitDeadlineAt &&
        lease.waitDeadlineAt.getTime() <= asOf.getTime() &&
        lease.status === 'ACTIVE',
    )
    if (leftoverHold) counts.leftoverAuthHolds += 1
    if (boundHold) {
      const holdRun = lease?.runId ? runById.get(lease.runId) : undefined
      if (holdRun?.status === 'WAITING_FOR_AUTH') {
        counts.waitingForAuth += 1
      }
    }
    const runLease =
      lease &&
      activeRunLeases.find(
        (item) =>
          item.runId === lease.runId &&
          item.holderWorkerId === session.ownerWorkerId &&
          item.status === 'ACTIVE' &&
          item.expiresAt.getTime() > asOf.getTime() &&
          (lease.runFencingToken == null || item.fencingToken === lease.runFencingToken),
      )
    const executing =
      occupancy &&
      worker &&
      session.ownerWorkerInstanceId === worker.instanceId &&
      lease &&
      lease.expiresAt.getTime() > asOf.getTime() &&
      lease.sessionGeneration === session.generation &&
      Boolean(runLease)
    if (!executing) continue
    counts.executingSlots += 1
    const run = lease?.runId ? runById.get(lease.runId) : undefined
    if (run?.status === 'RUNNING') counts.running += 1
    if (run?.status === 'HOLDING') counts.holding += 1
  }
  return out
}

export async function listWorkers(
  db: Db,
  query: WorkerListQueryInput,
  options: { networkMode: WorkerNetworkMode; envEndpoints: Record<string, string>; canSeeEndpoint: boolean },
): Promise<WorkerListResponse> {
  const parsed = workerListQuerySchema.parse(query)
  const { workers } = schemaFor(db)
  const asOf = await clockNow(db)
  const conditions = []
  if (parsed.search) conditions.push(like(workers.id, `%${parsed.search}%`))
  if (parsed.status) conditions.push(eq(workers.status, parsed.status))
  if (parsed.heartbeatFresh === true) {
    conditions.push(sql`${workers.heartbeatExpiresAt} IS NOT NULL AND ${workers.heartbeatExpiresAt} > ${asOf}`)
  }
  if (parsed.heartbeatFresh === false) {
    conditions.push(
      sql`(${workers.heartbeatExpiresAt} IS NULL OR ${workers.heartbeatExpiresAt} <= ${asOf})`,
    )
  }
  if (parsed.cursor) conditions.push(gt(workers.id, decodeWorkerCursor(parsed.cursor)))
  const rows = await db
    .select()
    .from(workers)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(workers.id))
    .limit(parsed.limit + 1)
  const page = rows.slice(0, parsed.limit)
  const counts = await countForWorkers(
    db,
    page.map((row) => row.id),
    asOf,
  )
  const items = page.map((row) =>
    summarizeWorker({
      worker: {
        id: row.id,
        instanceId: row.instanceId,
        status: row.status,
        capacity: row.capacity,
        maxSessions: row.maxSessions,
        heartbeatAt: row.heartbeatAt,
        internalBaseUrl: row.internalBaseUrl,
        lostAfterSeconds: row.lostAfterSeconds,
        heartbeatExpiresAt: row.heartbeatExpiresAt,
        liveHandleCount: row.liveHandleCount,
        sampledSlotCount: row.sampledSlotCount,
        handleMismatchStreak: row.handleMismatchStreak,
        handleSampledAt: row.liveHandleCount === null && row.sampledSlotCount === null ? null : row.heartbeatAt,
        protocolCapabilities: row.protocolCapabilities ?? [],
      },
      asOf,
      counts: counts.get(row.id) ?? emptyCounts(),
      networkMode: options.networkMode,
      envEndpoint: options.envEndpoints[row.id],
      canSeeEndpoint: options.canSeeEndpoint,
    }),
  )
  return workerListResponseSchema.parse({
    items,
    nextCursor: rows.length > parsed.limit ? encodeWorkerCursor(page.at(-1)!.id) : undefined,
    asOf: asOf.toISOString(),
  })
}

export async function getWorkerDetail(
  db: Db,
  workerId: string,
  query: WorkerSessionListQuery,
  options: { networkMode: WorkerNetworkMode; envEndpoints: Record<string, string>; canSeeEndpoint: boolean },
): Promise<WorkerDetailResponse> {
  const parsed = workerSessionListQuerySchema.parse(query)
  const worker = await getWorkerById(db, workerId)
  if (!worker) throw failure('not_found', { code: 'WORKER_NOT_FOUND', message: '执行节点不存在' })
  const asOf = await clockNow(db)
  const counts = await countForWorkers(db, [workerId], asOf)
  const { browserSessions, sessionLeases } = schemaFor(db)
  const conditions = [eq(browserSessions.ownerWorkerId, workerId), ne(browserSessions.status, 'CLOSED')]
  if (parsed.status) conditions.push(eq(browserSessions.status, parsed.status))
  if (parsed.cursor) {
    const raw = Buffer.from(parsed.cursor, 'base64url').toString('utf8')
    const sep = raw.lastIndexOf('|')
    if (sep <= 0) throw failure('bad_request', { code: 'INVALID_CURSOR', message: '游标无效' })
    const createdAt = new Date(raw.slice(0, sep))
    const id = raw.slice(sep + 1)
    conditions.push(
      sql`(${browserSessions.createdAt} < ${createdAt}) OR (${browserSessions.createdAt} = ${createdAt} AND ${browserSessions.id} < ${id})`,
    )
  }
  const rows = await db
    .select()
    .from(browserSessions)
    .where(and(...conditions))
    .orderBy(desc(browserSessions.createdAt), desc(browserSessions.id))
    .limit(parsed.limit + 1)
  const page = rows.slice(0, parsed.limit)
  const leases =
    page.length === 0
      ? []
      : await db
          .select()
          .from(sessionLeases)
          .where(
            and(
              inArray(
                sessionLeases.sessionId,
                page.map((row) => row.id),
              ),
              eq(sessionLeases.status, 'ACTIVE'),
            ),
          )
  const leaseBySession = new Map(leases.map((lease) => [lease.sessionId, lease]))
  const last = page.at(-1)
  return workerDetailResponseSchema.parse({
    worker: summarizeWorker({
      worker,
      asOf,
      counts: counts.get(workerId) ?? emptyCounts(),
      networkMode: options.networkMode,
      envEndpoint: options.envEndpoints[workerId],
      canSeeEndpoint: options.canSeeEndpoint,
    }),
    sessions: {
      items: page.map((row) => toSessionDto(row, leaseBySession.get(row.id) ?? null)),
      nextCursor:
        rows.length > parsed.limit && last
          ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`, 'utf8').toString('base64url')
          : undefined,
    },
    asOf: asOf.toISOString(),
  })
}
