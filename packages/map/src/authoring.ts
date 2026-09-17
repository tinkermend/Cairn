import { compileScenarioDocument } from '@cairn/authoring'
import {
  MAX_SCENARIO_STEPS,
  scenarioDocumentSchema,
  type KnowledgeDiagnostic,
  type KnowledgeDiff,
  type KnowledgeSourceRef,
  type KnowledgeSuggestedBinding,
  type KnowledgeSuggestedModule,
  type KnowledgeTermCandidate,
  type MapAssetRef,
  type MapConditionSnapshot,
  type ScenarioDocument,
  type Step,
} from '@cairn/shared'

export type TerminologyMatchInput = {
  termId: string
  canonicalName: string
  aliases: readonly string[]
  meaning: string
  termStatus: 'candidate' | 'confirmed' | 'retired'
  revision: number
  sources: readonly KnowledgeSourceRef[]
  conditionSnapshot?: MapConditionSnapshot
}

export type PublishedModuleKnowledge = {
  moduleId: string
  moduleVersionId: string
  name: string
  key: string
  aliases: readonly string[]
  intentExamples: readonly string[]
  tags: readonly string[]
  contentDigest: string
  publicationStatus: 'published' | 'deprecated' | 'withdrawn'
  steps: readonly Step[]
  inputs?: readonly { key: string; label: string; required: boolean }[]
  preconditions?: readonly { meaning: string; verification: { kind: string } }[]
  postconditions: readonly { meaning: string; verification: { kind: string } }[]
}

export type KnowledgeComposeInput = {
  question: string
  targetId: string
  draft: ScenarioDocument
  terms: readonly TerminologyMatchInput[]
  modules: readonly PublishedModuleKnowledge[]
  mapAssets: readonly { assetRef: MapAssetRef; name?: string }[]
  selectedTermIds?: readonly string[]
  selectedModuleVersionIds?: readonly string[]
  mapReleaseId?: string
  nextId: () => string
}

export type KnowledgeComposeResult = {
  status: 'proposed' | 'needs_input' | 'unsupported'
  question: string
  document?: ScenarioDocument
  diffs: KnowledgeDiff[]
  diagnostics: KnowledgeDiagnostic[]
  sources: KnowledgeSourceRef[]
  unknowns: string[]
  termCandidates: KnowledgeTermCandidate[]
  suggestedModules: KnowledgeSuggestedModule[]
  suggestedBindings: KnowledgeSuggestedBinding[]
}

const RECORD_ID_HINT = /订单号|记录ID|记录编号|单号|工单号|order\s*(no|id|number)|record\s*id/i
const RESULT_HINT = /状态|结果|断言|是否成功|判据|读取/
const INJECTION_HINT = /ignore (all )?(previous|above) instructions|you are now|忘记(以上|之前)指令|系统提示/i
const SECRET_HINT = /((?:password|token|secret|api[_-]?key|口令|密码)["']?\s*[:=：]\s*)(?:"[^"]*"|'[^']*'|[^\s,;，；]+)/gi

export function redactKnowledgeQuestion(question: string): string {
  return question
    .replace(SECRET_HINT, '$1***')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer ***')
    .replace(INJECTION_HINT, '[redacted-injection]')
    .trim()
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase()
}

/** 匹配用：去掉记录号/数字，避免「按订单号 1001 查询」对不上「按订单号查询」。 */
function compactQuery(value: string): string {
  return normalizeToken(value)
    .replace(/\b[0-9a-f]{8,}\b/gi, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function fieldMatchesQuery(field: string, needle: string, compactNeedle: string): boolean {
  const token = normalizeToken(field)
  if (!token) return false
  const compact = token.replace(/\s+/g, '')
  if (token === needle || compact === compactNeedle) return true
  if (compact.length >= 2 && (compactNeedle.includes(compact) || compact.includes(compactNeedle))) return true
  return token
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((part) => part.length >= 3)
    .some((part) => compactNeedle.includes(part))
}

function termTokens(term: TerminologyMatchInput): string[] {
  return [term.canonicalName, ...term.aliases].map(normalizeToken).filter(Boolean)
}

export function matchTerminologyCandidates(
  query: string,
  terms: readonly TerminologyMatchInput[],
): TerminologyMatchInput[] {
  const needle = normalizeToken(query)
  if (!needle) return []
  return terms.filter((term) => {
    if (term.termStatus === 'retired') return false
    return termTokens(term).some((token) => token === needle || token.includes(needle) || needle.includes(token))
  })
}

export function matchPublishedModules(
  query: string,
  modules: readonly PublishedModuleKnowledge[],
): PublishedModuleKnowledge[] {
  const needle = compactQuery(query)
  if (!needle) return []
  const compactNeedle = needle.replace(/\s+/g, '')
  return modules.filter((module) => {
    if (module.publicationStatus === 'withdrawn') return false
    return [module.name, module.key, ...module.aliases, ...module.intentExamples, ...module.tags].some((field) =>
      fieldMatchesQuery(field, needle, compactNeedle),
    )
  })
}

function draftCoversRecordId(draft: ScenarioDocument): boolean {
  return draft.inputs.some(input => RECORD_ID_HINT.test(`${input.key} ${input.label}`) || /^(?:(?:order|record|ticket)(?:Id|No|Number)|id)$/i.test(input.key)) || draft.steps.some(step => step.type === 'fill' && RECORD_ID_HINT.test(`${step.name} ${JSON.stringify(step.input.target)}`) && Boolean(step.input.from || step.input.value?.trim()))
}

function questionSuppliesRecordId(question: string): boolean {
  return /(?:订单号|单号|记录ID|工单号|order\s*(?:no|id|number))\s*[:：#]?\s*[A-Za-z0-9-]{3,}/i.test(question)
}

function hasExecutableResultCheck(steps: readonly Step[]): boolean {
  return steps.some((step) => step.type === 'assert' || step.type === 'ai_assert')
}

function remapContextKey(base: string, seed: string, taken: Set<string>): string {
  const compact = seed.replace(/-/g, '').slice(0, 8)
  const suffix = base.slice(0, 110)
  let candidate = `${suffix}_${compact}`
  if (!/^[A-Za-z]/.test(candidate)) candidate = `k${candidate}`
  candidate = candidate.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 128)
  let unique = candidate
  let index = 1
  while (taken.has(unique)) {
    unique = `${candidate.slice(0, 120)}_${index}`
    index += 1
  }
  taken.add(unique)
  return unique
}

export function copyModuleStepsAsIndependent(
  steps: readonly Step[],
  existing: ScenarioDocument,
  nextId: () => string,
): Step[] {
  const takenKeys = new Set(
    [...existing.inputs.map(input => input.key), ...existing.steps.map(step => step.outputKey).filter((key): key is string => Boolean(key))],
  )
  const idMap = new Map<string, string>()
  const outputMap = new Map<string, string>()
  for (const step of steps) {
    const id = nextId()
    idMap.set(step.id, id)
    if (step.outputKey) {
      const nextKey = takenKeys.has(step.outputKey)
        ? remapContextKey(step.outputKey, id, takenKeys)
        : step.outputKey
      takenKeys.add(nextKey)
      outputMap.set(step.outputKey, nextKey)
    }
  }
  return steps.map((step) => {
    const input = { ...(step.input as Record<string, unknown>) }
    if (typeof input.from === 'string' && outputMap.has(input.from)) {
      input.from = outputMap.get(input.from)
    }
    return {
      ...step,
      id: idMap.get(step.id) ?? nextId(),
      outputKey: step.outputKey ? outputMap.get(step.outputKey) ?? step.outputKey : step.outputKey,
      input,
    } as Step
  })
}

function documentDiffs(from: ScenarioDocument, to: ScenarioDocument): KnowledgeDiff[] {
  const diffs: KnowledgeDiff[] = []
  if (from.steps.length !== to.steps.length) {
    diffs.push({ fieldPath: ['steps', 'length'], from: from.steps.length, to: to.steps.length })
  }
  const fromIds = new Set(from.steps.map((step) => step.id))
  for (const [index, step] of to.steps.entries()) {
    if (!fromIds.has(step.id)) {
      diffs.push({ fieldPath: ['steps', String(index)], to: step })
    }
  }
  return diffs
}

function termCandidate(term: TerminologyMatchInput): KnowledgeTermCandidate {
  return {
    termId: term.termId,
    revision: term.revision,
    canonicalName: term.canonicalName,
    aliases: [...term.aliases],
    meaning: term.meaning,
  }
}

function moduleSuggestion(module: PublishedModuleKnowledge): KnowledgeSuggestedModule {
  return {
    moduleId: module.moduleId,
    moduleVersionId: module.moduleVersionId,
    name: module.name,
    contentDigest: module.contentDigest,
    manualRequirement: [...(module.preconditions ?? []), ...module.postconditions].some((item) => item.verification.kind === 'manual_requirement'),
  }
}

function sourcesFromTerm(term: TerminologyMatchInput): KnowledgeSourceRef[] {
  const sources: KnowledgeSourceRef[] = [{ kind: 'term', termId: term.termId, revision: term.revision }]
  for (const source of term.sources) {
    if (source.kind === 'map_asset') {
      sources.push({
        ...source,
        mapReleaseId: source.mapReleaseId,
      })
    } else {
      sources.push(source)
    }
  }
  return sources
}

function bindingsFromTerm(
  term: TerminologyMatchInput,
  stepId: string | undefined,
  targetId: string,
): KnowledgeSuggestedBinding[] {
  if (!stepId) return []
  return term.sources
    .filter((source): source is Extract<KnowledgeSourceRef, { kind: 'map_asset' }> => source.kind === 'map_asset')
    .filter((source) => source.assetRef.targetId === targetId)
    .map((source) => ({
      stepId,
      assetRef: source.assetRef,
    }))
}

export function composeKnowledgeSuggestion(input: KnowledgeComposeInput): KnowledgeComposeResult {
  const question = redactKnowledgeQuestion(input.question)
  const diagnostics: KnowledgeDiagnostic[] = []
  const unknowns: string[] = []
  const sources: KnowledgeSourceRef[] = []
  if (INJECTION_HINT.test(input.question) || input.question.search(SECRET_HINT) >= 0) {
    diagnostics.push({
      code: 'KNOWLEDGE_INPUT_REDACTED',
      message: '已把提示注入或秘密片段当作普通数据并脱敏，不会提升权限或自动发布。',
    })
  }

  const selectedTerms = input.selectedTermIds?.length
    ? input.terms.filter((term) => input.selectedTermIds!.includes(term.termId) && term.termStatus === 'confirmed')
    : matchTerminologyCandidates(question, input.terms.filter(term => term.termStatus === 'confirmed'))
  const aliasGroups = new Map<string, TerminologyMatchInput[]>()
  for (const term of selectedTerms) {
    for (const token of termTokens(term)) {
      const current = aliasGroups.get(token) ?? []
      current.push(term)
      aliasGroups.set(token, current)
    }
  }
  const ambiguous = [...aliasGroups.values()].find((group) => {
    const unique = new Set(group.map((item) => item.termId))
    return unique.size > 1 && !input.selectedTermIds?.length
  })
  if (ambiguous || selectedTerms.length > 1) {
    return {
      status: 'needs_input',
      question,
      diffs: [],
      diagnostics: [
        ...diagnostics,
        { code: 'KNOWLEDGE_ALIAS_AMBIGUOUS', message: '多个术语对应当前需求，请先选定一个术语含义。' },
      ],
      sources,
      unknowns,
      termCandidates: selectedTerms.slice(0, 16).map(termCandidate),
      suggestedModules: [],
      suggestedBindings: [],
    }
  }

  const selectedModules = input.selectedModuleVersionIds?.length
    ? input.modules.filter((module) => input.selectedModuleVersionIds!.includes(module.moduleVersionId))
    : matchPublishedModules(question, input.modules)
  const publishedModules = selectedModules.filter((module) => module.publicationStatus === 'published')
  if (publishedModules.length > 1) {
    return {
      status: 'needs_input',
      question,
      diffs: [],
      diagnostics: [
        ...diagnostics,
        { code: 'KNOWLEDGE_MODULE_AMBIGUOUS', message: '多个已发布做法匹配该请求，请先选定模块版本。' },
      ],
      sources,
      unknowns,
      termCandidates: selectedTerms.slice(0, 16).map(termCandidate),
      suggestedModules: publishedModules.slice(0, 8).map(moduleSuggestion),
      suggestedBindings: [],
    }
  }

  if (RECORD_ID_HINT.test(question) && !draftCoversRecordId(input.draft) && !questionSuppliesRecordId(question)) {
    return {
      status: 'needs_input',
      question,
      diffs: [],
      diagnostics: [
        ...diagnostics,
        { code: 'KNOWLEDGE_RECORD_ID_REQUIRED', message: '缺少记录标识，不能虚构订单号或业务主键。', fieldPath: ['inputs'] },
      ],
      sources: selectedTerms.flatMap((term) => sourcesFromTerm(term)).slice(0, 16),
      unknowns: ['recordId'],
      termCandidates: selectedTerms.slice(0, 16).map(termCandidate),
      suggestedModules: publishedModules.slice(0, 8).map(moduleSuggestion),
      suggestedBindings: [],
    }
  }

  const term = selectedTerms[0]
  const module = publishedModules[0]
  if (term) sources.push(...sourcesFromTerm(term))
  if (!term && !module && input.mapAssets.length === 0) {
    return {
      status: 'unsupported',
      question,
      diffs: [],
      diagnostics: [
        ...diagnostics,
        { code: 'KNOWLEDGE_CONTEXT_UNAVAILABLE', message: '当前没有可用术语、已发布做法或地图对象，请手工编写或使用单步助手。' },
      ],
      sources,
      unknowns: input.mapReleaseId ? [] : ['mapRelease'],
      termCandidates: [],
      suggestedModules: [],
      suggestedBindings: [],
    }
  }

  if (!module) {
    if (term) {
      return {
        status: 'needs_input',
        question,
        diffs: [],
        diagnostics: [
          ...diagnostics,
          { code: 'KNOWLEDGE_MODULE_UNAVAILABLE', message: '已选定术语，但没有可复制的已发布做法，请手工编写步骤。' },
        ],
        sources,
        unknowns,
        termCandidates: selectedTerms.slice(0, 16).map(termCandidate),
        suggestedModules: [],
        suggestedBindings: [],
      }
    }
    return {
      status: 'needs_input',
      question,
      diffs: [],
      diagnostics: [
        ...diagnostics,
        { code: 'KNOWLEDGE_NEEDS_SELECTION', message: '请选择术语或已发布做法后再生成可编辑步骤。' },
      ],
      sources,
      unknowns,
      termCandidates: selectedTerms.slice(0, 16).map(termCandidate),
      suggestedModules: [],
      suggestedBindings: [],
    }
  }

  const missingInputs = (module.inputs ?? []).filter(item => item.required && !input.draft.inputs.some(existing => existing.key === item.key))
  if (missingInputs.length) return {
    status: 'needs_input', question, diffs: [],
    diagnostics: [...diagnostics, { code: 'KNOWLEDGE_MODULE_INPUT_REQUIRED', message: '请先在草稿声明并绑定做法所需输入：' + missingInputs.map(item => item.label).join('、') }],
    sources, unknowns: missingInputs.map(item => item.key).slice(0, 16), termCandidates: selectedTerms.slice(0, 16).map(termCandidate), suggestedModules: [moduleSuggestion(module)], suggestedBindings: [],
  }
  if (term?.conditionSnapshot) {
    diagnostics.push({ code: 'KNOWLEDGE_CONDITION_UNKNOWN', message: '术语带有适用条件，当前编写上下文未证明这些条件成立，请先确认权限、工作区及账号。', termId: term.termId })
    return { status: 'needs_input', question, diffs: [], diagnostics, sources, unknowns: ['termCondition'], termCandidates: selectedTerms.slice(0, 16).map(termCandidate), suggestedModules: [moduleSuggestion(module)], suggestedBindings: [] }
  }
  const copied = copyModuleStepsAsIndependent(module.steps, input.draft, input.nextId)
  if (input.draft.steps.length + copied.length > MAX_SCENARIO_STEPS) {
    return {
      status: 'unsupported',
      question,
      diffs: [],
      diagnostics: [
        ...diagnostics,
        {
          code: 'KNOWLEDGE_STEP_LIMIT',
          message: `复制后将超过 ${MAX_SCENARIO_STEPS} 步，不能写入草稿。`,
          moduleVersionId: module.moduleVersionId,
        },
      ],
      sources,
      unknowns,
      termCandidates: selectedTerms.slice(0, 16).map(termCandidate),
      suggestedModules: [moduleSuggestion(module)],
      suggestedBindings: [],
    }
  }

  const document = scenarioDocumentSchema.parse({
    ...input.draft,
    steps: [...input.draft.steps, ...copied],
  })
  const compiled = compileScenarioDocument(document, { mode: 'save' })
  if (!compiled.ok || compiled.diagnostics.some(item => item.code === 'SCENARIO_UNRESOLVED_REF')) return {
    status: 'needs_input', question, diffs: [], diagnostics: compiled.diagnostics.filter(item => item.severity === 'error' || item.code === 'SCENARIO_UNRESOLVED_REF').slice(0, 32).map(item => ({ code: item.code, message: item.message, stepId: item.stepId })),
    sources, unknowns: ['compile'], termCandidates: selectedTerms.slice(0, 16).map(termCandidate), suggestedModules: [moduleSuggestion(module)], suggestedBindings: [],
  }
  sources.push({
    kind: 'module_version',
    moduleId: module.moduleId,
    moduleVersionId: module.moduleVersionId,
    contentDigest: module.contentDigest,
  })
  const suggestedModules = [moduleSuggestion(module)]
  if (suggestedModules[0]!.manualRequirement) {
    diagnostics.push({
      code: 'KNOWLEDGE_CONDITION_UNKNOWN',
      message: '该做法含人工说明，不能当作已自动验证的业务成功证据。',
      moduleVersionId: module.moduleVersionId,
    })
    unknowns.push('manual_requirement')
  }
  if (RESULT_HINT.test(question) && !hasExecutableResultCheck(document.steps)) {
    diagnostics.push({
      code: 'KNOWLEDGE_CONDITION_UNKNOWN',
      message: '缺少可执行的结果判据，不能宣称业务已验证。',
    })
    unknowns.push('resultCriterion')
  }

  if (!input.mapReleaseId) unknowns.push('mapRelease')
  const firstCopied = copied[0]
  const suggestedBindings = term
    ? bindingsFromTerm(term, firstCopied?.id, input.targetId).filter(binding => input.mapAssets.some(asset => Object.entries(binding.assetRef).every(([key, value]) => (asset.assetRef as Record<string, unknown>)[key] === value)))
    : []

  return {
    status: 'proposed',
    question,
    document,
    diffs: documentDiffs(input.draft, document),
    diagnostics,
    sources,
    unknowns,
    termCandidates: selectedTerms.slice(0, 16).map(termCandidate),
    suggestedModules,
    suggestedBindings: suggestedBindings.length === 1 ? suggestedBindings : [],
  }
}
