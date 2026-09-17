import {
  authoringModuleInvocationSchema,
  authoringNodeId,
  CONTAINS_NEEDLE_MIN,
  DEFAULT_RESOLVER_MAX_CANDIDATES,
  INTENT_EXAMPLE_COVERAGE_MIN,
  INTENT_EXAMPLE_MIN_OVERLAP,
  latestSelectableVersion,
  moduleResolveCandidateSchema,
  normalizeResolverText,
  tokenizeResolverText,
  computeTermSnapshotDigest,
  type AuthoringModuleInvocation,
  type ExtractedLiteral,
  type ModuleInputBinding,
  type ModuleInputDecl,
  type ModuleInputSuggestion,
  type ModuleResolveCandidate,
  type ModuleResolveMatch,
  type ModuleResolveMatchField,
  type ModuleResolveResult,
  type ModuleResolveStatus,
  type ModuleValueType,
  type ResolverCatalogModule,
  type ResolverCatalogVersion,
  type ResolverTerm,
  type ScenarioAuthoringDocumentV2,
} from '@cairn/shared'

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
