import {
  type AuthoringDiff,
  type AuthoringOperation,
  type DemonstrationFact,
  type DemonstrationSource,
  type GeneralizationDecisionPatch,
  type GeneralizationRound,
  type OutcomeContract,
  type ScenarioAuthoringDocumentV2,
  type ScenarioInputDecl,
  type ScenarioInputType,
  walkAuthoringNodes,
} from '@cairn/shared'
import { deterministicStepId, expandAuthoringDocument } from './expand.js'
import { applyAuthoringOperations } from './authoring-operations.js'
import { foldRecordingGeneralization } from './recording-generalization.js'

export interface TargetDatasetColumn {
  key: string
  name?: string
  type: string
  sampleValues?: string[]
}

export interface TargetDataset {
  id: string
  name: string
  schema: TargetDatasetColumn[]
}

export interface GenerateQuickActionRoundOptions {
  recordingDraftId: string
  roundId: string
  action: 'relax_timeout' | 'parameterize' | 'expect_outcome' | 'clean_login' | 'clean_misfires'
  targetStepId?: string
  targetSourceId?: string
  source: DemonstrationSource
  currentDocument: ScenarioAuthoringDocumentV2
  targetDatasets?: TargetDataset[]
  targetHasAuth?: boolean
}

export type GenerateQuickActionRoundResult =
  | {
      ok: true
      round: GeneralizationRound
      newCandidateDigest: string
      document: ScenarioAuthoringDocumentV2
    }
  | {
      ok: false
      error: { code: string; message: string }
    }

export function generateQuickActionRound(
  options: GenerateQuickActionRoundOptions,
): GenerateQuickActionRoundResult {
  const {
    recordingDraftId,
    roundId,
    action,
    targetStepId,
    targetSourceId,
    source,
    currentDocument,
    targetDatasets = [],
    targetHasAuth = false,
  } = options

  const allNodes = walkAuthoringNodes(currentDocument).filter((e) => e.node.kind === 'step')
  const factById = new Map<string, DemonstrationFact>(source.facts.map((f) => [f.id, f]))

  // 寻找目标步骤
  let targetNode = allNodes.find((entry) => {
    if (targetStepId && entry.id === targetStepId) return true
    if (targetSourceId && entry.node.kind === 'step' && entry.node.origin?.kind === 'recording') {
      return entry.node.origin.sourceIds?.includes(targetSourceId)
    }
    return false
  })

  let operations: AuthoringOperation[] = []
  let decisionPatches: GeneralizationDecisionPatch[] = []
  let intentText = ''
  let isTargetRedacted = false

  switch (action) {
    case 'relax_timeout': {
      if (!targetNode && allNodes.length > 0) {
        targetNode = allNodes[allNodes.length - 1]
      }
      if (!targetNode || targetNode.node.kind !== 'step') {
        return {
          ok: false,
          error: { code: 'STEP_NOT_FOUND', message: '未找到待放宽超时的步骤' },
        }
      }
      const step = targetNode.node.step
      const prevTimeout = step.policy?.timeoutMs ?? 10000
      const relaxedTimeout = Math.min(prevTimeout * 2, 60000)
      const opId = deterministicStepId(recordingDraftId, roundId, '0')

      operations = [
        {
          kind: 'set_step_policy',
          id: opId,
          stepId: step.id,
          timeoutMs: relaxedTimeout,
        },
      ]
      intentText = `放宽步骤「${step.name}」超时等待至 ${relaxedTimeout}ms`
      break
    }

    case 'parameterize': {
      // 若未指定目标步骤，优先寻找首个含字面量的输入步骤 (fill 或 ai_action input)
      if (!targetNode) {
        targetNode = allNodes.find((entry) => {
          if (entry.node.kind !== 'step') return false
          const s = entry.node.step
          if (s.type === 'fill') {
            const input = s.input as Record<string, unknown> | undefined
            return Boolean(input?.value && !input?.from)
          }
          if (s.type === 'ai_action' && 'operation' in (s.input ?? {}) && (s.input as any).operation === 'input') {
            const input = s.input as Record<string, unknown> | undefined
            return Boolean(input?.value && !input?.from)
          }
          return false
        })
      }
      if (!targetNode || targetNode.node.kind !== 'step') {
        return {
          ok: false,
          error: { code: 'STEP_NOT_FOUND', message: '未找到可参数化的输入步骤' },
        }
      }

      const step = targetNode.node.step
      const stepOrigin = targetNode.node.origin
      const sourceId = stepOrigin?.kind === 'recording' ? stepOrigin.sourceIds?.[0] : undefined
      const sourceFact = sourceId ? factById.get(sourceId) : undefined

      const isRedacted =
        sourceFact?.data?.value?.state === 'redacted' ||
        Boolean((step.input as any)?.sensitive) ||
        step.name.includes('密码') ||
        step.name.toLowerCase().includes('password')

      isTargetRedacted = isRedacted

      let literalValue = String((step.input as any)?.value ?? '')
      if (literalValue === 'undefined' || literalValue === 'null') {
        literalValue = ''
      }

      // 规则 2：限定在当前目标系统的数据集内匹配 sampleValues
      let matchedParamKey = ''
      let matchedParamLabel = ''
      let matchedParamType: ScenarioInputType = 'string'

      if (literalValue) {
        for (const ds of targetDatasets) {
          for (const col of ds.schema) {
            if (col.sampleValues && col.sampleValues.includes(literalValue)) {
              matchedParamKey = col.key
              matchedParamLabel = col.name ?? col.key
              matchedParamType = (col.type === 'number' || col.type === 'boolean' ? col.type : 'string') as ScenarioInputType
              break
            }
          }
          if (matchedParamKey) break
        }
      }

      if (!matchedParamKey) {
        matchedParamKey = isRedacted ? 'password' : `input_${step.id.slice(0, 6)}`
        matchedParamLabel = isRedacted ? '口令 / 密码' : `${step.name} 参数`
      }

      const param: ScenarioInputDecl = {
        key: matchedParamKey,
        label: matchedParamLabel,
        type: matchedParamType,
        required: true,
      }

      const patchId = sourceId ?? step.id
      decisionPatches = [
        {
          id: patchId,
          parameter: param,
        },
      ]
      intentText = `将步骤「${step.name}」参数化为「${matchedParamLabel}」(${matchedParamKey})`
      break
    }

    case 'clean_misfires': {
      // 误触清洗：同一元素短时间重复点击、且中间无页面状态或 DOM 变化
      const duplicateStepIds: string[] = []
      let lastClickSelector = ''
      let lastClickTime = 0

      for (const entry of allNodes) {
        if (entry.node.kind !== 'step') continue
        const step = entry.node.step
        const isClick =
          step.type === 'click' ||
          (step.type === 'ai_action' &&
            'operation' in (step.input ?? {}) &&
            (step.input as any).operation === 'tap')

        if (isClick) {
          const selector =
            step.type === 'click'
              ? JSON.stringify((step.input as any)?.target ?? '')
              : String((step.input as any)?.targetDescription ?? '')
          const stepOrigin = entry.node.origin
          const sId = stepOrigin?.kind === 'recording' ? stepOrigin.sourceIds?.[0] : undefined
          const fact = sId ? factById.get(sId) : undefined
          const factTime = fact?.observedAt ? new Date(fact.observedAt).getTime() : 0

          if (
            selector === lastClickSelector &&
            factTime > 0 &&
            lastClickTime > 0 &&
            factTime - lastClickTime < 1000
          ) {
            duplicateStepIds.push(step.id)
          } else {
            lastClickSelector = selector
            lastClickTime = factTime
          }
        } else {
          lastClickSelector = ''
          lastClickTime = 0
        }
      }

      if (duplicateStepIds.length === 0) {
        return {
          ok: false,
          error: { code: 'NO_MISFIRES_FOUND', message: '未检测到同一元素短时间内重复点击的误触动作' },
        }
      }

      operations = duplicateStepIds.map((stepId, idx) => ({
        kind: 'remove_step',
        id: deterministicStepId(recordingDraftId, roundId, String(idx)),
        stepId,
      }))
      intentText = `清洗 ${duplicateStepIds.length} 处同一元素连续点击的误触动作`
      break
    }

    case 'clean_login': {
      if (!targetHasAuth) {
        return {
          ok: false,
          error: {
            code: 'AUTH_NOT_CONFIGURED',
            message: '目标系统未配置受管认证，不建议剔除录制中的登录步骤',
          },
        }
      }

      // 检测开头的登录步骤
      const loginStepIds: string[] = []
      let foundSubmit = false

      for (const entry of allNodes) {
        if (entry.node.kind !== 'step') continue
        const step = entry.node.step
        const stepOrigin = entry.node.origin
        const sId = stepOrigin?.kind === 'recording' ? stepOrigin.sourceIds?.[0] : undefined
        const fact = sId ? factById.get(sId) : undefined
        const url = fact?.data?.url ?? ''

        const isLoginPage = /login|signin|auth/i.test(url)
        const isLoginName = /登录|登入|login|signin/i.test(step.name)
        const isPasswordInput =
          step.type === 'fill' &&
          (Boolean((step.input as any)?.sensitive) ||
            /password|pwd|密码/i.test(step.name) ||
            fact?.data?.value?.state === 'redacted')

        if (isLoginPage || isLoginName || isPasswordInput) {
          loginStepIds.push(step.id)
          if (step.type === 'click' && /登录|登入|确定|submit/i.test(step.name)) {
            foundSubmit = true
            break
          }
        } else {
          // 如果遇到了业务操作且尚未判定为登录流，则停止
          if (loginStepIds.length > 0 && foundSubmit) {
            break
          }
          if (loginStepIds.length === 0) {
            break
          }
        }
      }

      if (loginStepIds.length === 0) {
        return {
          ok: false,
          error: { code: 'NO_LOGIN_STEPS_FOUND', message: '未在录制开头检测到明显的登录流程' },
        }
      }

      operations = loginStepIds.map((stepId, idx) => ({
        kind: 'remove_step',
        id: deterministicStepId(recordingDraftId, roundId, String(idx)),
        stepId,
      }))
      intentText = '剔除开头的登录片段（认证由受管会话复用，不在场景内重复登录）'
      break
    }

    case 'expect_outcome': {
      if (!targetNode && allNodes.length > 0) {
        targetNode = allNodes[allNodes.length - 1]
      }
      if (!targetNode || targetNode.node.kind !== 'step') {
        return {
          ok: false,
          error: { code: 'STEP_NOT_FOUND', message: '未找到添加成功条件的目标步骤' },
        }
      }

      const step = targetNode.node.step
      const stepOrigin = targetNode.node.origin
      const sourceId = stepOrigin?.kind === 'recording' ? stepOrigin.sourceIds?.[0] : undefined
      const sourceFact = sourceId ? factById.get(sourceId) : undefined

      const afterUrl = sourceFact?.after?.url ?? sourceFact?.data?.url
      let outcomeMeaning = `确认「${step.name}」执行成功`
      let outcomeRule: OutcomeContract['rule'] = {
        kind: 'ai',
        instruction: `确认步骤「${step.name}」已完成，页面呈现预期结果`,
      }

      if (afterUrl && typeof afterUrl === 'string' && afterUrl.startsWith('http')) {
        let path = afterUrl
        try {
          path = new URL(afterUrl).pathname
        } catch {
          // fallback to raw afterUrl
        }
        outcomeMeaning = `确认页面位于「${path}」`
        outcomeRule = {
          kind: 'deterministic',
          expect: {
            kind: 'visible',
          },
        }
      }

      const opId = deterministicStepId(recordingDraftId, roundId, '0')
      operations = [
        {
          kind: 'add_outcome',
          id: opId,
          stepId: step.id,
          meaning: outcomeMeaning,
          rule: outcomeRule,
          severity: 'SHOULD',
          onViolation: 'continue',
        },
      ]
      intentText = `为步骤「${step.name}」添加成功条件：${outcomeMeaning}`
      break
    }
  }

  // 纯函数试跑检验：将新生成的轮次折叠进候选文档并计算 Diffs 和 Diagnostics
  const testRound: GeneralizationRound = {
    roundId,
    source: 'rule',
    intent: intentText,
    decisionPatches,
    operations,
    intentCoverage: [],
    diffs: [],
    diagnostics: [],
    status: 'accepted',
    createdAt: new Date().toISOString(),
  }

  // 提取原始来源决策并折叠
  const foldRes = foldRecordingGeneralization({
    source,
    recordingDraftId,
    baseDecisions: [],
    rounds: [testRound],
  })

  if (!foldRes.ok) {
    return {
      ok: false,
      error: { code: foldRes.error.code, message: foldRes.error.message },
    }
  }

  // 运行展开与编译以产生 Diagnostics
  const expansion = expandAuthoringDocument(foldRes.document, {
    targetId: 'preview',
    mode: 'preview',
    loadedModules: new Map(),
  })

  // 计算 diffs
  let diffs: AuthoringDiff[] = []
  if (operations.length > 0) {
    const opRes = applyAuthoringOperations(currentDocument, operations, {
      maxOperations: 50,
      maxInserts: 50,
      allowPolicyUpdate: true,
    })
    if (opRes.ok) {
      diffs = opRes.diffs
    }
  } else if (decisionPatches.length > 0) {
    for (const patch of decisionPatches) {
      if (patch.parameter && targetNode && targetNode.node.kind === 'step') {
        diffs.push({
          type: 'modify',
          stepId: targetNode.node.step.id,
          stepName: targetNode.node.step.name,
          stepType: targetNode.node.step.type,
          fieldPath: ['input', 'from'],
          from: (targetNode.node.step.input as any)?.value,
          to: patch.parameter.key,
          sensitive: isTargetRedacted,
        })
      }
    }
  }

  const finalizedRound: GeneralizationRound = {
    roundId,
    source: 'rule',
    intent: intentText,
    decisionPatches,
    operations,
    intentCoverage: [
      {
        intentId: 'intent-rule-1',
        operationIds: operations.map((o) => o.id),
      },
    ],
    diffs,
    diagnostics: expansion.diagnostics,
    status: 'proposed',
    createdAt: new Date().toISOString(),
  }

  return {
    ok: true,
    round: finalizedRound,
    newCandidateDigest: foldRes.candidateDigest,
    document: foldRes.document,
  }
}

export interface InterpretGeneralizationIntentOptions {
  intent: string
  recordingDraftId: string
  roundId: string
  targetStepId?: string
  targetSourceId?: string
  source: DemonstrationSource
  currentDocument: ScenarioAuthoringDocumentV2
  targetDatasets?: TargetDataset[]
  targetHasAuth?: boolean
}

export function interpretGeneralizationIntent(
  options: InterpretGeneralizationIntentOptions,
): GenerateQuickActionRoundResult {
  const rawIntent = options.intent.trim()

  // 1. 负例 1: 指代不明 / 模糊问句 (§13 负例 1)
  const vaguePatterns = [
    /^(写清楚|写清楚一点|弄好它|优化一下|修改一下|搞定它|搞一下|改好|弄好|完善一下)$/,
    /^(调整一下|处理一下|优化|改一下)$/,
  ]
  if (rawIntent.length < 3 || vaguePatterns.some((p) => p.test(rawIntent))) {
    return {
      ok: false,
      error: {
        code: 'CLARIFICATION_NEEDED',
        message: '意图过于模糊，请说明具体是调整步骤超时、在此取数、改为参数还是挂载期望结果',
      },
    }
  }

  // 2. 负例 2: 页面列表循环 / 页面驱动 (§13 负例 2 & §3.3)
  const pageLoopPatterns = [
    /对.*(每个|每一个|所有).*点/,
    /遍历.*(列表|表格|数据)/,
    /对页面上(每个|每一个|所有)/,
    /每条数据都/,
    /批量处理页面/,
  ]
  if (pageLoopPatterns.some((p) => p.test(rawIntent))) {
    return {
      ok: false,
      error: {
        code: 'PAGE_LOOP_UNSUPPORTED',
        message: '一期暂不支持页面列表循环（for_each），属于二期规划。若数据来自外部表格，请使用数据集参数化并由批量任务按行驱动执行',
      },
    }
  }

  // 3. 负例 3: 明文口令字面量 (§13 负例 3 & §6 D类)
  const sensitiveLiteralPatterns = [
    /(密码|口令).*(改成|设为|填入|输入|是)\s*[a-zA-Z0-9_\-@#!$%^&*]{3,}/,
    /写死(密码|口令)/,
  ]
  if (sensitiveLiteralPatterns.some((p) => p.test(rawIntent))) {
    return {
      ok: false,
      error: {
        code: 'SENSITIVE_LITERAL_FORBIDDEN',
        message: '禁止在泛化意图中写入明文密码或口令字面量。涉及凭据输入时必须使用敏感参数化绑定',
      },
    }
  }

  // 4. 负例 4: 步骤重排 (§13 负例 4 & §5)
  const reorderPatterns = [
    /(移到|换到|挪到).*(前面|后面)/,
    /交换.*顺序/,
    /先.*再.*/,
    /重排步骤/,
    /调换.*顺序/,
  ]
  if (reorderPatterns.some((p) => p.test(rawIntent))) {
    return {
      ok: false,
      error: {
        code: 'REORDERING_NOT_SUPPORTED',
        message: '录制顺序即业务操作顺序，一期不对泛化开放重排（move_step），建议在 Studio 调整或重新录制',
      },
    }
  }

  // 5. 负例 5: 控制分支结构 (§13 负例 5 & §3.2)
  const controlFlowPatterns = [
    /如果.*就.*/,
    /若.*则.*/,
    /条件分支/,
    /否则跳到/,
  ]
  if (controlFlowPatterns.some((p) => p.test(rawIntent))) {
    return {
      ok: false,
      error: {
        code: 'CONTROL_FLOW_UNSUPPORTED',
        message: '一期暂不支持条件分支（if/else）控制流修改，请在 Studio 进行高级编排',
      },
    }
  }

  // 正例匹配与快捷动作映射 (§6)
  // S1 / A: 调参放宽超时
  if (/多等|等待|超时|慢一点|慢/.test(rawIntent)) {
    return generateQuickActionRound({
      ...options,
      action: 'relax_timeout',
    })
  }

  // S2 / D: 参数化
  if (/参数|变量|批量跑/.test(rawIntent)) {
    return generateQuickActionRound({
      ...options,
      action: 'parameterize',
    })
  }

  // S3 / E: 成功条件与期望结果
  if (/应该看到|期望出现|成功提示|看到|期望结果/.test(rawIntent)) {
    return generateQuickActionRound({
      ...options,
      action: 'expect_outcome',
    })
  }

  // B: 锚点取数
  if (/取出来|提取|取数|获取.*数量/.test(rawIntent)) {
    return generateQuickActionRound({
      ...options,
      action: 'extract',
    })
  }

  // 清洗登录
  if (/登录|认证|登入/.test(rawIntent)) {
    return generateQuickActionRound({
      ...options,
      action: 'clean_login',
    })
  }

  // 清洗误触
  if (/误触|空转|重复点击/.test(rawIntent)) {
    return generateQuickActionRound({
      ...options,
      action: 'clean_misfires',
    })
  }

  return {
    ok: false,
    error: {
      code: 'MODEL_NOT_CONFIGURED',
      message: '平台尚未配置大语言模型，未识别的复杂自然语言泛化暂不可用',
    },
  }
}
