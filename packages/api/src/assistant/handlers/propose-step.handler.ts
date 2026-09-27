import {
  type AssistantAuthoringProposal,
  type AssistantProposal,
  type AssistantResult,
  type AssistantStepChange,
  type AuthoringOperation,
  type ScenarioAuthoringDocumentV2,
  type ScenarioDocument,
  type TargetKnowledgeContext,
  applyStepProposal,
  authoringDocumentDigest,
  authoringSteps,
  compareCompileDiagnostics,
  entityIdSchema,
  hasPermission,
  isAuthoringDocumentV2,
  parseScenarioDocument,
  scenarioDocumentDigest,
  scenarioFactsForModel,
  toAuthoringDocumentV2,
} from '@cairn/shared'
import { applyAuthoringOperations, compileForAssistant } from '@cairn/authoring'
import { DomainError, getScenario, getTargetKnowledgeContext, newId } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import { buildAuthoringSlice } from '../context-assembler.js'
import { generateScenarioAuthoringProposal, generateStepChange } from '../model-session.js'
import { requireVisibleTarget } from './common.js'

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

function hasSensitiveLiteral(ops: AuthoringOperation[]): boolean {
  for (const op of ops) {
    if (op.kind === 'insert_step' && op.step.type === 'fill') {
      const val = (op.step.input as any)?.value
      if (typeof val === 'string' && val.length > 0) {
        const nameOrTarget = `${op.step.name} ${(op.step.input as any)?.target ?? ''}`.toLowerCase()
        if (/(password|pwd|secret|token|口令|密码|凭据|验证码)/i.test(nameOrTarget)) {
          return true
        }
      }
    }
    if (op.kind === 'update_step' && op.patch) {
      const val = (op.patch.input as any)?.value
      if (typeof val === 'string' && val.length > 0) {
        return true
      }
    }
  }
  return false
}

function invalidAssetReference(ops: AuthoringOperation[], context?: TargetKnowledgeContext): boolean {
  const known = new Map<string, TargetKnowledgeContext['pages'][number]['views'][number]['elements']>()
  for (const page of context?.pages ?? []) for (const view of page.views) for (const element of view.elements) {
    if (!element.assetRef) continue
    const list = known.get(element.assetRef) ?? []
    list.push(element)
    known.set(element.assetRef, list)
  }
  for (const op of ops) {
    const input = op.kind === 'insert_step' ? op.step.input : op.kind === 'update_step' ? op.patch.input : undefined
    const target = input && typeof input === 'object' ? (input as Record<string, unknown>).target : undefined
    if (!target || typeof target !== 'object') continue
    const descriptor = target as { assetRef?: unknown; candidates?: unknown }
    if (descriptor.assetRef === undefined) continue
    if (typeof descriptor.assetRef !== 'string') return true
    const matches = known.get(descriptor.assetRef) ?? []
    if (!matches.length || !Array.isArray(descriptor.candidates)) return true
    const candidates = descriptor.candidates.filter(candidate => candidate && typeof candidate === 'object')
    if (!matches.some(element => candidates.some(candidate => element.locator.candidates.some(
      observed => observed.by === (candidate as { by?: unknown }).by
        && observed.value === (candidate as { value?: unknown }).value
        && observed.name === (candidate as { name?: unknown }).name,
    )))) return true
  }
  return false
}

function knownColumnAssertion(question: string, context: TargetKnowledgeContext | undefined,
  anchorStepId: string): AuthoringOperation | Extract<AssistantResult, { kind: 'unsupported' }> | null {
  if (!context || !anchorStepId) return null
  const requested = /表格.*?(?:存在|包含|有)\s*[「“"']?([\p{L}][\p{L}\p{N} _-]{0,64}?)\s*[」”"']?\s*列/u.exec(question)?.[1]?.trim()
  if (!requested) return null
  const found = context.pages.flatMap(page => page.views.flatMap(view => view.elements
    .filter(element => element.category === 'table_column' && element.assetRef
      && element.name.toLocaleLowerCase() === requested.toLocaleLowerCase())
    .map(element => ({ page, element }))))
  const normalizedQuestion = question.toLocaleLowerCase()
  const mentionedTitles = context.pages.filter(page =>
    page.title.trim() && normalizedQuestion.includes(page.title.toLocaleLowerCase()))
  const mentionedPaths = context.pages.filter(page => page.menuPath.some(segment =>
    segment.trim() && normalizedQuestion.includes(segment.toLocaleLowerCase())))
  const mentionedPages = mentionedTitles.length ? mentionedTitles : mentionedPaths
  const candidates = mentionedPages.length
    ? found.filter(({ page }) => mentionedPages.includes(page))
    : found
  if (candidates.length !== 1) return {
    kind: 'unsupported',
    reasonCode: candidates.length ? 'MAP_COLUMN_AMBIGUOUS' : 'MAP_COLUMN_NOT_OBSERVED',
    message: candidates.length
      ? `当前知识上下文中「${requested}」列存在多个定位，请明确页面或视图`
      : `当前知识上下文中指定页面没有已观测的「${requested}」列`,
  }
  const column = candidates[0]!.element
  return {
    kind: 'insert_step', id: newId(), anchorStepId,
    step: { id: newId(), name: `确认 ${column.name} 列存在`, type: 'assert', effectType: 'READ_ONLY',
      input: { target: { ...column.locator, assetRef: column.assetRef! }, expect: { kind: 'exists' } } },
  }
}

export async function handleScenarioProposeStep(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantResult> {
  const { actor, slots, question, session, db, targets, platformConfig, signal, onProgress } = ctx
  await onProgress?.('loading_facts', '正在检索并切片草稿上下文...')

  // 权限核验：必须具备 workflow:write 与 target:read 权限
  if (!actor.permissions.includes('workflow:write') || !actor.permissions.includes('target:read')) {
    return {
      kind: 'unsupported',
      reasonCode: 'PERMISSION_DENIED',
      message: '需要场景编写与目标读取权限（workflow:write, target:read）才能生成编排提议',
    }
  }

  const scenarioId = String(slots.scenarioId ?? (ctx.body?.pageContext as any)?.scenarioId ?? '')
  const stepId = slots.stepId ? String(slots.stepId) : ''
  const draftRevision = slots.draftRevision !== undefined && slots.draftRevision !== null
    ? Number(slots.draftRevision)
    : undefined

  if (!scenarioId) {
    throw new DomainError('bad_request', 'MISSING_SLOT', '缺少必需参数 scenarioId')
  }

  // N01: 模糊问句不机械执行，澄清业务目标
  const trimmedQ = question.trim()
  const isVague =
    /^(把|请|帮我)?(这条|这个)?(AI)?(指令|步骤)?(写清楚|优化一下|改好|改好一点|弄好|弄好一点|弄弄好|按前一步|处理一下|完善一下)$/.test(trimmedQ) ||
    trimmedQ === '把这条指令写清楚' ||
    trimmedQ === '写清楚' ||
    trimmedQ === '优化一下' ||
    trimmedQ === '帮我优化一下' ||
    trimmedQ === '帮我把这个步骤弄好一点' ||
    trimmedQ === '帮我把这步改好一点'
  if (isVague) {
    return {
      kind: 'clarify',
      question: '请指明具体的业务目标或需要澄清的动作细节（例如：需要提取哪些字段、断言什么预期、或者执行何种业务操作）：',
      missingFields: ['intent'],
    }
  }

  const detail = await getScenario(db, scenarioId)
  await requireVisibleTarget(actor, detail.targetId, targets, db)
  const targetKnowledge = session && hasPermission(actor.permissions, 'map:read')
    ? await getTargetKnowledgeContext(db, detail.targetId, { intent: question, maxPages: 3 }) : undefined

  if (draftRevision !== undefined && detail.draft && detail.draft.revision !== draftRevision) {
    throw new DomainError('conflict', 'ASSISTANT_DRAFT_STALE', '请基于当前已保存草稿重新生成')
  }

  const rawDoc = (detail as any).authoringDocument ?? detail.draft?.document
  const isV2 = isAuthoringDocumentV2(rawDoc)

  // N02: 步骤名称重名歧义检查
  const v2Doc: ScenarioAuthoringDocumentV2 = isV2 ? rawDoc : toAuthoringDocumentV2(rawDoc)
  const steps = authoringSteps(v2Doc)
  if (!stepId) {
    for (const step of steps) {
      if (question.includes(step.name)) {
        const duplicates = steps.filter((s) => s.name === step.name)
        if (duplicates.length > 1) {
          return {
            kind: 'clarify',
            question: `存在多个同名步骤「${step.name}」，请选择具体要操作的步骤：`,
            missingFields: ['stepId'],
            options: duplicates.map((s, idx) => ({
              id: s.id,
              label: `${s.name}（第 ${idx + 1} 处，ID: ${s.id.slice(0, 8)}）`,
              kind: 'scenario' as const,
            })),
          }
        }
      }
    }
  }

  if (isV2) {
    // V2 结构化编排提议处理
    let rawOps: AuthoringOperation[] = []
    const knownAssertion = knownColumnAssertion(question, targetKnowledge, stepId)

    if (knownAssertion?.kind === 'unsupported') return knownAssertion
    if (knownAssertion) {
      rawOps = [knownAssertion]
    } else if (session) {
      await onProgress?.('generating', '大模型正在生成结构化编排操作...')
      const flatDoc: ScenarioDocument = {
        schemaVersion: 1,
        inputs: v2Doc.inputs,
        steps,
      }
      const generated = typeof (session as any).generateScenarioAuthoringProposal === 'function'
        ? await (session as any).generateScenarioAuthoringProposal(
            question,
            { ...scenarioFactsForModel(flatDoc, stepId || undefined), targetKnowledge },
            signal,
          )
        : await generateScenarioAuthoringProposal(
            session,
            question,
            { ...scenarioFactsForModel(flatDoc, stepId || undefined), targetKnowledge },
            signal,
          )

      if (generated?.output) {
        if (generated.output.kind === 'clarify') {
          return {
            kind: 'clarify',
            question: generated.output.question,
            missingFields: generated.output.missingFields,
          }
        }
        if (generated.output.kind === 'unsupported') {
          return {
            kind: 'unsupported',
            reasonCode: generated.output.reasonCode,
            message: generated.output.message,
          }
        }
        if (generated.output.kind === 'proposal') {
          rawOps = generated.output.operations as any
        }
      } else if (generated?.operations) {
        rawOps = generated.operations
      }
    } else {
      // 规则回退/简单解析（包括纯新增、单步更新、删除、移动）
      if (stepId) {
        const targetStep = steps.find((s) => s.id === stepId)
        if (targetStep) {
          if (targetStep.type.startsWith('ai_')) {
            const instruction = question.replace(/^(把|请|帮我)?(这条|这个)?(AI)?(指令|提取|步骤)?(写成|改成|改为)?/, '').trim() || question
            rawOps.push({
              kind: 'update_step',
              id: newId(),
              stepId,
              patch: { input: { instruction } },
            })
          } else if (targetStep.type === 'fill') {
            const match = /(?:引用|改用|用|填入|绑定)\s*(?:前序|前面|上一步)?(?:提取的|抓取的|产出的)?\s*([a-zA-Z][\w-]*)/.exec(question) ?? /from\s+([a-zA-Z][\w-]*)/.exec(question)
            if (match) {
              rawOps.push({
                kind: 'update_step',
                id: newId(),
                stepId,
                patch: { input: { from: match[1]! } },
              })
            }
          } else if (targetStep.type === 'assert') {
            const text = /(?:改成|显示|包含|看到)[「"“](.+?)[」"”]/.exec(question)?.[1] ?? /改成\s*([^\s]+)/.exec(question)?.[1]
            if (text) {
              rawOps.push({
                kind: 'update_step',
                id: newId(),
                stepId,
                patch: { input: { expect: { kind: 'text_contains', value: text } } },
              })
            }
          }
        }
      } else {
        // 无 stepId 时的模式匹配
        const urlMatch = /(https?:\/\/[^\s"'<>]+)/.exec(question)
        if (urlMatch) {
          rawOps.push({
            kind: 'insert_step',
            id: newId(),
            step: {
              id: newId(),
              name: '打开指定页面',
              type: 'navigate',
              effectType: 'READ_ONLY',
              input: { url: urlMatch[1]! },
            },
          })
        } else if ((question.includes('删') || question.includes('移除') || question.includes('不要')) && question.includes('等待')) {
          const waitStep = steps.find((s) => s.type === 'wait')
          if (waitStep) {
            rawOps.push({
              kind: 'remove_step',
              id: newId(),
              stepId: waitStep.id,
            })
          }
        }
      }
    }

    if (rawOps.length === 0) {
      return {
        kind: 'unsupported',
        reasonCode: 'TASK_UNSUPPORTED',
        message: '未能根据输入生成受限编排操作，请指明具体的步骤操作目标',
      }
    }

    if (invalidAssetReference(rawOps, targetKnowledge)) return {
      kind: 'unsupported', reasonCode: 'MAP_ASSET_UNKNOWN',
      message: '步骤引用的地图资产与已观测定位不一致，请重新选择目标元素。',
    }

    // N08: 敏感凭据/口令明文字面量拦截
    if (hasSensitiveLiteral(rawOps)) {
      return {
        kind: 'unsupported',
        reasonCode: 'TASK_UNSUPPORTED',
        message: '密码或凭据不能以明文字符串字面量填入，请使用受管输入参数或凭据绑定（from/fromField）',
      }
    }

    // ID 映射与持久化保证：映射所有临时 ID 到 UUID
    const idMap = new Map<string, string>()
    const sanitizedOps: AuthoringOperation[] = rawOps.map((op) => {
      const opId = newId()
      if (op.kind === 'insert_step') {
        const rawStepId = op.step.id
        const isUuid = entityIdSchema.safeParse(rawStepId).success
        const realStepId = isUuid ? rawStepId : newId()
        idMap.set(rawStepId, realStepId)
        return {
          ...op,
          id: opId,
          step: {
            ...op.step,
            id: realStepId,
          },
        }
      }
      return {
        ...op,
        id: opId,
        stepId: idMap.get(op.stepId) ?? op.stepId,
        anchorStepId:
          'anchorStepId' in op && op.anchorStepId
            ? idMap.get(op.anchorStepId as string) ?? op.anchorStepId
            : undefined,
      } as AuthoringOperation
    })

    await onProgress?.('validating', '正在验证结构化草稿原子应用与静态预检...')
    const applied = applyAuthoringOperations(v2Doc, sanitizedOps)
    if (!applied.ok) {
      return {
        kind: 'unsupported',
        reasonCode: applied.error.code,
        message: applied.error.message,
      }
    }

    // 静态预检与编译器回归比对
    const baseline = compileForAssistant({
      schemaVersion: 1,
      inputs: (v2Doc.inputs ?? []) as any,
      steps: authoringSteps(v2Doc),
    })
    const next = compileForAssistant({
      schemaVersion: 1,
      inputs: (applied.document.inputs ?? []) as any,
      steps: authoringSteps(applied.document),
    })
    const compared = compareCompileDiagnostics(baseline.diagnostics, next.diagnostics)

    if (compared.added.some((d) => d.severity === 'error')) {
      return {
        kind: 'unsupported',
        reasonCode: 'COMPILER_REGRESSION',
        message: compared.added[0]?.message ?? '候选引入了新的编译错误',
      }
    }

    const baseDigest = await authoringDocumentDigest(v2Doc)
    const candidateDigest = await authoringDocumentDigest(applied.document)

    const authoringProposal: AssistantAuthoringProposal = {
      kind: 'authoring_proposal',
      proposalId: newId(),
      scenarioId: detail.id,
      base: {
        draftRevision: detail.draft?.revision ?? 1,
        documentDigest: baseDigest,
        dependencyFingerprint: `${detail.targetId}:${detail.draft?.revision ?? 1}`,
      },
      operations: sanitizedOps,
      candidateDigest,
      intentCoverage: [
        {
          intentId: 'primary',
          operationIds: sanitizedOps.map((op) => op.id),
        },
      ],
      diffs: applied.diffs,
      diagnostics: next.diagnostics.map((item) => ({
        code: item.code,
        severity: item.severity,
        stepId: item.stepId,
        fieldPath: item.fieldPath,
        message: item.message,
        baseline: compared.leftover.some(
          (left) => left.code === item.code && left.stepId === item.stepId,
        ),
      })),
      executable: next.ok,
      validation: {
        schema: 'passed',
        expansion: 'passed',
        compiler: next.ok ? 'passed' : 'baseline_errors',
      },
    }

    return authoringProposal
  }

  // -------------------------------------------------------------------------
  // 遗留 V1 扁平文档路径（向后兼容保留）
  // -------------------------------------------------------------------------
  if (!stepId) {
    throw new DomainError('bad_request', 'MISSING_SLOT', '缺少必需参数 stepId')
  }

  const document = requireFlatDocument(detail.draft?.document ?? rawDoc)
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
      { ...scenarioFactsForModel(slicedDoc, stepId), targetKnowledge },
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

  const legacyProposal: AssistantProposal = {
    kind: 'proposal',
    change,
    document: applied.document,
    stepId,
    draftRevision: detail.draft?.revision ?? 1,
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

  return legacyProposal
}
