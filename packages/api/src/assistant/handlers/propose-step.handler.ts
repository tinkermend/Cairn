import {
  type AssistantProposal,
  type AssistantResult,
  type AssistantStepChange,
  type ScenarioDocument,
  applyStepProposal,
  authoringSteps,
  compareCompileDiagnostics,
  isAuthoringDocumentV2,
  parseScenarioDocument,
  scenarioDocumentDigest,
  scenarioFactsForModel,
} from '@cairn/shared'
import { compileForAssistant } from '@cairn/authoring'
import { DomainError, getScenario } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry'
import { buildAuthoringSlice } from '../context-assembler'
import { generateStepChange } from '../model-session'
import { requireVisibleTarget } from './common'

function requireFlatDocument(document: unknown): ScenarioDocument {
  if (isAuthoringDocumentV2(document)) {
    return parseScenarioDocument({
      schemaVersion: document.schemaVersion,
      inputs: document.inputs,
      steps: authoringSteps(document),
    })
  }
  return parseScenarioDocument(document)
}

function constructRuleBasedStepChange(
  document: ScenarioDocument,
  stepId: string,
  question: string,
  maxInstructionChars: number,
): AssistantStepChange | Extract<AssistantResult, { kind: 'unsupported' }> {
  const step = document.steps.find((item) => item.id === stepId)
  if (!step) {
    return { kind: 'unsupported', reasonCode: 'STEP_NOT_FOUND', message: '步骤不在该草稿中' }
  }
  if (step.type === 'fill') {
    const match = /引用\s*([a-zA-Z][\w-]*)/.exec(question) ?? /from\s+([a-zA-Z][\w-]*)/.exec(question)
    if (!match) {
      return { kind: 'unsupported', reasonCode: 'NEED_BINDING', message: '请指明要引用的前序输出或输入名称' }
    }
    return { kind: 'fill_binding', from: match[1]! }
  }
  if (step.type === 'assert') {
    const text = /改成[「"](.+?)[」"]/.exec(question)?.[1]
    if (!text) {
      return { kind: 'unsupported', reasonCode: 'NEED_EXPECTATION', message: '请明确新的断言预期文字' }
    }
    return { kind: 'assert_expectation', expect: { kind: 'text_contains', value: text } }
  }
  if (step.type.startsWith('ai_')) {
    const instruction = question.replace(/^(把|请|帮我)?(这条)?(AI)?指令/, '').trim() || question
    return { kind: 'ai_instruction', instruction: instruction.slice(0, maxInstructionChars) }
  }
  return { kind: 'unsupported', reasonCode: 'STEP_TYPE_UNSUPPORTED', message: '一期不能修改这类步骤' }
}

export async function handleScenarioProposeStep(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantResult> {
  const { actor, slots, question, session, db, targets, platformConfig, signal, onProgress } = ctx
  await onProgress?.('loading_facts', '正在检索并切片草稿上下文...')

  const scenarioId = String(slots.scenarioId ?? '')
  const stepId = String(slots.stepId ?? '')
  const draftRevision = Number(slots.draftRevision)

  if (!scenarioId || !stepId) {
    throw new DomainError('bad_request', 'MISSING_SLOT', '缺少必需参数 scenarioId 或 stepId')
  }

  const detail = await getScenario(db, scenarioId)
  await requireVisibleTarget(actor, detail.targetId, targets, db)

  if (!detail.draft || detail.draft.revision !== draftRevision) {
    throw new DomainError('conflict', 'ASSISTANT_DRAFT_STALE', '请基于当前已保存草稿重新生成')
  }

  const document = requireFlatDocument(detail.draft.document)

  // AIF-11, AIF-16, AIF-17: Build slice & redact sensitive fields & pre-check hard limits
  const slice = buildAuthoringSlice(document, stepId)
  const slicedDoc = slice.slicedDocument

  const config = await platformConfig.get()
  const maxInstructionChars = config.document.platformAi.maxOutputTokens

  let change: AssistantStepChange | Extract<AssistantResult, { kind: 'unsupported' }> =
    constructRuleBasedStepChange(slicedDoc, stepId, question, maxInstructionChars)

  if ('reasonCode' in change && change.reasonCode !== 'STEP_NOT_FOUND' && session) {
    await onProgress?.('generating', '大模型正在生成步骤候选变更...')
    const generated = await generateStepChange(
      session,
      question,
      scenarioFactsForModel(slicedDoc, stepId),
      signal,
    )
    if (generated.change) {
      change = generated.change
    }
  }

  if ('reasonCode' in change) {
    return change
  }

  await onProgress?.('validating', '正在验证候选变更与编译完整性...')
  const applied = applyStepProposal(document, stepId, change)
  if (!applied.ok) {
    return {
      kind: 'unsupported',
      reasonCode: applied.error.code,
      message: applied.error.message,
    }
  }

  const baseline = compileForAssistant(document)
  const next = compileForAssistant(applied.document)
  const compared = compareCompileDiagnostics(baseline.diagnostics, next.diagnostics)

  if (compared.added.some((item) => item.severity === 'error')) {
    return {
      kind: 'unsupported',
      reasonCode: 'COMPILER_REGRESSION',
      message: compared.added[0]?.message ?? '候选引入了新的编译错误',
    }
  }

  return {
    kind: 'proposal',
    change,
    document: applied.document,
    stepId,
    draftRevision,
    documentDigest: await scenarioDocumentDigest(document),
    reason: '已按你的要求生成受限单步候选，采纳后仍需保存并试跑。',
    diffs: applied.diffs,
    diagnostics: next.diagnostics.map((item) => ({
      code: item.code,
      stepId: item.stepId,
      fieldPath: item.fieldPath,
      message: item.message,
      baseline: compared.leftover.some(
        (left) => left.code === item.code && left.stepId === item.stepId,
      ),
    })),
    executable: next.ok,
  }
}
