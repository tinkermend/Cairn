import { z } from 'zod'
import { assertExpectSchema } from './browser-command.js'
import { aiInstructionSchema } from './step.js'
import { targetDescriptorSchema } from './target-descriptor.js'
import { entityIdSchema, jsonValueSchema, utcInstantSchema } from './wire.js'

// ---------------------------------------------------------------------------
// Protocol & Enums
// ---------------------------------------------------------------------------

export const OUTCOME_MANIFEST_PROTOCOL = 'snapshot.outcomeManifest@1'

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
  contractId: string
  verdict: OutcomeVerdict
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
 * Run 级结果轴聚合纯函数。
 * 按既定瀑布顺序判定（先判未知再判结论）：
 * 1. 无契约定义 -> NOT_EVALUATED
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
): OutcomeStatus {
  const activeEntries = [
    ...(manifest?.entries ?? []).map((entry) => ({ id: entry.contractId, severity: entry.severity })),
    ...(invariantManifest?.entries ?? []).map((entry) => ({ id: entry.id, severity: entry.severity })),
  ].filter((entry) => entry.severity !== 'INFO')

  if (activeEntries.length === 0) {
    return 'NOT_EVALUATED'
  }

  const verdictsByContractId = new Map<string, OutcomeVerdict[]>()
  for (const item of results ?? []) {
    const list = verdictsByContractId.get(item.contractId) ?? []
    list.push(item.verdict)
    verdictsByContractId.set(item.contractId, list)
  }

  for (const entry of activeEntries) {
    if (entry.severity === 'MUST') {
      const verdict = foldOutcomeVerdicts(verdictsByContractId.get(entry.id) ?? [])
      if (!verdict || verdict === 'UNKNOWN') {
        return 'UNKNOWN'
      }
    }
  }

  for (const entry of activeEntries) {
    if (entry.severity === 'MUST') {
      const verdict = foldOutcomeVerdicts(verdictsByContractId.get(entry.id) ?? [])
      if (verdict === 'FAIL') {
        return 'FAIL'
      }
    }
  }

  for (const entry of activeEntries) {
    if (entry.severity === 'SHOULD') {
      const verdict = foldOutcomeVerdicts(verdictsByContractId.get(entry.id) ?? [])
      if (verdict === 'FAIL') {
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
  const activeContracts = stepContracts.filter((c) => c.severity !== 'INFO')
  if (activeContracts.length === 0) {
    return 'NOT_EVALUATED'
  }

  const verdictsByContractId = new Map<string, OutcomeVerdict[]>()
  for (const item of results ?? []) {
    const list = verdictsByContractId.get(item.contractId) ?? []
    list.push(item.verdict)
    verdictsByContractId.set(item.contractId, list)
  }

  for (const contract of activeContracts) {
    if (contract.severity === 'MUST') {
      const verdict = foldOutcomeVerdicts(verdictsByContractId.get(contract.id) ?? [])
      if (!verdict || verdict === 'UNKNOWN') {
        return 'UNKNOWN'
      }
    }
  }

  for (const contract of activeContracts) {
    if (contract.severity === 'MUST') {
      const verdict = foldOutcomeVerdicts(verdictsByContractId.get(contract.id) ?? [])
      if (verdict === 'FAIL') {
        return 'FAIL'
      }
    }
  }

  for (const contract of activeContracts) {
    if (contract.severity === 'SHOULD') {
      const verdict = foldOutcomeVerdicts(verdictsByContractId.get(contract.id) ?? [])
      if (verdict === 'FAIL') {
        return 'WARN'
      }
    }
  }

  return 'PASS'
}

export type JoinedOutcomeEvaluation = {
  entry: OutcomeManifestEntry
  result?: OutcomeResultDto
  displayVerdict: OutcomeStatus
}

/** 以 manifest 为全集左连接结果行，未求值条件保留为 NOT_EVALUATED。 */
export function joinOutcomeEvaluations(
  manifest?: OutcomeManifest | null,
  results?: readonly OutcomeResultDto[] | null,
): JoinedOutcomeEvaluation[] {
  const byContract = new Map<string, OutcomeResultDto>()
  for (const item of results ?? []) {
    byContract.set(item.contractId, item)
  }
  return (manifest?.entries ?? []).map((entry) => {
    const result = byContract.get(entry.contractId)
    if (!result) {
      return { entry, displayVerdict: 'NOT_EVALUATED' as const }
    }
    return { entry, result, displayVerdict: result.verdict }
  })
}
