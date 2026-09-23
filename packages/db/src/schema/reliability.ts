import { bigint, doublePrecision, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  BaselineKind,
  EvidenceScores,
  FeatureWindowType,
  IncidentLineage,
  IncidentSeverity,
  IncidentStatus,
  MapChangeCandidateStatus,
  ReliabilitySignalKind,
  ReliabilitySignalSeverity,
  WatermarkVector,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { targets } from './targets.js'

export const reliabilitySignals = cairnSchema.table(
  'reliability_signals',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().$type<ReliabilitySignalKind>(),
    severity: text('severity').notNull().default('WARN').$type<ReliabilitySignalSeverity>(),
    subjectRef: jsonb('subject_ref').notNull().$type<Record<string, unknown>>(),
    sourceRef: jsonb('source_ref').notNull().$type<Record<string, unknown>>(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    commitPosition: bigint('commit_position', { mode: 'number' }),
    value: doublePrecision('value'),
    unit: text('unit'),
    scopeDigest: text('scope_digest').notNull(),
    groupingKey: text('grouping_key'),
    availability: text('availability', { enum: ['available', 'missing', 'truncated'] })
      .notNull()
      .default('available'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_rel_signals_target_occurred').on(t.targetId, t.occurredAt),
    index('idx_rel_signals_grouping').on(t.groupingKey),
    index('idx_rel_signals_scope').on(t.scopeDigest),
  ],
)

export const featureWindows = cairnSchema.table(
  'feature_windows',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    scopeDigest: text('scope_digest').notNull(),
    windowType: text('window_type').notNull().$type<FeatureWindowType>(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    metricVersion: text('metric_version').notNull().default('1.0'),
    sampleCount: integer('sample_count').notNull().default(0),
    primaryHitCount: integer('primary_hit_count').notNull().default(0),
    fallbackCount: integer('fallback_count').notNull().default(0),
    retryStepCount: integer('retry_step_count').notNull().default(0),
    ewmaLatencyMs: doublePrecision('ewma_latency_ms').notNull().default(0),
    ewmaSuccessRate: doublePrecision('ewma_success_rate').notNull().default(1.0),
    stats: jsonb('stats').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_feature_windows_target_scope_win').on(t.targetId, t.scopeDigest, t.windowType, t.windowStart),
    index('idx_feature_windows_target_end').on(t.targetId, t.windowEnd),
  ],
)

export const baselineRevisions = cairnSchema.table(
  'baseline_revisions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    scopeDigest: text('scope_digest').notNull(),
    baselineKind: text('baseline_kind').notNull().$type<BaselineKind>(),
    algorithmVersion: text('algorithm_version').notNull().default('1.0'),
    sampleFloor: integer('sample_floor').notNull().default(10),
    stats: jsonb('stats').notNull().default({}),
    status: text('status', { enum: ['ready', 'insufficient', 'unavailable'] })
      .notNull()
      .default('ready'),
    excludedReasons: jsonb('excluded_reasons').$type<string[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_baseline_revisions_target_scope_kind').on(t.targetId, t.scopeDigest, t.baselineKind),
  ],
)

export const reliabilityEvaluations = cairnSchema.table(
  'reliability_evaluations',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    scopeDigest: text('scope_digest').notNull(),
    watermarkVector: jsonb('watermark_vector').notNull().$type<WatermarkVector>(),
    generation: integer('generation').notNull().default(1),
    rulesEvaluated: integer('rules_evaluated').notNull().default(0),
    breachesCount: integer('breaches_count').notNull().default(0),
    result: jsonb('result').notNull().default({}),
    coverageGaps: jsonb('coverage_gaps').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_rel_evaluations_target_generation').on(t.targetId, t.generation),
    index('idx_rel_evaluations_target_created').on(t.targetId, t.createdAt),
  ],
)

export const reliabilityCheckpoints = cairnSchema.table(
  'reliability_checkpoints',
  {
    targetId: uuid('target_id')
      .primaryKey()
      .references(() => targets.id, { onDelete: 'cascade' }),
    watermarkVector: jsonb('watermark_vector').notNull().$type<WatermarkVector>(),
    fencingToken: bigint('fencing_token', { mode: 'number' }).notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
)

export const reliabilityIncidents = cairnSchema.table(
  'reliability_incidents',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    groupingKey: text('grouping_key').notNull(),
    scopeDigest: text('scope_digest').notNull(),
    severity: text('severity').notNull().default('P3').$type<IncidentSeverity>(),
    status: text('status').notNull().default('DETECTED').$type<IncidentStatus>(),
    actionRequiredReason: text('action_required_reason'),
    memberCount: integer('member_count').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    rootCauseHypothesis: text('root_cause_hypothesis'),
    evidenceScores: jsonb('evidence_scores').notNull().$type<EvidenceScores>(),
    silencedUntil: timestamp('silenced_until', { withTimezone: true }),
    dismissedReason: text('dismissed_reason'),
    lineage: jsonb('lineage').$type<IncidentLineage>(),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_rel_incidents_target_status').on(t.targetId, t.status),
    index('idx_rel_incidents_grouping').on(t.targetId, t.groupingKey),
    index('idx_rel_incidents_last_seen').on(t.targetId, t.lastSeenAt),
  ],
)

export const reliabilityIncidentMembers = cairnSchema.table(
  'reliability_incident_members',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => reliabilityIncidents.id, { onDelete: 'cascade' }),
    memberRef: text('member_ref').notNull(),
    memberType: text('member_type').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_rel_inc_members_incident').on(t.incidentId),
    uniqueIndex('idx_rel_inc_members_uniq').on(t.incidentId, t.memberRef),
  ],
)

export const mapChangeCandidates = cairnSchema.table(
  'map_change_candidates',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    assetRef: jsonb('asset_ref').notNull().$type<Record<string, unknown>>(),
    beforeRef: jsonb('before_ref').$type<Record<string, unknown>>(),
    afterRef: jsonb('after_ref').$type<Record<string, unknown>>(),
    changeLevel: text('change_level', { enum: ['L1_structure', 'L2_object', 'L3_route'] }).notNull(),
    conditions: jsonb('conditions').notNull().$type<Record<string, unknown>>(),
    observationsCount: integer('observations_count').notNull().default(1),
    status: text('status').notNull().default('pending').$type<MapChangeCandidateStatus>(),
    evidenceScore: doublePrecision('evidence_score'),
    counterEvidenceScore: doublePrecision('counter_evidence_score'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_map_change_candidates_target_status').on(t.targetId, t.status),
  ],
)
