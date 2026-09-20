import {
  DEMONSTRATION_ADAPTER_VERSION,
  DEMONSTRATION_PROTOCOL,
  DEMONSTRATION_RULE_VERSION,
  canonicalJson,
  demonstrationPreviewSchema,
  stepSchema,
  syncSha256,
  applyDemonstrationBodySchema,
  authoringNodeId,
  normalizeAuthoringDocument,
  outputShapeForStep,
  scenarioAuthoringDocumentV2Schema,
  type ApplyDemonstrationBody,
  type ScenarioAuthoringDocumentV2,
  type OutcomeContract,
  type DemonstrationFact,
  type DemonstrationPlacement,
  type DemonstrationPreview,
  type DemonstrationSource,
  type DemonstrationSuggestion,
  type Step,
} from '@cairn/shared'
import { demonstrationFactDigest, sanitizeDemonstrationSource } from './demonstration-adapters.js'
import { deterministicStepId } from './expand.js'

function literal(fact: DemonstrationFact): string | undefined {
  return fact.data.value?.state === 'literal' ? fact.data.value.text : undefined
}

function toStep(fact: DemonstrationFact, source: DemonstrationSource): Step | undefined {
  const d = fact.data
  const value = literal(fact)
  let type: string = fact.action
  let input: unknown
  let effectType = 'SIDE_EFFECT'
  const midscene = source.importProfile === 'midscene-recorder-json@1'
  if (fact.action === 'navigate' || fact.action === 'openPage' || fact.action === 'navigation') {
    type = 'navigate'
    input = { url: d.url }
  } else if (fact.action === 'fill') {
    input = { target: d.target, value }
  } else if (fact.action === 'click' && !midscene) {
    input = { target: d.target, button: d.button, clickCount: d.clickCount, modifiers: d.modifiers }
  } else if (fact.action === 'press') {
    type = 'keyboard'
    input = { target: d.target, keys: [d.key] }
  } else if (fact.action === 'select') {
    input = { target: d.target, by: d.selectBy, value, index: d.selectIndex }
  } else if (
    ['aiTap', 'aiInput', 'aiKeyboardPress', 'aiScroll', 'ai', 'aiAct'].includes(fact.action) ||
    midscene
  ) {
    type = 'ai_action'
    const targetDescription = d.targetDescription
    if (fact.action === 'aiTap' || (midscene && fact.action === 'click'))
      input = { operation: 'tap', targetDescription }
    if (fact.action === 'aiInput' || fact.action === 'input')
      input = {
        operation: 'input',
        targetDescription,
        mode: d.mode,
        ...(d.mode === 'clear' ? {} : { value }),
      }
    if (fact.action === 'aiKeyboardPress' || fact.action === 'keydown')
      input = { operation: 'keyboard', targetDescription, key: d.key }
    if (fact.action === 'aiScroll' && d.scrollType === 'singleAction')
      input = {
        operation: 'scroll',
        targetDescription,
        direction: d.direction,
        distance: d.distance,
      }
    if (fact.action === 'ai' || fact.action === 'aiAct') input = { instruction: d.instruction }
  } else if (fact.action === 'sleep') {
    type = 'wait'
    effectType = 'READ_ONLY'
    input = { kind: 'time', durationMs: d.durationMs }
  }
  if (!input) return undefined
  const result = stepSchema.safeParse({
    id: deterministicStepId(source.captureId, fact.id),
    name: (d.targetDescription || (type === 'navigate' ? '打开页面' : fact.action)).slice(0, 128),
    type,
    effectType,
    input,
    ...(type === 'ai_action' ? { policy: { retryLimit: 0 } } : {}),
  })
  return result.success ? result.data : undefined
}

/** Pure L1/L2 derivation; source observations and attachment availability never change here. */
export function suggestDemonstration(sourceInput: DemonstrationSource): DemonstrationSuggestion[] {
  const source = sanitizeDemonstrationSource(sourceInput)
  const suggestions: DemonstrationSuggestion[] = []
  const primaryPage = source.facts.find((fact) => fact.pageId !== null)?.pageId
  let previousActionId: string | undefined
  for (const fact of source.facts) {
    const item: DemonstrationSuggestion = {
      id: fact.id,
      sourceIds: [...fact.sourceIds],
      action: fact.action,
      status: 'unresolved',
      diagnostics: [...fact.diagnostics],
    }
    if (primaryPage && fact.pageId && fact.pageId !== primaryPage)
      item.diagnostics.push('来源涉及另一个页面；本期不能隐式切换页面，请人工处理窗口归属')
    if (fact.kind === 'observation') {
      item.status = 'observation'
      suggestions.push(item)
      continue
    }
    const rule =
      fact.data.assertion ??
      (fact.action === 'aiAssert' && fact.data.instruction
        ? { kind: 'ai' as const, instruction: fact.data.instruction }
        : undefined)
    if (rule && previousActionId && !item.diagnostics.length) {
      item.outcome = {
        meaning: (fact.data.instruction ?? `录制成功条件：${fact.action}`).slice(0, 512),
        rule,
        severity: 'MUST',
        onViolation: 'halt',
        provenance: 'imported',
        afterSourceId: previousActionId,
      }
      item.status = 'mapped'
    } else if (!item.diagnostics.length && !rule) {
      item.step = toStep(fact, source)
      if (item.step) item.status = 'mapped'
    }
    if (fact.action === 'aiQuery')
      item.diagnostics.push('aiQuery 需要确认输出 Schema 和 outputKey；请将此项修正为 AI 提取步骤')
    if (fact.action === 'aiWaitFor')
      item.diagnostics.push('aiWaitFor 是等待重试语义，不能替换为一次断言')
    if (rule && !previousActionId) item.diagnostics.push('成功条件缺少前序业务动作；请人工放置')
    if (item.status === 'unresolved' && !item.diagnostics.length)
      item.diagnostics.push('动作或必要字段不在支持范围内，请修正或显式放弃')
    if (item.step) {
      const value = literal(fact)
      if (
        (item.step.type === 'fill' ||
          (item.step.type === 'ai_action' &&
            'operation' in item.step.input &&
            item.step.input.operation === 'input')) &&
        value !== undefined
      ) {
        item.parameter = { key: `input_${fact.sequence + 1}`, label: item.step.name, value }
      }
      if (item.step.type === 'wait' && item.step.input.kind === 'time')
        item.diagnostics.push('来源包含固定等待；可在 Studio 中改为可观察条件')
      if (
        'target' in item.step.input &&
        item.step.input.target?.candidates.some((c) => c.by === 'css')
      )
        item.diagnostics.push('包含结构定位器；建议在试跑中检查页面变化时的稳定性')
    }
    const previous = suggestions.at(-1)
    const priorFact = source.facts[fact.sequence - 1]
    const canMerge =
      fact.action === 'fill' &&
      previous?.step?.type === 'fill' &&
      item.step?.type === 'fill' &&
      priorFact?.action === 'fill' &&
      fact.pageId !== null &&
      fact.documentEpoch !== null &&
      fact.pageId === priorFact.pageId &&
      fact.documentEpoch === priorFact.documentEpoch &&
      canonicalJson(fact.framePath) === canonicalJson(priorFact.framePath) &&
      canonicalJson(fact.data.target) === canonicalJson(priorFact.data.target)
    if (canMerge && previous && item.step) {
      previous.sourceIds = [...new Set([...previous.sourceIds, ...item.sourceIds])]
      previous.step = { ...item.step, id: previous.step!.id }
      previous.parameter = item.parameter
      previousActionId = previous.id
      continue
    }
    suggestions.push(item)
    // Unresolved actions remain placement boundaries; accepting their replacement can resolve the outcome.
    if (!rule) previousActionId = item.id
  }
  return suggestions
}

export function previewDemonstration(input: {
  source: DemonstrationSource
  recordingDraftId: string
  scenarioId: string
  baseRevision: number
  placement: DemonstrationPlacement
  remainingCapacity: number
}): DemonstrationPreview {
  const preview = {
    protocolVersion: DEMONSTRATION_PROTOCOL,
    recordingDraftId: input.recordingDraftId,
    scenarioId: input.scenarioId,
    targetId: input.source.targetId,
    importProfile: input.source.importProfile,
    baseRevision: input.baseRevision,
    placement: input.placement,
    factDigest: demonstrationFactDigest(input.source),
    adapterVersion: DEMONSTRATION_ADAPTER_VERSION,
    ruleVersion: DEMONSTRATION_RULE_VERSION,
    suggestions: suggestDemonstration(input.source),
    remainingCapacity: input.remainingCapacity,
  }
  return demonstrationPreviewSchema.parse({
    ...preview,
    suggestionDigest: syncSha256(canonicalJson(preview)),
  })
}

export class DemonstrationApplyError extends Error {
  readonly code = 'DEMONSTRATION_APPLY_INVALID'
}

/** Apply reviewed decisions to a copy. The caller owns authorization, revision and persistence. */
export function applyDemonstrationToDocument(
  documentInput: ScenarioAuthoringDocumentV2,
  preview: DemonstrationPreview,
  bodyInput: ApplyDemonstrationBody,
): {
  document: ScenarioAuthoringDocumentV2
  sourceMap: Array<{
    sourceIds: string[]
    nodeId?: string
    contractId?: string
    disposition: string
  }>
} {
  const body = applyDemonstrationBodySchema.parse(bodyInput)
  function reject(message: string): never {
    throw new DemonstrationApplyError(message)
  }
  if (
    body.factDigest !== preview.factDigest ||
    body.suggestionDigest !== preview.suggestionDigest ||
    body.baseRevision !== preview.baseRevision ||
    canonicalJson(body.placement) !== canonicalJson(preview.placement)
  )
    reject('建议已过期，请重新预览')
  const decisions = new Map(body.decisions.map((d) => [d.id, d]))
  if (
    decisions.size !== body.decisions.length ||
    decisions.size !== preview.suggestions.length ||
    preview.suggestions.some((s) => !decisions.has(s.id))
  )
    reject('每项来源必须处理一次，不能遗漏或重复')
  const document = normalizeAuthoringDocument(structuredClone(documentInput))
  const place = body.placement
  const anchor =
    place.kind === 'start'
      ? -1
      : document.nodes.findIndex((n) => authoringNodeId(n) === place.nodeId)
  if (place.kind !== 'start' && anchor < 0) reject('插入或替换位置已不存在')
  const replacements: Extract<ScenarioAuthoringDocumentV2['nodes'][number], { kind: 'step' }>[] = []
  const bySource = new Map<
    string,
    Extract<ScenarioAuthoringDocumentV2['nodes'][number], { kind: 'step' }>
  >()
  const sourceMap: Array<{
    sourceIds: string[]
    nodeId?: string
    contractId?: string
    disposition: string
  }> = []
  for (const item of preview.suggestions) {
    const decision = decisions.get(item.id)!
    const mapping: (typeof sourceMap)[number] = {
      sourceIds: item.sourceIds,
      disposition: decision.disposition,
    }
    sourceMap.push(mapping)
    if (decision.disposition === 'discard') continue
    if (decision.disposition === 'accept' && item.outcome) {
      const target = bySource.get(item.outcome.afterSourceId)
      if (!target) reject('成功条件前序动作已放弃或未接受；不能改变断言发生位置')
      if (decision.parameter) reject('成功条件不能作为输入参数接受')
      const outcome: OutcomeContract = {
        id: deterministicStepId(preview.recordingDraftId, item.id, 'outcome'),
        scope: 'step',
        meaning: item.outcome.meaning,
        rule: item.outcome.rule,
        severity: 'MUST',
        onViolation: 'halt',
        provenance: 'imported',
      }
      target!.outcomes = [...(target!.outcomes ?? []), outcome]
      mapping.nodeId = target!.step.id
      mapping.contractId = outcome.id
      continue
    }
    const raw = decision.disposition === 'replace' ? decision.step : item.step
    if (!raw || (decision.disposition === 'accept' && item.status !== 'mapped'))
      reject('未决动作必须修正或明确放弃')
    let step = stepSchema.parse(raw)
    if (decision.disposition === 'accept' && decision.parameter) {
      if (!item.parameter) reject('此动作没有可参数化的普通输入')
      const parameter = decision.parameter
      const existing = document.inputs.find((input) => input.key === parameter.key)
      if (existing && canonicalJson(existing) !== canonicalJson(parameter))
        reject('参数名已存在且声明不同，请显式选用原声明或更名')
      if (!existing) document.inputs.push(parameter)
      if (step.type === 'fill') {
        const { value: _value, ...input } = step.input
        step = stepSchema.parse({ ...step, input: { ...input, from: parameter.key } })
      } else if (
        step.type === 'ai_action' &&
        'operation' in step.input &&
        step.input.operation === 'input'
      ) {
        const { value: _value, ...input } = step.input
        step = stepSchema.parse({ ...step, input: { ...input, from: parameter.key } })
      } else reject('此动作不支持参数绑定')
    }
    const node = { kind: 'step' as const, step }
    replacements.push(node)
    bySource.set(item.id, node)
    mapping.nodeId = step.id
  }
  if (place.kind === 'replace') {
    const original = document.nodes[anchor]
    if (original?.kind !== 'step') reject('一期仅支持替换独立步骤，不能替换模块节点')
    if (replacements.length !== 1) reject('单步重教须恰好保留一个新动作，其余来源需明确放弃')
    const replacement = replacements[0]!
    if (
      original.step.outputKey &&
      canonicalJson(outputShapeForStep(original.step)) !==
        canonicalJson(outputShapeForStep(replacement.step))
    )
      reject('新动作的输出类型与原步骤不兼容')
    const incomingId = replacement.step.id
    replacement.step = stepSchema.parse({
      ...replacement.step,
      id: original.step.id,
      name: original.step.name,
      outputKey: original.step.outputKey,
      policy: original.step.policy,
    })
    document.nodes[anchor] = {
      ...original,
      step: replacement.step,
      ...(original.outcomes || replacement.outcomes
        ? { outcomes: [...(original.outcomes ?? []), ...(replacement.outcomes ?? [])] }
        : {}),
    }
    for (const item of sourceMap) if (item.nodeId === incomingId) item.nodeId = original.step.id
  } else {
    document.nodes.splice(anchor + 1, 0, ...replacements)
  }
  return { document: scenarioAuthoringDocumentV2Schema.parse(document), sourceMap }
}
