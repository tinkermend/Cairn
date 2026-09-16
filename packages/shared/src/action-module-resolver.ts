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
  type ModuleValueType,
} from './action-module.js'
import { latestSelectableVersion } from './action-module-upgrade.js'
import {
  authoringModuleInvocationSchema,
  authoringNodeId,
  moduleInputBindingSchema,
  type AuthoringModuleInvocation,
  type ModuleInputBinding,
  type ScenarioAuthoringDocumentV2,
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

const QUOTE_PAIRS: Array<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
]

export function extractLiteralCandidates(expression: string): ExtractedLiteral[] {
  const found: ExtractedLiteral[] = []
  const occupied = new Array<boolean>(expression.length).fill(false)

  for (const [open, close] of QUOTE_PAIRS) {
    let from = 0
    while (from < expression.length) {
      const start = expression.indexOf(open, from)
      if (start < 0) break
      const end = expression.indexOf(close, start + open.length)
      if (end < 0) break
      const value = expression.slice(start + open.length, end).trim()
      if (value && !looksLikeSecret(value)) {
        found.push({ value, span: [start + open.length, end] })
        for (let i = start; i <= end; i += 1) occupied[i] = true
      }
      from = end + close.length
    }
  }

  const tokenRe = /[A-Za-z][A-Za-z0-9._-]{1,}|[0-9]+(?:\.[0-9]+)?/g
  let match: RegExpExecArray | null
  while ((match = tokenRe.exec(expression))) {
    const start = match.index
    const end = start + match[0]!.length
    if (occupied.slice(start, end).some(Boolean)) continue
    if (looksLikeSecret(match[0]!)) continue
    const prefix = expression.slice(Math.max(0, start - 16), start)
    if (/(?:password|token|secret|api[_-]?key|口令|密码)["']?\s*[:=：]\s*$/i.test(prefix)) continue
    found.push({ value: match[0]!, span: [start, end] })
  }
  return found
}

function looksLikeSecret(value: string): boolean {
  return /password|token|secret|api[_-]?key|口令|密码|bearer/i.test(value)
}

export function collectAvailableContextKeys(
  document: ScenarioAuthoringDocumentV2,
  anchorNodeId?: string,
): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  const add = (key: string | undefined) => {
    if (!key || seen.has(key)) return
    seen.add(key)
    keys.push(key)
  }
  for (const input of document.inputs) add(input.key)
  for (const node of document.nodes) {
    if (node.kind === 'step') add(node.step.outputKey)
    else {
      for (const exposed of Object.values(node.outputBindings)) add(exposed)
    }
    if (anchorNodeId && authoringNodeId(node) === anchorNodeId) break
  }
  return keys
}

export function insertModuleInvocation(
  document: ScenarioAuthoringDocumentV2,
  invocation: AuthoringModuleInvocation,
  afterNodeId?: string,
): ScenarioAuthoringDocumentV2 | null {
  const parsed = authoringModuleInvocationSchema.parse(invocation)
  const nodes = [...document.nodes]
  if (!afterNodeId) return { ...document, nodes: [...nodes, parsed] }
  const index = nodes.findIndex((node) => authoringNodeId(node) === afterNodeId)
  if (index < 0) return null
  nodes.splice(index + 1, 0, parsed)
  return { ...document, nodes }
}

type RankedHit = {
  module: ResolverCatalogModule
  version: ResolverCatalogVersion
  layer: number
  matchedBy: ModuleResolveMatch[]
}

function confirmedTerms(terms: readonly ResolverTerm[]): ResolverTerm[] {
  return terms.filter((item) => item.termStatus === 'confirmed')
}

function termNeedlesForExpression(expressionNorm: string, terms: readonly ResolverTerm[]): string[] {
  const needles: string[] = []
  const seen = new Set<string>()
  for (const term of confirmedTerms(terms)) {
    const names = [term.canonicalName, ...term.aliases]
    const hit = names.some((name) => {
      const norm = normalizeResolverText(name)
      return Boolean(norm) && (expressionNorm === norm || containsNeedle(expressionNorm, norm))
    })
    if (!hit) continue
    for (const name of names) {
      const norm = normalizeResolverText(name)
      if (!norm || seen.has(norm)) continue
      seen.add(norm)
      needles.push(name)
    }
  }
  return needles
}

function containsNeedle(haystack: string, needle: string): boolean {
  return needle.length >= CONTAINS_NEEDLE_MIN && haystack.includes(needle)
}

function moduleRelatedToTerm(
  module: ResolverCatalogModule,
  termNorm: string,
  nameNorm: string,
  keyNorm: string,
  capabilityNorm: string,
): boolean {
  if (nameNorm === termNorm || keyNorm === termNorm || capabilityNorm === termNorm) return true
  if (containsNeedle(nameNorm, termNorm) || containsNeedle(termNorm, nameNorm)) return true
  return module.aliases.some((alias) => {
    const aliasNorm = normalizeResolverText(alias)
    return Boolean(aliasNorm) && (aliasNorm === termNorm || containsNeedle(aliasNorm, termNorm) || containsNeedle(termNorm, aliasNorm))
  })
}

function matchModule(
  expression: string,
  expressionNorm: string,
  module: ResolverCatalogModule,
  termNeedles: readonly string[],
): { layer: number; matchedBy: ModuleResolveMatch[] } | null {
  const matchedBy: ModuleResolveMatch[] = []
  const mark = (field: ModuleResolveMatchField, text: string, layer: number) => {
    if (!matchedBy.some((item) => item.field === field && item.text === text)) {
      matchedBy.push({ field, text })
    }
    return layer
  }

  let layer: number | null = null
  const nameNorm = normalizeResolverText(module.name)
  const keyNorm = normalizeResolverText(module.key)
  const capabilityNorm = module.capabilityKey ? normalizeResolverText(module.capabilityKey) : ''
  if (nameNorm && expressionNorm === nameNorm) layer = mark('name', module.name, 1)
  for (const alias of module.aliases) {
    const aliasNorm = normalizeResolverText(alias)
    if (aliasNorm && expressionNorm === aliasNorm) layer = Math.min(layer ?? 1, mark('alias', alias, 1))
  }
  for (const term of termNeedles) {
    const termNorm = normalizeResolverText(term)
    if (termNorm && expressionNorm === termNorm && moduleRelatedToTerm(module, termNorm, nameNorm, keyNorm, capabilityNorm)) {
      layer = Math.min(layer ?? 1, mark('term', term, 1))
    }
  }
  if (layer === 1) return { layer, matchedBy }

  if (keyNorm && expressionNorm === keyNorm) return { layer: mark('key', module.key, 2), matchedBy }
  if (capabilityNorm && expressionNorm === capabilityNorm) {
    return { layer: mark('capabilityKey', module.capabilityKey!, 2), matchedBy }
  }

  if (nameNorm && containsNeedle(expressionNorm, nameNorm)) layer = mark('name', module.name, 3)
  for (const alias of module.aliases) {
    const aliasNorm = normalizeResolverText(alias)
    if (aliasNorm && containsNeedle(expressionNorm, aliasNorm)) {
      layer = Math.min(layer ?? 3, mark('alias', alias, 3))
    }
  }
  for (const term of termNeedles) {
    const termNorm = normalizeResolverText(term)
    if (termNorm && containsNeedle(expressionNorm, termNorm) && moduleRelatedToTerm(module, termNorm, nameNorm, keyNorm, capabilityNorm)) {
      layer = Math.min(layer ?? 3, mark('term', term, 3))
    }
  }
  if (layer === 3) return { layer, matchedBy }

  const exprTokens = tokenizeResolverText(expressionNorm)
  for (const example of module.intentExamples) {
    const exampleTokens = tokenizeResolverText(normalizeResolverText(example))
    if (exampleTokens.length === 0) continue
    const exampleSet = new Set(exampleTokens)
    const overlap = exprTokens.filter((token) => exampleSet.has(token))
    const uniqueOverlap = new Set(overlap)
    const coverage = uniqueOverlap.size / exampleSet.size
    if (coverage >= INTENT_EXAMPLE_COVERAGE_MIN && uniqueOverlap.size >= INTENT_EXAMPLE_MIN_OVERLAP) {
      layer = Math.min(layer ?? 4, mark('intentExample', example, 4))
    }
  }
  if (layer === 4) return { layer, matchedBy }

  for (const tag of module.tags) {
    const tagNorm = normalizeResolverText(tag)
    if (!tagNorm) continue
    if (expressionNorm === tagNorm || containsNeedle(expressionNorm, tagNorm)) {
      layer = Math.min(layer ?? 5, mark('tag', tag, 5))
    }
  }
  return layer ? { layer, matchedBy } : null
}

function compareHits(a: RankedHit, b: RankedHit): number {
  if (a.layer !== b.layer) return a.layer - b.layer
  const pubA = a.version.publicationStatus === 'published' ? 0 : 1
  const pubB = b.version.publicationStatus === 'published' ? 0 : 1
  if (pubA !== pubB) return pubA - pubB
  if (a.version.publishedAt !== b.version.publishedAt) {
    return a.version.publishedAt < b.version.publishedAt ? 1 : -1
  }
  if (a.module.key !== b.module.key) return a.module.key < b.module.key ? -1 : 1
  return a.module.moduleId < b.module.moduleId ? -1 : a.module.moduleId > b.module.moduleId ? 1 : 0
}

export function decideResolveStatus(candidates: readonly { layer: number }[]): ModuleResolveStatus {
  if (candidates.length === 0) return 'no_match'
  const first = candidates[0]!.layer
  const sameLayer = candidates.filter((item) => item.layer === first)
  if (sameLayer.length > 1) return 'ambiguous'
  if (first <= 2) return 'matched'
  return 'suggested'
}

export function suggestModuleInputs(input: {
  expression: string
  inputs: readonly ModuleInputDecl[]
  availableKeys?: readonly string[]
}): Record<string, ModuleInputSuggestion> {
  const suggestions: Record<string, ModuleInputSuggestion> = {}
  const literals = extractLiteralCandidates(input.expression)
  const requiredPrimitive = input.inputs.filter(
    (item) => item.required && (item.valueType === 'string' || item.valueType === 'number'),
  )
  const canLiteral = requiredPrimitive.length === 1 && literals.length === 1
  const literal = canLiteral ? literals[0]! : undefined

  for (const decl of input.inputs) {
    if (input.availableKeys?.includes(decl.key)) {
      suggestions[decl.key] = { kind: 'from', key: decl.key, source: 'rule' }
      continue
    }
    if (literal && requiredPrimitive[0]?.key === decl.key) {
      const typed = toLiteralValue(literal.value, decl.valueType)
      if (typed !== undefined && literal.value && input.expression.slice(literal.span[0], literal.span[1]) === literal.value) {
        suggestions[decl.key] = {
          kind: 'literal',
          value: typed,
          span: literal.span,
          source: 'rule',
        }
        continue
      }
    }
    suggestions[decl.key] = { kind: 'missing' }
  }
  return suggestions
}

function toLiteralValue(raw: string, valueType: ModuleValueType): string | number | undefined {
  if (valueType === 'number') {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (valueType === 'string') return raw
  return undefined
}

export function resolveModulesByRules(input: {
  expression: string
  catalog: readonly ResolverCatalogModule[]
  terms?: readonly ResolverTerm[]
  availableKeys?: readonly string[]
  maxCandidates?: number
}): {
  status: ModuleResolveStatus
  termRevision?: string
  candidates: ModuleResolveCandidate[]
  inputSuggestions: ModuleResolveResult['inputSuggestions']
  unknowns: string[]
} {
  const expression = input.expression.trim()
  const expressionNorm = normalizeResolverText(expression)
  const terms = input.terms ?? []
  const confirmed = confirmedTerms(terms)
  const termNeedles = termNeedlesForExpression(expressionNorm, confirmed)
  const termRevision = confirmed.length > 0 ? computeTermSnapshotDigest(confirmed) : undefined
  const maxCandidates = input.maxCandidates ?? DEFAULT_RESOLVER_MAX_CANDIDATES

  const hits: RankedHit[] = []
  for (const module of input.catalog) {
    const version = latestSelectableVersion(module.versions)
    if (!version || version.publicationStatus === 'withdrawn') continue
    const matched = matchModule(expression, expressionNorm, module, termNeedles)
    if (!matched) continue
    hits.push({ module, version, layer: matched.layer, matchedBy: matched.matchedBy })
  }
  hits.sort(compareHits)
  const sliced = hits.slice(0, maxCandidates)
  const candidates: ModuleResolveCandidate[] = sliced.map((hit, index) =>
    moduleResolveCandidateSchema.parse({
      moduleId: hit.module.moduleId,
      moduleVersionId: hit.version.versionId,
      key: hit.module.key,
      name: hit.module.name,
      versionNo: hit.version.versionNo,
      executionMode: hit.version.executionMode,
      effectCeiling: hit.version.effectCeiling,
      publicationStatus: hit.version.publicationStatus,
      matchedBy: hit.matchedBy,
      layer: hit.layer,
      rank: index + 1,
      notes: hit.version.publicationStatus === 'deprecated' ? ['deprecated'] : [],
    }),
  )

  const inputSuggestions: ModuleResolveResult['inputSuggestions'] = {}
  for (const hit of sliced) {
    inputSuggestions[hit.version.versionId] = suggestModuleInputs({
      expression,
      inputs: hit.version.inputs,
      availableKeys: input.availableKeys,
    })
  }

  return {
    status: decideResolveStatus(candidates),
    termRevision,
    candidates,
    inputSuggestions,
    unknowns: [],
  }
}

export function suggestionToBinding(suggestion: ModuleInputSuggestion | undefined): ModuleInputBinding | undefined {
  if (!suggestion || suggestion.kind === 'missing') return undefined
  if (suggestion.kind === 'from') return { kind: 'from', key: suggestion.key }
  return { kind: 'literal', value: suggestion.value }
}
