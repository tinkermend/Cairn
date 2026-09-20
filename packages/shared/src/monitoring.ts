import { z } from 'zod'
import { OBJECT_MISSING_REASONS } from './object-store.js'
import { nextCursorSchema } from './rbac.js'
import { SESSION_PROFILE_STATES } from './session-occupancy.js'
import { utcInstantSchema } from './wire.js'

/**
 * 运行监控指标值域。RM-A/B/C 与后续告警共用本文件，不得另起一份。
 */

export const MONITOR_LAYERS = ['L1', 'L2', 'L3', 'L4'] as const
export type MonitorLayer = (typeof MONITOR_LAYERS)[number]

export const MONITOR_UNITS = ['count', 'milliseconds', 'seconds', 'bytes', 'percent'] as const
export type MonitorUnit = (typeof MONITOR_UNITS)[number]

export const MONITOR_SAMPLE_SCOPES = ['platform', 'api', 'worker'] as const
export type MonitorSampleScope = (typeof MONITOR_SAMPLE_SCOPES)[number]

export const MONITOR_API_ID_SOURCES = ['configured', 'derived'] as const
export type MonitorApiIdSource = (typeof MONITOR_API_ID_SOURCES)[number]

export const DEFAULT_API_HEARTBEAT_MS = 5_000
export const DEFAULT_API_LOST_AFTER_SECONDS = 45
export const DEFAULT_MONITOR_SAMPLE_INTERVAL_MS = 60_000
export const MIN_MONITOR_SAMPLE_INTERVAL_MS = 15_000
export const DEFAULT_MONITOR_SAMPLE_RETENTION_DAYS = 30
export const DEFAULT_MONITOR_DISK_SAMPLE_MS = 60_000
export const DEFAULT_MONITOR_OBJECT_STORE_PROBE_MS = 60_000
export const DEFAULT_MONITOR_SERIES_WINDOW_MS = 6 * 60 * 60 * 1000
export const MAX_MONITOR_SERIES_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_MONITOR_SERIES_POINTS = 300
export const MAX_MONITOR_SERIES_KEYS = 8
export const MONITOR_AI_WINDOW_HOURS = 24
export const MONITOR_AI_P95_SAMPLE_LIMIT = 5_000
export const MONITOR_PROBE_RATE_LIMIT_MS = 10_000
export const WORKER_NODE_LOOP_STALE_HEARTBEATS = 3
export const WORKER_NODE_HEALTH_PING_TIMEOUT_MS = 1_500
export const MONITOR_OBJECT_STORE_KIND = 'default' as const
export const SCENARIO_AI_LEDGER_PURPOSE = 'scenario_step' as const

export const MONITOR_SOURCES = ['self', 'registry', 'aggregate', 'sample'] as const
export type MonitorSource = (typeof MONITOR_SOURCES)[number]

export const MONITOR_UNKNOWN_REASONS = [
  'not_collected',
  'not_reported',
  'sample_stale',
  'instance_replaced',
  'unsupported',
  'unavailable',
] as const
export type MonitorUnknownReason = (typeof MONITOR_UNKNOWN_REASONS)[number]

export const MONITOR_UNAVAILABLE_REASONS = ['DATA_PLANE_UNAVAILABLE', 'AGGREGATE_FAILED'] as const
export type MonitorUnavailableReason = (typeof MONITOR_UNAVAILABLE_REASONS)[number]

export const MONITOR_SCHEMA_CONSISTENCY = ['consistent', 'mismatch', 'unknown'] as const
export type MonitorSchemaConsistency = (typeof MONITOR_SCHEMA_CONSISTENCY)[number]

export const MONITOR_METRIC_KEYS = [
  'api.uptimeSeconds',
  'database.pingLatencyMs',
  'database.pool.totalCount',
  'database.pool.idleCount',
  'database.pool.waitingCount',
  'worker.status.ready',
  'worker.status.draining',
  'worker.status.stopped',
  'worker.status.lost',
  'worker.heartbeat.fresh',
  'worker.heartbeat.stale',
  'worker.capacity.total',
  'worker.capacity.used',
  'worker.sessions.total',
  'worker.sessions.used',
  'worker.slots.occupied',
  'worker.slots.lostOccupied',
  'worker.slots.executing',
  'worker.slots.running',
  'worker.slots.holding',
  'worker.slots.waitingForAuth',
  'worker.slots.leftoverAuthHolds',
  'worker.slots.expiredLeaseResidue',
  'worker.slots.runCapacityUsed',
  'queue.claimableRuns',
  'queue.oldestWaitMs',
  'queue.unclaimableRuns',
  'queue.recovering',
  'queue.needsReview',
  'queue.sessionOperations',
  'queue.schedulePending',
  'queue.mapJobsActive',
  'queue.mapJobsQueued',
  'queue.mapJobsRunning',
  'queue.mapJobsActiveGuardMismatch',
  'queue.maxTargetBacklog',
  'queue.targetsWithBacklog',
  'queue.targetBacklogP95',
  'queue.lastClaimScanCount',
  'queue.lastGlobalReclaimAgeMs',
  'lease.expiredActiveRunLeases',
  'lease.expiredActiveSessionLeases',
  'lease.leftoverAuthHolds',
  'lease.orphanAttempts',
  'lease.recoveryCappedRuns',
  'evidence.pendingUpload',
  'evidence.uploadFailed',
  'evidence.maxUploadAttempts',
  'evidence.purgeBacklog',
  'evidence.purgeFailed',
  'profile.pendingCleanups',
  'profile.diskUsageBytes',
  'api.instances.ready',
  'api.process.rssBytes',
  'api.process.eventLoopDelayMs',
  'api.sse.connections',
  'api.internalForward.inFlight',
  'worker.process.rssBytes',
  'worker.process.eventLoopDelayMs',
  'worker.process.cpuPercent',
  'worker.clockSkewMs',
  'worker.browserProcessCount',
  'worker.profileCount',
  'worker.profileDiskFreeBytes',
  'worker.midsceneBytes',
  'profile.nodeDiskUsageBytes',
  'objectStore.up',
  'objectStore.probeLatencyMs',
  'ai.calls',
  'ai.errors',
  'ai.inputTokens',
  'ai.outputTokens',
] as const
export type MonitorMetricKey = (typeof MONITOR_METRIC_KEYS)[number]
export const monitorMetricKeySchema = z.enum(MONITOR_METRIC_KEYS)

export const MONITOR_SAMPLE_KEYS = [
  'worker.status.ready',
  'worker.status.lost',
  'worker.capacity.used',
  'worker.sessions.used',
  'queue.claimableRuns',
  'queue.oldestWaitMs',
  'queue.unclaimableRuns',
  'queue.recovering',
  'queue.needsReview',
  'queue.targetsWithBacklog',
  'queue.targetBacklogP95',
  'queue.lastClaimScanCount',
  'evidence.pendingUpload',
  'evidence.uploadFailed',
  'lease.expiredActiveRunLeases',
  'api.instances.ready',
  'api.process.rssBytes',
  'api.process.eventLoopDelayMs',
  'api.sse.connections',
  'api.internalForward.inFlight',
  'worker.process.rssBytes',
  'worker.process.eventLoopDelayMs',
  'worker.process.cpuPercent',
  'worker.clockSkewMs',
  'worker.browserProcessCount',
  'worker.profileCount',
  'worker.profileDiskFreeBytes',
  'worker.midsceneBytes',
  'profile.nodeDiskUsageBytes',
  'objectStore.up',
  'objectStore.probeLatencyMs',
  'ai.calls',
  'ai.errors',
  'ai.inputTokens',
  'ai.outputTokens',
] as const satisfies readonly MonitorMetricKey[]
export type MonitorSampleKey = (typeof MONITOR_SAMPLE_KEYS)[number]
export const monitorSampleKeySchema = z.enum(MONITOR_SAMPLE_KEYS)
export const MONITOR_DEFAULT_SERIES_KEYS = [
  'queue.claimableRuns',
  'worker.status.ready',
  'evidence.pendingUpload',
] as const satisfies readonly MonitorSampleKey[]

export const MONITOR_SAMPLE_KEY_SCOPES = {
  'worker.status.ready': 'platform',
  'worker.status.lost': 'platform',
  'worker.capacity.used': 'platform',
  'worker.sessions.used': 'platform',
  'queue.claimableRuns': 'platform',
  'queue.oldestWaitMs': 'platform',
  'queue.unclaimableRuns': 'platform',
  'queue.recovering': 'platform',
  'queue.needsReview': 'platform',
  'queue.targetsWithBacklog': 'platform',
  'queue.targetBacklogP95': 'platform',
  'queue.lastClaimScanCount': 'worker',
  'evidence.pendingUpload': 'platform',
  'evidence.uploadFailed': 'platform',
  'lease.expiredActiveRunLeases': 'platform',
  'api.instances.ready': 'platform',
  'api.process.rssBytes': 'api',
  'api.process.eventLoopDelayMs': 'api',
  'api.sse.connections': 'api',
  'api.internalForward.inFlight': 'api',
  'worker.process.rssBytes': 'worker',
  'worker.process.eventLoopDelayMs': 'worker',
  'worker.process.cpuPercent': 'worker',
  'worker.clockSkewMs': 'worker',
  'worker.browserProcessCount': 'worker',
  'worker.profileCount': 'worker',
  'worker.profileDiskFreeBytes': 'worker',
  'worker.midsceneBytes': 'worker',
  'profile.nodeDiskUsageBytes': 'worker',
  'objectStore.up': 'platform',
  'objectStore.probeLatencyMs': 'platform',
  'ai.calls': 'platform',
  'ai.errors': 'platform',
  'ai.inputTokens': 'platform',
  'ai.outputTokens': 'platform',
} as const satisfies Record<MonitorSampleKey, MonitorSampleScope>

export type MonitorMetricDef = {
  layer: MonitorLayer
  unit: MonitorUnit
  unknownWhen: readonly MonitorUnknownReason[]
}

const L1_SELF: readonly MonitorUnknownReason[] = ['unavailable']
const L1_POOL: readonly MonitorUnknownReason[] = ['unsupported', 'unavailable']
const L2_REGISTRY: readonly MonitorUnknownReason[] = ['unavailable']
const L3_AGGREGATE: readonly MonitorUnknownReason[] = ['unavailable']
const L3_NOT_COLLECTED: readonly MonitorUnknownReason[] = ['not_collected']
const L2_SAMPLE: readonly MonitorUnknownReason[] = [
  'not_collected',
  'not_reported',
  'sample_stale',
  'instance_replaced',
  'unavailable',
]
const L2_PROCESS: readonly MonitorUnknownReason[] = ['not_reported', 'unavailable']

export const MONITOR_METRIC_CATALOG: { readonly [K in MonitorMetricKey]: MonitorMetricDef } = {
  'api.uptimeSeconds': { layer: 'L1', unit: 'seconds', unknownWhen: L1_SELF },
  'database.pingLatencyMs': { layer: 'L1', unit: 'milliseconds', unknownWhen: ['unavailable'] },
  'database.pool.totalCount': { layer: 'L1', unit: 'count', unknownWhen: L1_POOL },
  'database.pool.idleCount': { layer: 'L1', unit: 'count', unknownWhen: L1_POOL },
  'database.pool.waitingCount': { layer: 'L1', unit: 'count', unknownWhen: L1_POOL },
  'worker.status.ready': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.status.draining': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.status.stopped': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.status.lost': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.heartbeat.fresh': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.heartbeat.stale': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.capacity.total': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.capacity.used': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.sessions.total': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.sessions.used': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.slots.occupied': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.slots.lostOccupied': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.slots.executing': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.slots.running': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.slots.holding': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.slots.waitingForAuth': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.slots.leftoverAuthHolds': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.slots.expiredLeaseResidue': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'worker.slots.runCapacityUsed': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'queue.claimableRuns': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'queue.oldestWaitMs': { layer: 'L3', unit: 'milliseconds', unknownWhen: L3_AGGREGATE },
  'queue.unclaimableRuns': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'queue.recovering': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'queue.needsReview': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'queue.sessionOperations': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'queue.schedulePending': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'queue.mapJobsActive': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'queue.mapJobsQueued': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'queue.mapJobsRunning': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'queue.mapJobsActiveGuardMismatch': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'queue.maxTargetBacklog': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'queue.targetsWithBacklog': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'queue.targetBacklogP95': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'queue.lastClaimScanCount': { layer: 'L3', unit: 'count', unknownWhen: L3_NOT_COLLECTED },
  'queue.lastGlobalReclaimAgeMs': { layer: 'L3', unit: 'milliseconds', unknownWhen: L3_NOT_COLLECTED },
  'lease.expiredActiveRunLeases': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'lease.expiredActiveSessionLeases': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'lease.leftoverAuthHolds': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'lease.orphanAttempts': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'lease.recoveryCappedRuns': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'evidence.pendingUpload': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'evidence.uploadFailed': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'evidence.maxUploadAttempts': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'evidence.purgeBacklog': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'evidence.purgeFailed': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'profile.pendingCleanups': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'profile.diskUsageBytes': { layer: 'L3', unit: 'bytes', unknownWhen: L3_NOT_COLLECTED },
  'api.instances.ready': { layer: 'L2', unit: 'count', unknownWhen: L2_REGISTRY },
  'api.process.rssBytes': { layer: 'L2', unit: 'bytes', unknownWhen: L2_PROCESS },
  'api.process.eventLoopDelayMs': { layer: 'L2', unit: 'milliseconds', unknownWhen: L2_PROCESS },
  'api.sse.connections': { layer: 'L2', unit: 'count', unknownWhen: L2_PROCESS },
  'api.internalForward.inFlight': { layer: 'L2', unit: 'count', unknownWhen: L2_PROCESS },
  'worker.process.rssBytes': { layer: 'L2', unit: 'bytes', unknownWhen: L2_PROCESS },
  'worker.process.eventLoopDelayMs': { layer: 'L2', unit: 'milliseconds', unknownWhen: L2_PROCESS },
  'worker.process.cpuPercent': { layer: 'L2', unit: 'percent', unknownWhen: L2_PROCESS },
  'worker.clockSkewMs': { layer: 'L2', unit: 'milliseconds', unknownWhen: L2_SAMPLE },
  'worker.browserProcessCount': { layer: 'L2', unit: 'count', unknownWhen: L2_SAMPLE },
  'worker.profileCount': { layer: 'L2', unit: 'count', unknownWhen: L2_SAMPLE },
  'worker.profileDiskFreeBytes': { layer: 'L2', unit: 'bytes', unknownWhen: L2_SAMPLE },
  'worker.midsceneBytes': { layer: 'L2', unit: 'bytes', unknownWhen: L2_SAMPLE },
  'profile.nodeDiskUsageBytes': { layer: 'L2', unit: 'bytes', unknownWhen: L2_SAMPLE },
  'objectStore.up': { layer: 'L2', unit: 'count', unknownWhen: L2_SAMPLE },
  'objectStore.probeLatencyMs': { layer: 'L2', unit: 'milliseconds', unknownWhen: L2_SAMPLE },
  'ai.calls': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'ai.errors': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'ai.inputTokens': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
  'ai.outputTokens': { layer: 'L3', unit: 'count', unknownWhen: L3_AGGREGATE },
}

export const monitorUnknownReasonSchema = z.enum(MONITOR_UNKNOWN_REASONS)

export const monitorMetricNumberSchema = z.discriminatedUnion('availability', [
  z.object({ availability: z.literal('known'), value: z.number().finite() }),
  z.object({ availability: z.literal('unknown'), reason: monitorUnknownReasonSchema }),
])
export type MonitorMetricNumber = z.infer<typeof monitorMetricNumberSchema>

export function knownMetric(value: number): MonitorMetricNumber {
  return { availability: 'known', value }
}

export function unknownMetric(reason: MonitorUnknownReason): MonitorMetricNumber {
  return { availability: 'unknown', reason }
}

export const MONITOR_REALTIME_UNAVAILABLE = '实时进度不可用' as const

export const monitorSourceSchema = z.enum(MONITOR_SOURCES)
export const monitorUnavailableReasonSchema = z.enum(MONITOR_UNAVAILABLE_REASONS)

export function monitorPartitionSchema<T extends z.ZodTypeAny>(data: T) {
  return z.discriminatedUnion('availability', [
    z.object({
      availability: z.literal('available'),
      source: monitorSourceSchema,
      sampledAt: utcInstantSchema,
      data,
    }),
    z.object({
      availability: z.literal('unavailable'),
      reasonCode: monitorUnavailableReasonSchema,
      message: z.string().min(1),
    }),
  ])
}

export const monitorApiInstanceItemSchema = z.object({
  id: z.string().min(1).max(256),
  idSource: z.enum(MONITOR_API_ID_SOURCES),
  instanceId: z.string().min(1),
  status: z.enum(['READY', 'DRAINING', 'STOPPED', 'LOST']),
  version: z.string().min(1).nullable(),
  schemaLogicalVersion: z.string().min(1).nullable(),
  heartbeatAt: utcInstantSchema.nullable(),
  heartbeatExpiresAt: utcInstantSchema.nullable(),
  startedAt: utcInstantSchema.nullable(),
  rssBytes: monitorMetricNumberSchema,
  eventLoopDelayMs: monitorMetricNumberSchema,
  sseConnections: monitorMetricNumberSchema,
  internalForwardInFlight: monitorMetricNumberSchema,
})
export type MonitorApiInstanceItem = z.infer<typeof monitorApiInstanceItemSchema>

export const monitorObjectStoreCardSchema = z.object({
  status: monitorMetricNumberSchema,
  latencyMs: monitorMetricNumberSchema,
  probedAt: utcInstantSchema.nullable(),
  errorClass: z.string().min(1).max(64).nullable(),
})
export type MonitorObjectStoreCard = z.infer<typeof monitorObjectStoreCardSchema>

export const monitorServiceCardSchema = z.object({
  api: z.object({
    status: z.enum(['ok', 'degraded']),
    service: z.enum(['cairn-api', 'cairn-worker']),
    uptimeSeconds: monitorMetricNumberSchema,
  }),
  database: z.object({
    driver: z.enum(['postgres', 'mysql', 'sqlite']),
    ping: z.enum(['up', 'down']),
    pingLatencyMs: monitorMetricNumberSchema,
    expectedLogicalVersion: z.string().min(1),
    appliedPrefix: z.string().min(1).nullable(),
    expectedPrefix: z.string().min(1),
    schemaConsistency: z.enum(MONITOR_SCHEMA_CONSISTENCY),
    pool: z.object({
      totalCount: monitorMetricNumberSchema,
      idleCount: monitorMetricNumberSchema,
      waitingCount: monitorMetricNumberSchema,
    }),
  }),
  changeHint: z.object({
    status: z.enum(['up', 'down', 'unused']),
    realtime: z.boolean(),
    realtimeProgressAvailable: z.boolean(),
    consequence: z.string().nullable(),
  }),
  apiInstances: z
    .object({
      ready: monitorMetricNumberSchema,
      lost: monitorMetricNumberSchema,
      derivedCount: monitorMetricNumberSchema,
      items: z.array(monitorApiInstanceItemSchema).max(16),
    })
    .default({
      ready: unknownMetric('not_collected'),
      lost: unknownMetric('not_collected'),
      derivedCount: unknownMetric('not_collected'),
      items: [],
    }),
  objectStore: monitorObjectStoreCardSchema.default({
    status: unknownMetric('not_collected'),
    latencyMs: unknownMetric('not_collected'),
    probedAt: null,
    errorClass: null,
  }),
})
export type MonitorServiceCard = z.infer<typeof monitorServiceCardSchema>

export const monitorWorkerSampleItemSchema = z.object({
  workerId: z.string().min(1),
  rssBytes: monitorMetricNumberSchema,
  cpuPercent: monitorMetricNumberSchema,
  eventLoopDelayMs: monitorMetricNumberSchema,
  browserProcessCount: monitorMetricNumberSchema,
  clockSkewMs: monitorMetricNumberSchema,
  sampledAt: utcInstantSchema.nullable(),
})
export type MonitorWorkerSampleItem = z.infer<typeof monitorWorkerSampleItemSchema>

export const monitorCapacityCardSchema = z.object({
  workers: z.object({
    ready: monitorMetricNumberSchema,
    draining: monitorMetricNumberSchema,
    stopped: monitorMetricNumberSchema,
    lost: monitorMetricNumberSchema,
    heartbeatFresh: monitorMetricNumberSchema,
    heartbeatStale: monitorMetricNumberSchema,
  }),
  capacity: z.object({
    total: monitorMetricNumberSchema,
    used: monitorMetricNumberSchema,
  }),
  sessions: z.object({
    total: monitorMetricNumberSchema,
    used: monitorMetricNumberSchema,
  }),
  slots: z.object({
    occupied: monitorMetricNumberSchema,
    lostOccupied: monitorMetricNumberSchema,
    executing: monitorMetricNumberSchema,
    running: monitorMetricNumberSchema,
    holding: monitorMetricNumberSchema,
    waitingForAuth: monitorMetricNumberSchema,
    leftoverAuthHolds: monitorMetricNumberSchema,
    expiredLeaseResidue: monitorMetricNumberSchema,
    runCapacityUsed: monitorMetricNumberSchema,
  }),
  workerSamples: z
    .object({
      items: z.array(monitorWorkerSampleItemSchema).max(32),
    })
    .default({ items: [] }),
})
export type MonitorCapacityCard = z.infer<typeof monitorCapacityCardSchema>

export const monitorQueuesCardSchema = z.object({
  claimableRuns: monitorMetricNumberSchema,
  oldestWaitMs: monitorMetricNumberSchema,
  unclaimableRuns: monitorMetricNumberSchema,
  recovering: monitorMetricNumberSchema,
  needsReview: monitorMetricNumberSchema,
  sessionOperations: monitorMetricNumberSchema,
  schedulePending: monitorMetricNumberSchema,
  mapJobsActive: monitorMetricNumberSchema,
  mapJobsQueued: monitorMetricNumberSchema,
  mapJobsRunning: monitorMetricNumberSchema,
  mapJobsActiveGuardMismatch: monitorMetricNumberSchema,
  maxTargetBacklog: monitorMetricNumberSchema,
  targetsWithBacklog: monitorMetricNumberSchema.default(knownMetric(0)),
  targetBacklogP95: monitorMetricNumberSchema.default(knownMetric(0)),
  lastClaimScanCount: monitorMetricNumberSchema.default(unknownMetric('not_collected')),
  lastGlobalReclaimAgeMs: monitorMetricNumberSchema,
})
export type MonitorQueuesCard = z.infer<typeof monitorQueuesCardSchema>

export const monitorMissingReasonCountSchema = z.object({
  reason: z.string().min(1).max(64),
  count: z.number().int().nonnegative(),
})

export const monitorAnomaliesCardSchema = z.object({
  leases: z.object({
    expiredActiveRunLeases: monitorMetricNumberSchema,
    expiredActiveSessionLeases: monitorMetricNumberSchema,
    leftoverAuthHolds: monitorMetricNumberSchema,
    orphanAttempts: monitorMetricNumberSchema,
    recoveryCappedRuns: monitorMetricNumberSchema,
  }),
  evidence: z.object({
    pendingUpload: monitorMetricNumberSchema,
    uploadFailed: monitorMetricNumberSchema,
    maxUploadAttempts: monitorMetricNumberSchema,
    purgeBacklog: monitorMetricNumberSchema,
    purgeFailed: monitorMetricNumberSchema,
    missingReasons: z.array(monitorMissingReasonCountSchema).max(32),
  }),
  clockSkew: z
    .object({
      maxAbsSkewMs: monitorMetricNumberSchema,
    })
    .default({
      maxAbsSkewMs: unknownMetric('not_collected'),
    }),
})
export type MonitorAnomaliesCard = z.infer<typeof monitorAnomaliesCardSchema>

export const monitorAiCardSchema = z.object({
  calls: monitorMetricNumberSchema,
  errors: monitorMetricNumberSchema,
  inputTokens: monitorMetricNumberSchema,
  outputTokens: monitorMetricNumberSchema,
  durationP95Ms: monitorMetricNumberSchema,
  cost: monitorMetricNumberSchema,
  lastCallAt: utcInstantSchema.nullable(),
  lastErrorAt: utcInstantSchema.nullable(),
  lastErrorClass: z.string().min(1).max(64).nullable(),
})
export type MonitorAiCard = z.infer<typeof monitorAiCardSchema>

export const monitorProfileNodeItemSchema = z.object({
  workerId: z.string().min(1),
  diskUsageBytes: monitorMetricNumberSchema,
  profileCount: monitorMetricNumberSchema,
  diskFreeBytes: monitorMetricNumberSchema,
  midsceneBytes: monitorMetricNumberSchema,
  sampledAt: utcInstantSchema.nullable(),
})
export type MonitorProfileNodeItem = z.infer<typeof monitorProfileNodeItemSchema>

export const monitorServicePartitionSchema = monitorPartitionSchema(monitorServiceCardSchema)
export const monitorCapacityPartitionSchema = monitorPartitionSchema(monitorCapacityCardSchema)
export const monitorQueuesPartitionSchema = monitorPartitionSchema(monitorQueuesCardSchema)
export const monitorAnomaliesPartitionSchema = monitorPartitionSchema(monitorAnomaliesCardSchema)
export const monitorAiPartitionSchema = monitorPartitionSchema(monitorAiCardSchema)

const unknownAiCard: MonitorAiCard = {
  calls: unknownMetric('not_collected'),
  errors: unknownMetric('not_collected'),
  inputTokens: unknownMetric('not_collected'),
  outputTokens: unknownMetric('not_collected'),
  durationP95Ms: unknownMetric('not_collected'),
  cost: unknownMetric('not_collected'),
  lastCallAt: null,
  lastErrorAt: null,
  lastErrorClass: null,
}

export const monitoringOverviewResponseSchema = z.object({
  asOf: utcInstantSchema,
  partitions: z.object({
    service: monitorServicePartitionSchema,
    capacity: monitorCapacityPartitionSchema,
    queues: monitorQueuesPartitionSchema,
    anomalies: monitorAnomaliesPartitionSchema,
    ai: monitorAiPartitionSchema.default({
      availability: 'unavailable',
      reasonCode: 'AGGREGATE_FAILED',
      message: 'AI 账本尚未采集',
    }),
  }),
})
export type MonitoringOverviewResponse = z.infer<typeof monitoringOverviewResponseSchema>

export const monitorProfileListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: nextCursorSchema,
})
export type MonitorProfileListQuery = z.infer<typeof monitorProfileListQuerySchema>
export type MonitorProfileListQueryInput = z.input<typeof monitorProfileListQuerySchema>

export const monitorProfileItemSchema = z.object({
  profileKey: z.string().min(1),
  locationWorkerId: z.string().min(1).nullable(),
  state: z.enum(SESSION_PROFILE_STATES),
  revision: z.number().int(),
  pendingCleanups: z.number().int().nonnegative(),
  targetId: z.string().min(1),
  targetAccountId: z.string().min(1),
  targetName: z.string().min(1).nullable(),
  accountLabel: z.string().min(1).nullable(),
  updatedAt: utcInstantSchema,
  diskUsageBytes: monitorMetricNumberSchema,
})
export type MonitorProfileItem = z.infer<typeof monitorProfileItemSchema>

export const monitorProfileListResponseSchema = z.object({
  asOf: utcInstantSchema,
  items: z.array(monitorProfileItemSchema),
  nodes: z.array(monitorProfileNodeItemSchema).max(32).default([]),
  nextCursor: nextCursorSchema,
})
export type MonitorProfileListResponse = z.infer<typeof monitorProfileListResponseSchema>

/** 与 reaper / expireStaleRunLeases 出厂上限一致。 */
export const DEFAULT_MONITOR_MAX_RECOVERIES = 3

/** `evidence.uploadFailed` 只计上传/对象存储失败，不含清理或采集失败。 */
export const MONITOR_UPLOAD_FAILED_REASONS = [
  OBJECT_MISSING_REASONS.storeUnavailable,
  OBJECT_MISSING_REASONS.uploadIncomplete,
] as const

export const monitorStreamQuerySchema = z.object({
  intervalMs: z.coerce.number().int().positive().max(60_000).optional(),
})
export type MonitorStreamQuery = z.infer<typeof monitorStreamQuerySchema>
export type MonitorStreamQueryInput = z.input<typeof monitorStreamQuerySchema>

export const monitorStreamControlSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ready'),
    intervalMs: z.number().int().positive(),
    minIntervalMs: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('error'),
    code: z.enum(['UNAUTHORIZED', 'FORBIDDEN', 'INTERNAL']),
    message: z.string().min(1),
  }),
])
export type MonitorStreamControl = z.infer<typeof monitorStreamControlSchema>

export function clampMonitorSseInterval(
  requested: number | undefined,
  minIntervalMs: number,
  defaultIntervalMs: number,
): number {
  return Math.max(minIntervalMs, requested ?? defaultIntervalMs)
}

export function resolveBuildVersion(raw: string | undefined | null): string | null {
  const value = raw?.trim() ?? ''
  if (!value || value === '0.0.0') return null
  return value
}

export function deriveApiInstanceId(hostname: string, port: number): string {
  return `${hostname}:${port}`
}

export function alignMonitorSampleBucket(at: Date, intervalMs: number): Date {
  const ms = Math.max(MIN_MONITOR_SAMPLE_INTERVAL_MS, intervalMs)
  return new Date(Math.floor(at.getTime() / ms) * ms)
}

export function downsampleMonitorSeries<T extends { bucketAt: string; value: number }>(
  points: readonly T[],
  maxPoints = MAX_MONITOR_SERIES_POINTS,
): T[] {
  if (points.length <= maxPoints) return [...points]
  const first = Date.parse(points[0]!.bucketAt)
  const last = Date.parse(points.at(-1)!.bucketAt)
  const span = Math.max(1, last - first)
  const coarse = Math.ceil(span / maxPoints)
  const lastInBucket = new Map<number, T>()
  for (const point of points) {
    const key = Math.floor((Date.parse(point.bucketAt) - first) / coarse)
    lastInBucket.set(key, point)
  }
  const sorted = [...lastInBucket.values()].sort((a, b) => a.bucketAt.localeCompare(b.bucketAt))
  if (sorted.length <= maxPoints) return sorted
  return [...sorted.slice(0, maxPoints - 1), sorted.at(-1)!]
}

export const monitorSeriesQuerySchema = z
  .object({
    keys: z
      .string()
      .min(1)
      .transform((raw) =>
        raw
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      )
      .pipe(z.array(monitorSampleKeySchema).min(1).max(MAX_MONITOR_SERIES_KEYS)),
    from: utcInstantSchema.optional(),
    to: utcInstantSchema.optional(),
    scope: z.enum(MONITOR_SAMPLE_SCOPES).default('platform'),
    scopeId: z.string().max(256).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.from && value.to && Date.parse(value.from) >= Date.parse(value.to)) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'from 必须早于 to' })
    }
    const toMs = value.to ? Date.parse(value.to) : Date.now()
    const fromMs = value.from ? Date.parse(value.from) : toMs - DEFAULT_MONITOR_SERIES_WINDOW_MS
    if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs - fromMs > MAX_MONITOR_SERIES_WINDOW_MS) {
      ctx.addIssue({ code: 'custom', path: value.to ? ['to'] : ['from'], message: '查询跨度不得超过 30 天' })
    }
    if (value.scope !== 'platform' && !value.scopeId) {
      ctx.addIssue({ code: 'custom', path: ['scopeId'], message: '非 platform scope 必须提供 scopeId' })
    }
  })
export type MonitorSeriesQuery = z.infer<typeof monitorSeriesQuerySchema>
export type MonitorSeriesQueryInput = z.input<typeof monitorSeriesQuerySchema>

export const monitorSeriesPointSchema = z.object({
  bucketAt: utcInstantSchema,
  value: z.number().finite(),
})
export type MonitorSeriesPoint = z.infer<typeof monitorSeriesPointSchema>

export const monitorSeriesItemSchema = z.object({
  key: monitorSampleKeySchema,
  scope: z.enum(MONITOR_SAMPLE_SCOPES),
  scopeId: z.string(),
  points: z.array(monitorSeriesPointSchema).max(MAX_MONITOR_SERIES_POINTS),
})
export type MonitorSeriesItem = z.infer<typeof monitorSeriesItemSchema>

export const monitorSeriesResponseSchema = z.object({
  asOf: utcInstantSchema,
  from: utcInstantSchema,
  to: utcInstantSchema,
  scope: z.enum(MONITOR_SAMPLE_SCOPES),
  scopeId: z.string(),
  items: z.array(monitorSeriesItemSchema).max(MAX_MONITOR_SERIES_KEYS),
})
export type MonitorSeriesResponse = z.infer<typeof monitorSeriesResponseSchema>

export const monitorProbeBodySchema = z.object({
  target: z.literal('object_store'),
})
export type MonitorProbeBody = z.infer<typeof monitorProbeBodySchema>

export const monitorProbeResponseSchema = z.object({
  asOf: utcInstantSchema,
  target: z.literal('object_store'),
  objectStore: monitorObjectStoreCardSchema,
})
export type MonitorProbeResponse = z.infer<typeof monitorProbeResponseSchema>

export { unknownAiCard }
