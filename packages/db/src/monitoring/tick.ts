import { eq, sql } from 'drizzle-orm'
import {
  DEFAULT_MONITOR_OBJECT_STORE_PROBE_MS,
  MONITOR_OBJECT_STORE_KIND,
  heartbeatFresh,
  type MonitorSampleKey,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, schemaFor } from '../native.js'
import { summarizeAnomalies } from './anomalies.js'
import { summarizeFleet } from './fleet.js'
import { takeLastClaimDiagnostics } from '../leases/index.js'
import { summarizeQueues } from './queues.js'
import { countScenarioAiInBucket, type MonitorSampleWrite } from './samples.js'

function knownWrites(
  asOf: Date,
  rows: Array<{ key: MonitorSampleKey; scope: MonitorSampleWrite['scope']; scopeId?: string; value: number | null }>,
): MonitorSampleWrite[] {
  void asOf
  return rows
    .filter((row): row is typeof row & { value: number } => row.value != null && Number.isFinite(row.value))
    .map((row) => ({ key: row.key, scope: row.scope, scopeId: row.scopeId, value: row.value }))
}

export async function collectPlatformSamples(
  db: Db,
  options?: { objectStoreStaleAfterMs?: number },
): Promise<MonitorSampleWrite[]> {
  const asOf = await clockNow(db)
  const staleAfterMs = options?.objectStoreStaleAfterMs ?? 2 * DEFAULT_MONITOR_OBJECT_STORE_PROBE_MS
  const [fleet, queues, anomalies, ai, apiReady, probe] = await Promise.all([
    summarizeFleet(db, asOf),
    summarizeQueues(db, asOf),
    summarizeAnomalies(db, asOf),
    countScenarioAiInBucket(db),
    countReadyApiInstances(db, asOf),
    readFreshProbe(db, asOf, staleAfterMs),
  ])
  const writes = knownWrites(asOf, [
    { key: 'worker.status.ready', scope: 'platform', value: metricValue(fleet.data.workers.ready) },
    { key: 'worker.status.lost', scope: 'platform', value: metricValue(fleet.data.workers.lost) },
    { key: 'worker.capacity.used', scope: 'platform', value: metricValue(fleet.data.capacity.used) },
    { key: 'worker.sessions.used', scope: 'platform', value: metricValue(fleet.data.sessions.used) },
    { key: 'queue.claimableRuns', scope: 'platform', value: metricValue(queues.data.claimableRuns) },
    { key: 'queue.oldestWaitMs', scope: 'platform', value: metricValue(queues.data.oldestWaitMs) },
    { key: 'queue.unclaimableRuns', scope: 'platform', value: metricValue(queues.data.unclaimableRuns) },
    { key: 'queue.recovering', scope: 'platform', value: metricValue(queues.data.recovering) },
    { key: 'queue.needsReview', scope: 'platform', value: metricValue(queues.data.needsReview) },
    { key: 'queue.targetsWithBacklog', scope: 'platform', value: metricValue(queues.data.targetsWithBacklog) },
    { key: 'queue.targetBacklogP95', scope: 'platform', value: metricValue(queues.data.targetBacklogP95) },
    { key: 'evidence.pendingUpload', scope: 'platform', value: metricValue(anomalies.data.evidence.pendingUpload) },
    { key: 'evidence.uploadFailed', scope: 'platform', value: metricValue(anomalies.data.evidence.uploadFailed) },
    {
      key: 'lease.expiredActiveRunLeases',
      scope: 'platform',
      value: metricValue(anomalies.data.leases.expiredActiveRunLeases),
    },
    { key: 'api.instances.ready', scope: 'platform', value: apiReady },
    { key: 'ai.calls', scope: 'platform', value: ai.calls },
    { key: 'ai.errors', scope: 'platform', value: ai.errors },
    { key: 'ai.inputTokens', scope: 'platform', value: ai.inputTokens },
    { key: 'ai.outputTokens', scope: 'platform', value: ai.outputTokens },
  ])
  if (probe) {
    writes.push(
      { key: 'objectStore.up', scope: 'platform', value: probe.up },
      { key: 'objectStore.probeLatencyMs', scope: 'platform', value: probe.latencyMs },
    )
  }
  writes.push(...(await collectApiInstanceSamples(db)))
  return writes
}

export async function collectWorkerSamples(
  db: Db,
  workerId: string,
): Promise<MonitorSampleWrite[]> {
  const { workers } = schemaFor(db)
  const [row] = await db.select().from(workers).where(eq(workers.id, workerId)).limit(1)
  if (!row) return []
  const claim = takeLastClaimDiagnostics()
  return knownWrites(row.heartbeatAt, [
    {
      key: 'queue.lastClaimScanCount',
      scope: 'worker',
      scopeId: workerId,
      value: claim.recorded ? claim.scanned : null,
    },
    { key: 'worker.process.rssBytes', scope: 'worker', scopeId: workerId, value: row.sampledRssBytes },
    {
      key: 'worker.process.eventLoopDelayMs',
      scope: 'worker',
      scopeId: workerId,
      value: row.sampledEventLoopDelayMs,
    },
    { key: 'worker.process.cpuPercent', scope: 'worker', scopeId: workerId, value: row.sampledCpuPercent },
    { key: 'worker.clockSkewMs', scope: 'worker', scopeId: workerId, value: row.processClockSkewMs },
    { key: 'worker.browserProcessCount', scope: 'worker', scopeId: workerId, value: row.sampledBrowserProcessCount },
    { key: 'worker.profileCount', scope: 'worker', scopeId: workerId, value: row.sampledProfileCount },
    { key: 'worker.profileDiskFreeBytes', scope: 'worker', scopeId: workerId, value: row.sampledProfileDiskFreeBytes },
    { key: 'worker.midsceneBytes', scope: 'worker', scopeId: workerId, value: row.sampledMidsceneBytes },
    { key: 'profile.nodeDiskUsageBytes', scope: 'worker', scopeId: workerId, value: row.sampledProfileBytes },
  ])
}

async function collectApiInstanceSamples(db: Db): Promise<MonitorSampleWrite[]> {
  const asOf = await clockNow(db)
  const { apiInstances } = schemaFor(db)
  const rows = await db.select().from(apiInstances)
  const writes: MonitorSampleWrite[] = []
  for (const row of rows) {
    if (row.status !== 'READY' || !heartbeatFresh({ heartbeatExpiresAt: row.heartbeatExpiresAt, asOf })) continue
    writes.push(
      ...knownWrites(row.heartbeatAt, [
        { key: 'api.process.rssBytes', scope: 'api', scopeId: row.id, value: row.sampledRssBytes },
        {
          key: 'api.process.eventLoopDelayMs',
          scope: 'api',
          scopeId: row.id,
          value: row.sampledEventLoopDelayMs,
        },
        { key: 'api.sse.connections', scope: 'api', scopeId: row.id, value: row.sampledSseConnections },
        {
          key: 'api.internalForward.inFlight',
          scope: 'api',
          scopeId: row.id,
          value: row.sampledInternalForwardInFlight,
        },
      ]),
    )
  }
  return writes
}

async function countReadyApiInstances(db: Db, asOf: Date): Promise<number> {
  const { apiInstances } = schemaFor(db)
  const [row] = await db
    .select({ n: sql`count(*)` })
    .from(apiInstances)
    .where(
      sql`${apiInstances.status} = 'READY'
        AND ${apiInstances.heartbeatExpiresAt} IS NOT NULL
        AND ${apiInstances.heartbeatExpiresAt} > ${asOf}`,
    )
  return Number(row?.n ?? 0)
}

async function readFreshProbe(
  db: Db,
  asOf: Date,
  staleAfterMs: number,
): Promise<{ up: number; latencyMs: number } | null> {
  const { objectStoreProbes } = schemaFor(db)
  const [row] = await db
    .select()
    .from(objectStoreProbes)
    .where(eq(objectStoreProbes.storeKind, MONITOR_OBJECT_STORE_KIND))
    .limit(1)
  if (!row || row.latencyMs == null) return null
  if (asOf.getTime() - row.probedAt.getTime() > staleAfterMs) return null
  return { up: row.status === 'ok' ? 1 : 0, latencyMs: row.latencyMs }
}

function metricValue(metric: { availability: 'known' | 'unknown'; value?: number }): number | null {
  return metric.availability === 'known' ? metric.value ?? null : null
}
