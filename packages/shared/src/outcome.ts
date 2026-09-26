import { z } from 'zod'
import { assertExpectSchema } from './browser-command.js'
import { aiInstructionSchema } from './step.js'
import { targetDescriptorSchema } from './target-descriptor.js'
import { entityIdSchema, jsonValueSchema, utcInstantSchema, type JsonValue } from './wire.js'
import type { StepSkipReason, StepRunStatus } from './run.js'
import type { CandidateGroup } from './authoring-document.js'

/** 不适用条件对应的跳过原因集合（CF-A §3.2） */
export const OUTCOME_NOT_APPLICABLE_SKIP_REASONS = new Set<StepSkipReason>([
  'disabled',
  'fallback_not_selected',
  'fallback_abandoned',
  'condition_not_met',
  'optional_absent',
  'loop_empty',
])

/**
 * 循环体步骤 → 循环头步骤。循环体步骤只在每一项开始时建记录，集合为空时一条记录也没有，
 * 聚合时要据此区分「循环正常执行 0 项」（不适用）与「循环没跑到」（未知）。
 */
export function loopBodyHeadersOf(
  controlFlow?: { blocks?: readonly { kind: string; headerStepId?: string; bodyStepIds?: readonly string[] }[] } | null,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of controlFlow?.blocks ?? []) {
    if ((block.kind !== 'for_each' && block.kind !== 'repeat') || !block.headerStepId) continue
    for (const stepId of block.bodyStepIds ?? []) map.set(stepId, block.headerStepId)
  }
  return map
}

// ---------------------------------------------------------------------------
// Protocol & Enums
// ---------------------------------------------------------------------------

export const OUTCOME_MANIFEST_PROTOCOL = 'snapshot.outcomeManifest@1'
export const IMPORTED_OUTCOME_PROTOCOL = 'outcome.imported@1' as const

export const OUTCOME_SCOPES = ['step', 'scenario'] as const
export type OutcomeScope = (typeof OUTCOME_SCOPES)[number]
export const outcomeScopeSchema = z.enum(OUTCOME_SCOPES)

export const OUTCOME_SEVERITIES = ['MUST', 'SHOULD', 'INFO'] as const
export type OutcomeSeverity = (typeof OUTCOME_SEVERITIES)[number]
export const outcomeSeveritySchema = z.enum(OUTCOME_SEVERITIES)

export const OUTCOME_ON_VIOLATIONS = ['halt', 'continue'] as const
export type OutcomeOnViolation = (typeof OUTCOME_ON_VIOLATIONS)[number]
export const outcomeOnViolationSchema = z.enum(OUTCOME_ON_VIOLATIONS)

export const OUTCOME_PROVENANCES = [
  'manual',
  'module_inherited',
  'recorded',
  'imported',
  'ai_compiled',
  'legacy_assert',
  'runtime_invariant',
] as const
export type OutcomeProvenance = (typeof OUTCOME_PROVENANCES)[number]
export const outcomeProvenanceSchema = z.enum(OUTCOME_PROVENANCES)

export const OUTCOME_STATUSES = [
  'PASS',
  'WARN',
  'FAIL',
  'UNKNOWN',
  'NOT_EVALUATED',
] as const
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number]
export const outcomeStatusSchema = z.enum(OUTCOME_STATUSES)

export const OUTCOME_VERDICTS = ['PASS', 'WARN', 'FAIL', 'UNKNOWN'] as const
export type OutcomeVerdict = (typeof OUTCOME_VERDICTS)[number]
export const outcomeVerdictSchema = z.enum(OUTCOME_VERDICTS)

// ---------------------------------------------------------------------------
// Rules & Contracts
// ---------------------------------------------------------------------------

export const outcomeDeterministicRuleSchema = z.strictObject({
  kind: z.literal('deterministic'),
  target: targetDescriptorSchema.optional(),
  expect: assertExpectSchema,
  tolerance: z
    .strictObject({
      numberDelta: z.number().nonnegative().optional(),
      percentDelta: z.number().nonnegative().optional(),
      windowMs: z.number().int().positive().optional(),
    })
    .optional(),
})
export type OutcomeDeterministicRule = z.infer<typeof outcomeDeterministicRuleSchema>

export const outcomeAiRuleSchema = z.strictObject({
  kind: z.literal('ai'),
  instruction: aiInstructionSchema,
})
export type OutcomeAiRule = z.infer<typeof outcomeAiRuleSchema>

export const outcomeRuleSchema = z.discriminatedUnion('kind', [
  outcomeDeterministicRuleSchema,
  outcomeAiRuleSchema,
])
export type OutcomeRule = z.infer<typeof outcomeRuleSchema>

export const outcomeContractSchema = z
  .strictObject({
    id: entityIdSchema,
    scope: outcomeScopeSchema,
    meaning: z.string().trim().min(1).max(512),
    severity: outcomeSeveritySchema,
    onViolation: outcomeOnViolationSchema,
    provenance: outcomeProvenanceSchema,
    rule: outcomeRuleSchema,
  })
  .superRefine((contract, ctx) => {
    if ((contract.severity === 'SHOULD' || contract.severity === 'INFO') && contract.onViolation === 'halt') {
      ctx.addIssue({
        code: 'custom',
        path: ['onViolation'],
        message: `${contract.severity} 条件不允许配置 halt，只能配置 continue`,
      })
    }
  })
export type OutcomeContract = z.infer<typeof outcomeContractSchema>

// ---------------------------------------------------------------------------
// Manifest (Snapshot Freeze)
// ---------------------------------------------------------------------------

export const outcomeManifestEntrySchema = z.strictObject({
  contractId: entityIdSchema,
  scope: outcomeScopeSchema,
  meaning: z.string().trim().min(1).max(512),
  severity: outcomeSeveritySchema,
  onViolation: outcomeOnViolationSchema,
  provenance: outcomeProvenanceSchema,
  stepId: entityIdSchema,
  sourceStepId: entityIdSchema.optional(),
  moduleId: entityIdSchema.optional(),
  invocationId: entityIdSchema.optional(),
  rule: outcomeRuleSchema,
})
export type OutcomeManifestEntry = z.infer<typeof outcomeManifestEntrySchema>

export const outcomeManifestSchema = z.strictObject({
  entries: z.array(outcomeManifestEntrySchema),
})
export type OutcomeManifest = z.infer<typeof outcomeManifestSchema>

// ---------------------------------------------------------------------------
// Result DTO & Evaluation Record
// ---------------------------------------------------------------------------

export const outcomeResultDtoSchema = z.strictObject({
  id: entityIdSchema,
  runId: entityIdSchema,
  stepRunId: entityIdSchema,
  attemptId: entityIdSchema,
  contractId: entityIdSchema,
  scope: outcomeScopeSchema,
  meaning: z.string().trim().min(1).max(512),
  severity: outcomeSeveritySchema,
  onViolation: outcomeOnViolationSchema,
  provenance: outcomeProvenanceSchema,
  verdict: outcomeVerdictSchema,
  expected: jsonValueSchema.nullable().optional(),
  actual: jsonValueSchema.nullable().optional(),
  evidenceId: entityIdSchema.nullable().optional(),
  details: z.record(z.string(), jsonValueSchema).nullable().optional(),
  evaluatedAt: utcInstantSchema,
  createdAt: utcInstantSchema.optional(),
})
export type OutcomeResultDto = z.infer<typeof outcomeResultDtoSchema>

// ---------------------------------------------------------------------------
// Pure Aggregation Functions
// ---------------------------------------------------------------------------

export type OutcomeResultEvaluation = {
  id?: string
  contractId: string
  verdict: OutcomeVerdict
  stepRunId?: string | null
  attemptId?: string | null
  evaluatedAt?: string | Date | null
  provenance?: OutcomeProvenance
  expected?: JsonValue | null
  actual?: JsonValue | null
  evidenceId?: string | null
  details?: Record<string, JsonValue> | null
}

export type StepRunEvaluationInfo = {
  id?: string
  stepId: string
  status: StepRunStatus
  skipReason?: StepSkipReason | null
}

export type EffectiveOutcomeEvaluation = {
  contractId: string
  scope: OutcomeScope
  meaning: string
  severity: OutcomeSeverity
  onViolation: OutcomeOnViolation
  provenance: OutcomeProvenance
  stepId?: string
  applicable: boolean
  notApplicableReason?: StepSkipReason
  effectiveVerdict?: OutcomeVerdict
  displayVerdict: OutcomeStatus | 'NOT_APPLICABLE'
  evaluationCount: number
  lastResult?: OutcomeResultEvaluation
  history?: OutcomeResultEvaluation[]
}

export function foldOutcomeVerdicts(verdicts: readonly OutcomeVerdict[]): OutcomeVerdict | undefined {
  if (verdicts.length === 0) return undefined
  if (verdicts.includes('FAIL')) return 'FAIL'
  if (verdicts.includes('UNKNOWN')) return 'UNKNOWN'
  if (verdicts.includes('WARN')) return 'WARN'
  if (verdicts.includes('PASS')) return 'PASS'
  return undefined
}

/**
 * 核心纯函数：依据 R1–R5 计算每个成功条件的有效状态。
 * R1 重试覆盖：同一 StepRun 上的同一条件，以最后一次尝试的结论为准。
 * R2 多实例折叠：同一条件落在多个 StepRun 上时，各 StepRun 取 R1 结论后再行折叠。
 * R3 约束不覆盖：运行期约束（provenance = runtime_invariant）任何一次违反都计入。
 * R4 不适用与全不适用边界：跳过原因属于不适用集合的条件不参与聚合，全不适用收尾为 NOT_EVALUATED。
 * R5 以选中的备选为准：候选回退中，只有最终选中备选上的条件计入；被放弃/未选中的备选判定为不适用。
 */
export function effectiveOutcomeEvaluations(input: {
  manifest?: OutcomeManifest | null
  results?: readonly OutcomeResultEvaluation[] | null
  stepRuns?: readonly StepRunEvaluationInfo[] | null
  candidateGroups?: readonly CandidateGroup[] | null
  invariantManifest?: { entries: readonly { id: string; severity: OutcomeSeverity; meaning?: string; onViolation?: OutcomeOnViolation }[] } | null
  loopBodyHeaders?: ReadonlyMap<string, string> | null
}): EffectiveOutcomeEvaluation[] {
  const stepRunsByStepId = new Map<string, StepRunEvaluationInfo[]>()
  for (const sr of input.stepRuns ?? []) {
    const list = stepRunsByStepId.get(sr.stepId) ?? []
    list.push(sr)
    stepRunsByStepId.set(sr.stepId, list)
  }

  // 判定候选回退备选的选中状态（Rule R5）
  // 映射 stepId -> StepSkipReason（针对被放弃或未采用备选中的步骤）
  const candidateStepSkipReasons = new Map<string, StepSkipReason>()
  for (const group of input.candidateGroups ?? []) {
    // 检查是否有备选全部步骤成功
    const selectedAlt = group.alternatives.find(
      (alt) =>
        alt.stepIds.length > 0 &&
        alt.stepIds.every((id) => stepRunsByStepId.get(id)?.some((sr) => sr.status === 'SUCCEEDED')),
    )

    if (selectedAlt) {
      const selectedIndex = group.alternatives.indexOf(selectedAlt)
      for (const [index, alt] of group.alternatives.entries()) {
        if (alt !== selectedAlt) {
          const reason: StepSkipReason =
            index < selectedIndex ? 'fallback_abandoned' : 'fallback_not_selected'
          for (const stepId of alt.stepIds) {
            candidateStepSkipReasons.set(stepId, reason)
          }
        }
      }
    } else {
      // 无备选完全成功：按最后尝试过的备选区分
      let lastAttemptedIndex = -1
      for (const [index, alt] of group.alternatives.entries()) {
        const attempted = alt.stepIds.some((id) => {
          const srs = stepRunsByStepId.get(id) ?? []
          return srs.some((sr) => sr.status !== 'PENDING' && (sr.status !== 'SKIPPED' || sr.skipReason !== 'disabled'))
        })
        if (attempted) {
          lastAttemptedIndex = index
        }
      }
      if (lastAttemptedIndex >= 0) {
        for (let i = 0; i < lastAttemptedIndex; i++) {
          const alt = group.alternatives[i]!
          for (const stepId of alt.stepIds) {
            candidateStepSkipReasons.set(stepId, 'fallback_abandoned')
          }
        }
        for (let i = lastAttemptedIndex + 1; i < group.alternatives.length; i++) {
          const alt = group.alternatives[i]!
          for (const stepId of alt.stepIds) {
            candidateStepSkipReasons.set(stepId, 'fallback_not_selected')
          }
        }
      }
    }
  }

  // 按 contractId 归组并按时间排序结果
  const resultsByContractId = new Map<string, OutcomeResultEvaluation[]>()
  for (const item of input.results ?? []) {
    const list = resultsByContractId.get(item.contractId) ?? []
    list.push(item)
    resultsByContractId.set(item.contractId, list)
  }
  for (const list of resultsByContractId.values()) {
    list.sort((a, b) => {
      if (a.evaluatedAt && b.evaluatedAt) {
        const ta = new Date(a.evaluatedAt).getTime()
        const tb = new Date(b.evaluatedAt).getTime()
        if (ta !== tb) return ta - tb
      }
      return 0
    })
  }

  const evaluations: EffectiveOutcomeEvaluation[] = []

  // 1. 处理场景 Manifest 中的条件契约
  for (const entry of input.manifest?.entries ?? []) {
    const rawResults = resultsByContractId.get(entry.contractId) ?? []
    const evaluationCount = rawResults.length
    const lastResult = rawResults[rawResults.length - 1]

    // Rule R5: 候选回退未选备选判断
    const candidateReason = candidateStepSkipReasons.get(entry.stepId)
    if (candidateReason) {
      evaluations.push({
        contractId: entry.contractId,
        scope: entry.scope,
        meaning: entry.meaning,
        severity: entry.severity,
        onViolation: entry.onViolation,
        provenance: entry.provenance,
        stepId: entry.stepId,
        applicable: false,
        notApplicableReason: candidateReason,
        displayVerdict: 'NOT_APPLICABLE',
        evaluationCount,
        lastResult,
        history: rawResults,
      })
      continue
    }

    // Rule R4: 步骤跳过原因判断
    const srs = stepRunsByStepId.get(entry.stepId) ?? []
    if (
      srs.length > 0 &&
      srs.every((sr) => sr.status === 'SKIPPED' && sr.skipReason && OUTCOME_NOT_APPLICABLE_SKIP_REASONS.has(sr.skipReason))
    ) {
      const skipReason = srs[0]?.skipReason ?? 'disabled'
      evaluations.push({
        contractId: entry.contractId,
        scope: entry.scope,
        meaning: entry.meaning,
        severity: entry.severity,
        onViolation: entry.onViolation,
        provenance: entry.provenance,
        stepId: entry.stepId,
        applicable: false,
        notApplicableReason: skipReason,
        displayVerdict: 'NOT_APPLICABLE',
        evaluationCount,
        lastResult,
        history: rawResults,
      })
      continue
    }

    // 循环体步骤没有任何记录、也没有结果：循环头已成功说明集合为空、执行了 0 项，条件不适用。
    const loopHeaderStepId = input.loopBodyHeaders?.get(entry.stepId)
    if (loopHeaderStepId && srs.length === 0 && rawResults.length === 0) {
      const headerRuns = stepRunsByStepId.get(loopHeaderStepId) ?? []
      if (headerRuns.some((sr) => sr.status === 'SUCCEEDED')) {
        evaluations.push({
          contractId: entry.contractId,
          scope: entry.scope,
          meaning: entry.meaning,
          severity: entry.severity,
          onViolation: entry.onViolation,
          provenance: entry.provenance,
          stepId: entry.stepId,
          applicable: false,
          notApplicableReason: 'loop_empty',
          displayVerdict: 'NOT_APPLICABLE',
          evaluationCount: 0,
        })
        continue
      }
    }

    // 条件属于适用范围
    if (rawResults.length === 0) {
      evaluations.push({
        contractId: entry.contractId,
        scope: entry.scope,
        meaning: entry.meaning,
        severity: entry.severity,
        onViolation: entry.onViolation,
        provenance: entry.provenance,
        stepId: entry.stepId,
        applicable: true,
        displayVerdict: 'NOT_EVALUATED',
        evaluationCount: 0,
      })
      continue
    }

    // Rule R3: 运行期约束不走 R1 重试覆盖
    if (entry.provenance === 'runtime_invariant') {
      const effectiveVerdict = foldOutcomeVerdicts(rawResults.map((r) => r.verdict))
      evaluations.push({
        contractId: entry.contractId,
        scope: entry.scope,
        meaning: entry.meaning,
        severity: entry.severity,
        onViolation: entry.onViolation,
        provenance: entry.provenance,
        stepId: entry.stepId,
        applicable: true,
        effectiveVerdict,
        displayVerdict: effectiveVerdict ?? 'NOT_EVALUATED',
        evaluationCount,
        lastResult,
        history: rawResults,
      })
      continue
    }

    // Rule R1 & R2: 按 StepRun 分组，每 StepRun 取最后尝试，多 StepRun 再折叠
    const resultsByStepRun = new Map<string, OutcomeResultEvaluation[]>()
    for (const r of rawResults) {
      const key = r.stepRunId ?? '__default__'
      const list = resultsByStepRun.get(key) ?? []
      list.push(r)
      resultsByStepRun.set(key, list)
    }

    const perStepRunVerdicts: OutcomeVerdict[] = []
    for (const resList of resultsByStepRun.values()) {
      const latestOnStepRun = resList[resList.length - 1]
      if (latestOnStepRun) {
        perStepRunVerdicts.push(latestOnStepRun.verdict)
      }
    }
    // 同一条件的其他实例（循环的其他项）没有结论、也不属于不适用跳过：该项没有被验证，计为未知，
    // 否则「第 1 项通过、其余项因中止没跑」会被聚合成通过。
    for (const sr of srs) {
      if (!sr.id || resultsByStepRun.has(sr.id)) continue
      if (sr.status === 'SKIPPED' && sr.skipReason && OUTCOME_NOT_APPLICABLE_SKIP_REASONS.has(sr.skipReason)) continue
      perStepRunVerdicts.push('UNKNOWN')
    }

    const effectiveVerdict = foldOutcomeVerdicts(perStepRunVerdicts)

    evaluations.push({
      contractId: entry.contractId,
      scope: entry.scope,
      meaning: entry.meaning,
      severity: entry.severity,
      onViolation: entry.onViolation,
      provenance: entry.provenance,
      stepId: entry.stepId,
      applicable: true,
      effectiveVerdict,
      displayVerdict: effectiveVerdict ?? 'NOT_EVALUATED',
      evaluationCount,
      lastResult,
      history: rawResults,
    })
  }

  // 2. 处理运行时约束（Rule R3）
  for (const inv of input.invariantManifest?.entries ?? []) {
    if (evaluations.some((e) => e.contractId === inv.id)) continue

    const rawResults = resultsByContractId.get(inv.id) ?? []
    const evaluationCount = rawResults.length
    const lastResult = rawResults[rawResults.length - 1]
    const effectiveVerdict = foldOutcomeVerdicts(rawResults.map((r) => r.verdict))

    evaluations.push({
      contractId: inv.id,
      scope: 'scenario',
      meaning: inv.meaning ?? '运行期约束',
      severity: inv.severity,
      onViolation: inv.onViolation ?? 'halt',
      provenance: 'runtime_invariant',
      applicable: true,
      effectiveVerdict,
      displayVerdict: effectiveVerdict ?? 'NOT_EVALUATED',
      evaluationCount,
      lastResult,
      history: rawResults,
    })
  }

  return evaluations
}

/**
 * Run 级结果轴聚合纯函数。
 * 基于 effectiveOutcomeEvaluations 判定：
 * 1. 无有效契约定义或全部契约不适用 -> NOT_EVALUATED
 * 2. 存在未求值或求值异常的 MUST 条件 -> UNKNOWN
 * 3. 任一 MUST 条件 FAIL -> FAIL
 * 4. 任一 SHOULD 条件 FAIL -> WARN
 * 5. 其余全部已通过 -> PASS
 * INFO 条件不参与聚合。
 */
export function aggregateRunOutcomeStatus(
  manifest?: OutcomeManifest | null,
  results?: readonly OutcomeResultEvaluation[] | null,
  invariantManifest?: { entries: readonly { id: string; severity: OutcomeSeverity }[] } | null,
  stepRuns?: readonly StepRunEvaluationInfo[] | null,
  candidateGroups?: readonly CandidateGroup[] | null,
  loopBodyHeaders?: ReadonlyMap<string, string> | null,
): OutcomeStatus {
  const evaluations = effectiveOutcomeEvaluations({
    manifest,
    results,
    invariantManifest,
    stepRuns,
    candidateGroups,
    loopBodyHeaders,
  })

  const activeEntries = evaluations.filter((e) => e.applicable && e.severity !== 'INFO')

  if (activeEntries.length === 0) {
    return 'NOT_EVALUATED'
  }

  for (const entry of activeEntries) {
    if (entry.severity === 'MUST') {
      if (!entry.effectiveVerdict || entry.effectiveVerdict === 'UNKNOWN') {
        return 'UNKNOWN'
      }
    }
  }

  for (const entry of activeEntries) {
    if (entry.severity === 'MUST') {
      if (entry.effectiveVerdict === 'FAIL') {
        return 'FAIL'
      }
    }
  }

  for (const entry of activeEntries) {
    if (entry.severity === 'SHOULD') {
      if (entry.effectiveVerdict === 'FAIL') {
        return 'WARN'
      }
    }
  }

  return 'PASS'
}

/**
 * StepRun 级结果轴聚合纯函数。
 * 仅针对绑定在当前步骤上的契约集合。
 */
export function aggregateStepRunOutcomeStatus(
  stepContracts: readonly { id: string; severity: OutcomeSeverity }[],
  results?: readonly OutcomeResultEvaluation[] | null,
): OutcomeStatus {
  const resultsByContractId = new Map<string, OutcomeResultEvaluation[]>()
  for (const item of results ?? []) {
    const list = resultsByContractId.get(item.contractId) ?? []
    list.push(item)
    resultsByContractId.set(item.contractId, list)
  }

  const entries = stepContracts.map((contract) => {
    const sorted = [...(resultsByContractId.get(contract.id) ?? [])].sort((a, b) => {
      if (a.evaluatedAt && b.evaluatedAt) {
        const ta = new Date(a.evaluatedAt).getTime()
        const tb = new Date(b.evaluatedAt).getTime()
        if (ta !== tb) return ta - tb
      }
      return 0
    })
    return {
      contractId: contract.id,
      scope: 'step' as const,
      meaning: contract.id,
      severity: contract.severity,
      onViolation: contract.severity === 'MUST' ? ('halt' as const) : ('continue' as const),
      provenance: sorted[0]?.provenance ?? ('manual' as const),
      stepId: contract.id,
      rule: { kind: 'deterministic' as const, expect: { kind: 'exists' as const } },
    }
  })

  return aggregateRunOutcomeStatus({ entries }, results)
}

export type JoinedOutcomeEvaluation = {
  entry: OutcomeManifestEntry
  result?: OutcomeResultDto | OutcomeResultEvaluation
  displayVerdict: OutcomeStatus | 'NOT_APPLICABLE'
  applicable?: boolean
  notApplicableReason?: StepSkipReason
  evaluationCount?: number
  history?: OutcomeResultEvaluation[]
}

/** 以 manifest 为全集左连接结果行，未求值条件保留为 NOT_EVALUATED，不适用条件为 NOT_APPLICABLE。 */
export function joinOutcomeEvaluations(
  manifest?: OutcomeManifest | null,
  results?: readonly OutcomeResultDto[] | readonly OutcomeResultEvaluation[] | null,
  stepRuns?: readonly StepRunEvaluationInfo[] | null,
  candidateGroups?: readonly CandidateGroup[] | null,
  loopBodyHeaders?: ReadonlyMap<string, string> | null,
): JoinedOutcomeEvaluation[] {
  const evaluations = effectiveOutcomeEvaluations({
    manifest,
    results: results as readonly OutcomeResultEvaluation[] | null,
    stepRuns,
    candidateGroups,
    loopBodyHeaders,
  })

  const evalMap = new Map<string, EffectiveOutcomeEvaluation>()
  for (const ev of evaluations) {
    evalMap.set(ev.contractId, ev)
  }

  return (manifest?.entries ?? []).map((entry) => {
    const ev = evalMap.get(entry.contractId)
    if (!ev) {
      return { entry, displayVerdict: 'NOT_EVALUATED' as const, applicable: true, evaluationCount: 0 }
    }
    return {
      entry,
      result: ev.lastResult as OutcomeResultDto | undefined,
      displayVerdict: ev.displayVerdict,
      applicable: ev.applicable,
      notApplicableReason: ev.notApplicableReason,
      evaluationCount: ev.evaluationCount,
      history: ev.history,
    }
  })
}
