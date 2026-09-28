import {
  type AssistantResult,
  type ScenarioDocument,
  type ScenarioAuthoringDocumentV2,
  authoringSteps,
  isAuthoringDocumentV2,
  normalizeAuthoringDocument,
  normalizeAssistantPageContext,
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

function asksAboutSelectedStep(question: string): boolean {
  return /(?:这一步|当前步骤|选中步骤|该步骤|这个步骤|上一步|前一步|下一步|后一步|第\s*[一二三四五六七八九十\d]+\s*步)/.test(question)
}

function asksAboutSuccessCriteria(question: string): boolean {
  return /(?:成功条件|成功标准|(?:判断|判定|算|是否).{0,12}成功|验收条件|验收标准|通过条件|通过标准)/.test(question)
}

function asksForStepSequence(question: string): boolean {
  return /(?:按步骤|逐步|每一步|各步骤|步骤顺序|具体步骤|步骤说明)/.test(question)
}

const STEP_ACTION_NAMES: Record<string, string> = {
  navigate: '导航', click: '点击', fill: '填写', assert: '断言',
  wait: '等待', extract: '提取', ai: 'AI 判断',
}

function describeStepSequence(document: ScenarioDocument): string {
  if (document.steps.length === 0) return '当前已保存定义没有步骤，无法按步骤说明。'
  const parts: string[] = []
  let length = 0
  for (const [index, step] of document.steps.entries()) {
    const next = `${index + 1}.「${step.name}」（${STEP_ACTION_NAMES[step.type] ?? step.type}）`
    if (length + next.length > 1300) break
    parts.push(next)
    length += next.length
  }
  const remainder = document.steps.length - parts.length
  return `已保存步骤依次为：${parts.join('；')}${remainder > 0 ? `；另有 ${remainder} 步未在本条展开，请指定步骤范围` : ''}。`
}

function expectationDescription(expect: { kind: string; value?: string | number; op?: string }): string {
  switch (expect.kind) {
    case 'exists': return '目标元素存在'
    case 'visible': return '目标元素可见'
    case 'text_equals': return `文本等于「${expect.value}」`
    case 'text_contains': return `文本包含「${expect.value}」`
    case 'number_compare': return `数值满足 ${expect.op} ${expect.value}`
    case 'aria_snapshot': return '无障碍快照匹配已保存模板'
    default: return '满足已保存的断言规则'
  }
}

function explainAdjacentStep(
  document: ScenarioDocument,
  stepId: string,
  question: string,
): string | undefined {
  if (!/(?:从哪|来源|前一步|上一步|后一步|下一步|删掉|删除|移除)/.test(question)) return undefined
  const index = document.steps.findIndex((item) => item.id === stepId)
  if (index < 0) return undefined
  const step = document.steps[index]!
  const parts = [`当前步骤「${step.name}」类型为 ${step.type}。`]
  const requestedBinding = /(?:用的|使用的|引用的|变量)\s*[`“"']?([A-Za-z][\w-]*)/.exec(question)?.[1]
  const binding = step.type === 'fill' ? step.input.from : undefined
  const inputBinding = binding && document.inputs.some((item) => item.key === binding)
  const upstream = binding && !inputBinding
      ? document.steps.slice(0, index).findLast((item) => {
        const input = item.input as Record<string, unknown>
        return item.outputKey === binding || input.as === binding || input.variable === binding ||
          item.id === binding || item.name === binding
      })
    : undefined
  if (requestedBinding && requestedBinding !== binding) {
    parts.push(`这一步没有引用 ${requestedBinding}${binding ? `，实际引用的是 ${binding}` : ''}。`)
  }
  if (binding) {
    parts.push(inputBinding
      ? `绑定 ${binding} 来自场景输入，不是由紧邻前一步生成。`
      : upstream
        ? `绑定 ${binding} 来自前序步骤「${upstream.name}」。`
        : `已保存定义只显示此步骤引用 ${binding}，没有找到它的已定义来源。`)
  }
  if (/(?:前一步|上一步|删掉|删除|移除)/.test(question)) {
    const previous = document.steps[index - 1]
    if (previous) {
      parts.push(`紧邻前一步是「${previous.name}」（${previous.type}）。`)
      if (/(?:删掉|删除|移除)/.test(question)) {
        parts.push(inputBinding
          ? `删除它不会删除场景输入 ${binding}，但会跳过「${previous.name}」的动作；后续运行是否仍成功需要试跑验证。`
          : upstream?.id === previous.id
            ? `删除它会移除当前步骤所引用的 ${binding} 来源；需要先调整绑定并验证后续步骤。`
            : `删除它会跳过该动作；仅凭已保存定义不能断定后续运行结果，需要试跑验证。`)
      }
    } else {
      parts.push('当前步骤之前没有已保存步骤。')
    }
  }
  if (/(?:后一步|下一步)/.test(question)) {
    const next = document.steps[index + 1]
    parts.push(next ? `紧邻后一步是「${next.name}」（${next.type}）。` : '当前步骤之后没有已保存步骤。')
  }
  return parts.join(' ')
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
  const target = await requireVisibleTarget(actor, detail.targetId, targets, db)

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

  // The UI can have a selected step while the user asks about the whole scenario.
  // Only use the selected-step slice when the question is actually step-focused.
  const stepFocused = Boolean(stepId && asksAboutSelectedStep(question))
  const successQuestion = asksAboutSuccessCriteria(question)
  const sequenceQuestion = asksForStepSequence(question)
  const scenarioWide = !stepFocused && (
    /(?:这个|当前|整个|该|本)场景/.test(question) || successQuestion || sequenceQuestion
  )
  const stepSequenceQuestion = scenarioWide && sequenceQuestion
  let workingDoc = document
  if (!scenarioWide && stepId && document.steps.some((s) => s.id === stepId)) {
    const slice = buildAuthoringSlice(document, stepId)
    workingDoc = slice.slicedDocument
  }

  const outcomeManifest = deriveOutcomeManifest({ authoringDocument, definition: document })
  const outcomes = outcomeManifest?.entries ?? []
  const compile = compileScenarioDocument(document, {
    mode: 'release',
    outcomeManifest: { entries: outcomes },
  })
  const step = !scenarioWide && stepId ? workingDoc.steps.find((item) => item.id === stepId) : undefined

  let summary = `场景「${detail.name}」共 ${document.steps.length} 步，绑定${target?.name ? `目标系统「${target.name}」` : '当前目标系统'}。本轮解释的是已保存${versionNote}。`
  if (outcomes.length > 0 && scenarioWide && successQuestion) {
    summary += ` 已定义 ${outcomes.length} 个成功条件。`
  } else if (outcomes.length > 0) {
    const listed = outcomes.slice(0, 3).map((item) => `${item.severity}「${item.meaning}」`).join('、')
    summary += ` 已定义 ${outcomes.length} 个成功条件：${listed}${outcomes.length > 3 ? `等（另有 ${outcomes.length - 3} 个）` : ''}。`
  }
  let stepSummary = step ? `当前步骤「${step.name}」类型为 ${step.type}。` : undefined
  const groundedAdjacentSummary = stepFocused && stepId ? explainAdjacentStep(document, stepId, question) : undefined
  if (groundedAdjacentSummary) stepSummary = groundedAdjacentSummary

  const unsavedLocalEdit = normalizeAssistantPageContext(ctx.body.pageContext)?.draft?.isDirty === true ||
    /未保存|还没保存|尚未保存|刚改|本地改动/.test(question)
  if (unsavedLocalEdit) {
    summary = `${summary} 我只能看到已保存定义，当前画布里未保存的具体修改没有进入助手事实包，因此不能判断那段修改为什么不行。请先保存草稿后再问，或提供具体步骤设置与报错。`.slice(0, 2048)
  } else if (successQuestion || stepSequenceQuestion) {
    if (stepSequenceQuestion) summary = `${summary} ${describeStepSequence(document)}`.slice(0, 2048)
    if (successQuestion) {
      const relevantOutcomes = stepFocused && stepId
        ? outcomes.filter((item) => (item.sourceStepId ?? item.stepId) === stepId)
        : outcomes
      if (relevantOutcomes.length === 0) {
        const explanation = stepFocused && step
          ? outcomes.length > 0
            ? '这个步骤没有直接关联的成功条件；全场景的条件见上方摘要。'
            : '这个步骤和当前已保存场景均未列出业务成功条件。'
          : '当前已保存定义未列出业务成功条件，无法从这份定义说明明确的通过标准。'
        if (stepFocused && stepSummary) stepSummary = `${stepSummary} ${explanation}`
        else summary = `${summary} ${explanation}`.slice(0, 2048)
      } else {
        const criteria = relevantOutcomes.map((item) => {
          const source = document.steps.find((candidate) => candidate.id === (item.sourceStepId ?? item.stepId))
          const sourceText = source ? `关联步骤「${source.name}」（${STEP_ACTION_NAMES[source.type] ?? source.type}）` : '关联步骤未包含在当前已保存定义中'
          const ruleText = item.rule.kind === 'deterministic'
            ? `检查${expectationDescription(item.rule.expect)}`
            : '按已保存的 AI 判断规则检查'
          const violationText = item.onViolation === 'halt' ? '不满足时中止' : '不满足时继续执行并记录结果'
          return `${item.severity}「${item.meaning}」：${sourceText}，${ruleText}，${violationText}。`
        })
        if (stepFocused && stepSummary) stepSummary = `${stepSummary} ${criteria.join(' ')}`.slice(0, 1024)
        else summary = `${summary} ${criteria.join(' ')}`.slice(0, 2048)
      }
      summary = `${summary} 以上是已保存定义的判断标准，不代表场景已经运行通过。`.slice(0, 2048)
    }
  } else if (session && !groundedAdjacentSummary) {
    await onProgress?.('generating', '大模型正在解析场景逻辑...')
    const polished = await generateExplanationText(
      session,
      question,
      {
        ...scenarioFactsForModel(workingDoc, scenarioWide ? undefined : stepId),
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
    // A question about the selected step should not surface unrelated step warnings.
    diagnostics: compile.diagnostics
      .filter((item) => !groundedAdjacentSummary || !item.stepId || item.stepId === stepId)
      .map((item) => ({
        code: item.code,
        stepId: item.stepId,
        fieldPath: item.fieldPath,
        message: item.message,
        baseline: true,
      })),
    executable: compile.ok,
  }
}
