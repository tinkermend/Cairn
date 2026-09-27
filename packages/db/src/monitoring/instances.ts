import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  DEFAULT_API_LOST_AFTER_SECONDS,
  heartbeatFresh,
  knownMetric,
  unknownMetric,
  type MonitorApiIdSource,
  type MonitorApiInstanceItem,
  type WorkerStatus,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, databaseNow, schemaFor, updateRows, updateRowsCount } from '../native.js'

export type ApiInstanceHeartbeatInput = {
  id: string
  instanceId: string
  idSource: MonitorApiIdSource
  lostAfterSeconds: number
  version: string | null
  schemaLogicalVersion: string | null
  rssBytes?: number | null
  eventLoopDelayMs?: number | null
  sseConnections?: number | null
  internalForwardInFlight?: number | null
}

export async function heartbeatApiInstance(db: Db, input: ApiInstanceHeartbeatInput): Promise<'ok' | 'lost'> {
  const { apiInstances } = schemaFor(db)
  return db.transaction(async (tx) => {
    const now = await clockNow(tx as unknown as Db)
    const expires = new Date(now.getTime() + input.lostAfterSeconds * 1000)
    const samples = {
      sampledRssBytes: input.rssBytes ?? null,
      sampledEventLoopDelayMs: input.eventLoopDelayMs ?? null,
      sampledSseConnections: input.sseConnections ?? null,
      sampledInternalForwardInFlight: input.internalForwardInFlight ?? null,
    }
    const [current] = await tx.select().from(apiInstances).where(eq(apiInstances.id, input.id)).limit(1)
    if (!current) {
      await tx.insert(apiInstances).values({
        id: input.id,
        instanceId: input.instanceId,
        idSource: input.idSource,
        status: 'READY',
        startedAt: now,
        heartbeatAt: now,
        heartbeatExpiresAt: expires,
        lostAfterSeconds: input.lostAfterSeconds,
        version: input.version,
        schemaLogicalVersion: input.schemaLogicalVersion,
        updatedAt: now,
        stoppedAt: null,
        ...samples,
      })
      return 'ok'
    }
    if (current.instanceId !== input.instanceId) {
      const expired = !current.heartbeatExpiresAt || current.heartbeatExpiresAt.getTime() <= now.getTime()
      if (current.status !== 'STOPPED' && current.status !== 'LOST' && !expired) return 'lost'
    }
    // 只判是否命中 CAS，不读回实体：MySQL 下省掉 SELECT FOR UPDATE + 回读两次往返。
    const updated = await updateRowsCount(
      tx,
      apiInstances,
      {
        instanceId: input.instanceId,
        idSource: input.idSource,
        status: 'READY',
        heartbeatAt: now,
        heartbeatExpiresAt: expires,
        lostAfterSeconds: input.lostAfterSeconds,
        version: input.version,
        schemaLogicalVersion: input.schemaLogicalVersion,
        updatedAt: now,
        stoppedAt: null,
        startedAt: current.instanceId === input.instanceId ? current.startedAt : now,
        ...samples,
      },
      and(
        eq(apiInstances.id, input.id),
        sql`(
          ${apiInstances.instanceId} = ${input.instanceId}
          OR ${apiInstances.status} IN ('STOPPED', 'LOST')
          OR ${apiInstances.heartbeatExpiresAt} IS NULL
          OR ${apiInstances.heartbeatExpiresAt} <= ${databaseNow(tx as unknown as Db)}
        )`,
      ),
    )
    return updated > 0 ? 'ok' : 'lost'
  })
}

export async function markApiInstanceStopped(db: Db, id: string, instanceId: string): Promise<boolean> {
  const { apiInstances } = schemaFor(db)
  const now = await clockNow(db)
  return (
    (await updateRowsCount(
      db,
      apiInstances,
      { status: 'STOPPED', stoppedAt: now, updatedAt: now },
      and(eq(apiInstances.id, id), eq(apiInstances.instanceId, instanceId), inArray(apiInstances.status, ['READY', 'DRAINING'])),
    )) > 0
  )
}

export async function markLostApiInstances(db: Db): Promise<string[]> {
  const { apiInstances } = schemaFor(db)
  const now = new Date()
  const rows = await updateRows(
    db,
    apiInstances,
    { status: 'LOST', updatedAt: now, stoppedAt: now },
    sql`${apiInstances.status} IN ('READY', 'DRAINING')
        AND ${apiInstances.heartbeatExpiresAt} IS NOT NULL
        AND ${apiInstances.heartbeatExpiresAt} <= ${databaseNow(db)}`,
    { id: apiInstances.id },
  )
  return rows.map((row) => row.id)
}

function metricOrUnknown(value: number | null | undefined) {
  return value == null || Number.isNaN(value) ? unknownMetric('not_reported') : knownMetric(value)
}

export async function listApiInstanceCard(db: Db, asOf: Date): Promise<{
  ready: ReturnType<typeof knownMetric>
  lost: ReturnType<typeof knownMetric>
  derivedCount: ReturnType<typeof knownMetric>
  items: MonitorApiInstanceItem[]
}> {
  const { apiInstances } = schemaFor(db)
  const rows = await db.select().from(apiInstances).orderBy(desc(apiInstances.heartbeatAt))
  let ready = 0
  let lost = 0
  let derived = 0
  const items: MonitorApiInstanceItem[] = []
  for (const row of rows) {
    const fresh = heartbeatFresh({ heartbeatExpiresAt: row.heartbeatExpiresAt, asOf })
    if (row.status === 'READY' && fresh) ready += 1
    if (row.status === 'LOST' || ((row.status === 'READY' || row.status === 'DRAINING') && !fresh)) lost += 1
    if (row.idSource === 'derived') derived += 1
    if (items.length < 16) {
      items.push({
        id: row.id,
        idSource: row.idSource,
        instanceId: row.instanceId,
        status: row.status as Extract<WorkerStatus, 'READY' | 'DRAINING' | 'STOPPED' | 'LOST'>,
        version: row.version,
        schemaLogicalVersion: row.schemaLogicalVersion,
        heartbeatAt: row.heartbeatAt.toISOString(),
        heartbeatExpiresAt: row.heartbeatExpiresAt?.toISOString() ?? null,
        startedAt: row.startedAt.toISOString(),
        rssBytes: metricOrUnknown(row.sampledRssBytes),
        eventLoopDelayMs: metricOrUnknown(row.sampledEventLoopDelayMs),
        sseConnections: metricOrUnknown(row.sampledSseConnections),
        internalForwardInFlight: metricOrUnknown(row.sampledInternalForwardInFlight),
      })
    }
  }
  return {
    ready: knownMetric(ready),
    lost: knownMetric(lost),
    derivedCount: knownMetric(derived),
    items,
  }
}

export interface PlatformApiHealthSummary {
  recentlyLostInstances: number
  earliestApiValidUntil: Date | null
}

/**
 * 平台健康只关注最近一个心跳租期内失联的在服实例。
 * 监控卡仍保留全部 LOST 历史，不能用它的累计计数判断当前平台状态。
 */
export async function readPlatformApiHealthSummary(db: Db, asOf: Date): Promise<PlatformApiHealthSummary> {
  const { apiInstances } = schemaFor(db)
  const rows = await db
    .select({
      status: apiInstances.status,
      heartbeatExpiresAt: apiInstances.heartbeatExpiresAt,
      lostAfterSeconds: apiInstances.lostAfterSeconds,
    })
    .from(apiInstances)
    .where(inArray(apiInstances.status, ['READY', 'DRAINING', 'LOST']))

  const nowMs = asOf.getTime()
  let recentlyLostInstances = 0
  let earliestApiValidUntilMs: number | null = null

  for (const row of rows) {
    const expiresMs = row.heartbeatExpiresAt?.getTime()
    if (expiresMs == null) continue

    if (row.status === 'READY' || row.status === 'DRAINING') {
      if (expiresMs > nowMs) {
        // 新鲜实例的下一个状态转换点是心跳到期。
        earliestApiValidUntilMs = Math.min(earliestApiValidUntilMs ?? expiresMs, expiresMs)
        continue
      }
    }

    // 失联只在到期后的一个租期内影响当前健康；随后仅在监控历史中保留。
    const lostAfterSeconds = row.lostAfterSeconds && row.lostAfterSeconds > 0
      ? row.lostAfterSeconds
      : DEFAULT_API_LOST_AFTER_SECONDS
    const incidentEndsMs = expiresMs + lostAfterSeconds * 1000
    if (incidentEndsMs <= nowMs) continue

    recentlyLostInstances += 1
    earliestApiValidUntilMs = Math.min(earliestApiValidUntilMs ?? incidentEndsMs, incidentEndsMs)
  }

  return {
    recentlyLostInstances,
    earliestApiValidUntil: earliestApiValidUntilMs == null ? null : new Date(earliestApiValidUntilMs),
  }
}
