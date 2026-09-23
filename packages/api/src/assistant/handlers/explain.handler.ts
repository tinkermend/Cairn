import {
  type AssistantExplanation,
  type AssistantResult,
  type ScenarioDocument,
  isAuthoringDocumentV2,
  parseScenarioDocument,
  scenarioFactsForModel,
} from '@cairn/shared'
import { compileForAssistant } from '@cairn/authoring'
import { DomainError, getScenario, loadScenarioVersion } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry'
import { buildAuthoringSlice } from '../context-assembler'
import { generateExplanationText } from '../model-session'
import { requireVisibleTarget } from './common'

function requireFlatDocument(document: unknown): ScenarioDocument {
  if (isAuthoringDocumentV2(document)) {
    return parseScenarioDocument({
      schemaVersion: document.schemaVersion,
      inputs: document.inputs,
      steps: document.nodes.flatMap((n) => (n.kind === 'step' ? [n.step] : [])),
    })
  }
  return parseScenarioDocument(document)
}

export async function handleScenarioExplain(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantResult> {
  const { actor, slots, question, session, db, targets, signal, onProgress } = ctx
  await onProgress?.('loading_facts', '正在加载场景定义与草稿...')

  const scenarioId = String(slots.scenarioId ?? '')
  if (!scenarioId) {
    throw new DomainError('bad_request', 'MISSING_SLOT', '缺少必需参数 scenarioId')
  }

  const detail = await getScenario(db, scenarioId)
  await requireVisibleTarget(actor, detail.targetId, targets, db)

  let document: ScenarioDocument | null = null
  if (slots.draftRevision != null) {
    const revision = Number(slots.draftRevision)
    if (!detail.draft || detail.draft.revision !== revision) {
      throw new DomainError('conflict', 'ASSISTANT_DRAFT_STALE', '请基于当前已保存草稿重新解释')
    }
    document = requireFlatDocument(detail.draft.document)
  } else if (typeof slots.versionId === 'string' && slots.versionId) {
    const loaded = await loadScenarioVersion(db, detail.id, slots.versionId)
    document = loaded.version.definition
  }

  if (!document) {
    if (detail.draft) {
      document = requireFlatDocument(detail.draft.document)
    } else if (detail.published) {
      document = requireFlatDocument(detail.published.definition)
    }
  }

  if (!document) {
    return {
      kind: 'clarify',
      question: '请指定要解释的已保存草稿或已发布版本。',
      missingFields: ['definitionRef'],
    }
  }

  // Resolve stepNumber if stepId is not explicitly set (e.g. "解释第三步")
  let stepId = typeof slots.stepId === 'string' ? slots.stepId : undefined
  if (!stepId && slots.stepNumber != null) {
    const num = Number(slots.stepNumber)
    if (num >= 1 && num <= document.steps.length) {
      stepId = document.steps[num - 1]?.id
    }
  }

  // If a stepId is selected, slice by selected node & dependencies (AIF-11 & AIF-16)
  let workingDoc = document
  if (stepId && document.steps.some((s) => s.id === stepId)) {
    const slice = buildAuthoringSlice(document, stepId)
    workingDoc = slice.slicedDocument
  }

  const compile = compileForAssistant(workingDoc)
  const step = stepId ? workingDoc.steps.find((item) => item.id === stepId) : undefined

  const versionNote = detail.draft ? `草稿（修订版本 ${detail.draft.revision}）` : '已发布版本'
  let summary = `场景「${detail.name}」共 ${workingDoc.steps.length} 步，绑定目标 ${detail.targetId}。本轮解释的是已保存${versionNote}。`
  let stepSummary = step ? `当前步骤「${step.name}」类型为 ${step.type}。` : undefined

  if (session) {
    await onProgress?.('generating', '大模型正在解析场景逻辑...')
    const polished = await generateExplanationText(
      session,
      question,
      scenarioFactsForModel(workingDoc, stepId),
      signal,
    )
    if (polished.summary) summary = polished.summary
    if (polished.stepSummary) stepSummary = polished.stepSummary
  }

  return {
    kind: 'explanation',
    summary,
    stepSummary,
    references: workingDoc.steps.flatMap((item) =>
      'from' in item.input && item.input.from ? [`${item.name} 引用 ${item.input.from}`] : [],
    ),
    diagnostics: compile.diagnostics.map((item) => ({
      code: item.code,
      stepId: item.stepId,
      fieldPath: item.fieldPath,
      message: item.message,
      baseline: true,
    })),
    executable: compile.ok,
  }
}
