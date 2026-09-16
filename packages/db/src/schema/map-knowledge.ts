import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  AuthoringProposalBaseline,
  AuthoringProposalStatus,
  KnowledgeDiagnostic,
  KnowledgeDiff,
  KnowledgeSourceRef,
  KnowledgeSuggestedBinding,
  KnowledgeSuggestedModule,
  KnowledgeTermCandidate,
  MapConditionSnapshot,
  ScenarioDocument,
  TermStatus,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { scenarios } from './execution.js'
import { targets } from './targets.js'

export const mapTerminologyEntries = cairnSchema.table(
  'map_terminology_entries',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    requestKey: text('request_key').notNull(),
    canonicalName: text('canonical_name').notNull(),
    aliases: jsonb('aliases').$type<string[]>().notNull(),
    meaning: text('meaning').notNull(),
    conditionSnapshot: jsonb('condition_snapshot').$type<MapConditionSnapshot>(),
    termStatus: text('term_status').notNull().$type<TermStatus>(),
    revision: integer('revision').notNull(),
    sources: jsonb('sources').$type<KnowledgeSourceRef[]>().notNull(),
    createdByConsoleAccountId: uuid('created_by_console_account_id').notNull(),
    updatedByConsoleAccountId: uuid('updated_by_console_account_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_terminology_entries_key_idx').on(t.targetId, t.requestKey),
    index('map_terminology_entries_target_idx').on(t.targetId, t.canonicalName),
  ],
)

export const mapTerminologyRevisions = cairnSchema.table(
  'map_terminology_revisions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    termId: uuid('term_id')
      .notNull()
      .references(() => mapTerminologyEntries.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    actorId: uuid('actor_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('map_terminology_revisions_unique').on(t.termId, t.revision)],
)

export const mapAuthoringProposals = cairnSchema.table(
  'map_authoring_proposals',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    scenarioId: uuid('scenario_id')
      .notNull()
      .references(() => scenarios.id, { onDelete: 'restrict' }),
    requestKey: text('request_key').notNull(),
    acceptKey: text('accept_key'),
    requestDigest: text('request_digest'),
    proposalStatus: text('proposal_status').notNull().$type<AuthoringProposalStatus>(),
    question: text('question').notNull(),
    baseline: jsonb('baseline').$type<AuthoringProposalBaseline>().notNull(),
    document: jsonb('document').$type<ScenarioDocument>(),
    diffs: jsonb('diffs').$type<KnowledgeDiff[]>().notNull(),
    diagnostics: jsonb('diagnostics').$type<KnowledgeDiagnostic[]>().notNull(),
    sources: jsonb('sources').$type<KnowledgeSourceRef[]>().notNull(),
    unknowns: jsonb('unknowns').$type<string[]>().notNull(),
    termCandidates: jsonb('term_candidates').$type<KnowledgeTermCandidate[]>().notNull(),
    suggestedModules: jsonb('suggested_modules').$type<KnowledgeSuggestedModule[]>().notNull(),
    suggestedBindings: jsonb('suggested_bindings').$type<KnowledgeSuggestedBinding[]>().notNull(),
    acceptedRevision: integer('accepted_revision'),
    actorId: uuid('actor_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_authoring_proposals_key_idx').on(t.scenarioId, t.requestKey),
    uniqueIndex('map_authoring_proposals_accept_key_idx').on(t.scenarioId, t.acceptKey),
    index('map_authoring_proposals_target_idx').on(t.targetId, t.updatedAt),
  ],
)
