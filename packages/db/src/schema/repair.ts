import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { runs, scenarios } from './execution.js'
import type {
  PatchTargetRef,
  AuthoringOrigin,
  HealingPatch,
  DigestManifest,
  GuardResults,
  RepairCandidateStatus,
  RepairSourceRunKind,
  ValidationScope,
  ValidationRefs,
  AdoptionReceipt,
  CandidateRejectionReceipt,
  CandidateReopenReceipt,
} from '@cairn/shared'

export const repairCandidates = cairnSchema.table(
  'repair_candidates',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    candidateId: text('candidate_id').notNull(),
    scenarioId: uuid('scenario_id')
      .notNull()
      .references(() => scenarios.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    sourceAttemptId: uuid('source_attempt_id').notNull(),
    sourceTargetDigest: text('source_target_digest').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    observationCount: integer('observation_count').notNull().default(1),
    rejectedObservationCount: integer('rejected_observation_count').notNull().default(0),
    lastSeenRunId: uuid('last_seen_run_id').references(() => runs.id, { onDelete: 'set null' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    sourceRunKind: text('source_run_kind').$type<RepairSourceRunKind>().notNull().default('published'),
    patchTargetRef: jsonb('patch_target_ref').$type<PatchTargetRef>().notNull(),
    authoringOrigin: jsonb('authoring_origin').$type<AuthoringOrigin | null>(),
    patch: jsonb('patch').$type<HealingPatch>().notNull(),
    hypothesis: text('hypothesis').notNull(),
    applicability: text('applicability'),
    digestManifest: jsonb('digest_manifest').$type<DigestManifest>().notNull(),
    guardResults: jsonb('guard_results').$type<GuardResults>().notNull(),
    status: text('status').$type<RepairCandidateStatus>().notNull().default('proposed'),
    validationScope: jsonb('validation_scope').$type<ValidationScope>().notNull(),
    validationRefs: jsonb('validation_refs').$type<ValidationRefs | null>(),
    adoption: jsonb('adoption').$type<AdoptionReceipt | null>(),
    rejection: jsonb('rejection').$type<CandidateRejectionReceipt | null>(),
    reopenHistory: jsonb('reopen_history').$type<CandidateReopenReceipt[] | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('repair_candidates_candidate_id_idx').on(t.candidateId),
    index('repair_candidates_scenario_id_idx').on(t.scenarioId),
    index('repair_candidates_dedupe_key_idx').on(t.dedupeKey),
    index('repair_candidates_run_idx').on(t.runId),
    index('repair_candidates_status_idx').on(t.status),
    index('repair_candidates_source_attempt_idx').on(t.sourceAttemptId),
  ],
)

