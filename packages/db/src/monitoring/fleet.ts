import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { knownMetric, unknownMetric, type MonitorCapacityCard, type MonitorWorkerSampleItem } from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, schemaFor } from '../native.js'
import { asCount, occupancyStatuses } from './util.js'

export async function summarizeFleet(
  db: Db,
  asOf?: Date,
): Promise<{ asOf: Date; data: MonitorCapacityCard; liveHeartbeatStale: number }> {
  const resolved = asOf ?? (await clockNow(db))
  const { workers, browserSessions, sessionLeases, runLeases, runs } = schemaFor(db)
  const occupancy = occupancyStatuses()

  const [workerRow] = await db
    .select({
      ready: sql`sum(case when ${workers.status} = 'READY' then 1 else 0 end)`,
      draining: sql`sum(case when ${workers.status} = 'DRAINING' then 1 else 0 end)`,
      stopped: sql`sum(case when ${workers.status} = 'STOPPED' then 1 else 0 end)`,
      lost: sql`sum(case when ${workers.status} = 'LOST' then 1 else 0 end)`,
      heartbeatFresh: sql`sum(case when ${workers.heartbeatExpiresAt} IS NOT NULL AND ${workers.heartbeatExpiresAt} > ${resolved} then 1 else 0 end)`,
      heartbeatStale: sql`sum(case when ${workers.heartbeatExpiresAt} IS NULL OR ${workers.heartbeatExpiresAt} <= ${resolved} then 1 else 0 end)`,
      heartbeatStaleLive: sql`sum(case when ${workers.status} in ('READY', 'DRAINING') and (${workers.heartbeatExpiresAt} is null or ${workers.heartbeatExpiresAt} <= ${resolved}) then 1 else 0 end)`,
      capacityTotal: sql`coalesce(sum(${workers.capacity}), 0)`,
      sessionsTotal: sql`coalesce(sum(${workers.maxSessions}), 0)`,
    })
    .from(workers)

  const leftoverHold = sql`EXISTS (
    SELECT 1 FROM ${sessionLeases} l
     WHERE l.session_id = ${browserSessions.id}
       AND l.status = 'ACTIVE'
       AND l.purpose = 'AUTH_WAIT'
       AND l.wait_deadline_at IS NOT NULL
       AND l.wait_deadline_at <= ${resolved}
  )`
  const expiredLease = sql`EXISTS (
    SELECT 1 FROM ${sessionLeases} l
     WHERE l.session_id = ${browserSessions.id}
       AND l.status = 'ACTIVE'
       AND l.expires_at <= ${resolved}
  )`
  const waitingForAuth = sql`EXISTS (
    SELECT 1 FROM ${sessionLeases} l
     INNER JOIN ${runs} r ON r.id = l.run_id
     WHERE l.session_id = ${browserSessions.id}
       AND l.status = 'ACTIVE'
       AND l.purpose = 'AUTH_WAIT'
       AND l.expires_at > ${resolved}
       AND (l.wait_deadline_at IS NULL OR l.wait_deadline_at > ${resolved})
       AND r.status = 'WAITING_FOR_AUTH'
  )`
  const executing = sql`(
    ${inArray(browserSessions.status, occupancy)}
    AND EXISTS (
      SELECT 1 FROM ${workers} w
       WHERE w.id = ${browserSessions.ownerWorkerId}
         AND w.instance_id = ${browserSessions.ownerWorkerInstanceId}
    )
    AND EXISTS (
      SELECT 1 FROM ${sessionLeases} l
       WHERE l.session_id = ${browserSessions.id}
         AND l.status = 'ACTIVE'
         AND l.expires_at > ${resolved}
         AND l.session_generation = ${browserSessions.generation}
         AND EXISTS (
           SELECT 1 FROM ${runLeases} rl
            WHERE rl.run_id = l.run_id
              AND rl.holder_worker_id = ${browserSessions.ownerWorkerId}
              AND rl.status = 'ACTIVE'
              AND rl.expires_at > ${resolved}
              AND (l.run_fencing_token IS NULL OR rl.fencing_token = l.run_fencing_token)
         )
    )
  )`
  const executingRunning = sql`(
    ${executing}
    AND EXISTS (
      SELECT 1 FROM ${sessionLeases} l
       INNER JOIN ${runs} r ON r.id = l.run_id
       WHERE l.session_id = ${browserSessions.id}
         AND l.status = 'ACTIVE'
         AND r.status = 'RUNNING'
    )
  )`
  const executingHolding = sql`(
    ${executing}
    AND EXISTS (
      SELECT 1 FROM ${sessionLeases} l
       INNER JOIN ${runs} r ON r.id = l.run_id
       WHERE l.session_id = ${browserSessions.id}
         AND l.status = 'ACTIVE'
         AND r.status = 'HOLDING'
    )
  )`

  const [slotRow] = await db
    .select({
      occupied: sql`sum(case when ${inArray(browserSessions.status, occupancy)} then 1 else 0 end)`,
      lostOccupied: sql`sum(case when ${browserSessions.status} = 'LOST' then 1 else 0 end)`,
      expiredLeaseResidue: sql`sum(case when ${inArray(browserSessions.status, occupancy)} AND ${expiredLease} then 1 else 0 end)`,
      leftoverAuthHolds: sql`sum(case when ${inArray(browserSessions.status, occupancy)} AND ${leftoverHold} then 1 else 0 end)`,
      waitingForAuth: sql`sum(case when ${inArray(browserSessions.status, occupancy)} AND ${waitingForAuth} then 1 else 0 end)`,
      executing: sql`sum(case when ${executing} then 1 else 0 end)`,
      running: sql`sum(case when ${executingRunning} then 1 else 0 end)`,
      holding: sql`sum(case when ${executingHolding} then 1 else 0 end)`,
    })
    .from(browserSessions)
    .where(ne(browserSessions.status, 'CLOSED'))

  const [runCap] = await db
    .select({ used: sql`count(*)` })
    .from(runLeases)
    .where(and(eq(runLeases.status, 'ACTIVE'), sql`${runLeases.expiresAt} > ${resolved}`))

  const data: MonitorCapacityCard = {
    workers: {
      ready: knownMetric(asCount(workerRow?.ready)),
      draining: knownMetric(asCount(workerRow?.draining)),
      stopped: knownMetric(asCount(workerRow?.stopped)),
      lost: knownMetric(asCount(workerRow?.lost)),
      heartbeatFresh: knownMetric(asCount(workerRow?.heartbeatFresh)),
      heartbeatStale: knownMetric(asCount(workerRow?.heartbeatStale)),
    },
    capacity: {
      total: knownMetric(asCount(workerRow?.capacityTotal)),
      used: knownMetric(asCount(runCap?.used)),
    },
    sessions: {
      total: knownMetric(asCount(workerRow?.sessionsTotal)),
      used: knownMetric(asCount(slotRow?.occupied)),
    },
    slots: {
      occupied: knownMetric(asCount(slotRow?.occupied)),
      lostOccupied: knownMetric(asCount(slotRow?.lostOccupied)),
      executing: knownMetric(asCount(slotRow?.executing)),
      running: knownMetric(asCount(slotRow?.running)),
      holding: knownMetric(asCount(slotRow?.holding)),
      waitingForAuth: knownMetric(asCount(slotRow?.waitingForAuth)),
      leftoverAuthHolds: knownMetric(asCount(slotRow?.leftoverAuthHolds)),
      expiredLeaseResidue: knownMetric(asCount(slotRow?.expiredLeaseResidue)),
      runCapacityUsed: knownMetric(asCount(runCap?.used)),
    },
    workerSamples: { items: await listWorkerSamples(db, resolved) },
  }
  return { asOf: resolved, data, liveHeartbeatStale: asCount(workerRow?.heartbeatStaleLive) }
}

function sampleMetric(value: number | null | undefined) {
  return value == null || Number.isNaN(value) ? unknownMetric('not_reported') : knownMetric(value)
}

async function listWorkerSamples(db: Db, asOf: Date): Promise<MonitorWorkerSampleItem[]> {
  const { workers } = schemaFor(db)
  const rows = await db
    .select()
    .from(workers)
    .where(
      and(
        sql`${workers.heartbeatExpiresAt} IS NOT NULL`,
        sql`${workers.heartbeatExpiresAt} > ${asOf}`,
      ),
    )
    .orderBy(desc(workers.heartbeatAt))
    .limit(32)
  return rows.map((row) => ({
    workerId: row.id,
    rssBytes: sampleMetric(row.sampledRssBytes),
    cpuPercent: sampleMetric(row.sampledCpuPercent),
    eventLoopDelayMs: sampleMetric(row.sampledEventLoopDelayMs),
    browserProcessCount: sampleMetric(row.sampledBrowserProcessCount),
    clockSkewMs: sampleMetric(row.processClockSkewMs),
    sampledAt: row.heartbeatAt ? row.heartbeatAt.toISOString() : asOf.toISOString(),
  }))
}
