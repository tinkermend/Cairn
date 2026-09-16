import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  MapAssetRef,
  MapCandidateEvaluation,
  MapConditionSnapshot,
  MapConsumptionAllowedStepType,
  MapConsumptionMode,
  MapEvidenceRef,
  MapSelectionDecision,
  MapSelectionDecisionKind,
  MapSelectionReasonCode,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { attempts, runs, stepRuns } from './execution.js'
import { mapReleases } from './map-assets.js'
import { targets } from './targets.js'

export const mapConsumptionPolicies = cairnSchema.table('map_consumption_policies', {
  targetId: uuid('target_id')
    .primaryKey()
    .references(() => targets.id, { onDelete: 'restrict' }),
  policySchemaVersion: integer('policy_schema_version').notNull(),
  policyVersion: integer('policy_version').notNull(),
  consumptionMode: text('consumption_mode').notNull().$type<MapConsumptionMode>(),
  allowedStepTypes: jsonb('allowed_step_types').$type<MapConsumptionAllowedStepType[]>().notNull(),
  allowedAssetRefs: jsonb('allowed_asset_refs').$type<MapAssetRef[]>().notNull(),
  maxCandidateCount: integer('max_candidate_count').notNull(),
  maxResolveMs: integer('max_resolve_ms').notNull(),
  maxExtraAiCalls: integer('max_extra_ai_calls').notNull().default(0),
  revision: integer('revision').notNull(),
  updatedBy: uuid('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const mapConsumptionEligibility = cairnSchema.table(
  'map_consumption_eligibility',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    eligibilityReportKey: text('eligibility_report_key').notNull(),
    eligibleStepTypes: jsonb('eligible_step_types').$type<MapConsumptionAllowedStepType[]>().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_consumption_eligibility_target_report').on(t.targetId, t.eligibilityReportKey),
    index('map_consumption_eligibility_target_idx').on(t.targetId, t.recordedAt),
  ],
)

export const mapConsumptionPolicyCommands = cairnSchema.table(
  'map_consumption_policy_commands',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    commandKey: text('command_key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('map_consumption_policy_commands_key').on(t.targetId, t.commandKey)],
)

export const mapRunReleaseRefs = cairnSchema.table(
  'map_run_release_refs',
  {
    runId: uuid('run_id')
      .primaryKey()
      .references(() => runs.id, { onDelete: 'restrict' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => mapReleases.id, { onDelete: 'restrict' }),
    manifestDigest: text('manifest_digest').notNull(),
    sourceWatermark: integer('source_watermark').notNull(),
    consumerVersion: text('consumer_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('map_run_release_refs_target_idx').on(t.targetId, t.releaseId)],
)

export const mapSelectionDecisions = cairnSchema.table(
  'map_selection_decisions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    stepRunId: uuid('step_run_id')
      .notNull()
      .references(() => stepRuns.id, { onDelete: 'restrict' }),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => attempts.id, { onDelete: 'restrict' }),
    decisionOrdinal: integer('decision_ordinal').notNull(),
    releaseId: uuid('release_id'),
    manifestDigest: text('manifest_digest'),
    policyVersion: integer('policy_version'),
    consumerVersion: text('consumer_version'),
    assetRefKey: text('asset_ref_key'),
    objectId: uuid('object_id'),
    implementationKey: text('implementation_key'),
    descriptorVersion: integer('descriptor_version'),
    conditionSnapshot: jsonb('condition_snapshot').$type<MapConditionSnapshot>(),
    coverage: text('coverage'),
    baselineOutcome: text('baseline_outcome').notNull(),
    candidatesJson: jsonb('candidates_json').$type<MapCandidateEvaluation[]>().notNull(),
    selectedDescriptorVersion: integer('selected_descriptor_version'),
    selectedDescriptorDigest: text('selected_descriptor_digest'),
    consumptionMode: text('consumption_mode').notNull().$type<MapConsumptionMode>(),
    decisionKind: text('decision_kind').notNull().$type<MapSelectionDecisionKind>(),
    reasonCode: text('reason_code').notNull().$type<MapSelectionReasonCode>(),
    spentMs: integer('spent_ms').notNull(),
    extraAiCalls: integer('extra_ai_calls').notNull().default(0),
    evidenceRefs: jsonb('evidence_refs').$type<MapEvidenceRef[]>().notNull(),
    payloadJson: jsonb('payload_json').$type<MapSelectionDecision>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_selection_decisions_attempt_ord').on(t.attemptId, t.decisionOrdinal),
    index('map_selection_decisions_run_idx').on(t.runId, t.stepRunId, t.createdAt),
  ],
)

/**
 * A confirmed wrong match closes the Target-wide fallback gate immediately.  The
 * original eligibility evidence stays immutable; a later, independent T report
 * can explicitly clear this suspension by granting a new eligibility record.
 */
export const mapConsumptionEligibilitySuspensions = cairnSchema.table(
  'map_consumption_eligibility_suspensions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    decisionId: uuid('decision_id')
      .notNull()
      .references(() => mapSelectionDecisions.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('map_consumption_eligibility_suspensions_target').on(t.targetId)],
)
