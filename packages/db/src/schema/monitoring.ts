import { bigint, doublePrecision, index, integer, jsonb, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  AlertComparator,
  AlertDeliveryState,
  AlertNoticeKind,
  AlertRuleKind,
  AlertSeverity,
  AlertStaleSource,
  AlertState,
  MonitorApiIdSource,
  MonitorSampleScope,
  WorkerStatus,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'

export const apiInstances = cairnSchema.table(
  'api_instances',
  {
    id: text('id').primaryKey(),
    instanceId: uuid('instance_id').notNull(),
    idSource: text('id_source').notNull().$type<MonitorApiIdSource>(),
    status: text('status').notNull().$type<WorkerStatus>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull(),
    heartbeatExpiresAt: timestamp('heartbeat_expires_at', { withTimezone: true }),
    lostAfterSeconds: integer('lost_after_seconds'),
    version: text('version'),
    schemaLogicalVersion: text('schema_logical_version'),
    sampledRssBytes: bigint('sampled_rss_bytes', { mode: 'number' }),
    sampledEventLoopDelayMs: doublePrecision('sampled_event_loop_delay_ms'),
    sampledSseConnections: integer('sampled_sse_connections'),
    sampledInternalForwardInFlight: integer('sampled_internal_forward_in_flight'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
  },
  (t) => [index('api_instances_expire_idx').on(t.status, t.heartbeatExpiresAt)],
)

export const objectStoreProbes = cairnSchema.table('object_store_probes', {
  storeKind: text('store_kind').primaryKey(),
  status: text('status').notNull().$type<'ok' | 'failed'>(),
  latencyMs: integer('latency_ms'),
  errorClass: text('error_class'),
  probedAt: timestamp('probed_at', { withTimezone: true }).notNull(),
  probedBy: text('probed_by').notNull(),
})

export const monitorSamples = cairnSchema.table(
  'monitor_samples',
  {
    metricKey: text('metric_key').notNull(),
    scope: text('scope').notNull().$type<MonitorSampleScope>(),
    scopeId: text('scope_id').notNull(),
    bucketAt: timestamp('bucket_at', { withTimezone: true }).notNull(),
    value: doublePrecision('value').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.metricKey, t.scope, t.scopeId, t.bucketAt], name: 'monitor_samples_pkey' }),
    index('monitor_samples_bucket_idx').on(t.bucketAt),
  ],
)

export const scenarioAiCalls = cairnSchema.table(
  'scenario_ai_calls',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    evidenceId: uuid('evidence_id').notNull(),
    runId: uuid('run_id').notNull(),
    stepRunId: uuid('step_run_id').notNull(),
    attemptId: uuid('attempt_id'),
    purpose: text('purpose').notNull(),
    model: text('model'),
    phase: text('phase').notNull().$type<'completed' | 'failed'>(),
    durationMs: integer('duration_ms'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cost: doublePrecision('cost'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('scenario_ai_calls_evidence_unique').on(t.evidenceId),
    index('scenario_ai_calls_created_idx').on(t.createdAt),
    index('scenario_ai_calls_model_created_idx').on(t.model, t.createdAt),
  ],
)

export const monitoringAlerts = cairnSchema.table(
  'monitoring_alerts',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    ruleId: text('rule_id').notNull(),
    ruleName: text('rule_name').notNull(),
    scope: text('scope').notNull().$type<MonitorSampleScope>(),
    scopeId: text('scope_id').notNull(),
    state: text('state').notNull().$type<AlertState>(),
    severity: text('severity').notNull().$type<AlertSeverity>(),
    kind: text('kind').notNull().$type<AlertRuleKind>(),
    metricKey: text('metric_key'),
    staleSource: text('stale_source').$type<AlertStaleSource>(),
    comparator: text('comparator').$type<AlertComparator>(),
    threshold: doublePrecision('threshold'),
    conditionOpenedAt: timestamp('condition_opened_at', { withTimezone: true }).notNull(),
    firedAt: timestamp('fired_at', { withTimezone: true }),
    recoveryOpenedAt: timestamp('recovery_opened_at', { withTimezone: true }),
    interruptedAt: timestamp('interrupted_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    triggerValue: doublePrecision('trigger_value'),
    channelIds: jsonb('channel_ids').$type<string[]>().notNull().default([]),
    openKey: text('open_key'),
    silencedUntil: timestamp('silenced_until', { withTimezone: true }),
    silencedBy: text('silenced_by'),
    deliveryStatus: text('delivery_status').$type<AlertDeliveryState>(),
    deliveryKind: text('delivery_kind').$type<AlertNoticeKind>(),
    deliveryAttempts: integer('delivery_attempts').notNull().default(0),
    deliveryClaimedAt: timestamp('delivery_claimed_at', { withTimezone: true }),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    lastDeliveryError: text('last_delivery_error'),
    lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('monitoring_alerts_open_key_idx').on(t.openKey),
    index('monitoring_alerts_active_idx').on(t.state, t.firedAt),
    index('monitoring_alerts_history_idx').on(t.resolvedAt, t.id),
    index('monitoring_alerts_delivery_idx').on(t.deliveryStatus, t.nextRetryAt),
  ],
)

export type ApiInstanceRow = typeof apiInstances.$inferSelect
export type ObjectStoreProbeRow = typeof objectStoreProbes.$inferSelect
export type MonitorSampleRow = typeof monitorSamples.$inferSelect
export type ScenarioAiCallRow = typeof scenarioAiCalls.$inferSelect
export type MonitoringAlertRow = typeof monitoringAlerts.$inferSelect
