import {
  type AssistantCitationKey,
  type AssistantFact,
  type AssistantNextAction,
  type AssistantQuoteContext,
  type ScenarioDocument,
  type RunObservation,
  type DiagnosticFocus,
  type MissingInfoReason,
  citationKey,
  isSensitiveFillInput,
  stepRunMapByStep,
  stepRunsOf,
  SENSITIVE_FILL_HINT,
  canonicalJson,
} from '@cairn/shared'
import { DomainError, loadRunObservation, type DbHandle } from '@cairn/db'

export type ScenarioStep = ScenarioDocument['steps'][number]

export interface DiagnoseFactPack {
  text: string
  facts: AssistantFact[]
  citations: AssistantCitationKey[]
  focus?: DiagnosticFocus
  missingInformation: string[]
  missingReasons?: Array<{ reason: MissingInfoReason; detail: string }>
  nextActions: AssistantNextAction[]
  truncated: boolean
}

export interface AuthoringSliceResult {
  slicedDocument: ScenarioDocument
  targetStep: ScenarioStep
  upstreamStepIds: string[]
  redactedFieldCount: number
  characterCount: number
}

export interface RunCompareFactPack {
  summary: string
  comparability?: {
    comparable: boolean
    incomparableFactors: string[]
    alignmentBasis?: string
  }
  differences: Array<{
    dimension?: 'definition' | 'input' | 'environment' | 'execution'
    stepId?: string
    stepName: string
    baseStatus?: string
    targetStatus?: string
    durationDiffMs?: number
    errorDiff?: string
    detail?: string
  }>
  facts: AssistantFact[]
  missingInformation?: string[]
  nextActions: AssistantNextAction[]
}

const MAX_DIAGNOSE_FACT_CHARS = 12_000
const MAX_AUTHORING_CONTEXT_CHARS = 200_000 // AIF-17 hard limit

/**
 * AIF-10: Assemble diagnose context while preserving critical failure chains.
 * First failed step and subsequent cascading errors must remain intact;
 * earlier successful steps are folded first if limits are exceeded.
 */
export async function assembleDiagnoseContext(
  db: DbHandle,
  runId: string,
  options: { stepId?: string; focus?: DiagnosticFocus | string; quote?: AssistantQuoteContext },
  actorId: string,
): Promise<{ observation: RunObservation; pack: DiagnoseFactPack }> {
  const observation = await loadRunObservation(db, runId, actorId)
  if (!observation) {
    throw new DomainError('not_found', 'RUN_NOT_FOUND', '运行不存在')
  }

  const run = observation.run
  const facts: AssistantFact[] = []
  const citations: AssistantCitationKey[] = [citationKey('run', run.id)]
  const missingInformation: string[] = []
  const missingReasons: Array<{ reason: MissingInfoReason; detail: string }> = []

  const add = (id: string, text: string, keys: AssistantCitationKey[], isFailureChain = false) => {
    facts.push({ id, text, citations: keys, isFailureChain } as AssistantFact & { isFailureChain?: boolean })
    citations.push(...keys)
  }

  if (options.quote) {
    add(
      'focused_quote',
      `[用户显式引用的焦点对象]\n- 类型: ${options.quote.type}\n- 目标ID: ${options.quote.targetId}\n- 标题: ${options.quote.title}\n- 提取摘要: ${options.quote.summary}`,
      [citationKey('run', run.id)],
      true,
    )
  }

  const effectiveFocus = (options.focus as DiagnosticFocus) || 'overview'

  add('status', `运行状态为 ${run.status}，证据轴为 ${run.evidenceStatus}。`, [citationKey('run', run.id)])
  add(
    'placement',
    `调度位置为 ${run.placement.state}${run.placement.sessionStatus ? `，会话 ${run.placement.sessionStatus}` : ''}。`,
    [citationKey('run', run.id)],
  )

  if (run.status === 'WAITING_FOR_AUTH') {
    add('auth', '运行正在等待目标系统认证，不是步骤失败。', [citationKey('run', run.id)])
  }

  // Focus-specific fact enrichment (B1)
  if (effectiveFocus === 'wait') {
    add(
      'focus_wait',
      `【等待聚焦】运行处于状态 ${run.status}，调度阶段为 ${run.placement.state}，会话租约状态为 ${run.placement.sessionStatus ?? '未分配'}。若处于等待态，应排查调度队列或双租约等待，而非步骤业务执行报错。`,
      [citationKey('run', run.id)],
      true,
    )
  } else if (effectiveFocus === 'duration') {
    if (run.startedAt && run.finishedAt) {
      const totalMs = Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt))
      add('focus_duration', `【耗时聚焦】运行总执行耗时为 ${totalMs} 毫秒。`, [citationKey('run', run.id)], true)
    }
  } else if (effectiveFocus === 'outcome') {
    add(
      'focus_outcome',
      `【业务结果聚焦】运行最终状态为 ${run.status}，证据轴完整度为 ${run.evidenceStatus}。需分别评估业务断言契约与执行过程。`,
      [citationKey('run', run.id)],
      true,
    )
  } else if (effectiveFocus === 'evidence_missing') {
    add(
      'focus_evidence',
      `【证据缺失聚焦】当前已持久化证据 ${observation.evidence.items.length} 项，证据状态为 ${run.evidenceStatus}。注意：缺少证据不能宣称完整交付，但补证不得等同于盲目重跑带副作用的业务步骤。`,
      [citationKey('run', run.id)],
      true,
    )
  }

  const effectiveStepId =
    options.stepId ||
    (options.quote?.type === 'step_failure' || options.quote?.type === 'scenario_step'
      ? options.quote.targetId
      : undefined)

  const byStep = effectiveStepId ? stepRunsOf(run.stepRuns, effectiveStepId) : []
  const targetSteps = effectiveStepId
    ? (byStep.length > 0 ? byStep : run.stepRuns.filter((item) => item.id === effectiveStepId))
    : run.stepRuns

  if (effectiveStepId && targetSteps.length === 0) {
    missingInformation.push('指定步骤不在该 Run 的 Snapshot 中')
    missingReasons.push({ reason: 'missing', detail: `指定步骤「${effectiveStepId}」不在该 Run 的快照中` })
  }

  let seenFirstFailure = false

  for (const step of targetSteps) {
    const stepCite = citationKey('step', step.stepId)
    const lastAttempt = step.attempts.at(-1)
    const isStepFailed = step.status === 'FAILED' || Boolean(lastAttempt?.error)

    if (isStepFailed) {
      seenFirstFailure = true
    }

    const inFailureChain = seenFirstFailure

    const failedThenOk =
      step.attempts.some((item) => item.status === 'FAILED') && step.status === 'SUCCEEDED'
    if (failedThenOk) {
      add(
        `step-${step.id}-retry`,
        `步骤「${step.name}」曾有失败 Attempt，后续尝试成功，不能据此把整个运行判为失败。`,
        [stepCite, citationKey('stepRun', step.id)],
        inFailureChain,
      )
    }

    if (lastAttempt?.error) {
      add(
        `step-${step.id}-error`,
        `步骤「${step.name}」最近错误：${lastAttempt.error.code}。`,
        [stepCite, citationKey('attempt', lastAttempt.id)],
        true, // critical failure chain
      )
    }

    if (step.startedAt && step.finishedAt) {
      const ms = Date.parse(step.finishedAt) - Date.parse(step.startedAt)
      if (Number.isFinite(ms)) {
        add(
          `step-${step.id}-time`,
          `步骤「${step.name}」耗时 ${Math.max(0, ms)} 毫秒。`,
          [stepCite, citationKey('stepRun', step.id)],
          inFailureChain || effectiveFocus === 'duration',
        )
      }
    }
  }

  if (run.evidenceStatus !== 'COMPLETE') {
    missingInformation.push('证据不完整，不能把补证据等同于重跑业务操作')
    missingReasons.push({ reason: 'incomplete', detail: '运行证据轴不完整，缺少部分审计事实或关键证据' })
  }

  // Check truncation
  let totalLength = facts.reduce((sum, f) => sum + f.text.length, 0)
  let truncated = false
  let keptFacts = facts

  if (totalLength > MAX_DIAGNOSE_FACT_CHARS) {
    truncated = true
    // AIF-10: Critical failure chain must be preserved!
    // Separate failure chain facts from earlier successful steps.
    const failureFacts = facts.filter((f) => (f as { isFailureChain?: boolean }).isFailureChain)
    const nonFailureFacts = facts.filter((f) => !(f as { isFailureChain?: boolean }).isFailureChain)

    let remainingBudget = MAX_DIAGNOSE_FACT_CHARS - failureFacts.reduce((sum, f) => sum + f.text.length, 0)
    const keptNonFailure: AssistantFact[] = []

    for (const f of nonFailureFacts) {
      if (f.text.length <= remainingBudget) {
        keptNonFailure.push(f)
        remainingBudget -= f.text.length
      } else {
        break
      }
    }

    keptFacts = [...keptNonFailure, ...failureFacts]
    missingInformation.push('事实包已折叠前序成功步骤，完整保留关键失败链')
    missingReasons.push({ reason: 'truncated', detail: '事实包因超过上限已折叠前序成功步骤，完整保留关键失败链' })
  }

  const nextActions: AssistantNextAction[] = [
    {
      kind: 'run.detail',
      label: '打开运行详情',
      href: `/runs/${run.id}`,
      citations: [citationKey('run', run.id)],
    },
  ]

  if (observation.evidence.items.length > 0) {
    nextActions.push({
      kind: 'run.evidence',
      label: '查看运行证据',
      href: `/runs/${run.id}`,
      citations: [citationKey('run', run.id)],
    })
  }

  const pack: DiagnoseFactPack = {
    text: keptFacts.map((f) => f.text).join('\n'),
    facts: keptFacts.map(({ id, text, citations }) => ({ id, text, citations })),
    citations: Array.from(new Set(keptFacts.flatMap((f) => f.citations))),
    focus: effectiveFocus,
    missingInformation,
    missingReasons: missingReasons.length > 0 ? missingReasons : undefined,
    nextActions,
    truncated,
  }

  return { observation, pack }
}

/**
 * AIF-11, AIF-16, AIF-17: Build authoring slice with dependency extraction,
 * field-level redaction, and proactive hard limit check.
 */
export function buildAuthoringSlice(
  document: ScenarioDocument,
  targetStepId: string,
  hardLimitChars: number = MAX_AUTHORING_CONTEXT_CHARS,
): AuthoringSliceResult {
  const steps = document.steps
  const targetIndex = steps.findIndex((s) => s.id === targetStepId)
  if (targetIndex === -1) {
    throw new DomainError('bad_request', 'STEP_NOT_FOUND', `指定步骤不存在于草稿中: ${targetStepId}`)
  }

  const targetStep = steps[targetIndex]!

  // Trace upstream dependencies
  const upstreamIds = new Set<string>()
  const queue: string[] = []

  // Check direct inputs of target step
  function scanStepDependencies(step: ScenarioStep) {
    const inputStr = JSON.stringify(step.input)
    // Find all 'from' bindings or step references
    const matches = inputStr.matchAll(/"from"\s*:\s*"([a-zA-Z0-9_-]+)"/g)
    for (const match of matches) {
      const referenced = match[1]!
      // Find step with id, name, or output variable matching referenced
      const found = steps.find(
        (s) =>
          s.id === referenced ||
          s.name === referenced ||
          (s.input as Record<string, unknown>)?.variable === referenced ||
          (s.input as Record<string, unknown>)?.as === referenced,
      )
      if (found && found.id !== step.id && !upstreamIds.has(found.id)) {
        upstreamIds.add(found.id)
        queue.push(found.id)
      }
    }
  }

  scanStepDependencies(targetStep)
  while (queue.length > 0) {
    const nextId = queue.shift()!
    const step = steps.find((s) => s.id === nextId)
    if (step) {
      scanStepDependencies(step)
    }
  }

  // Filter steps: only upstream dependencies + target step (AIF-11)
  const slicedSteps = steps.filter((s) => s.id === targetStepId || upstreamIds.has(s.id))

  // Field-level redaction (AIF-16)
  let redactedFieldCount = 0
  const redactedSteps: ScenarioStep[] = slicedSteps.map((step) => {
    if (step.type === 'fill') {
      const fillInput = step.input as Record<string, unknown>
      const isSensitive =
        isSensitiveFillInput(step.input) ||
        Boolean(fillInput.sensitive) ||
        SENSITIVE_FILL_HINT.test(JSON.stringify(fillInput.target ?? ''))

      if (isSensitive) {
        redactedFieldCount++
        return {
          ...step,
          input: {
            ...fillInput,
            value: '[REDACTED]',
          } as any,
        }
      }
    }
    return step
  })

  const slicedDocument: ScenarioDocument = {
    ...document,
    steps: redactedSteps,
  }

  const jsonStr = canonicalJson(slicedDocument)
  const characterCount = jsonStr.length

  // AIF-17: Proactive hard limit pre-check
  if (characterCount > hardLimitChars) {
    throw new DomainError(
      'bad_request',
      'CONTEXT_HARD_LIMIT_EXCEEDED',
      `草稿上下文切片(${characterCount}字符)超过大模型硬限制(${hardLimitChars}字符)，请收窄选择范围。`,
    )
  }

  return {
    slicedDocument,
    targetStep,
    upstreamStepIds: Array.from(upstreamIds),
    redactedFieldCount,
    characterCount,
  }
}

/**
 * AIF-03: Assemble context for run comparison.
 */
export async function assembleRunCompareContext(
  db: DbHandle,
  baseRunId: string,
  targetRunId: string,
  actorId: string,
): Promise<{
  baseObservation: RunObservation
  targetObservation: RunObservation
  pack: RunCompareFactPack
}> {
  const [baseObservation, targetObservation] = await Promise.all([
    loadRunObservation(db, baseRunId, actorId),
    loadRunObservation(db, targetRunId, actorId),
  ])

  if (!baseObservation) {
    throw new DomainError('not_found', 'BASE_RUN_NOT_FOUND', `基准运行不存在: ${baseRunId}`)
  }
  if (!targetObservation) {
    throw new DomainError('not_found', 'TARGET_RUN_NOT_FOUND', `对比运行不存在: ${targetRunId}`)
  }

  const incomparableFactors: string[] = []
  if (baseObservation.run.scenarioId !== targetObservation.run.scenarioId) {
    incomparableFactors.push('SCENARIO_MISMATCH: 两次运行来自不同场景，步骤定义与语义基线不一致')
  }
  if (baseObservation.run.targetId !== targetObservation.run.targetId) {
    incomparableFactors.push('TARGET_MISMATCH: 两次运行针对不同目标系统，页面基线与运行环境不一致')
  }
  if (
    baseObservation.run.targetAccountId &&
    targetObservation.run.targetAccountId &&
    baseObservation.run.targetAccountId !== targetObservation.run.targetAccountId
  ) {
    incomparableFactors.push('ACCOUNT_DIFFERENCE: 两次运行使用了不同的目标账号')
  }
  if (baseObservation.run.scenarioVersionId !== targetObservation.run.scenarioVersionId) {
    incomparableFactors.push('VERSION_DIFFERENCE: 两次运行使用了不同的场景版本')
  }

  const comparable = !incomparableFactors.some(
    (f) => f.startsWith('SCENARIO_MISMATCH') || f.startsWith('TARGET_MISMATCH'),
  )
  const alignmentBasis = comparable
    ? incomparableFactors.length === 0
      ? 'identical_configuration'
      : 'compatible_configuration'
    : 'incomparable'

  const baseSteps = stepRunMapByStep(baseObservation.run.stepRuns)
  const targetSteps = stepRunMapByStep(targetObservation.run.stepRuns)

  const allStepIds = Array.from(new Set([...baseSteps.keys(), ...targetSteps.keys()]))
  const differences: RunCompareFactPack['differences'] = []
  const facts: AssistantFact[] = []

  const baseCite = citationKey('run', baseRunId)
  const targetCite = citationKey('run', targetRunId)

  facts.push({
    id: 'base-overview',
    text: `基准运行 ${baseRunId} 状态为 ${baseObservation.run.status}，包含 ${baseObservation.run.stepRuns.length} 步。`,
    citations: [baseCite],
  })
  facts.push({
    id: 'target-overview',
    text: `对比运行 ${targetRunId} 状态为 ${targetObservation.run.status}，包含 ${targetObservation.run.stepRuns.length} 步。`,
    citations: [targetCite],
  })

  if (!comparable) {
    facts.push({
      id: 'comparability-warning',
      text: `【可比性警告】两次运行不可强行对比：${incomparableFactors.join('；')}。不可强断言模型或步骤缺陷。`,
      citations: [baseCite, targetCite],
    })
  }

  // Definition & Environment dimensional diffs (B1)
  if (baseObservation.run.scenarioVersionId !== targetObservation.run.scenarioVersionId) {
    differences.push({
      dimension: 'definition',
      stepName: '场景版本',
      detail: `基准版本 ${baseObservation.run.scenarioVersionId ?? '草稿'} vs 对比版本 ${targetObservation.run.scenarioVersionId ?? '草稿'}`,
    })
  }
  if (
    baseObservation.run.targetAccountId &&
    targetObservation.run.targetAccountId &&
    baseObservation.run.targetAccountId !== targetObservation.run.targetAccountId
  ) {
    differences.push({
      dimension: 'environment',
      stepName: '执行账号',
      detail: `基准账号 ${baseObservation.run.targetAccountId} vs 对比账号 ${targetObservation.run.targetAccountId}`,
    })
  }

  for (const stepId of allStepIds) {
    const baseStep = baseSteps.get(stepId)
    const targetStep = targetSteps.get(stepId)
    const stepName = baseStep?.name ?? targetStep?.name ?? stepId

    const baseStatus = baseStep?.status
    const targetStatus = targetStep?.status

    const baseDuration =
      baseStep?.startedAt && baseStep?.finishedAt
        ? Date.parse(baseStep.finishedAt) - Date.parse(baseStep.startedAt)
        : undefined
    const targetDuration =
      targetStep?.startedAt && targetStep?.finishedAt
        ? Date.parse(targetStep.finishedAt) - Date.parse(targetStep.startedAt)
        : undefined

    const durationDiffMs =
      baseDuration !== undefined && targetDuration !== undefined
        ? targetDuration - baseDuration
        : undefined

    const baseError = baseStep?.attempts.at(-1)?.error?.code
    const targetError = targetStep?.attempts.at(-1)?.error?.code
    const errorDiff =
      baseError !== targetError
        ? `基准错误: ${baseError ?? '无'}, 对比错误: ${targetError ?? '无'}`
        : undefined

    if (baseStatus !== targetStatus || errorDiff || (durationDiffMs !== undefined && Math.abs(durationDiffMs) > 1000)) {
      differences.push({
        dimension: 'execution',
        stepId,
        stepName,
        baseStatus,
        targetStatus,
        durationDiffMs,
        errorDiff,
      })

      facts.push({
        id: `diff-${stepId}`,
        text: `步骤「${stepName}」状态由 ${baseStatus ?? '未执行'} 变为 ${targetStatus ?? '未执行'}${
          durationDiffMs ? `，耗时变动 ${durationDiffMs > 0 ? '+' : ''}${durationDiffMs}ms` : ''
        }${errorDiff ? `（${errorDiff}）` : ''}。`,
        citations: [baseCite, targetCite],
      })
    }
  }

  const summary = `基准运行 ${baseObservation.run.status} vs 对比运行 ${targetObservation.run.status}，共检测到 ${differences.length} 处步骤与配置差异。${
    !comparable ? '（注意：两次运行存在关键不可比因素）' : ''
  }`

  const missingInformation: string[] = []
  if (!comparable) {
    missingInformation.push(`运行对比存在不可比因素：${incomparableFactors.join('；')}`)
  }

  const nextActions: AssistantNextAction[] = [
    {
      kind: 'run.detail',
      label: '查看基准运行',
      href: `/runs/${baseRunId}`,
      citations: [baseCite],
    },
    {
      kind: 'run.detail',
      label: '查看对比运行',
      href: `/runs/${targetRunId}`,
      citations: [targetCite],
    },
  ]

  return {
    baseObservation,
    targetObservation,
    pack: {
      summary,
      comparability: {
        comparable,
        incomparableFactors,
        alignmentBasis,
      },
      differences,
      facts,
      missingInformation: missingInformation.length > 0 ? missingInformation : undefined,
      nextActions,
    },
  }
}

export interface GroundingValidationOptions {
  facts?: AssistantFact[]
  sourceRevisions?: Record<string, string | number>
  accessibleSources?: Set<string>
}

/**
 * AIF-15 & Scheme B: Grounding validator.
 * Validates hypotheses/claims against genuine citations, source accessibility,
 * revision matching, and semantic consistency with confirmed facts.
 */
export function validateGrounding<T extends { text?: string; citations: AssistantCitationKey[] }>(
  items: T[],
  allowedCitations: AssistantCitationKey[],
  options?: GroundingValidationOptions,
): { valid: T[]; invalid: T[]; invalidReasons?: Record<number, string> } {
  const allowed = new Set(allowedCitations)
  const valid: T[] = []
  const invalid: T[] = []
  const invalidReasons: Record<number, string> = {}

  items.forEach((item, index) => {
    // 1. Must have at least 1 citation
    if (!item.citations || item.citations.length === 0) {
      invalid.push(item)
      invalidReasons[index] = 'MISSING_CITATIONS'
      return
    }

    // 2. All citations must exist in allowedCitations
    const unknownCitations = item.citations.filter((c) => !allowed.has(c))
    if (unknownCitations.length > 0) {
      invalid.push(item)
      invalidReasons[index] = `UNKNOWN_CITATIONS: ${unknownCitations.join(', ')}`
      return
    }

    // 3. Accessible sources check (if specified)
    if (options?.accessibleSources) {
      const forbiddenCitations = item.citations.filter((c) => {
        const id = c.split(':')[1]
        return id && !options.accessibleSources!.has(id) && !options.accessibleSources!.has(c)
      })
      if (forbiddenCitations.length > 0) {
        invalid.push(item)
        invalidReasons[index] = `INACCESSIBLE_SOURCES: ${forbiddenCitations.join(', ')}`
        return
      }
    }

    // 4. Source revision consistency check (if revisions are specified)
    if (options?.sourceRevisions) {
      for (const c of item.citations) {
        const parts = c.split(':')
        const sourceId = parts[1]
        const citedRevision = parts[2]
        if (sourceId && citedRevision && options.sourceRevisions[sourceId] !== undefined) {
          if (String(options.sourceRevisions[sourceId]) !== citedRevision) {
            invalid.push(item)
            invalidReasons[index] = `REVISION_MISMATCH: ${sourceId} expected ${options.sourceRevisions[sourceId]} got ${citedRevision}`
            return
          }
        }
      }
    }

    // 5. Fact consistency check against confirmed facts
    if (options?.facts && item.text) {
      const textLower = item.text.toLowerCase()
      for (const fact of options.facts) {
        if (fact.value !== undefined) {
          if (fact.factKey?.includes('heartbeat') && fact.value === false) {
            if (textLower.includes('正常') && !textLower.includes('不正常') && !textLower.includes('非正常')) {
              invalid.push(item)
              invalidReasons[index] = 'CONTRADICTS_CONFIRMED_FACT_STALE_HEARTBEAT'
              return
            }
          }
          if (fact.factKey === 'status' && fact.value === 'FAILED') {
            if (textLower.includes('执行成功') || textLower.includes('运行成功')) {
              invalid.push(item)
              invalidReasons[index] = 'CONTRADICTS_CONFIRMED_FACT_STATUS_FAILED'
              return
            }
          }
        }
      }
    }

    valid.push(item)
  })

  return { valid, invalid, invalidReasons }
}
