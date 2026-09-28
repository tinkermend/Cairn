import { z } from 'zod'
import { nextCursorSchema } from './rbac.js'
import { resourceDeletedBySchema } from './resource-lifecycle.js'
import { resolutionPolicySchema } from './resolution-policy.js'
import { locatorPlanSchema } from './locator-plan.js'
import { outputFieldNameSchema } from './output-schema.js'
import {
  contextKeySchema,
  FORBIDDEN_CONTEXT_KEYS,
  scenarioInputDeclSchema,
  stepSchema,
  type ScenarioInputDecl,
  type Step,
} from './step.js'
import { entityIdSchema, RUNTIME_SCHEMA_VERSION, runtimeSchemaVersionSchema, utcInstantSchema } from './wire.js'
import {
  moduleManifestSchema,
  scenarioAuthoringDocumentV2Schema,
} from './authoring-document.js'

export const SCENARIO_STATUSES = ['active', 'disabled'] as const
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number]
export const scenarioStatusSchema = z.enum(SCENARIO_STATUSES)

export const SCENARIO_VERSION_KINDS = ['published', 'trial'] as const
export type ScenarioVersionKind = (typeof SCENARIO_VERSION_KINDS)[number]
export const scenarioVersionKindSchema = z.enum(SCENARIO_VERSION_KINDS)

export const SCENARIO_ERROR_CODES = [
  'SCENARIO_NOT_FOUND',
  'SCENARIO_VERSION_NOT_FOUND',
  'SCENARIO_NAME_CONFLICT',
  'SCENARIO_HAS_RUNS',
  'RESOURCE_BUSY',
  'RESOURCE_DELETED',
  'SCENARIO_UNRESOLVED_REF',
  'SCENARIO_DISABLED',
  'SCENARIO_DRAFT_CONFLICT',
  'SCENARIO_COMPILE_BLOCKED',
  'SCENARIO_VERSION_NOT_PUBLISHED',
] as const
export type ScenarioErrorCode = (typeof SCENARIO_ERROR_CODES)[number]

export const MAX_SCENARIO_STEPS = 32
export const MAX_SYSTEM_VERIFICATION_STEPS = 32
export const MAX_COMPILED_SCENARIO_STEPS = 64
export const MAX_SCENARIO_LOOP_BUDGET_STEPS = 2000

export const scenarioNameSchema = z.string().trim().min(1).max(128)

export { scenarioInputDeclSchema, type ScenarioInputDecl }

import {
  scenarioMetricDeclSchema,
  scenarioDataRowFieldDeclSchema,
  scenarioOutputDeclSchema,
  type ScenarioMetricDecl,
  type ScenarioDataRowFieldDecl,
  type ScenarioOutputDecl,
} from './run-output.js'

export {
  scenarioMetricDeclSchema,
  scenarioDataRowFieldDeclSchema,
  scenarioOutputDeclSchema,
  type ScenarioMetricDecl,
  type ScenarioDataRowFieldDecl,
  type ScenarioOutputDecl,
}

function refineScenarioDocument(
  document: {
    inputs: Array<{ key: string }>
    steps: Array<{ id: string; outputKey?: string }>
    outputs?: { metrics?: Array<{ key: string }>; dataRowFields?: Array<{ columnKey: string }> }
  },
  ctx: z.RefinementCtx,
) {
  const inputKeys = new Set<string>()
  for (const [index, input] of document.inputs.entries()) {
    if (inputKeys.has(input.key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['inputs', index, 'key'],
        message: '同一场景内 inputs.key 不能重复',
      })
    }
    inputKeys.add(input.key)
  }
  const stepIds = new Set<string>()
  const outputKeys = new Set<string>()
  for (const [index, step] of document.steps.entries()) {
    if (stepIds.has(step.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps', index, 'id'],
        message: '同一场景内 step.id 不能重复',
      })
    }
    stepIds.add(step.id)
    if (step.outputKey) {
      if (outputKeys.has(step.outputKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'outputKey'],
          message: '同一场景内 outputKey 不能重复',
        })
      }
      outputKeys.add(step.outputKey)
    }
  }
  if (document.outputs?.metrics) {
    const metricKeys = new Set<string>()
    for (const [index, metric] of document.outputs.metrics.entries()) {
      if (metricKeys.has(metric.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', 'metrics', index, 'key'],
          message: '同一场景内 metrics.key 不能重复',
        })
      }
      metricKeys.add(metric.key)
    }
  }
  if (document.outputs?.dataRowFields) {
    const colKeys = new Set<string>()
    for (const [index, field] of document.outputs.dataRowFields.entries()) {
      if (colKeys.has(field.columnKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', 'dataRowFields', index, 'columnKey'],
          message: '同一场景内 dataRowFields.columnKey 不能重复',
        })
      }
      colKeys.add(field.columnKey)
    }
  }
}

export const scenarioDocumentSchema = z
  .strictObject({
    schemaVersion: runtimeSchemaVersionSchema,
    inputs: z.array(scenarioInputDeclSchema).max(64).default([]),
    steps: z.array(stepSchema).min(1).max(MAX_SCENARIO_STEPS),
    outputs: scenarioOutputDeclSchema.optional(),
    resolution: resolutionPolicySchema.optional(),
    locatorPlan: locatorPlanSchema.optional(),
    locatorProtocol: z.literal(2).optional(),
  })
  .superRefine((document, ctx) => {
    refineScenarioDocument(document, ctx)
    if (document.resolution && document.locatorPlan) ctx.addIssue({ code: 'custom', path: ['locatorPlan'], message: '场景不能同时设置旧版与新版定位策略' })
  })
export type ScenarioDocument = z.infer<typeof scenarioDocumentSchema>

export const scenarioDefinitionSchema = z
  .strictObject({
    schemaVersion: runtimeSchemaVersionSchema,
    inputs: z.array(scenarioInputDeclSchema).max(64).default([]),
    steps: z.array(stepSchema).min(1).max(MAX_COMPILED_SCENARIO_STEPS),
    outputs: scenarioOutputDeclSchema.optional(),
    resolution: resolutionPolicySchema.optional(),
    locatorPlan: locatorPlanSchema.optional(),
    locatorProtocol: z.literal(2).optional(),
  })
  .superRefine((document, ctx) => {
    refineScenarioDocument(document, ctx)
    if (document.resolution && document.locatorPlan) ctx.addIssue({ code: 'custom', path: ['locatorPlan'], message: '场景不能同时设置旧版与新版定位策略' })
  })
export type ScenarioDefinition = z.infer<typeof scenarioDefinitionSchema>

export class ScenarioValidationError extends Error {
  readonly code: ScenarioErrorCode

  constructor(code: ScenarioErrorCode, message: string) {
    super(message)
    this.name = 'ScenarioValidationError'
    this.code = code
  }
}

function contextFrom(step: Step): string[] {
  if (step.type === 'ai_action' && 'operation' in step.input && step.input.operation === 'input') {
    return step.input.from ? [step.input.from] : []
  }
  if (step.type === 'echo' || step.type === 'fill' || step.type === 'select') {
    return step.input.from ? [step.input.from] : []
  }
  if (step.type === 'upload') {
    return step.input.files
      .filter((f): f is Extract<typeof f, { source: 'context' }> => f.source === 'context')
      .map((f) => f.from)
      .filter(Boolean)
  }
  return []
}

/** 保存期：`from` 不得指向本步或更晚步骤的 outputKey。指向未声明的 key 是参数化，放过。 */
export function assertNoForwardFrom(steps: readonly Step[]): void {
  for (const [index, step] of steps.entries()) {
    const froms = contextFrom(step)
    if (froms.length === 0) continue
    const laterOrSelf = new Set(
      steps.slice(index).flatMap((item) => (item.outputKey ? [item.outputKey] : [])),
    )
    for (const from of froms) {
      if (laterOrSelf.has(from)) {
        throw new ScenarioValidationError(
          'SCENARIO_UNRESOLVED_REF',
          `步骤「${step.name}」的 from=${from} 不得指向本步或更晚步骤的 outputKey`,
        )
      }
    }
  }
}

/**
 * 创建 Run 时解析不到的引用：既不在 input 里，也没有更早步骤的 outputKey 供给。
 * 返回键与提出要求的步骤名——调用方要么据此报错，要么把键列给外部调用方。
 */
export function unresolvedRunInputs(
  steps: readonly Step[],
  input: Readonly<Record<string, unknown>>,
): { key: string; stepName: string }[] {
  const available = new Set(Object.keys(input))
  const unresolved: { key: string; stepName: string }[] = []
  for (const step of steps) {
    if (!step.disabled) {
      const froms = contextFrom(step)
      for (const from of froms) {
        if (!available.has(from) && !unresolved.some((item) => item.key === from)) {
          unresolved.push({ key: from, stepName: step.name })
        }
      }
    }
    if (step.outputKey) available.add(step.outputKey)
    if (step.type === 'loop') {
      const loopInput = step.input as any
      if (loopInput?.control?.type === 'for_each') {
        if (loopInput.control.as) available.add(loopInput.control.as)
        if (loopInput.control.indexAs) available.add(loopInput.control.indexAs)
      }
      for (const rule of loopInput?.collect ?? []) {
        if (rule.into) available.add(rule.into)
      }
    }
  }
  return unresolved
}

/** 创建 Run：`from` 必须是 input 键或更早步骤的 outputKey。 */
export function assertRunFromResolved(
  steps: readonly Step[],
  input: Readonly<Record<string, unknown>>,
): void {
  const [first] = unresolvedRunInputs(steps, input)
  if (first) {
    throw new ScenarioValidationError('SCENARIO_UNRESOLVED_REF', unresolvedRunInputMessage(first))
  }
}

/** 建 Run 被拒时人看见的那句话。三条路径共用，改词只改这里。 */
export function unresolvedRunInputMessage(first: { key: string; stepName: string }): string {
  return `步骤「${first.stepName}」的 from=${first.key} 解析不到 input 或更早步骤的 outputKey`
}

/**
 * 正式运行必须提供的 input 键。
 *
 * 声明的 `inputs` 未必覆盖全部 `from`——保存期把「指向未声明 key」当参数化放过，
 * 发布期也不强制声明。只按 `inputs` 渲染表单会让这类场景在控制台里无处填值，
 * 跑到该步才失败。这里与 `assertRunFromResolved` 同源：声明的键，加上被步骤引用
 * 却没有前序 outputKey 供给的键（标签回落为键名）。
 */
export function requiredRunInputKeys(
  definition: Pick<ScenarioDefinition, 'inputs' | 'steps'>,
): ScenarioInputDecl[] {
  const declared = new Map<string, ScenarioInputDecl>()
  for (const input of definition.inputs ?? []) {
    if (!declared.has(input.key)) declared.set(input.key, input)
  }
  const available = new Set(declared.keys())
  const derived: ScenarioInputDecl[] = []
  for (const step of definition.steps) {
    const froms = contextFrom(step)
    for (const from of froms) {
      if (!available.has(from)) {
        available.add(from)
        derived.push({ key: from, label: from })
      }
    }
    if (step.outputKey) available.add(step.outputKey)
  }
  return [...declared.values(), ...derived]
}

export function validateScenarioDocument(document: unknown): ScenarioDocument {
  const parsed = scenarioDocumentSchema.parse(document)
  assertNoForwardFrom(parsed.steps)
  return parsed
}

export function validateScenarioDefinition(definition: unknown): ScenarioDefinition {
  const parsed = scenarioDefinitionSchema.parse(definition)
  assertNoForwardFrom(parsed.steps)
  return parsed
}

export const scenarioLatestRunSchema = z.object({
  id: entityIdSchema,
  status: z.string(),
  outcomeStatus: z.string().nullable().optional(),
  createdAt: utcInstantSchema,
})
export type ScenarioLatestRun = z.infer<typeof scenarioLatestRunSchema>

export const scenarioScheduleSummarySchema = z.object({
  id: entityIdSchema,
  name: z.string().nullable().optional(),
  enabled: z.boolean(),
  summary: z.string(),
  nextDueAt: utcInstantSchema.nullable().optional(),
})
export type ScenarioScheduleSummary = z.infer<typeof scenarioScheduleSummarySchema>

export const scenarioSchema = z.object({
  id: entityIdSchema,
  targetId: entityIdSchema,
  name: scenarioNameSchema,
  status: scenarioStatusSchema,
  purpose: z.enum(['user', 'module_verification', 'map_job']).default('user'),
  latestVersionId: entityIdSchema,
  latestVersionNo: z.number().int().min(1),
  stepCount: z.number().int().min(1).max(MAX_COMPILED_SCENARIO_STEPS),
  draftDirty: z.boolean().default(false),
  deletedAt: utcInstantSchema.nullable().optional(),
  deletedBy: resourceDeletedBySchema.nullable().optional(),
  createdByName: z.string().nullable().optional(),
  latestRun: scenarioLatestRunSchema.nullable().optional(),
  schedule: scenarioScheduleSummarySchema.nullable().optional(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type ScenarioDto = z.infer<typeof scenarioSchema>

export const compileDiagnosticSchema = z.object({
  code: z.string().min(1).max(64),
  severity: z.enum(['error', 'warning']),
  message: z.string().min(1).max(512),
  stepId: entityIdSchema.optional(),
  inputKey: contextKeySchema.optional(),
  fieldPath: z.array(z.string().min(1).max(64)).max(8).optional(),
})
export type CompileDiagnostic = z.infer<typeof compileDiagnosticSchema>

export const compileResultSchema = z.object({
  ok: z.boolean(),
  compilerVersion: z.number().int().min(1),
  diagnostics: z.array(compileDiagnosticSchema),
})
export type CompileResultDto = z.infer<typeof compileResultSchema>

export const scenarioDraftDtoSchema = z.object({
  revision: z.number().int().min(1),
  document: z.lazy(() => z.union([scenarioAuthoringDocumentV2Schema, scenarioDocumentSchema])),
  updatedAt: utcInstantSchema,
  updatedBy: z.object({
    id: entityIdSchema,
    displayName: z.string().min(1),
  }),
})
export type ScenarioDraftDto = z.infer<typeof scenarioDraftDtoSchema>

export const scenarioPublishedDtoSchema = z.object({
  versionId: entityIdSchema,
  versionNo: z.number().int().min(1),
  definition: scenarioDefinitionSchema,
  compilerVersion: z.number().int().min(1),
  authoringDocument: z.lazy(() => scenarioAuthoringDocumentV2Schema).optional(),
  moduleManifest: z.lazy(() => moduleManifestSchema).optional(),
  createdAt: utcInstantSchema,
})
export type ScenarioPublishedDto = z.infer<typeof scenarioPublishedDtoSchema>

export const scenarioDetailSchema = scenarioSchema.extend({
  steps: z.array(stepSchema),
  published: scenarioPublishedDtoSchema.optional(),
  draft: scenarioDraftDtoSchema.optional(),
  compile: compileResultSchema.optional(),
})
export type ScenarioDetailDto = z.infer<typeof scenarioDetailSchema>

export const scenarioListQuerySchema = z.object({
  search: z.string().trim().optional(),
  targetId: entityIdSchema.optional(),
  status: scenarioStatusSchema.optional(),
  purpose: z.enum(['user', 'module_verification']).optional(),
  hasDraft: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
})
export type ScenarioListQuery = z.input<typeof scenarioListQuerySchema>

export const scenarioListResponseSchema = z.object({
  items: z.array(scenarioSchema),
  nextCursor: nextCursorSchema,
})
export type ScenarioListResponse = z.infer<typeof scenarioListResponseSchema>

export const scenarioVersionSchema = z.object({
  id: entityIdSchema,
  scenarioId: entityIdSchema,
  versionNo: z.number().int().min(1).nullable(),
  kind: scenarioVersionKindSchema,
  definition: scenarioDefinitionSchema,
  compilerVersion: z.number().int().min(1),
  authoringDocument: z.lazy(() => scenarioAuthoringDocumentV2Schema).optional(),
  moduleManifest: z.lazy(() => moduleManifestSchema).optional(),
  createdAt: utcInstantSchema,
})
export type ScenarioVersionDto = z.infer<typeof scenarioVersionSchema>

export const scenarioVersionListResponseSchema = z.object({
  items: z.array(scenarioVersionSchema),
  nextCursor: nextCursorSchema,
})
export type ScenarioVersionListResponse = z.infer<typeof scenarioVersionListResponseSchema>

export const createScenarioBodySchema = z.strictObject({
  targetId: entityIdSchema,
  name: scenarioNameSchema,
  steps: z.array(stepSchema).min(1).max(MAX_SCENARIO_STEPS),
  inputs: z.array(scenarioInputDeclSchema).max(64).optional(),
  status: scenarioStatusSchema.optional(),
})
export type CreateScenarioBody = z.infer<typeof createScenarioBodySchema>

export const updateScenarioBodySchema = z
  .strictObject({
    name: scenarioNameSchema.optional(),
    status: scenarioStatusSchema.optional(),
  })
  .refine((body) => body.name !== undefined || body.status !== undefined, {
    message: '至少提供一个要修改的字段',
  })
export type UpdateScenarioBody = z.infer<typeof updateScenarioBodySchema>

export const saveScenarioDraftBodySchema = z.strictObject({
  revision: z.number().int().min(1),
  document: z.lazy(() => z.union([scenarioAuthoringDocumentV2Schema, scenarioDocumentSchema])),
})
export type SaveScenarioDraftBody = z.infer<typeof saveScenarioDraftBodySchema>

export const publishScenarioBodySchema = z.strictObject({
  revision: z.number().int().min(1),
})
export type PublishScenarioBody = z.infer<typeof publishScenarioBodySchema>

export const previewScenarioExpansionBodySchema = z.strictObject({
  document: z.unknown().optional(),
})
export type PreviewScenarioExpansionBody = z.infer<typeof previewScenarioExpansionBodySchema>

export const previewScenarioExpansionResponseSchema = z.strictObject({
  definition: scenarioDefinitionSchema.optional(),
  manifest: z.lazy(() => moduleManifestSchema).optional(),
  diagnostics: z.array(z.any()),
})
export type PreviewScenarioExpansionResponse = z.infer<typeof previewScenarioExpansionResponseSchema>

export const inlineScenarioModuleInvocationBodySchema = z.strictObject({
  expectedDraftLockVersion: z.number().int().min(1),
})
export type InlineScenarioModuleInvocationBody = z.infer<typeof inlineScenarioModuleInvocationBodySchema>

export function scenarioDefinitionFromSteps(
  steps: ScenarioDefinition['steps'],
  inputs: ScenarioDefinition['inputs'] = [],
  outputs?: ScenarioOutputDecl,
): ScenarioDefinition {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    inputs,
    steps,
    ...(outputs ? { outputs } : {}),
  }
}
