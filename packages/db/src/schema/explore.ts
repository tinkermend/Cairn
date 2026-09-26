import { index, integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { TargetStateRule } from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { runs } from './execution.js'
import { mapJobs } from './map-jobs.js'
import { targetAccounts, targets } from './targets.js'

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
