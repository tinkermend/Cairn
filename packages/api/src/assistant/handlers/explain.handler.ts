import {
  type AssistantExplanation,
  type AssistantResult,
  type ScenarioDocument,
  type ScenarioAuthoringDocumentV2,
  authoringSteps,
  isAuthoringDocumentV2,
  normalizeAuthoringDocument,
  parseScenarioDocument,
  scenarioFactsForModel,
} from '@cairn/shared'
import { compileScenarioDocument, deriveOutcomeManifest } from '@cairn/authoring'
import { DomainError, getScenario, loadScenarioVersion } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry'
import { buildAuthoringSlice } from '../context-assembler'
import { generateExplanationText } from '../model-session'
import { requireVisibleTarget } from './common'

function requireFlatDocument(document: unknown): ScenarioDocument {
  if (isAuthoringDocumentV2(document)) {
    const authoring = normalizeAuthoringDocument(document)
    return parseScenarioDocument({
      schemaVersion: authoring.schemaVersion,
      inputs: authoring.inputs,
      steps: authoringSteps(authoring),
      ...(authoring.outputs ? { outputs: authoring.outputs } : {}),
      ...(authoring.resolution ? { resolution: authoring.resolution } : {}),
      ...(authoring.locatorPlan ? { locatorPlan: authoring.locatorPlan } : {}),
      ...(authoring.locatorProtocol ? { locatorProtocol: authoring.locatorProtocol } : {}),
    })
  }
  return parseScenarioDocument(document)
}

const MISSING_OUTCOME_CLAIM = /(?:没有|尚未|未|无|缺少|不存在|未配置|未设置)[^。；，]{0,10}(?:成功条件|结果条件|断言)/

function withoutFalseOutcomeClaim(text: string | undefined, hasOutcomes: boolean): string | undefined {
  return hasOutcomes && text && MISSING_OUTCOME_CLAIM.test(text) ? undefined : text
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
  let authoringDocument: ScenarioAuthoringDocumentV2 | null = null
  let versionNote: string | null = null
  if (slots.draftRevision != null) {
    const revision = Number(slots.draftRevision)
    if (!detail.draft || detail.draft.revision !== revision) {
      throw new DomainError('conflict', 'ASSISTANT_DRAFT_STALE', '请基于当前已保存草稿重新解释')
    }
    document = requireFlatDocument(detail.draft.document)
    if (isAuthoringDocumentV2(detail.draft.document)) {
      authoringDocument = normalizeAuthoringDocument(detail.draft.document)
    }
    versionNote = `草稿（修订版本 ${detail.draft.revision}）`
  } else if (typeof slots.versionId === 'string' && slots.versionId) {
    const loaded = await loadScenarioVersion(db, detail.id, slots.versionId)
    document = loaded.version.definition
    if (loaded.version.authoringDocument) {
      authoringDocument = normalizeAuthoringDocument(loaded.version.authoringDocument)
    }
    versionNote = loaded.version.kind === 'published' ? `已发布版本 ${loaded.version.versionNo}` : '试跑版本'
  }

  if (!document) {
    if (detail.draft) {
      document = requireFlatDocument(detail.draft.document)
      if (isAuthoringDocumentV2(detail.draft.document)) {
        authoringDocument = normalizeAuthoringDocument(detail.draft.document)
      }
      versionNote = `草稿（修订版本 ${detail.draft.revision}）`
    } else if (detail.published) {
      document = requireFlatDocument(detail.published.definition)
      if (detail.published.authoringDocument) {
        authoringDocument = normalizeAuthoringDocument(detail.published.authoringDocument)
      }
      versionNote = `已发布版本 ${detail.published.versionNo}`
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

  const stepIds = new Set(workingDoc.steps.map((item) => item.id))
  const outcomeManifest = deriveOutcomeManifest({ authoringDocument, definition: document })
  const outcomes = outcomeManifest?.entries.filter(
    (item) => item.scope === 'scenario' || stepIds.has(item.sourceStepId ?? item.stepId),
  ) ?? []
  const compile = compileScenarioDocument(workingDoc, {
    mode: 'release',
    outcomeManifest: { entries: outcomes },
  })
  const step = stepId ? workingDoc.steps.find((item) => item.id === stepId) : undefined

  let summary = `场景「${detail.name}」共 ${workingDoc.steps.length} 步，绑定目标 ${detail.targetId}。本轮解释的是已保存${versionNote}。`
  if (outcomes.length > 0) {
    const listed = outcomes.slice(0, 3).map((item) => `${item.severity}「${item.meaning}」`).join('、')
    summary += ` 已定义 ${outcomes.length} 个成功条件：${listed}${outcomes.length > 3 ? `等（另有 ${outcomes.length - 3} 个）` : ''}。`
  }
  let stepSummary = step ? `当前步骤「${step.name}」类型为 ${step.type}。` : undefined

  if (session) {
    await onProgress?.('generating', '大模型正在解析场景逻辑...')
    const polished = await generateExplanationText(
      session,
      question,
      {
        ...scenarioFactsForModel(workingDoc, stepId),
        successConditions: outcomes.map((item) => ({
          meaning: item.meaning,
          severity: item.severity,
          scope: item.scope,
          sourceStepId: item.sourceStepId ?? item.stepId,
          ruleKind: item.rule.kind,
          ...(item.rule.kind === 'deterministic' ? { expect: item.rule.expect } : {}),
        })),
      },
      signal,
    )
    const polishedSummary = withoutFalseOutcomeClaim(polished.summary, outcomes.length > 0)
    const polishedStepSummary = withoutFalseOutcomeClaim(polished.stepSummary, outcomes.length > 0)
    if (polishedSummary) summary = `${summary} ${polishedSummary}`.slice(0, 2048)
    if (stepSummary && polishedStepSummary) stepSummary = `${stepSummary} ${polishedStepSummary}`.slice(0, 1024)
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
