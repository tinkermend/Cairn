import { index, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { runs } from './execution.js'
import type {
  PatchTargetRef,
  AuthoringOrigin,
  HealingPatch,
  DigestManifest,
  GuardResults,
  RepairCandidateStatus,
  ValidationScope,
  ValidationRefs,
  AdoptionReceipt,
} from '@cairn/shared'

export const repairCandidates = cairnSchema.table(
  'repair_candidates',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    candidateId: text('candidate_id').notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sourceAttemptId: uuid('source_attempt_id').notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('repair_candidates_candidate_id_idx').on(t.candidateId),
    index('repair_candidates_run_idx').on(t.runId),
    index('repair_candidates_status_idx').on(t.status),
    index('repair_candidates_source_attempt_idx').on(t.sourceAttemptId),
  ],
)
