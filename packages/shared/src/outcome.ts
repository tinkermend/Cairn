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
): OutcomeStatus {
  if (!manifest || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    return 'NOT_EVALUATED'
  }

  const resultsByContractId = new Map<string, OutcomeVerdict>()
  for (const item of results ?? []) {
    resultsByContractId.set(item.contractId, item.verdict)
  }

  const activeEntries = manifest.entries.filter((e) => e.severity !== 'INFO')
  if (activeEntries.length === 0) {
    return 'NOT_EVALUATED'
  }

  // 2. 检查是否存在未求值或为 UNKNOWN 的 MUST 条件
  for (const entry of activeEntries) {
    if (entry.severity === 'MUST') {
      const verdict = resultsByContractId.get(entry.contractId)
      if (!verdict || verdict === 'UNKNOWN') {
        return 'UNKNOWN'
      }
    }
  }

  // 3. 检查是否存在失败的 MUST 条件
  for (const entry of activeEntries) {
    if (entry.severity === 'MUST') {
      const verdict = resultsByContractId.get(entry.contractId)
      if (verdict === 'FAIL') {
        return 'FAIL'
      }
    }
  }

  // 4. 检查是否存在失败的 SHOULD 条件
  for (const entry of activeEntries) {
    if (entry.severity === 'SHOULD') {
      const verdict = resultsByContractId.get(entry.contractId)
      if (verdict === 'FAIL') {
        return 'WARN'
      }
    }
  }

  // 5. 其余已求值
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

  const resultsByContractId = new Map<string, OutcomeVerdict>()
  for (const item of results ?? []) {
    resultsByContractId.set(item.contractId, item.verdict)
  }

  // 检查未求值或 UNKNOWN 的 MUST 条件
  for (const contract of activeContracts) {
    if (contract.severity === 'MUST') {
      const verdict = resultsByContractId.get(contract.id)
      if (!verdict || verdict === 'UNKNOWN') {
        return 'UNKNOWN'
      }
    }
  }

  // 检查失败的 MUST 条件
  for (const contract of activeContracts) {
    if (contract.severity === 'MUST') {
      const verdict = resultsByContractId.get(contract.id)
      if (verdict === 'FAIL') {
        return 'FAIL'
      }
    }
  }

  // 检查失败的 SHOULD 条件
  for (const contract of activeContracts) {
    if (contract.severity === 'SHOULD') {
      const verdict = resultsByContractId.get(contract.id)
      if (verdict === 'FAIL') {
        return 'WARN'
      }
    }
  }

  return 'PASS'
}
