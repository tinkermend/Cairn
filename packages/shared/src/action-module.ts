/**
 * Action Module C0 契约。
 *
 * 定义模块、版本、契约与校验规则。
 * 唯一所有者：AM-A。消费方不得另建近似 DTO。
 */
import { z } from 'zod'
import {
  implementationKeySchema,
  moduleExecutionModeSchema,
  type ModuleExecutionMode,
} from './action-module-vocabulary.js'
import {
  outputFieldTypeSchema,
  outputFieldNameSchema,
} from './output-schema.js'
import {
  type CompileDiagnostic,
  scenarioDefinitionFromSteps,
  MAX_SCENARIO_STEPS,
} from './scenario.js'
import {
  contextKeySchema,
  effectTypeSchema,
  FORBIDDEN_CONTEXT_KEYS,
  isAiStepType,
  stepSchema,
} from './step.js'
import { entityIdSchema, jsonValueSchema, utcInstantSchema } from './wire.js'
import { moduleHealthSummarySchema } from './action-module-health.js'

// ---------------------------------------------------------------------------
// Module key
// ---------------------------------------------------------------------------

/** Target 内唯一的模块键。小写点分标识符，如 order.query。 */
export const moduleKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/,
    '模块 key 须为小写点分标识符（如 order.query），最长 64 字符',
  )
export type ModuleKey = z.infer<typeof moduleKeySchema>

// ---------------------------------------------------------------------------
// Value type for module inputs
// ---------------------------------------------------------------------------

export const MODULE_VALUE_TYPES = ['string', 'number', 'boolean', 'json'] as const
export type ModuleValueType = (typeof MODULE_VALUE_TYPES)[number]
export const moduleValueTypeSchema = z.enum(MODULE_VALUE_TYPES)

// ---------------------------------------------------------------------------
// Module input / output declarations
// ---------------------------------------------------------------------------

export const moduleInputDeclSchema = z.strictObject({
  key: contextKeySchema.refine((key) => !(FORBIDDEN_CONTEXT_KEYS as readonly string[]).includes(key), '不得使用对象保留名'),
  label: z.string().trim().min(1).max(128),
  valueType: moduleValueTypeSchema,
  required: z.boolean(),
  description: z.string().max(512).optional(),
})
export type ModuleInputDecl = z.infer<typeof moduleInputDeclSchema>

/**
 * OutputShape 的 Zod schema 形式，用于模块输出声明。
 * 复用 output-schema.ts 中的 OutputShape 类型定义。
 */
export const moduleOutputShapeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unknown') }),
  z.strictObject({
    kind: z.literal('scalar'),
    type: z.enum(['string', 'number', 'boolean', 'json']),
  }),
  z.strictObject({
    kind: z.literal('object'),
    fields: z.array(
      z.strictObject({
        name: outputFieldNameSchema,
        type: outputFieldTypeSchema,
        required: z.boolean(),
      }),
    ).min(1).max(32).superRefine((fields, ctx) => {
      const names = new Set<string>()
      fields.forEach((field, index) => {
        if (names.has(field.name)) ctx.addIssue({ code: 'custom', message: '输出字段名重复', path: [index, 'name'] })
        names.add(field.name)
      })
    }),
  }),
])

export const moduleOutputDeclSchema = z.strictObject({
  key: contextKeySchema.refine((key) => !(FORBIDDEN_CONTEXT_KEYS as readonly string[]).includes(key), '不得使用对象保留名'),
  label: z.string().trim().min(1).max(128),
  shape: moduleOutputShapeSchema,
  description: z.string().max(512).optional(),
})
export type ModuleOutputDecl = z.infer<typeof moduleOutputDeclSchema>

// ---------------------------------------------------------------------------
// Condition & Verification
// ---------------------------------------------------------------------------

export const conditionVerificationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('step'), stepId: entityIdSchema }),
  z.strictObject({ kind: z.literal('output_required'), outputKey: contextKeySchema }),
  z.strictObject({ kind: z.literal('manual_requirement') }),
])
export type ConditionVerification = z.infer<typeof conditionVerificationSchema>

export const moduleConditionSchema = z.strictObject({
  meaning: z.string().min(1).max(512),
  verification: conditionVerificationSchema,
})
export type ModuleCondition = z.infer<typeof moduleConditionSchema>

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const moduleContractSchema = z
  .strictObject({
    inputs: z.array(moduleInputDeclSchema).max(32).default([]),
    outputs: z.array(moduleOutputDeclSchema).max(32).default([]),
    effectCeiling: effectTypeSchema,
    preconditions: z.array(moduleConditionSchema).max(16).default([]),
    postconditions: z.array(moduleConditionSchema).max(16).default([]),
    entryState: moduleConditionSchema.optional(),
    exitState: moduleConditionSchema.optional(),
  })
  .superRefine((contract, ctx) => {
    // Input key uniqueness
    const inputKeys = new Set<string>()
    for (const [i, input] of contract.inputs.entries()) {
      if (inputKeys.has(input.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['inputs', i, 'key'],
          message: `模块输入 key「${input.key}」重复`,
        })
      }
      inputKeys.add(input.key)
    }
    // Output key uniqueness
    const outputKeys = new Set<string>()
    for (const [i, output] of contract.outputs.entries()) {
      if (outputKeys.has(output.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', i, 'key'],
          message: `模块输出 key「${output.key}」重复`,
        })
      }
      outputKeys.add(output.key)
    }
  })
export type ModuleContract = z.infer<typeof moduleContractSchema>

// ---------------------------------------------------------------------------
// Output mapping
// ---------------------------------------------------------------------------

export const outputMappingSchema = z.record(contextKeySchema, contextKeySchema)
export type OutputMapping = z.infer<typeof outputMappingSchema>

// ---------------------------------------------------------------------------
// Execution mode
// ---------------------------------------------------------------------------

export {
  MODULE_EXECUTION_MODES,
  moduleExecutionModeSchema,
  implementationKeySchema,
  type ModuleExecutionMode,
  type ImplementationKey,
} from './action-module-vocabulary.js'

/** 从步骤列表派生执行方式。 */
export function deriveExecutionMode(steps: readonly { type: string }[]): ModuleExecutionMode {
  const hasAi = steps.some((s) => isAiStepType(s.type))
  const hasDet = steps.some((s) => !isAiStepType(s.type))
  if (hasAi && hasDet) return 'HYBRID'
  if (hasAi) return 'AI'
  return 'DETERMINISTIC'
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const MAX_MODULE_IMPLEMENTATIONS = 3 as const

export const moduleImplementationSchema = z.strictObject({
  implementationKey: implementationKeySchema,
  kind: z.literal('structured_steps'),
  steps: z.array(stepSchema).max(MAX_SCENARIO_STEPS),
  outputMapping: outputMappingSchema,
  preconditionBindings: z.array(conditionVerificationSchema).max(16).optional(),
  postconditionBindings: z.array(conditionVerificationSchema).max(16).optional(),
})
export type ModuleImplementation = z.infer<typeof moduleImplementationSchema>

// ---------------------------------------------------------------------------
// Module content (draft / version payload)
// ---------------------------------------------------------------------------

export const moduleContentSchema = z
  .strictObject({
    contract: moduleContractSchema,
    implementations: z.array(moduleImplementationSchema).min(1).max(MAX_MODULE_IMPLEMENTATIONS),
  })
  .superRefine((content, ctx) => {
    const keys = new Set<string>()
    for (const [index, impl] of content.implementations.entries()) {
      if (keys.has(impl.implementationKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['implementations', index, 'implementationKey'],
          message: `实现 key「${impl.implementationKey}」重复`,
        })
      }
      keys.add(impl.implementationKey)
    }
  })
export type ModuleContent = z.infer<typeof moduleContentSchema>

export function findModuleImplementation(
  content: ModuleContent,
  implementationKey: string,
): ModuleImplementation | undefined {
  return content.implementations.find((item) => item.implementationKey === implementationKey)
}

// ---------------------------------------------------------------------------
// Publication status
// ---------------------------------------------------------------------------

export const MODULE_PUBLICATION_STATUSES = ['published', 'deprecated', 'withdrawn'] as const
export type ModulePublicationStatus = (typeof MODULE_PUBLICATION_STATUSES)[number]
export const modulePublicationStatusSchema = z.enum(MODULE_PUBLICATION_STATUSES)

// ---------------------------------------------------------------------------
// Module status (soft delete)
// ---------------------------------------------------------------------------

export const MODULE_STATUSES = ['active', 'deleted'] as const
export type ModuleStatus = (typeof MODULE_STATUSES)[number]

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const MODULE_ERROR_CODES = [
  'MODULE_NOT_FOUND',
  'MODULE_KEY_DUPLICATE',
  'MODULE_DRAFT_CONFLICT',
  'MODULE_COMPILE_BLOCKED',
  'MODULE_WARNINGS_NOT_CONFIRMED',
  'MODULE_TARGET_MISMATCH',
  'MODULE_HAS_VERSIONS',
  'MODULE_IDEMPOTENCY_CONFLICT',
  'MODULE_VERSION_NOT_FOUND',
  'MODULE_REFERENCED',
  'MODULE_PUBLICATION_TRANSITION_INVALID',
  'MODULE_UPGRADE_BLOCKED',
  'MODULE_UPGRADE_CONFIRMATION_REQUIRED',
  'MODULE_EXTRACT_SELECTION_INVALID',
  'MODULE_REPLACE_NOT_EQUIVALENT',
  'MODULE_IMPLEMENTATION_UNVERIFIED',
] as const
export type ModuleErrorCode = (typeof MODULE_ERROR_CODES)[number]

// ---------------------------------------------------------------------------
// Diagnostic codes (compiler)
// ---------------------------------------------------------------------------

export const MODULE_DIAGNOSTIC_CODES = [
  'MODULE_EFFECT_EXCEEDS_CEILING',
  'MODULE_OUTPUT_UNMAPPED',
  'MODULE_INPUT_UNDECLARED',
  'MODULE_INPUT_UNUSED',
  'MODULE_VERIFICATION_MISSING',
  'MODULE_CONDITION_STEP_INVALID',
  'MODULE_CONDITION_OUTPUT_INVALID',
  'MODULE_IMPLEMENTATION_EMPTY',
  'MODULE_IMPLEMENTATION_COUNT',
  'MODULE_IMPLEMENTATION_KEY_DUPLICATE',
  'MODULE_IMPLEMENTATION_UNKNOWN',
  'MODULE_FALLBACK_NOT_READ_ONLY',
  'MODULE_FALLBACK_DISABLED',
  'MODULE_FALLBACK_CANDIDATES_INVALID',
  'MODULE_VERIFICATION_TOO_WEAK',
  'MODULE_PRECONDITION_MISSING',
  'MODULE_SCHEMA_INVALID',
] as const
export type ModuleDiagnosticCode = (typeof MODULE_DIAGNOSTIC_CODES)[number]

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

/** AM-F 多实现编译规则修订；已发布版本保留原 compilerVersion。 */
export const MODULE_COMPILER_VERSION = 4 as const

export type ModuleCompileContext = {
  mode: 'save' | 'release'
  executableTypes?: readonly string[]
}

export type ModuleCompileResult = {
  ok: boolean
  diagnostics: CompileDiagnostic[]
  executionMode: ModuleExecutionMode
}

/** 稳定的逐条警告标识，避免同诊断码的多个字段被一次确认。 */
export function moduleWarningKey(diagnostic: CompileDiagnostic): string {
  return JSON.stringify([diagnostic.code, diagnostic.stepId ?? '', diagnostic.fieldPath ?? [], diagnostic.message])
}

// ---------------------------------------------------------------------------
// DTOs (list, detail, version)
// ---------------------------------------------------------------------------

export const actionModuleSummarySchema = z.object({
  id: entityIdSchema,
  targetId: entityIdSchema,
  key: moduleKeySchema,
  name: z.string().min(1).max(128),
  description: z.string().max(2048).optional().nullable(),
  capabilityKey: z.string().max(128).optional().nullable(),
  executionMode: moduleExecutionModeSchema.optional().nullable(),
  effectCeiling: effectTypeSchema.optional().nullable(),
  latestVersionNo: z.number().int().min(1).optional().nullable(),
  latestVersionPublishedAt: utcInstantSchema.optional().nullable(),
  publicationStatus: modulePublicationStatusSchema.optional().nullable(),
  tags: z.array(z.string().max(64)).max(16).default([]),
  health: moduleHealthSummarySchema.optional(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type ActionModuleSummary = z.infer<typeof actionModuleSummarySchema>

export const actionModuleDetailSchema = actionModuleSummarySchema.extend({
  aliases: z.array(z.string().max(128)).max(16).default([]),
  intentExamples: z.array(z.string().max(256)).max(20).default([]),
  draftRevision: z.number().int().min(0).nullable(),
  draftContent: moduleContentSchema.nullable(),
  compile: z.object({
    ok: z.boolean(),
    diagnostics: z.array(z.object({
      code: z.string().min(1).max(64),
      severity: z.enum(['error', 'warning']),
      message: z.string().min(1).max(512),
      stepId: entityIdSchema.optional(),
      inputKey: contextKeySchema.optional(),
      fieldPath: z.array(z.string().min(1).max(64)).max(8).optional(),
    })),
  }).optional(),
})
export type ActionModuleDetail = z.infer<typeof actionModuleDetailSchema>

export const actionModuleVersionDtoSchema = z.object({
  id: entityIdSchema,
  moduleId: entityIdSchema,
  versionNo: z.number().int().min(1),
  content: moduleContentSchema,
  contractDigest: z.string().min(1),
  implementationDigest: z.string().min(1),
  contentDigest: z.string().min(1),
  compilerVersion: z.number().int().min(1),
  executionMode: moduleExecutionModeSchema,
  effectCeiling: effectTypeSchema,
  publicationStatus: modulePublicationStatusSchema,
  sourceDraftRevision: z.number().int().min(0).nullable(),
  createdBy: z.string().min(1),
  createdAt: utcInstantSchema,
})
export type ActionModuleVersionDto = z.infer<typeof actionModuleVersionDtoSchema>

// ---------------------------------------------------------------------------
// API request/response schemas
// ---------------------------------------------------------------------------

export const createModuleBodySchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(128),
  targetId: entityIdSchema,
  key: moduleKeySchema,
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(2048).optional(),
  capabilityKey: z.string().trim().max(128).optional(),
})
export type CreateModuleBody = z.infer<typeof createModuleBodySchema>

export const updateModuleMetaBodySchema = z
  .strictObject({
    baseRevision: z.number().int().min(0),
    name: z.string().trim().min(1).max(128).optional(),
    description: z.string().trim().max(2048).nullable().optional(),
    capabilityKey: z.string().trim().max(128).nullable().optional(),
    tags: z.array(z.string().trim().max(64)).max(16).optional(),
    aliases: z.array(z.string().trim().max(128)).max(16).optional(),
    intentExamples: z.array(z.string().trim().max(256)).max(20).optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.description !== undefined ||
      body.capabilityKey !== undefined ||
      body.tags !== undefined ||
      body.aliases !== undefined ||
      body.intentExamples !== undefined,
    { message: '至少提供一个要修改的字段' },
  )
export type UpdateModuleMetaBody = z.infer<typeof updateModuleMetaBodySchema>

export const saveModuleDraftBodySchema = z.strictObject({
  baseRevision: z.number().int().min(0),
  content: moduleContentSchema,
})
export type SaveModuleDraftBody = z.infer<typeof saveModuleDraftBodySchema>

export const publishModuleBodySchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(128),
  expectedRevision: z.number().int().min(0),
  confirmedWarnings: z.array(z.string().min(1).max(2048)).max(256).default([]),
})
export type PublishModuleBody = z.infer<typeof publishModuleBodySchema>

export const moduleListQuerySchema = z.object({
  targetId: entityIdSchema.optional(),
  q: z.string().trim().optional(),
  capabilityKey: z.string().trim().optional(),
  tag: z.string().trim().optional(),
  executionMode: moduleExecutionModeSchema.optional(),
  publication: modulePublicationStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type ModuleListQuery = z.input<typeof moduleListQuerySchema>

export const moduleListResponseSchema = z.object({
  items: z.array(actionModuleSummarySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
})
export type ModuleListResponse = z.infer<typeof moduleListResponseSchema>

export const moduleVersionListResponseSchema = z.object({
  items: z.array(actionModuleVersionDtoSchema),
})
export type ModuleVersionListResponse = z.infer<typeof moduleVersionListResponseSchema>

// ---------------------------------------------------------------------------
// Audit actions for modules
// ---------------------------------------------------------------------------

export const MODULE_AUDIT_ACTIONS = [
  'module.create',
  'module.update',
  'module.delete',
  'module.publish',
  'module.publication',
  'module.upgrade',
  'module.extract',
  'module.replace',
  'module.resolve',
  'module.resolve_accept',
] as const
export type ModuleAuditAction = (typeof MODULE_AUDIT_ACTIONS)[number]

export const moduleTrialRunBodySchema = z.strictObject({
  inputs: z.record(z.string(), jsonValueSchema).optional(),
  runInput: z.record(z.string(), jsonValueSchema).optional(),
  targetAccountId: entityIdSchema.optional(),
  implementationKey: implementationKeySchema.optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
})
export type ModuleTrialRunBody = z.infer<typeof moduleTrialRunBodySchema>
