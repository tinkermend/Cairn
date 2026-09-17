/**
 * AM-D 编写期模块映射：契约与规则层纯函数。
 * AI 层（D2）未开放前，`rules_then_ai` 只跑本文件的规则结果。
 */
import { z } from 'zod'
import {
  moduleExecutionModeSchema,
  type ModuleExecutionMode,
  type ModuleInputDecl,
  type ModulePublicationStatus,
} from './action-module.js'
import {
  authoringModuleInvocationSchema,
  moduleInputBindingSchema,
} from './authoring-document.js'
import { canonicalJson } from './canonical.js'
import { compileDiagnosticSchema } from './scenario.js'
import { syncSha256 } from './sha256-sync.js'
import { contextKeySchema, effectTypeSchema, type EffectType } from './step.js'
import { idempotencyKeySchema } from './run-api.js'
import { entityIdSchema } from './wire.js'

export const MODULE_RESOLVE_MODES = ['rules', 'rules_then_ai'] as const
export type ModuleResolveMode = (typeof MODULE_RESOLVE_MODES)[number]
export const moduleResolveModeSchema = z.enum(MODULE_RESOLVE_MODES)

export const MODULE_RESOLVE_STATUSES = ['matched', 'suggested', 'ambiguous', 'no_match'] as const
export type ModuleResolveStatus = (typeof MODULE_RESOLVE_STATUSES)[number]
export const moduleResolveStatusSchema = z.enum(MODULE_RESOLVE_STATUSES)

export const MODULE_RESOLVE_OUTCOMES = ['pending', 'accepted', 'rejected', 'abandoned'] as const
export type ModuleResolveOutcome = (typeof MODULE_RESOLVE_OUTCOMES)[number]
export const moduleResolveOutcomeSchema = z.enum(MODULE_RESOLVE_OUTCOMES)

export const MODULE_RESOLVE_MATCH_FIELDS = [
  'name',
  'key',
  'alias',
  'intentExample',
  'capabilityKey',
  'tag',
  'term',
] as const
export type ModuleResolveMatchField = (typeof MODULE_RESOLVE_MATCH_FIELDS)[number]
export const moduleResolveMatchFieldSchema = z.enum(MODULE_RESOLVE_MATCH_FIELDS)

export const MODULE_RESOLVE_NOTES = ['deprecated', 'healthDegraded'] as const
export type ModuleResolveNote = (typeof MODULE_RESOLVE_NOTES)[number]
export const moduleResolveNoteSchema = z.enum(MODULE_RESOLVE_NOTES)

export const MODULE_RESOLVE_AI_SKIPPED = [
  'ai_layer_not_open',
  'ai_unavailable',
  'ai_budget',
  'ai_forbidden',
] as const
export type ModuleResolveAiSkipped = (typeof MODULE_RESOLVE_AI_SKIPPED)[number]
export const moduleResolveAiSkippedSchema = z.enum(MODULE_RESOLVE_AI_SKIPPED)

export const RESOLUTION_ERROR_CODES = [
  'RESOLUTION_CANDIDATE_MISMATCH',
  'RESOLUTION_CANDIDATE_UNAVAILABLE',
  'RESOLUTION_ALREADY_SETTLED',
  'RESOLUTION_NOT_FOUND',
  'RESOLUTION_IDEMPOTENCY_CONFLICT',
  'RESOLUTION_ANCHOR_NOT_FOUND',
  'RESOLUTION_BINDING_INVALID',
  'RESOLUTION_TARGET_MISMATCH',
  'RESOLUTION_SCENARIO_NOT_WRITABLE',
] as const
export type ResolutionErrorCode = (typeof RESOLUTION_ERROR_CODES)[number]

export const DEFAULT_RESOLVER_MAX_CANDIDATES = 10

export const INTENT_EXAMPLE_COVERAGE_MIN = 0.5
export const INTENT_EXAMPLE_MIN_OVERLAP = 2
export const CONTAINS_NEEDLE_MIN = 2

const PUNCTUATION = /[，。！？、；：""''"'（）()【】［］\[\]《》〈〉…—–·,!?;:]/g

export function normalizeResolverText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/\u3000/g, ' ')
    .replace(PUNCTUATION, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenizeResolverText(normalized: string): string[] {
  const tokens: string[] = []
  const source = normalized.trim()
  if (!source) return tokens
  const parts = source.split(/\s+/).filter(Boolean)
  for (const part of parts) {
    const latin = part.match(/[a-z0-9.]+/g) ?? []
    for (const word of latin) {
      if (word) tokens.push(word)
    }
    const cjk = part.match(/\p{Script=Han}/gu) ?? []
    tokens.push(...cjk)
  }
  return tokens
}

export function computeTermSnapshotDigest(
  terms: readonly { termId: string; revision: number }[],
): string {
  const rows = [...terms]
    .map((item) => [item.termId, item.revision] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]))
  return syncSha256(canonicalJson(rows))
}

export type ResolverTerm = {
  termId: string
  canonicalName: string
  aliases: readonly string[]
  revision: number
  termStatus: 'candidate' | 'confirmed' | 'retired'
}

export type ResolverCatalogVersion = {
  versionId: string
  versionNo: number
  publishedAt: string
  publicationStatus: ModulePublicationStatus
  executionMode: ModuleExecutionMode
  effectCeiling: EffectType
  inputs: readonly ModuleInputDecl[]
}

export type ResolverCatalogModule = {
  moduleId: string
  targetId: string
  key: string
  name: string
  capabilityKey?: string | null
  aliases: readonly string[]
  intentExamples: readonly string[]
  tags: readonly string[]
  versions: readonly ResolverCatalogVersion[]
}

export const moduleResolveMatchSchema = z.strictObject({
  field: moduleResolveMatchFieldSchema,
  text: z.string().min(1).max(256),
})
export type ModuleResolveMatch = z.infer<typeof moduleResolveMatchSchema>

export const moduleResolveCandidateSchema = z.strictObject({
  moduleId: entityIdSchema,
  moduleVersionId: entityIdSchema,
  key: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  versionNo: z.number().int().min(1),
  executionMode: moduleExecutionModeSchema,
  effectCeiling: effectTypeSchema,
  publicationStatus: z.enum(['published', 'deprecated']),
  matchedBy: z.array(moduleResolveMatchSchema).max(16),
  layer: z.number().int().min(1).max(5),
  rank: z.number().int().min(1),
  notes: z.array(moduleResolveNoteSchema).max(4),
})
export type ModuleResolveCandidate = z.infer<typeof moduleResolveCandidateSchema>

export const moduleInputSuggestionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('literal'),
    value: z.union([z.string().max(256), z.number()]),
    span: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
    source: z.enum(['rule', 'ai']),
  }),
  z.strictObject({
    kind: z.literal('from'),
    key: contextKeySchema,
    source: z.enum(['rule', 'ai']),
  }),
  z.strictObject({
    kind: z.literal('missing'),
  }),
])
export type ModuleInputSuggestion = z.infer<typeof moduleInputSuggestionSchema>

export const moduleResolveRequestSchema = z.strictObject({
  targetId: entityIdSchema,
  scenarioId: entityIdSchema.optional(),
  draftRevision: z.number().int().min(0).optional(),
  anchorNodeId: entityIdSchema.optional(),
  expression: z.string().trim().min(1).max(512),
  mode: moduleResolveModeSchema.default('rules'),
  idempotencyKey: idempotencyKeySchema,
  termRevision: z.string().trim().min(1).max(128).optional(),
})
export type ModuleResolveRequest = z.infer<typeof moduleResolveRequestSchema>

export const moduleResolveResultSchema = z.strictObject({
  requestId: entityIdSchema,
  status: moduleResolveStatusSchema,
  termRevision: z.string().min(1).max(128).optional(),
  aiSkipped: moduleResolveAiSkippedSchema.optional(),
  candidates: z.array(moduleResolveCandidateSchema).max(20),
  inputSuggestions: z.record(entityIdSchema, z.record(contextKeySchema, moduleInputSuggestionSchema)),
  unknowns: z.array(z.string().min(1).max(128)).max(32).default([]),
  outcome: moduleResolveOutcomeSchema,
})
export type ModuleResolveResult = z.infer<typeof moduleResolveResultSchema>

export const moduleResolveCloseBodySchema = z.strictObject({
  outcome: z.enum(['rejected', 'abandoned']),
})
export type ModuleResolveCloseBody = z.infer<typeof moduleResolveCloseBodySchema>

export const moduleResolveAcceptBodySchema = z.strictObject({
  moduleVersionId: entityIdSchema,
  inputBindings: z.record(contextKeySchema, moduleInputBindingSchema).default({}),
  outputBindings: z.record(contextKeySchema, contextKeySchema).default({}),
  anchorNodeId: entityIdSchema.optional(),
  baseRevision: z.number().int().min(0),
  idempotencyKey: idempotencyKeySchema,
})
export type ModuleResolveAcceptBody = z.infer<typeof moduleResolveAcceptBodySchema>

export const moduleResolveAcceptResponseSchema = z.strictObject({
  request: moduleResolveResultSchema,
  scenario: z.unknown(),
  diagnostics: z.array(compileDiagnosticSchema),
})
export type ModuleResolveAcceptResponse = z.infer<typeof moduleResolveAcceptResponseSchema>

export type ExtractedLiteral = {
  value: string
  span: [number, number]
}
