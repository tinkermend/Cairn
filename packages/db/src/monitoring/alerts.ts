import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import {
  ALERT_CONSOLE_PATH,
  ALERT_DELIVERY_CLAIM_STALE_MS,
  DEFAULT_ALERT_DELIVERY_MAX_ATTEMPTS,
  DEFAULT_MONITOR_OBJECT_STORE_PROBE_MS,
  FACTORY_ALERTING,
  alertNoticeSchema,
  alertOpenKey,
  alertRetryDelayMs,
  compareAlertThreshold,
  heartbeatFresh,
  knownMetric,
  monitorAlertItemSchema,
  monitorAlertListResponseSchema,
  monitorAlertRulesResponseSchema,
  platformAlertingSchema,
  publicAlertDeliveryStatus,
  unknownMetric,
  type AlertChannel,
  type AlertComparator,
  type AlertDeliveryState,
  type AlertNotice,
  type AlertNoticeKind,
  type AlertRule,
  type AlertStaleSource,
  type MonitorAlertItem,
  type MonitorAlertListQuery,
  type MonitorAlertListResponse,
  type MonitorAlertRulesResponse,
  type MonitorMetricKey,
  type MonitorMetricNumber,
  type MonitorSampleScope,
  type PlatformAlerting,
  type PlatformConfigCurrent,
} from '@cairn/shared'
import type { AuditActor } from '../audit/record.js'
import { recordAudit } from '../audit/record.js'
import type { Db } from '../client.js'
import { decodeCursor, encodeCursor } from '../cursor.js'
import { newId } from '../id.js'
import { afterSeconds, atomic, clockNow, insertIgnoreRows, schemaFor, updateRows } from '../native.js'
import { getOrCreatePlatformConfig, updatePlatformConfig } from '../platform-config/store.js'
import { upsertStandaloneSecret } from '../secrets/store.js'
import { failure, notFound } from '../runs/errors.js'
import { summarizeAi } from './ai.js'
import { summarizeAnomalies } from './anomalies.js'
import { summarizeFleet } from './fleet.js'
import { summarizeQueues } from './queues.js'

const PLATFORM_SCOPE_ID = 'platform'

type ReadingMap = Map<string, MonitorMetricNumber>

function readingKey(
  kind: 'metric' | 'stale',
  id: string,
  scope: MonitorSampleScope,
  scopeId: string,
): string {
  return `${kind}:${id}:${scope}:${scopeId}`
}

function putMetric(
  readings: ReadingMap,
  key: MonitorMetricKey,
  scope: MonitorSampleScope,
  scopeId: string,
  value: MonitorMetricNumber,
) {
  readings.set(readingKey('metric', key, scope, scopeId), value)
}

function putStale(
  readings: ReadingMap,
  source: AlertStaleSource,
  scope: MonitorSampleScope,
  scopeId: string,
  value: MonitorMetricNumber,
) {
  readings.set(readingKey('stale', source, scope, scopeId), value)
}

function readMetric(
  readings: ReadingMap,
  key: MonitorMetricKey,
  scope: MonitorSampleScope,
  scopeId: string,
): MonitorMetricNumber {
  return readings.get(readingKey('metric', key, scope, scopeId)) ?? unknownMetric('not_collected')
}

function readStale(
  readings: ReadingMap,
  source: AlertStaleSource,
  scope: MonitorSampleScope,
  scopeId: string,
): MonitorMetricNumber {
  return readings.get(readingKey('stale', source, scope, scopeId)) ?? unknownMetric('not_collected')
}

function elapsed(from: Date, seconds: number, asOf: Date): boolean {
  return asOf.getTime() - from.getTime() >= seconds * 1000
}

function snapshotFromRule(rule: AlertRule) {
  return {
    ruleName: rule.name,
    severity: rule.severity,
    channelIds: rule.channelIds,
    threshold: rule.kind === 'threshold' ? rule.threshold : null,
    comparator: rule.kind === 'threshold' ? rule.comparator : null,
  }
}

function hysteresisDeadline(asOf: Date, forSeconds: number): Date {
  return new Date(asOf.getTime() - forSeconds * 1000)
}

function sampleOrUnknown(value: number | null | undefined): MonitorMetricNumber {
  return value == null || !Number.isFinite(value) ? unknownMetric('not_reported') : knownMetric(value)
}

function absSample(value: number | null | undefined): MonitorMetricNumber {
  const metric = sampleOrUnknown(value)
  return metric.availability === 'known' ? knownMetric(Math.abs(metric.value)) : metric
}

export async function collectAlertReadings(
  db: Db,
  asOf: Date,
  options?: { objectStoreStaleAfterMs?: number },
): Promise<ReadingMap> {
  const staleAfterMs = options?.objectStoreStaleAfterMs ?? 2 * DEFAULT_MONITOR_OBJECT_STORE_PROBE_MS
  const readings: ReadingMap = new Map()
  const [fleet, queues, anomalies, ai] = await Promise.all([
    summarizeFleet(db, asOf),
    summarizeQueues(db, asOf),
    summarizeAnomalies(db, asOf),
    summarizeAi(db, asOf),
  ])

  const workers = fleet.data.workers
  putMetric(readings, 'worker.status.ready', 'platform', PLATFORM_SCOPE_ID, workers.ready)
  putMetric(readings, 'worker.status.draining', 'platform', PLATFORM_SCOPE_ID, workers.draining)
  putMetric(readings, 'worker.status.stopped', 'platform', PLATFORM_SCOPE_ID, workers.stopped)
  putMetric(readings, 'worker.status.lost', 'platform', PLATFORM_SCOPE_ID, workers.lost)
  putMetric(readings, 'worker.heartbeat.fresh', 'platform', PLATFORM_SCOPE_ID, workers.heartbeatFresh)
  putMetric(readings, 'worker.heartbeat.stale', 'platform', PLATFORM_SCOPE_ID, knownMetric(fleet.liveHeartbeatStale))
  putMetric(readings, 'worker.capacity.total', 'platform', PLATFORM_SCOPE_ID, fleet.data.capacity.total)
  putMetric(readings, 'worker.capacity.used', 'platform', PLATFORM_SCOPE_ID, fleet.data.capacity.used)
  putMetric(readings, 'worker.sessions.total', 'platform', PLATFORM_SCOPE_ID, fleet.data.sessions.total)
  putMetric(readings, 'worker.sessions.used', 'platform', PLATFORM_SCOPE_ID, fleet.data.sessions.used)
  putMetric(readings, 'worker.slots.occupied', 'platform', PLATFORM_SCOPE_ID, fleet.data.slots.occupied)
  putMetric(readings, 'worker.slots.lostOccupied', 'platform', PLATFORM_SCOPE_ID, fleet.data.slots.lostOccupied)
  putMetric(readings, 'worker.slots.executing', 'platform', PLATFORM_SCOPE_ID, fleet.data.slots.executing)
  putMetric(readings, 'worker.slots.running', 'platform', PLATFORM_SCOPE_ID, fleet.data.slots.running)
  putMetric(readings, 'worker.slots.holding', 'platform', PLATFORM_SCOPE_ID, fleet.data.slots.holding)
  putMetric(readings, 'worker.slots.waitingForAuth', 'platform', PLATFORM_SCOPE_ID, fleet.data.slots.waitingForAuth)
  putMetric(readings, 'worker.slots.leftoverAuthHolds', 'platform', PLATFORM_SCOPE_ID, fleet.data.slots.leftoverAuthHolds)
  putMetric(
    readings,
    'worker.slots.expiredLeaseResidue',
    'platform',
    PLATFORM_SCOPE_ID,
    fleet.data.slots.expiredLeaseResidue,
  )
  putMetric(readings, 'worker.slots.runCapacityUsed', 'platform', PLATFORM_SCOPE_ID, fleet.data.slots.runCapacityUsed)

  putMetric(readings, 'queue.claimableRuns', 'platform', PLATFORM_SCOPE_ID, queues.data.claimableRuns)
  putMetric(readings, 'queue.oldestWaitMs', 'platform', PLATFORM_SCOPE_ID, queues.data.oldestWaitMs)
  putMetric(readings, 'queue.unclaimableRuns', 'platform', PLATFORM_SCOPE_ID, queues.data.unclaimableRuns)
  putMetric(readings, 'queue.recovering', 'platform', PLATFORM_SCOPE_ID, queues.data.recovering)
  putMetric(readings, 'queue.needsReview', 'platform', PLATFORM_SCOPE_ID, queues.data.needsReview)
  putMetric(readings, 'queue.sessionOperations', 'platform', PLATFORM_SCOPE_ID, queues.data.sessionOperations)
  putMetric(readings, 'queue.schedulePending', 'platform', PLATFORM_SCOPE_ID, queues.data.schedulePending)
  putMetric(readings, 'queue.mapJobsActive', 'platform', PLATFORM_SCOPE_ID, queues.data.mapJobsActive)
  putMetric(readings, 'queue.mapJobsQueued', 'platform', PLATFORM_SCOPE_ID, queues.data.mapJobsQueued)
  putMetric(readings, 'queue.mapJobsRunning', 'platform', PLATFORM_SCOPE_ID, queues.data.mapJobsRunning)
  putMetric(
    readings,
    'queue.mapJobsActiveGuardMismatch',
    'platform',
    PLATFORM_SCOPE_ID,
    queues.data.mapJobsActiveGuardMismatch,
  )
  putMetric(readings, 'queue.maxTargetBacklog', 'platform', PLATFORM_SCOPE_ID, queues.data.maxTargetBacklog)
  putMetric(readings, 'queue.targetsWithBacklog', 'platform', PLATFORM_SCOPE_ID, queues.data.targetsWithBacklog)
  putMetric(readings, 'queue.targetBacklogP95', 'platform', PLATFORM_SCOPE_ID, queues.data.targetBacklogP95)
  putMetric(readings, 'queue.lastGlobalReclaimAgeMs', 'platform', PLATFORM_SCOPE_ID, queues.data.lastGlobalReclaimAgeMs)

  putMetric(
    readings,
    'lease.expiredActiveRunLeases',
    'platform',
    PLATFORM_SCOPE_ID,
    anomalies.data.leases.expiredActiveRunLeases,
  )
  putMetric(
    readings,
    'lease.expiredActiveSessionLeases',
    'platform',
    PLATFORM_SCOPE_ID,
    anomalies.data.leases.expiredActiveSessionLeases,
  )
  putMetric(readings, 'lease.leftoverAuthHolds', 'platform', PLATFORM_SCOPE_ID, anomalies.data.leases.leftoverAuthHolds)
  putMetric(readings, 'lease.orphanAttempts', 'platform', PLATFORM_SCOPE_ID, anomalies.data.leases.orphanAttempts)
  putMetric(readings, 'lease.recoveryCappedRuns', 'platform', PLATFORM_SCOPE_ID, anomalies.data.leases.recoveryCappedRuns)
  putMetric(readings, 'evidence.pendingUpload', 'platform', PLATFORM_SCOPE_ID, anomalies.data.evidence.pendingUpload)
  putMetric(readings, 'evidence.uploadFailed', 'platform', PLATFORM_SCOPE_ID, anomalies.data.evidence.uploadFailed)
  putMetric(readings, 'evidence.maxUploadAttempts', 'platform', PLATFORM_SCOPE_ID, anomalies.data.evidence.maxUploadAttempts)
  putMetric(readings, 'evidence.purgeBacklog', 'platform', PLATFORM_SCOPE_ID, anomalies.data.evidence.purgeBacklog)
  putMetric(readings, 'evidence.purgeFailed', 'platform', PLATFORM_SCOPE_ID, anomalies.data.evidence.purgeFailed)

  putMetric(readings, 'ai.calls', 'platform', PLATFORM_SCOPE_ID, ai.calls)
  putMetric(readings, 'ai.errors', 'platform', PLATFORM_SCOPE_ID, ai.errors)
  putMetric(readings, 'ai.inputTokens', 'platform', PLATFORM_SCOPE_ID, ai.inputTokens)
  putMetric(readings, 'ai.outputTokens', 'platform', PLATFORM_SCOPE_ID, ai.outputTokens)

  const staleWorkers = workers.heartbeatStale.availability === 'known' && (workers.heartbeatStale.value ?? 0) >= 1
  putStale(
    readings,
    'worker_registry',
    'platform',
    PLATFORM_SCOPE_ID,
    workers.heartbeatStale.availability === 'known' ? knownMetric(staleWorkers ? 1 : 0) : unknownMetric('unavailable'),
  )

  const { workers: workerRows, apiInstances, objectStoreProbes } = schemaFor(db)
  const [probe] = await db.select().from(objectStoreProbes).limit(1)
  if (!probe) {
    putMetric(readings, 'objectStore.up', 'platform', PLATFORM_SCOPE_ID, unknownMetric('not_collected'))
    putMetric(readings, 'objectStore.probeLatencyMs', 'platform', PLATFORM_SCOPE_ID, unknownMetric('not_collected'))
    putStale(readings, 'object_store_probe', 'platform', PLATFORM_SCOPE_ID, unknownMetric('not_collected'))
  } else {
    const age = asOf.getTime() - probe.probedAt.getTime()
    const stale = age > staleAfterMs
    putStale(readings, 'object_store_probe', 'platform', PLATFORM_SCOPE_ID, knownMetric(stale ? 1 : 0))
    if (stale) {
      putMetric(readings, 'objectStore.up', 'platform', PLATFORM_SCOPE_ID, unknownMetric('sample_stale'))
      putMetric(readings, 'objectStore.probeLatencyMs', 'platform', PLATFORM_SCOPE_ID, unknownMetric('sample_stale'))
    } else {
      putMetric(readings, 'objectStore.up', 'platform', PLATFORM_SCOPE_ID, knownMetric(probe.status === 'ok' ? 1 : 0))
      putMetric(
        readings,
        'objectStore.probeLatencyMs',
        'platform',
        PLATFORM_SCOPE_ID,
        probe.latencyMs == null ? unknownMetric('not_reported') : knownMetric(probe.latencyMs),
      )
    }
  }

  const registeredWorkers = await db.select().from(workerRows)
  for (const row of registeredWorkers) {
    const fresh = heartbeatFresh({ heartbeatExpiresAt: row.heartbeatExpiresAt, asOf })
    putStale(readings, 'worker_registry', 'worker', row.id, knownMetric(fresh ? 0 : 1))
    putMetric(readings, 'queue.lastClaimScanCount', 'worker', row.id, unknownMetric('not_collected'))
    if (!fresh) {
      putMetric(readings, 'worker.process.rssBytes', 'worker', row.id, unknownMetric('not_reported'))
      putMetric(readings, 'worker.process.eventLoopDelayMs', 'worker', row.id, unknownMetric('not_reported'))
      putMetric(readings, 'worker.process.cpuPercent', 'worker', row.id, unknownMetric('not_reported'))
      putMetric(readings, 'worker.clockSkewMs', 'worker', row.id, unknownMetric('sample_stale'))
      putMetric(readings, 'worker.browserProcessCount', 'worker', row.id, unknownMetric('sample_stale'))
      putMetric(readings, 'worker.profileCount', 'worker', row.id, unknownMetric('sample_stale'))
      putMetric(readings, 'worker.profileDiskFreeBytes', 'worker', row.id, unknownMetric('sample_stale'))
      putMetric(readings, 'worker.midsceneBytes', 'worker', row.id, unknownMetric('sample_stale'))
      putMetric(readings, 'profile.nodeDiskUsageBytes', 'worker', row.id, unknownMetric('sample_stale'))
      continue
    }
    putMetric(readings, 'worker.process.rssBytes', 'worker', row.id, sampleOrUnknown(row.sampledRssBytes))
    putMetric(readings, 'worker.process.eventLoopDelayMs', 'worker', row.id, sampleOrUnknown(row.sampledEventLoopDelayMs))
    putMetric(readings, 'worker.process.cpuPercent', 'worker', row.id, sampleOrUnknown(row.sampledCpuPercent))
    putMetric(readings, 'worker.clockSkewMs', 'worker', row.id, absSample(row.processClockSkewMs))
    putMetric(readings, 'worker.browserProcessCount', 'worker', row.id, sampleOrUnknown(row.sampledBrowserProcessCount))
    putMetric(readings, 'worker.profileCount', 'worker', row.id, sampleOrUnknown(row.sampledProfileCount))
    putMetric(readings, 'worker.profileDiskFreeBytes', 'worker', row.id, sampleOrUnknown(row.sampledProfileDiskFreeBytes))
    putMetric(readings, 'worker.midsceneBytes', 'worker', row.id, sampleOrUnknown(row.sampledMidsceneBytes))
    putMetric(readings, 'profile.nodeDiskUsageBytes', 'worker', row.id, sampleOrUnknown(row.sampledProfileBytes))
  }

  const apis = await db.select().from(apiInstances)
  let staleApis = 0
  let readyApis = 0
  for (const row of apis) {
    const fresh = row.status === 'READY' && heartbeatFresh({ heartbeatExpiresAt: row.heartbeatExpiresAt, asOf })
    if (fresh) readyApis += 1
    else staleApis += 1
    putStale(readings, 'api_registry', 'api', row.id, knownMetric(fresh ? 0 : 1))
    if (!fresh) {
      putMetric(readings, 'api.process.rssBytes', 'api', row.id, unknownMetric('not_reported'))
      putMetric(readings, 'api.process.eventLoopDelayMs', 'api', row.id, unknownMetric('not_reported'))
      putMetric(readings, 'api.sse.connections', 'api', row.id, unknownMetric('not_reported'))
      putMetric(readings, 'api.internalForward.inFlight', 'api', row.id, unknownMetric('not_reported'))
      continue
    }
    putMetric(readings, 'api.process.rssBytes', 'api', row.id, sampleOrUnknown(row.sampledRssBytes))
    putMetric(readings, 'api.process.eventLoopDelayMs', 'api', row.id, sampleOrUnknown(row.sampledEventLoopDelayMs))
    putMetric(readings, 'api.sse.connections', 'api', row.id, sampleOrUnknown(row.sampledSseConnections))
    putMetric(readings, 'api.internalForward.inFlight', 'api', row.id, sampleOrUnknown(row.sampledInternalForwardInFlight))
  }
  putMetric(readings, 'api.instances.ready', 'platform', PLATFORM_SCOPE_ID, knownMetric(readyApis))
  putStale(
    readings,
    'api_registry',
    'platform',
    PLATFORM_SCOPE_ID,
    apis.length === 0 ? unknownMetric('not_collected') : knownMetric(staleApis > 0 ? 1 : 0),
  )

  return readings
}

function instanceIds(rule: AlertRule, readings: ReadingMap): string[] {
  if (rule.scope === 'platform') return [PLATFORM_SCOPE_ID]
  const prefix =
    rule.kind === 'threshold'
      ? `metric:${rule.metricKey}:${rule.scope}:`
      : `stale:${rule.source}:${rule.scope}:`
  const ids: string[] = []
  for (const key of readings.keys()) {
    if (key.startsWith(prefix)) ids.push(key.slice(prefix.length))
  }
  return ids
}

function readingFor(rule: AlertRule, readings: ReadingMap, scopeId: string): MonitorMetricNumber {
  return rule.kind === 'threshold'
    ? readMetric(readings, rule.metricKey, rule.scope, scopeId)
    : readStale(readings, rule.source, rule.scope, scopeId)
}

function isViolating(rule: AlertRule, reading: MonitorMetricNumber): boolean {
  if (reading.availability !== 'known') return false
  if (rule.kind === 'source_stale') return reading.value >= 1
  return compareAlertThreshold(reading.value, rule.comparator, rule.threshold)
}

function pendingDelivery(
  kind: AlertNoticeKind,
  asOf: Date,
): {
  deliveryStatus: AlertDeliveryState
  deliveryKind: AlertNoticeKind
  deliveryAttempts: number
  deliveryClaimedAt: null
  nextRetryAt: Date
  lastDeliveryError: null
} {
  return {
    deliveryStatus: 'pending',
    deliveryKind: kind,
    deliveryAttempts: 0,
    deliveryClaimedAt: null,
    nextRetryAt: asOf,
    lastDeliveryError: null,
  }
}

export async function evaluateAlerts(
  db: Db,
  options?: { asOf?: Date; objectStoreStaleAfterMs?: number },
): Promise<{ evaluated: number; fired: number; resolved: number; interrupted: number }> {
  const asOf = options?.asOf ?? (await clockNow(db))
  const config = await getOrCreatePlatformConfig(db)
  const alerting = config.document.alerting ?? FACTORY_ALERTING
  const enabled = alerting.rules.filter((rule) => rule.enabled)
  if (enabled.length === 0) return { evaluated: 0, fired: 0, resolved: 0, interrupted: 0 }

  const readings = await collectAlertReadings(db, asOf, {
    objectStoreStaleAfterMs: options?.objectStoreStaleAfterMs,
  })
  const stats = { evaluated: 0, fired: 0, resolved: 0, interrupted: 0 }
  const { monitoringAlerts } = schemaFor(db)
  const openRows = await db
    .select({
      ruleId: monitoringAlerts.ruleId,
      scopeId: monitoringAlerts.scopeId,
    })
    .from(monitoringAlerts)
    .where(inArray(monitoringAlerts.state, ['pending', 'firing', 'interrupted']))
  const openByRule = new Map<string, Set<string>>()
  for (const row of openRows) {
    const scopeIds = openByRule.get(row.ruleId) ?? new Set<string>()
    scopeIds.add(row.scopeId)
    openByRule.set(row.ruleId, scopeIds)
  }
  for (const rule of enabled) {
    const scopeIds = new Set(instanceIds(rule, readings))
    for (const scopeId of openByRule.get(rule.id) ?? []) scopeIds.add(scopeId)
    for (const scopeId of scopeIds) {
      stats.evaluated += 1
      const outcome = await applyRuleInstance(db, {
        rule,
        scopeId,
        reading: readingFor(rule, readings, scopeId),
        asOf,
      })
      if (outcome === 'firing') stats.fired += 1
      if (outcome === 'resolved') stats.resolved += 1
      if (outcome === 'interrupted') stats.interrupted += 1
    }
  }
  return stats
}

async function applyRuleInstance(
  db: Db,
  input: { rule: AlertRule; scopeId: string; reading: MonitorMetricNumber; asOf: Date },
): Promise<AlertNoticeKind | 'none'> {
  const { rule, scopeId, reading, asOf } = input
  const openKey = alertOpenKey(rule.id, rule.scope, scopeId)
  const unknown = reading.availability === 'unknown'
  const violating = isViolating(rule, reading)
  const recovered = reading.availability === 'known' && !violating
  const triggerValue = reading.availability === 'known' ? reading.value : null

  return atomic(db, async (tx) => {
    const { monitoringAlerts } = schemaFor(tx)
    let [existing] = await tx.select().from(monitoringAlerts).where(eq(monitoringAlerts.openKey, openKey)).limit(1)

    if (!existing && violating) {
      await insertIgnoreRows(tx, monitoringAlerts, {
        id: newId(),
        ruleId: rule.id,
        ruleName: rule.name,
        scope: rule.scope,
        scopeId,
        state: 'pending',
        severity: rule.severity,
        kind: rule.kind,
        metricKey: rule.kind === 'threshold' ? rule.metricKey : null,
        staleSource: rule.kind === 'source_stale' ? rule.source : null,
        comparator: rule.kind === 'threshold' ? rule.comparator : null,
        threshold: rule.kind === 'threshold' ? rule.threshold : null,
        conditionOpenedAt: asOf,
        triggerValue,
        channelIds: rule.channelIds,
        openKey,
        createdAt: asOf,
        updatedAt: asOf,
      })
      ;[existing] = await tx.select().from(monitoringAlerts).where(eq(monitoringAlerts.openKey, openKey)).limit(1)
    }

    if (!existing) return 'none'

    if (existing.state === 'pending') {
      if (unknown || recovered) {
        await tx.delete(monitoringAlerts).where(and(eq(monitoringAlerts.id, existing.id), eq(monitoringAlerts.state, 'pending')))
        return 'none'
      }
      if (violating && elapsed(existing.conditionOpenedAt, rule.forSeconds, asOf)) {
        const moved = await updateRows(
          tx,
          monitoringAlerts,
          {
            ...snapshotFromRule(rule),
            state: 'firing',
            firedAt: asOf,
            triggerValue,
            recoveryOpenedAt: null,
            updatedAt: asOf,
            ...pendingDelivery('firing', asOf),
          },
          and(
            eq(monitoringAlerts.id, existing.id),
            eq(monitoringAlerts.state, 'pending'),
            sql`${monitoringAlerts.conditionOpenedAt} <= ${hysteresisDeadline(asOf, rule.forSeconds)}`,
          ),
        )
        if (moved.length) {
          const { enqueueAlertNotificationTx } = await import('../notifications/core.js')
          await enqueueAlertNotificationTx(tx, existing.id, 'firing')
        }
        return moved.length > 0 ? 'firing' : 'none'
      }
      return 'none'
    }

    if (existing.state === 'firing') {
      if (unknown) {
        const moved = await updateRows(
          tx,
          monitoringAlerts,
          {
            ...snapshotFromRule(rule),
            state: 'interrupted',
            interruptedAt: asOf,
            recoveryOpenedAt: null,
            updatedAt: asOf,
            ...pendingDelivery('interrupted', asOf),
          },
          and(eq(monitoringAlerts.id, existing.id), eq(monitoringAlerts.state, 'firing')),
        )
        if (moved.length) {
          const { enqueueAlertNotificationTx } = await import('../notifications/core.js')
          await enqueueAlertNotificationTx(tx, existing.id, 'interrupted')
        }
        return moved.length > 0 ? 'interrupted' : 'none'
      }
      if (violating) {
        if (existing.recoveryOpenedAt) {
          await updateRows(
            tx,
            monitoringAlerts,
            { recoveryOpenedAt: null, triggerValue, updatedAt: asOf },
            and(eq(monitoringAlerts.id, existing.id), eq(monitoringAlerts.state, 'firing')),
          )
        }
        return 'none'
      }
      return completeRecovery(
        tx,
        { id: existing.id, state: 'firing', recoveryOpenedAt: existing.recoveryOpenedAt },
        rule,
        asOf,
        triggerValue,
      )
    }

    if (existing.state === 'interrupted') {
      if (unknown) return 'none'
      if (violating) {
        await updateRows(
          tx,
          monitoringAlerts,
          {
            ...snapshotFromRule(rule),
            state: 'firing',
            triggerValue,
            recoveryOpenedAt: null,
            updatedAt: asOf,
          },
          and(eq(monitoringAlerts.id, existing.id), eq(monitoringAlerts.state, 'interrupted')),
        )
        return 'none'
      }
      return completeRecovery(
        tx,
        { id: existing.id, state: 'interrupted', recoveryOpenedAt: existing.recoveryOpenedAt },
        rule,
        asOf,
        triggerValue,
      )
    }

    return 'none'
  })
}

async function completeRecovery(
  tx: Db,
  existing: { id: string; state: 'firing' | 'interrupted'; recoveryOpenedAt: Date | null },
  rule: AlertRule,
  asOf: Date,
  triggerValue: number | null,
): Promise<AlertNoticeKind | 'none'> {
  const { monitoringAlerts } = schemaFor(tx)
  if (!existing.recoveryOpenedAt) {
    await updateRows(
      tx,
      monitoringAlerts,
      { recoveryOpenedAt: asOf, triggerValue, updatedAt: asOf },
      and(eq(monitoringAlerts.id, existing.id), eq(monitoringAlerts.state, existing.state)),
    )
    if (rule.forSeconds > 0) return 'none'
  }
  const started = existing.recoveryOpenedAt ?? asOf
  if (!elapsed(started, rule.forSeconds, asOf)) return 'none'
  const moved = await updateRows(
    tx,
    monitoringAlerts,
    {
      ...snapshotFromRule(rule),
      state: 'resolved',
      resolvedAt: asOf,
      openKey: null,
      triggerValue,
      updatedAt: asOf,
      ...pendingDelivery('resolved', asOf),
    },
    and(eq(monitoringAlerts.id, existing.id), eq(monitoringAlerts.state, existing.state)),
  )
  if (moved.length) {
    const { enqueueAlertNotificationTx } = await import('../notifications/core.js')
    await enqueueAlertNotificationTx(tx, existing.id, 'resolved')
  }
  return moved.length > 0 ? 'resolved' : 'none'
}

function encodeActiveCursor(severity: string, at: Date, id: string): string {
  const rank = severity === 'critical' ? 0 : 1
  return Buffer.from(`${rank}|${at.toISOString()}|${id}`, 'utf8').toString('base64url')
}

function decodeActiveCursor(cursor: string): { rank: number; at: Date; id: string } {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const first = raw.indexOf('|')
    const last = raw.lastIndexOf('|')
    if (first <= 0 || last <= first) throw new Error('bad cursor')
    const rank = Number(raw.slice(0, first))
    const at = new Date(raw.slice(first + 1, last))
    const id = raw.slice(last + 1)
    if (!id || !Number.isFinite(rank) || Number.isNaN(at.getTime())) throw new Error('bad cursor')
    return { rank, at, id }
  } catch {
    throw failure('bad_request', { code: 'INVALID_CURSOR', message: '游标无效' })
  }
}

function silenceRemainingSeconds(silencedUntil: Date | null, asOf: Date): number | null {
  if (!silencedUntil) return null
  const remaining = Math.ceil((silencedUntil.getTime() - asOf.getTime()) / 1000)
  return remaining > 0 ? remaining : null
}

function toAlertItem(
  row: {
    id: string
    ruleId: string
    ruleName: string
    kind: AlertRule['kind']
    metricKey: string | null
    staleSource: AlertStaleSource | null
    scope: MonitorSampleScope
    scopeId: string
    state: 'firing' | 'interrupted' | 'resolved'
    severity: AlertRule['severity']
    comparator: AlertComparator | null
    threshold: number | null
    triggerValue: number | null
    conditionOpenedAt: Date
    firedAt: Date | null
    interruptedAt: Date | null
    resolvedAt: Date | null
    silencedUntil: Date | null
    deliveryKind: AlertNoticeKind | null
    deliveryStatus: AlertDeliveryState | null
    lastDeliveryError: string | null
  },
  asOf: Date,
): MonitorAlertItem {
  const remaining = silenceRemainingSeconds(row.silencedUntil, asOf)
  return monitorAlertItemSchema.parse({
    id: row.id,
    ruleId: row.ruleId,
    ruleName: row.ruleName,
    kind: row.kind,
    metricKey: row.metricKey,
    staleSource: row.staleSource,
    scope: row.scope,
    scopeId: row.scopeId,
    state: row.state,
    severity: row.severity,
    comparator: row.comparator,
    threshold: row.threshold,
    triggerValue: row.triggerValue,
    conditionOpenedAt: row.conditionOpenedAt.toISOString(),
    firedAt: row.firedAt?.toISOString() ?? null,
    interruptedAt: row.interruptedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    silencedUntil: remaining ? row.silencedUntil!.toISOString() : null,
    silenceRemainingSeconds: remaining,
    noticeKind: row.deliveryKind,
    deliveryStatus: publicAlertDeliveryStatus(row.deliveryStatus),
    lastDeliveryError: row.lastDeliveryError,
  })
}

export async function listMonitorAlerts(db: Db, query: MonitorAlertListQuery): Promise<MonitorAlertListResponse> {
  const asOf = await clockNow(db)
  const { monitoringAlerts } = schemaFor(db)
  const limit = query.limit
  if (query.view === 'active') {
    const cursor = query.cursor ? decodeActiveCursor(query.cursor) : undefined
    const rows = await db
      .select()
      .from(monitoringAlerts)
      .where(
        and(
          inArray(monitoringAlerts.state, ['firing', 'interrupted']),
          cursor
            ? or(
                sql`case when ${monitoringAlerts.severity} = 'critical' then 0 else 1 end > ${cursor.rank}`,
                and(
                  sql`case when ${monitoringAlerts.severity} = 'critical' then 0 else 1 end = ${cursor.rank}`,
                  or(
                    sql`coalesce(${monitoringAlerts.firedAt}, ${monitoringAlerts.conditionOpenedAt}) < ${cursor.at}`,
                    and(
                      sql`coalesce(${monitoringAlerts.firedAt}, ${monitoringAlerts.conditionOpenedAt}) = ${cursor.at}`,
                      sql`${monitoringAlerts.id} < ${cursor.id}`,
                    ),
                  ),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(
        sql`case when ${monitoringAlerts.severity} = 'critical' then 0 else 1 end`,
        desc(sql`coalesce(${monitoringAlerts.firedAt}, ${monitoringAlerts.conditionOpenedAt})`),
        desc(monitoringAlerts.id),
      )
      .limit(limit + 1)
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return monitorAlertListResponseSchema.parse({
      asOf: asOf.toISOString(),
      items: page.map((row) =>
        toAlertItem(
          {
            ...row,
            state: row.state as 'firing' | 'interrupted',
          },
          asOf,
        ),
      ),
      nextCursor:
        rows.length > limit && last
          ? encodeActiveCursor(
              last.severity,
              last.firedAt ?? last.conditionOpenedAt,
              last.id,
            )
          : undefined,
    })
  }

  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined
  const rows = await db
    .select()
    .from(monitoringAlerts)
    .where(
      and(
        eq(monitoringAlerts.state, 'resolved'),
        cursor
          ? or(
              sql`${monitoringAlerts.resolvedAt} < ${cursor.createdAt}`,
              and(eq(monitoringAlerts.resolvedAt, cursor.createdAt), sql`${monitoringAlerts.id} < ${cursor.id}`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(monitoringAlerts.resolvedAt), desc(monitoringAlerts.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return monitorAlertListResponseSchema.parse({
    asOf: asOf.toISOString(),
    items: page.map((row) => toAlertItem({ ...row, state: 'resolved' }, asOf)),
    nextCursor:
      rows.length > limit && last?.resolvedAt
        ? encodeCursor(last.resolvedAt, last.id)
        : undefined,
  })
}

export async function silenceMonitorAlert(
  db: Db,
  input: { alertId: string; durationSeconds: number; actor: AuditActor },
): Promise<MonitorAlertItem> {
  const asOf = await clockNow(db)
  return atomic(db, async (tx) => {
    const { monitoringAlerts } = schemaFor(tx)
    const [row] = await tx.select().from(monitoringAlerts).where(eq(monitoringAlerts.id, input.alertId)).limit(1)
    if (!row || row.state === 'pending' || row.state === 'resolved') {
      throw notFound('MONITOR_ALERT_NOT_FOUND', '告警不存在或已恢复')
    }
    const silencedUntil = new Date(asOf.getTime() + input.durationSeconds * 1000)
    const updated = await updateRows(
      tx,
      monitoringAlerts,
      { silencedUntil, silencedBy: input.actor.id, updatedAt: asOf },
      and(eq(monitoringAlerts.id, row.id), inArray(monitoringAlerts.state, ['firing', 'interrupted'])),
    )
    const current = updated[0]
    if (!current) throw notFound('MONITOR_ALERT_NOT_FOUND', '告警不存在或已恢复')
    await recordAudit(
      tx,
      { id: input.actor.id },
      'monitor.silence',
      'monitoring_alert',
      row.id,
      `静默告警 ${row.ruleId} ${input.durationSeconds} 秒`,
    )
    return toAlertItem(
      {
        ...current,
        state: current.state as 'firing' | 'interrupted',
      },
      asOf,
    )
  })
}

export type AlertDeliveryJob = {
  alertId: string
  notice: AlertNotice
  channelIds: string[]
  silenced: boolean
}

export async function claimDueAlertDeliveries(
  db: Db,
  options?: { limit?: number; asOf?: Date; maxAttempts?: number },
): Promise<AlertDeliveryJob[]> {
  const asOf = options?.asOf ?? (await clockNow(db))
  const limit = options?.limit ?? 20
  const maxAttempts = options?.maxAttempts ?? DEFAULT_ALERT_DELIVERY_MAX_ATTEMPTS
  const { monitoringAlerts } = schemaFor(db)
  const staleClaim = afterSeconds(db, -ALERT_DELIVERY_CLAIM_STALE_MS / 1000)
  const candidates = await db
    .select()
    .from(monitoringAlerts)
    .where(
      and(
        inArray(monitoringAlerts.deliveryStatus, ['pending', 'failed', 'sending']),
        sql`${monitoringAlerts.deliveryAttempts} < ${maxAttempts}`,
        or(
          sql`${monitoringAlerts.nextRetryAt} IS NULL`,
          sql`${monitoringAlerts.nextRetryAt} <= ${asOf}`,
          and(eq(monitoringAlerts.deliveryStatus, 'sending'), sql`${monitoringAlerts.deliveryClaimedAt} <= ${staleClaim}`),
        ),
      ),
    )
    .orderBy(monitoringAlerts.nextRetryAt, monitoringAlerts.id)
    .limit(limit)

  const jobs: AlertDeliveryJob[] = []
  for (const row of candidates) {
    if (!row.deliveryKind) continue
    const claimed = await updateRows(
      db,
      monitoringAlerts,
      {
        deliveryStatus: 'sending',
        deliveryClaimedAt: asOf,
        updatedAt: asOf,
      },
      and(
        eq(monitoringAlerts.id, row.id),
        sql`${monitoringAlerts.deliveryAttempts} < ${maxAttempts}`,
        or(
          and(
            inArray(monitoringAlerts.deliveryStatus, ['pending', 'failed']),
            or(
              sql`${monitoringAlerts.nextRetryAt} IS NULL`,
              sql`${monitoringAlerts.nextRetryAt} <= ${asOf}`,
            ),
          ),
          and(
            eq(monitoringAlerts.deliveryStatus, 'sending'),
            sql`${monitoringAlerts.deliveryClaimedAt} <= ${staleClaim}`,
          ),
        ),
      ),
    )
    if (claimed.length === 0) continue
    const current = claimed[0]!
    const remaining = silenceRemainingSeconds(current.silencedUntil, asOf)
    jobs.push({
      alertId: current.id,
      channelIds: current.channelIds ?? [],
      silenced: remaining != null,
      notice: alertNoticeSchema.parse({
        kind: current.deliveryKind,
        alertId: current.id,
        ruleId: current.ruleId,
        ruleName: current.ruleName,
        metricKey: current.metricKey,
        source: current.staleSource,
        scope: current.scope,
        scopeId: current.scopeId,
        value: current.triggerValue,
        threshold: current.threshold,
        comparator: current.comparator,
        severity: current.severity,
        at: (current.firedAt ?? current.interruptedAt ?? current.resolvedAt ?? current.updatedAt).toISOString(),
        consolePath: ALERT_CONSOLE_PATH,
      }),
    })
  }
  return jobs
}

export async function finishAlertDelivery(
  db: Db,
  input: {
    alertId: string
    status: Extract<AlertDeliveryState, 'sent' | 'failed' | 'suppressed'>
    errorClass?: string | null
    asOf?: Date
  },
): Promise<void> {
  const asOf = input.asOf ?? (await clockNow(db))
  const { monitoringAlerts } = schemaFor(db)
  const [row] = await db.select().from(monitoringAlerts).where(eq(monitoringAlerts.id, input.alertId)).limit(1)
  if (!row || row.deliveryStatus !== 'sending') return
  const attempts = row.deliveryAttempts + (input.status === 'failed' ? 1 : 0)
  await updateRows(
    db,
    monitoringAlerts,
    {
      deliveryStatus: input.status,
      deliveryAttempts: attempts,
      deliveryClaimedAt: null,
      lastDeliveryAt: asOf,
      lastDeliveryError: input.status === 'failed' ? (input.errorClass ?? 'delivery_failed').slice(0, 64) : null,
      nextRetryAt: input.status === 'failed' ? new Date(asOf.getTime() + alertRetryDelayMs(attempts)) : null,
      updatedAt: asOf,
    },
    and(eq(monitoringAlerts.id, input.alertId), eq(monitoringAlerts.deliveryStatus, 'sending')),
  )
}

export function resolveAlerting(document: { alerting?: Omit<PlatformAlerting, 'channels'> & { channels?: AlertChannel[] }; notifications?: import('@cairn/shared').PlatformNotifications }): PlatformAlerting {
  const base = document.alerting ?? FACTORY_ALERTING
  const channels: AlertChannel[] = document.notifications
    ? document.notifications.channels.filter(c => c.kind === 'webhook').map(c => ({ id: c.id, name: c.name, kind: 'webhook', enabled: c.enabled, secretRef: c.secretRef, urlHost: c.host }))
    : base.channels ?? []
  return { ...base, channels }
}

export function findAlertChannel(alerting: PlatformAlerting, channelId: string): AlertChannel | undefined {
  return alerting.channels.find((channel) => channel.id === channelId)
}

export async function listMonitorAlertRules(db: Db): Promise<MonitorAlertRulesResponse> {
  const current = await getOrCreatePlatformConfig(db)
  const alerting = resolveAlerting(current.document)
  return monitorAlertRulesResponseSchema.parse({
    revision: current.revision,
    rules: alerting.rules,
    channels: alerting.channels,
  })
}

export async function updateAlertingRules(
  db: Db,
  input: { expectedRevision: number; reason: string; rules: AlertRule[]; actor: AuditActor },
): Promise<PlatformConfigCurrent> {
  const current = await getOrCreatePlatformConfig(db)
  return updatePlatformConfig(db, {
    expectedRevision: input.expectedRevision,
    reason: input.reason,
    document: {
      ...current.document,
      alerting: { ...current.document.alerting, rules: input.rules },
    },
    actor: input.actor,
  })
}

export async function upsertAlertChannel(
  db: Db,
  input: {
    expectedRevision: number
    reason: string
    channel: AlertChannel
    actor: AuditActor
    secret?: { id: string; ciphertext: Buffer }
  },
): Promise<PlatformConfigCurrent> {
  const current = await getOrCreatePlatformConfig(db)
  const old = current.document.notifications.channels.find(c => c.id === input.channel.id)
  const { writeNotificationConfig } = await import('../notifications/config.js')
  return writeNotificationConfig(db, {
    actorId: input.actor.id, expectedRevision: input.expectedRevision, reason: input.reason,
    channel: { id: input.channel.id, name: input.channel.name, kind: 'webhook', enabled: input.channel.enabled,
      secretRef: input.channel.secretRef, host: input.channel.urlHost, version: (old?.version ?? 0) + 1,
      allowAlerts: true, targetIds: [], recipients: [], format: 'legacy_alert@1', replay: 'manual_on_unknown' },
    secrets: input.secret ? [input.secret] : [],
  })
}
