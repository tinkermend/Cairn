import { index, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  MapEvidenceRef,
  ResolutionDecision,
  ResolutionDecisionKind,
  ResolutionPolicy,
  ResolutionReasonCode,
  ResolutionRungRecord,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { attempts, runs, stepRuns } from './execution.js'

export const resolutionDecisions = cairnSchema.table(
  'resolution_decisions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    stepRunId: uuid('step_run_id')
      .notNull()
      .references(() => stepRuns.id, { onDelete: 'restrict' }),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => attempts.id, { onDelete: 'restrict' }),
    stepId: uuid('step_id').notNull(),
    effectivePolicy: text('effective_policy').notNull().$type<ResolutionPolicy>(),
    decisionKind: text('decision_kind').notNull().$type<ResolutionDecisionKind>(),
    reasonCode: text('reason_code').$type<ResolutionReasonCode>(),
    semanticDigest: text('semantic_digest'),
    rungsJson: jsonb('rungs_json').$type<ResolutionRungRecord[]>().notNull(),
    evidenceRefs: jsonb('evidence_refs').$type<MapEvidenceRef[]>().notNull(),
    payloadJson: jsonb('payload_json').$type<ResolutionDecision>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('resolution_decisions_attempt').on(t.attemptId),
    index('resolution_decisions_run_idx').on(t.runId, t.stepRunId, t.createdAt),
    index('resolution_decisions_decision_idx').on(t.decisionKind),
  ],
)
