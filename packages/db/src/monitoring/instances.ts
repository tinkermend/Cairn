import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  heartbeatFresh,
  knownMetric,
  unknownMetric,
  type MonitorApiIdSource,
  type MonitorApiInstanceItem,
  type WorkerStatus,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, databaseNow, schemaFor, updateRows } from '../native.js'

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
    const [row] = await updateRows(
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
      { id: apiInstances.id },
    )
    return row ? 'ok' : 'lost'
  })
}

export async function markApiInstanceStopped(db: Db, id: string, instanceId: string): Promise<boolean> {
  const { apiInstances } = schemaFor(db)
  const now = await clockNow(db)
  const [row] = await updateRows(
    db,
    apiInstances,
    { status: 'STOPPED', stoppedAt: now, updatedAt: now },
    and(eq(apiInstances.id, id), eq(apiInstances.instanceId, instanceId), inArray(apiInstances.status, ['READY', 'DRAINING'])),
    { id: apiInstances.id },
  )
  return row !== undefined
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
