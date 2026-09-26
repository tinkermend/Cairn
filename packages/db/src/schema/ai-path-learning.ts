import { integer, jsonb, text, timestamp, uniqueIndex, index, uuid } from 'drizzle-orm/pg-core'
import type {
  AiElementBinding,
  AiPageObservation,
  AiTaskEventPhase,
  AiValueProvenance,
  SolidifiableLevel,
  TraceIntegrityState,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { attempts, runs, stepRuns } from './execution.js'

export const aiTaskEvents = cairnSchema.table(
  'ai_task_events',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => attempts.id, { onDelete: 'restrict' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    stepRunId: uuid('step_run_id')
      .notNull()
      .references(() => stepRuns.id, { onDelete: 'restrict' }),
    agentInstanceId: text('agent_instance_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    phase: text('phase').notNull().$type<AiTaskEventPhase>(),
    source: text('source').notNull(), // 'action_edge'
    actionName: text('action_name').notNull(),
    sdkVersion: text('sdk_version').notNull(),
    elementDescription: text('element_description'),
    bindingJson: jsonb('binding_json').notNull().$type<AiElementBinding>(),
    valueProvenanceJson: jsonb('value_provenance_json').notNull().$type<AiValueProvenance>(),
    paramsSummaryJson: jsonb('params_summary_json').$type<Record<string, unknown>>(),
    pageBeforeJson: jsonb('page_before_json').notNull().$type<AiPageObservation>(),
    pageAfterJson: jsonb('page_after_json').$type<AiPageObservation | null>(),
    writeSignalCount: integer('write_signal_count').notNull().default(0),
    writeSignalPathsJson: jsonb('write_signal_paths_json').notNull().$type<string[]>().default([]),
    durationMs: integer('duration_ms'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ai_task_events_dedup_idx').on(t.attemptId, t.agentInstanceId, t.ordinal, t.phase),
    index('ai_task_events_attempt_ordinal_idx').on(t.attemptId, t.ordinal),
    index('ai_task_events_run_idx').on(t.runId),
  ],
)

export const aiPathObservations = cairnSchema.table(
  'ai_path_observations',
  {
    attemptId: uuid('attempt_id')
      .primaryKey()
      .references(() => attempts.id, { onDelete: 'restrict' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    stepRunId: uuid('step_run_id')
      .notNull()
      .references(() => stepRuns.id, { onDelete: 'restrict' }),
    stepId: uuid('step_id').notNull(),
    scenarioId: uuid('scenario_id').notNull(),
    scenarioVersion: integer('scenario_version'),
    targetId: uuid('target_id').notNull(),
    /** 未绑定账号的 Run 为 null，不拿 runId 冒充账号。 */
    targetAccountId: uuid('target_account_id'),
    stepDefinitionDigest: text('step_definition_digest').notNull(),
    namespaceDigest: text('namespace_digest').notNull(),
    signature: text('signature'),
    actionCount: integer('action_count').notNull().default(0),
    solidifiableLevel: text('solidifiable_level').notNull().$type<SolidifiableLevel>(),
    solidifiableReasonsJson: jsonb('solidifiable_reasons_json').notNull().$type<string[]>().default([]),
    traceIntegrity: text('trace_integrity').notNull().$type<TraceIntegrityState>(),
    modelCalls: integer('model_calls').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    stepResult: text('step_result').notNull().$type<'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN'>(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_path_observations_scenario_step_idx').on(t.scenarioId, t.stepId, t.recordedAt),
    index('ai_path_observations_namespace_idx').on(t.namespaceDigest, t.recordedAt),
    index('ai_path_observations_run_idx').on(t.runId),
  ],
)

export type AiTaskEventRow = typeof aiTaskEvents.$inferSelect
export type AiPathObservationRow = typeof aiPathObservations.$inferSelect
