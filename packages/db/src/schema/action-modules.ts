import { relations } from 'drizzle-orm'
import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  ActionModuleDetail,
  EffectType,
  ModuleContent,
  ModuleExecutionMode,
  ModuleInvocationAttribution,
  ModuleInvocationOutcome,
  ModuleInvocationRunKind,
  ModulePublicationStatus,
  ModuleVerificationStrength,
  ResourceDeletedBy,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema, consoleAccounts } from './console.js'
import { targets } from './targets.js'
import { runs, scenarios, scenarioVersions } from './execution.js'

export const actionModules = cairnSchema.table(
  'action_modules',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    capabilityKey: text('capability_key'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
    intentExamples: jsonb('intent_examples').$type<string[]>().notNull().default([]),
    draftRevision: integer('draft_revision').notNull().default(0),
    draftContent: jsonb('draft_content').$type<ModuleContent>(),
    createdByConsoleAccountId: uuid('created_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    updatedByConsoleAccountId: uuid('updated_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: jsonb('deleted_by').$type<ResourceDeletedBy>(),
  },
  (t) => [
    uniqueIndex('action_modules_target_key_idx').on(t.targetId, t.key),
    index('action_modules_target_capability_idx').on(t.targetId, t.capabilityKey),
    index('action_modules_target_id_idx').on(t.targetId),
    index('action_modules_deleted_at_idx').on(t.deletedAt),
  ],
)

export const actionModuleVersions = cairnSchema.table(
  'action_module_versions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    moduleId: uuid('module_id')
      .notNull()
      .references(() => actionModules.id, { onDelete: 'restrict' }),
    versionNo: integer('version_no').notNull(),
    content: jsonb('content').$type<ModuleContent>().notNull(),
    contractDigest: text('contract_digest').notNull(),
    implementationDigest: text('implementation_digest').notNull(),
    contentDigest: text('content_digest').notNull(),
    compilerVersion: integer('compiler_version').notNull().default(1),
    executionMode: text('execution_mode', { enum: ['DETERMINISTIC', 'AI', 'HYBRID'] })
      .notNull()
      .$type<ModuleExecutionMode>(),
    effectCeiling: text('effect_ceiling', { enum: ['READ_ONLY', 'IDEMPOTENT', 'SIDE_EFFECT'] })
      .notNull()
      .$type<EffectType>(),
    publicationStatus: text('publication_status', { enum: ['published', 'deprecated', 'withdrawn'] })
      .notNull()
      .default('published')
      .$type<ModulePublicationStatus>(),
    sourceDraftRevision: integer('source_draft_revision'),
    createdByConsoleAccountId: uuid('created_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('action_module_versions_module_version_idx').on(t.moduleId, t.versionNo),
    index('action_module_versions_module_pub_idx').on(t.moduleId, t.publicationStatus),
    index('action_module_versions_module_id_idx').on(t.moduleId),
  ],
)

export const actionModulesRelations = relations(actionModules, ({ one, many }) => ({
  target: one(targets, { fields: [actionModules.targetId], references: [targets.id] }),
  versions: many(actionModuleVersions),
}))

export const actionModuleVersionsRelations = relations(actionModuleVersions, ({ one }) => ({
  module: one(actionModules, { fields: [actionModuleVersions.moduleId], references: [actionModules.id] }),
}))

export type ActionModuleRow = typeof actionModules.$inferSelect
export type ActionModuleVersionRow = typeof actionModuleVersions.$inferSelect

/** 持久化请求回执：创建/发布重试返回首次提交的结果。 */
export const actionModuleReceipts = cairnSchema.table('action_module_receipts', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  actorId: uuid('actor_id').notNull().references(() => consoleAccounts.id, { onDelete: 'restrict' }),
  idempotencyKey: text('idempotency_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  moduleId: uuid('module_id').notNull().references(() => actionModules.id, { onDelete: 'restrict' }),
  response: jsonb('response').$type<ActionModuleDetail>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('action_module_receipts_actor_key_idx').on(t.actorId, t.idempotencyKey)])

export const scenarioModuleRefs = cairnSchema.table(
  'scenario_module_refs',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    scenarioId: uuid('scenario_id')
      .notNull()
      .references(() => scenarios.id, { onDelete: 'cascade' }),
    scenarioVersionId: uuid('scenario_version_id').references(() => scenarioVersions.id, {
      onDelete: 'cascade',
    }),
    invocationId: uuid('invocation_id').notNull(),
    moduleId: uuid('module_id')
      .notNull()
      .references(() => actionModules.id, { onDelete: 'cascade' }),
    moduleVersionId: uuid('module_version_id').references(() => actionModuleVersions.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('scenario_module_refs_scenario_ver_idx').on(t.scenarioId, t.scenarioVersionId),
    index('scenario_module_refs_module_ver_idx').on(t.moduleId, t.moduleVersionId),
  ],
)

export type ScenarioModuleRefRow = typeof scenarioModuleRefs.$inferSelect

export const ACTION_MODULE_COMMANDS = ['upgrade', 'batch_upgrade', 'extract', 'replace', 'disable_affected'] as const
export type ActionModuleCommand = (typeof ACTION_MODULE_COMMANDS)[number]

export const actionModuleCommandReceipts = cairnSchema.table(
  'action_module_command_receipts',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    actorId: uuid('actor_id').notNull().references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    idempotencyKey: text('idempotency_key').notNull(),
    command: text('command').notNull().$type<ActionModuleCommand>(),
    requestDigest: text('request_digest').notNull(),
    moduleId: uuid('module_id').references(() => actionModules.id, { onDelete: 'restrict' }),
    scenarioId: uuid('scenario_id').references(() => scenarios.id, { onDelete: 'restrict' }),
    response: jsonb('response').$type<unknown>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('action_module_command_receipts_actor_key_idx').on(t.actorId, t.idempotencyKey),
    index('action_module_command_receipts_module_idx').on(t.moduleId),
  ],
)
export type ActionModuleCommandReceiptRow = typeof actionModuleCommandReceipts.$inferSelect

export const MODULE_RESOLVE_MODES = ['rules', 'rules_then_ai'] as const
export const MODULE_RESOLVE_STATUSES = ['matched', 'suggested', 'ambiguous', 'no_match'] as const
export const MODULE_RESOLVE_OUTCOMES = ['pending', 'accepted', 'rejected', 'abandoned'] as const

export const moduleResolutionRequests = cairnSchema.table(
  'module_resolution_requests',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    scenarioId: uuid('scenario_id').references(() => scenarios.id, { onDelete: 'restrict' }),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    idempotencyKey: text('idempotency_key').notNull(),
    requestDigest: text('request_digest').notNull(),
    expression: text('expression').notNull(),
    mode: text('mode').notNull().$type<(typeof MODULE_RESOLVE_MODES)[number]>(),
    termRevision: text('term_revision'),
    status: text('status').notNull().$type<(typeof MODULE_RESOLVE_STATUSES)[number]>(),
    candidates: jsonb('candidates').$type<unknown>().notNull(),
    inputSuggestions: jsonb('input_suggestions').$type<unknown>().notNull(),
    unknowns: jsonb('unknowns').$type<string[]>().notNull().default([]),
    aiSkipped: text('ai_skipped'),
    outcome: text('outcome').notNull().default('pending').$type<(typeof MODULE_RESOLVE_OUTCOMES)[number]>(),
    acceptedModuleVersionId: uuid('accepted_module_version_id').references(() => actionModuleVersions.id, {
      onDelete: 'restrict',
    }),
    acceptIdempotencyKey: text('accept_idempotency_key'),
    acceptResponse: jsonb('accept_response').$type<unknown>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('module_resolution_requests_actor_key_idx').on(t.actorId, t.idempotencyKey),
    index('module_resolution_requests_target_created_idx').on(t.targetId, t.createdAt),
    index('module_resolution_requests_created_idx').on(t.createdAt),
  ],
)
export type ModuleResolutionRequestRow = typeof moduleResolutionRequests.$inferSelect

export const moduleInvocationResults = cairnSchema.table(
  'module_invocation_results',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    invocationId: uuid('invocation_id').notNull(),
    projectorVersion: integer('projector_version').notNull(),
    moduleId: uuid('module_id')
      .notNull()
      .references(() => actionModules.id, { onDelete: 'restrict' }),
    moduleVersionId: uuid('module_version_id').references(() => actionModuleVersions.id, { onDelete: 'restrict' }),
    moduleDraftRevision: integer('module_draft_revision'),
    runKind: text('run_kind').notNull().$type<ModuleInvocationRunKind>(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    targetAccountId: uuid('target_account_id'),
    outcome: text('outcome').notNull().$type<ModuleInvocationOutcome>(),
    attribution: text('attribution').notNull().$type<ModuleInvocationAttribution>(),
    failedExpandedStepId: uuid('failed_expanded_step_id'),
    errorCategory: text('error_category'),
    errorCode: text('error_code'),
    manualRequirementsUnverified: integer('manual_requirements_unverified').notNull().default(0),
    verificationStrength: text('verification_strength').notNull().$type<ModuleVerificationStrength>(),
    retriedSuccess: integer('retried_success').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    aiCalls: integer('ai_calls').notNull().default(0),
    aiCost: text('ai_cost'),
    sourceRunEventSeq: integer('source_run_event_seq').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('module_invocation_results_run_invocation_idx').on(t.runId, t.invocationId),
    index('module_invocation_results_version_finished_idx').on(t.moduleVersionId, t.finishedAt),
    index('module_invocation_results_module_finished_idx').on(t.moduleId, t.finishedAt),
    index('module_invocation_results_account_finished_idx').on(t.targetAccountId, t.finishedAt),
  ],
)
export type ModuleInvocationResultRow = typeof moduleInvocationResults.$inferSelect

