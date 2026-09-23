import { z } from 'zod'
import { entityIdSchema, jsonValueSchema, utcInstantSchema } from './wire.js'
import { contextKeySchema } from './step.js'
import { implementationKeySchema } from './action-module.js'

// ---------------------------------------------------------------------------
// Constants & Statuses
// ---------------------------------------------------------------------------

export const MODULE_CASE_STATUSES = ['ACTIVE', 'ARCHIVED', 'INCOMPATIBLE'] as const
export type ModuleCaseStatus = (typeof MODULE_CASE_STATUSES)[number]
export const moduleCaseStatusSchema = z.enum(MODULE_CASE_STATUSES)

export const MODULE_CASE_RESULT_STATUSES = ['PENDING', 'PASS', 'FAIL', 'INCONCLUSIVE'] as const
export type ModuleCaseResultStatus = (typeof MODULE_CASE_RESULT_STATUSES)[number]
export const moduleCaseResultStatusSchema = z.enum(MODULE_CASE_RESULT_STATUSES)

export const MODULE_TEST_BATCH_STATUSES = ['RUNNING', 'COMPLETED', 'HALTED', 'FAILED'] as const
export type ModuleTestBatchStatus = (typeof MODULE_TEST_BATCH_STATUSES)[number]
export const moduleTestBatchStatusSchema = z.enum(MODULE_TEST_BATCH_STATUSES)

export const MAX_TEST_BATCH_CASES = 20 as const

// ---------------------------------------------------------------------------
// Sample Review Schema (非敏感样本审阅凭据)
// ---------------------------------------------------------------------------

export const sampleReviewSchema = z.strictObject({
  reviewedBy: z.string().min(1).max(64),
  reviewedAt: utcInstantSchema,
  inputsDigest: z.string().min(1).max(128),
  outputsDigest: z.string().min(1).max(128),
  confirmed: z.boolean(),
})
export type SampleReview = z.infer<typeof sampleReviewSchema>

// ---------------------------------------------------------------------------
// Module Test Case
// ---------------------------------------------------------------------------

export const moduleTestCaseSchema = z.strictObject({
  id: entityIdSchema,
  moduleId: entityIdSchema,
  name: z.string().trim().min(1).max(128),
  revision: z.number().int().positive(),
  contractDigest: z.string().min(1).max(128),
  inputs: z.record(contextKeySchema, jsonValueSchema).default({}),
  expectedModuleOutcome: z.string().min(1).max(32).default('VERIFIED'),
  expectedFailureCode: z.string().min(1).max(64).optional(),
  expectedOutputs: z.record(contextKeySchema, jsonValueSchema).default({}),
  implementationKey: implementationKeySchema.default('default'),
  releaseGate: z.boolean().default(true),
  targetAccountId: entityIdSchema.optional(),
  sampleReview: sampleReviewSchema,
  status: moduleCaseStatusSchema.default('ACTIVE'),
  createdBy: z.string().min(1).max(64),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type ModuleTestCase = z.infer<typeof moduleTestCaseSchema>

export const createModuleTestCaseBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  inputs: z.record(contextKeySchema, jsonValueSchema).default({}),
  expectedModuleOutcome: z.string().min(1).max(32).default('VERIFIED'),
  expectedFailureCode: z.string().min(1).max(64).optional(),
  expectedOutputs: z.record(contextKeySchema, jsonValueSchema).default({}),
  implementationKey: implementationKeySchema.default('default'),
  releaseGate: z.boolean().default(true),
  targetAccountId: entityIdSchema.optional(),
  sampleReview: sampleReviewSchema,
})
export type CreateModuleTestCaseBody = z.infer<typeof createModuleTestCaseBodySchema>

export const updateModuleTestCaseBodySchema = z.strictObject({
  baseRevision: z.number().int().positive(),
  name: z.string().trim().min(1).max(128).optional(),
  inputs: z.record(contextKeySchema, jsonValueSchema).optional(),
  expectedModuleOutcome: z.string().min(1).max(32).optional(),
  expectedFailureCode: z.string().min(1).max(64).optional(),
  expectedOutputs: z.record(contextKeySchema, jsonValueSchema).optional(),
  implementationKey: implementationKeySchema.optional(),
  releaseGate: z.boolean().optional(),
  targetAccountId: entityIdSchema.optional().nullable(),
  sampleReview: sampleReviewSchema.optional(),
  status: moduleCaseStatusSchema.optional(),
})
export type UpdateModuleTestCaseBody = z.infer<typeof updateModuleTestCaseBodySchema>

export const runModuleTestCaseBodySchema = z.strictObject({
  targetAccountId: entityIdSchema.optional(),
  mode: z.enum(['draft', 'published']).default('draft'),
  idempotencyKey: z.string().min(1).max(128).optional(),
})
export type RunModuleTestCaseBody = z.infer<typeof runModuleTestCaseBodySchema>

// ---------------------------------------------------------------------------
// Module Case Execution (不可变执行快照)
// ---------------------------------------------------------------------------

export const moduleCaseExecutionSchema = z.strictObject({
  id: entityIdSchema,
  caseId: entityIdSchema,
  moduleId: entityIdSchema,
  caseRevision: z.number().int().positive(),
  runId: entityIdSchema,
  comparatorVersion: z.string().min(1).max(32).default('v1'),
  moduleDraftRevision: z.number().int().nonnegative().optional(),
  moduleVersionId: entityIdSchema.optional(),
  contentDigest: z.string().min(1).max(128),
  implementationKey: implementationKeySchema,
  targetAccountId: entityIdSchema.optional(),
  frozenInputs: z.record(contextKeySchema, jsonValueSchema),
  frozenExpectedOutcome: z.string().min(1).max(32),
  frozenExpectedFailureCode: z.string().min(1).max(64).optional(),
  frozenExpectedOutputs: z.record(contextKeySchema, jsonValueSchema),
  idempotencyKey: z.string().min(1).max(128).optional(),
  createdBy: z.string().min(1).max(64),
  createdAt: utcInstantSchema,
})
export type ModuleCaseExecution = z.infer<typeof moduleCaseExecutionSchema>

// ---------------------------------------------------------------------------
// Module Case Result (版本化重算投影)
// ---------------------------------------------------------------------------

export const moduleCaseResultSchema = z.strictObject({
  id: entityIdSchema,
  executionId: entityIdSchema,
  caseId: entityIdSchema,
  runId: entityIdSchema,
  revision: z.number().int().positive().default(1),
  status: moduleCaseResultStatusSchema.default('PENDING'),
  outcomeMatched: z.boolean().optional(),
  outputsMatched: z.boolean().optional(),
  evidenceComplete: z.boolean().optional(),
  failureReason: z.string().optional(),
  details: z.record(z.string(), jsonValueSchema).optional(),
  projectorVersion: z.string().min(1).max(32).default('v1'),
  createdAt: utcInstantSchema,
  settledAt: utcInstantSchema.optional(),
})
export type ModuleCaseResult = z.infer<typeof moduleCaseResultSchema>

// ---------------------------------------------------------------------------
// Module Test Batch (批量回归作业)
// ---------------------------------------------------------------------------

export const moduleTestBatchSchema = z.strictObject({
  id: entityIdSchema,
  moduleId: entityIdSchema,
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema.optional(),
  totalCases: z.number().int().nonnegative(),
  passedCases: z.number().int().nonnegative().default(0),
  failedCases: z.number().int().nonnegative().default(0),
  status: moduleTestBatchStatusSchema.default('RUNNING'),
  haltReason: z.string().optional(),
  caseExecutionIds: z.array(entityIdSchema).default([]),
  confirmedBy: z.string().min(1).max(64),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type ModuleTestBatch = z.infer<typeof moduleTestBatchSchema>

export const createModuleTestBatchBodySchema = z.strictObject({
  caseIds: z.array(entityIdSchema).min(1).max(MAX_TEST_BATCH_CASES),
  targetAccountId: entityIdSchema.optional(),
  confirmedEnv: z.boolean().refine((val) => val === true, '必须确认测试环境和测试账号范围'),
})
export type CreateModuleTestBatchBody = z.infer<typeof createModuleTestBatchBodySchema>

// ---------------------------------------------------------------------------
// Output Comparison Helper
// ---------------------------------------------------------------------------

/**
 * 比较声明输出。首期按声明输出键比较 scalar 精确值或 object 中明确选择的第一层字段，未指定字段不比较。
 */
export function compareModuleCaseOutputs(
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>>,
): {
  matched: boolean
  mismatches: Record<string, { expected: unknown; actual: unknown }>
} {
  const mismatches: Record<string, { expected: unknown; actual: unknown }> = {}
  for (const [key, expVal] of Object.entries(expected)) {
    if (!Object.hasOwn(actual, key)) {
      mismatches[key] = { expected: expVal, actual: undefined }
      continue
    }
    const actVal = actual[key]
    if (expVal !== null && typeof expVal === 'object' && !Array.isArray(expVal)) {
      // First-level object comparison
      if (actVal === null || typeof actVal !== 'object' || Array.isArray(actVal)) {
        mismatches[key] = { expected: expVal, actual: actVal }
        continue
      }
      const actObj = actVal as Record<string, unknown>
      let objMismatch = false
      for (const [subKey, subExp] of Object.entries(expVal as Record<string, unknown>)) {
        if (!Object.hasOwn(actObj, subKey) || actObj[subKey] !== subExp) {
          objMismatch = true
          break
        }
      }
      if (objMismatch) {
        mismatches[key] = { expected: expVal, actual: actVal }
      }
    } else if (actVal !== expVal) {
      mismatches[key] = { expected: expVal, actual: actVal }
    }
  }
  return {
    matched: Object.keys(mismatches).length === 0,
    mismatches,
  }
}
