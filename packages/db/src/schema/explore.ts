import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  CandidateCategory,
  DiscoveryStatus,
  ExploreEvidenceStatus,
  ExploreActionCategory,
  ExploreEntryRequestProfile,
  ExploreReviewDecision,
  RecipeStep,
  TargetDescriptor,
  TargetStateRule,
  TraversalRelationType,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { runs } from './execution.js'
import { mapJobs, mapSafeEntries } from './map-jobs.js'
import { targetAccounts, targets } from './targets.js'

export const exploreStateRecipes = cairnSchema.table(
  'explore_state_recipes',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    targetAccountId: uuid('target_account_id')
      .notNull()
      .references(() => targetAccounts.id, { onDelete: 'restrict' }),
    mapSafeEntryId: uuid('map_safe_entry_id')
      .notNull()
      .references(() => mapSafeEntries.id, { onDelete: 'restrict' }),
    safeEntryVersion: integer('safe_entry_version').notNull(),
    recipeName: text('recipe_name').notNull(),
    revision: integer('revision').notNull(),
    stateRuleVersion: integer('state_rule_version').notNull().default(1),
    status: text('status').notNull().$type<'draft' | 'pending_review' | 'approved' | 'rejected' | 'archived'>(),
    stepsJson: jsonb('steps_json').$type<RecipeStep[]>().notNull(),
    safetyBasisJson: jsonb('safety_basis_json').$type<{ kind: string; summary: string; confirmedBy: string; confirmedAt: string }>().notNull(),
    usageLimit: integer('usage_limit').notNull().default(5),
    usageRemaining: integer('usage_remaining').notNull().default(5),
    timeoutSeconds: integer('timeout_seconds').notNull().default(90),
    isManualSeed: integer('is_manual_seed').notNull().default(0),
    commandKey: text('command_key').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('explore_state_recipes_target_key').on(t.targetId, t.commandKey),
    index('explore_state_recipes_target_idx').on(t.targetId, t.createdAt),
    index('explore_state_recipes_status_idx').on(t.targetId, t.status),
  ],
)

export const exploreStates = cairnSchema.table(
  'explore_states',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    targetAccountId: uuid('target_account_id')
      .notNull()
      .references(() => targetAccounts.id, { onDelete: 'restrict' }),
    jobId: uuid('job_id').references(() => mapJobs.id, { onDelete: 'set null' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    pageKey: text('page_key').notNull(),
    viewStateKey: text('view_state_key').notNull(),
    presentationStateKey: text('presentation_state_key').notNull(),
    stateRuleVersion: integer('state_rule_version').notNull().default(1),
    readiness: text('readiness').notNull().$type<'ready' | 'ambiguous' | 'unknown'>(),
    snapshotJson: jsonb('snapshot_json').$type<Record<string, unknown>>().notNull(),
    evidenceRef: text('evidence_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('explore_states_pres_idx').on(t.targetId, t.presentationStateKey),
    index('explore_states_page_idx').on(t.targetId, t.pageKey),
    index('explore_states_job_idx').on(t.jobId),
  ],
)

export const exploreDiscoveries = cairnSchema.table(
  'explore_discoveries',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => mapJobs.id, { onDelete: 'restrict' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    stepRunId: uuid('step_run_id'),
    attemptId: uuid('attempt_id'),
    sourceExploreStateId: uuid('source_explore_state_id').references(() => exploreStates.id, { onDelete: 'set null' }),
    sourcePresentationStateKey: text('source_presentation_state_key').notNull(),
    controlFingerprint: text('control_fingerprint').notNull(),
    accessibleName: text('accessible_name').notNull(),
    role: text('role').notNull(),
    ancestorPathJson: jsonb('ancestor_path_json').$type<string[]>().notNull(),
    frameSelector: text('frame_selector').notNull().default(''),
    candidateCategory: text('candidate_category').notNull().$type<CandidateCategory>(),
    targetUrl: text('target_url'),
    targetDigest: text('target_digest'),
    targetHint: text('target_hint').notNull(),
    locatorDescriptorJson: jsonb('locator_descriptor_json').$type<TargetDescriptor>(),
    collectorVersion: text('collector_version').notNull(),
    evidenceStatus: text('evidence_status').notNull().$type<ExploreEvidenceStatus>(),
    rejectionReason: text('rejection_reason'),
    status: text('status').notNull().$type<DiscoveryStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('explore_discoveries_job_ctrl').on(t.jobId, t.controlFingerprint),
    index('explore_discoveries_target_idx').on(t.targetId, t.createdAt),
    index('explore_discoveries_job_idx').on(t.jobId, t.status),
  ],
)

export const exploreReviews = cairnSchema.table(
  'explore_reviews',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => mapJobs.id, { onDelete: 'restrict' }),
    exploreDiscoveryId: uuid('explore_discovery_id')
      .notNull()
      .references(() => exploreDiscoveries.id, { onDelete: 'restrict' }),
    reviewerId: uuid('reviewer_id').notNull(),
    decision: text('decision').notNull().$type<ExploreReviewDecision>(),
    expectedRevision: integer('expected_revision').notNull(),
    actionCategory: text('action_category').notNull().$type<ExploreActionCategory>(),
    securityBasis: text('security_basis').notNull(),
    allowedRoutePattern: text('allowed_route_pattern'),
    requestEnvelopeJson: jsonb('request_envelope_json').$type<Record<string, unknown>[]>(),
    exactTargetUrl: text('exact_target_url'),
    dispatchQuota: integer('dispatch_quota').notNull().default(1),
    quotaRemaining: integer('quota_remaining').notNull().default(1),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('explore_reviews_cmd_key').on(t.targetId, t.idempotencyKey),
    index('explore_reviews_disc_idx').on(t.exploreDiscoveryId),
    index('explore_reviews_target_idx').on(t.targetId, t.createdAt),
  ],
)

export const exploreTraversals = cairnSchema.table(
  'explore_traversals',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => mapJobs.id, { onDelete: 'restrict' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    attemptId: uuid('attempt_id'),
    exploreDiscoveryId: uuid('explore_discovery_id').references(() => exploreDiscoveries.id, { onDelete: 'set null' }),
    exploreReviewId: uuid('explore_review_id').references(() => exploreReviews.id, { onDelete: 'set null' }),
    actionCategory: text('action_category').notNull().$type<ExploreActionCategory>(),
    relationType: text('relation_type').notNull().$type<TraversalRelationType>(),
    fromExploreStateId: uuid('from_explore_state_id').references(() => exploreStates.id, { onDelete: 'set null' }),
    fromPresentationStateKey: text('from_presentation_state_key').notNull(),
    toExploreStateId: uuid('to_explore_state_id').references(() => exploreStates.id, { onDelete: 'set null' }),
    toPresentationStateKey: text('to_presentation_state_key'),
    guardDecision: text('guard_decision').notNull().$type<'allow' | 'skip' | 'stop'>(),
    guardReason: text('guard_reason').notNull(),
    actionOutcome: text('action_outcome').notNull().$type<'completed' | 'failed' | 'unknown' | 'not_dispatched'>(),
    locationVerify: text('location_verify').notNull().$type<'support' | 'deny' | 'unknown'>(),
    actionVerify: text('action_verify').notNull().$type<'support' | 'deny' | 'unknown'>(),
    pageChangeVerify: text('page_change_verify').notNull().$type<'support' | 'deny' | 'unknown'>(),
    businessResult: text('business_result').notNull().default('unknown').$type<'unknown'>(),
    promoted: integer('promoted').notNull().default(0),
    evidenceStatus: text('evidence_status').notNull().$type<ExploreEvidenceStatus>(),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('explore_traversals_target_idx').on(t.targetId, t.createdAt),
    index('explore_traversals_job_idx').on(t.jobId),
    index('explore_traversals_disc_idx').on(t.exploreDiscoveryId),
  ],
)

export const exploreEntryRequestProfiles = cairnSchema.table(
  'explore_entry_request_profiles',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    mapSafeEntryId: uuid('map_safe_entry_id')
      .notNull()
      .references(() => mapSafeEntries.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull(),
    entryUrl: text('entry_url').notNull(),
    profileJson: jsonb('profile_json').$type<ExploreEntryRequestProfile>().notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('explore_entry_request_profiles_entry').on(t.targetId, t.mapSafeEntryId)],
)

export const targetStateRules = cairnSchema.table('target_state_rules', {
  targetId: uuid('target_id')
    .primaryKey()
    .references(() => targets.id, { onDelete: 'restrict' }),
  ruleVersion: integer('rule_version').notNull(),
  rulesJson: jsonb('rules_json').$type<TargetStateRule>().notNull(),
  revision: integer('revision').notNull(),
  updatedBy: uuid('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
