import { z } from 'zod'
import { FORBIDDEN_CONTEXT_KEYS } from './run.js'
import { nextCursorSchema } from './rbac.js'
import { contextKeySchema, stepSchema, type Step } from './step.js'
import { entityIdSchema, RUNTIME_SCHEMA_VERSION, runtimeSchemaVersionSchema, utcInstantSchema } from './wire.js'

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
  'SCENARIO_UNRESOLVED_REF',
  'SCENARIO_DISABLED',
  'SCENARIO_DRAFT_CONFLICT',
  'SCENARIO_COMPILE_BLOCKED',
  'SCENARIO_VERSION_NOT_PUBLISHED',
] as const
export type ScenarioErrorCode = (typeof SCENARIO_ERROR_CODES)[number]

export const MAX_SCENARIO_STEPS = 32

export const scenarioNameSchema = z.string().trim().min(1).max(128)

export const scenarioInputDeclSchema = z.strictObject({
  key: contextKeySchema.refine(
    (key) => !(FORBIDDEN_CONTEXT_KEYS as readonly string[]).includes(key),
    'input 键不得使用对象保留名',
  ),
  label: z.string().trim().min(1).max(128),
})
export type ScenarioInputDecl = z.infer<typeof scenarioInputDeclSchema>

export const scenarioDocumentSchema = z
  .strictObject({
    schemaVersion: runtimeSchemaVersionSchema,
    inputs: z.array(scenarioInputDeclSchema).max(64).default([]),
    steps: z.array(stepSchema).min(1).max(MAX_SCENARIO_STEPS),
  })
  .superRefine((document, ctx) => {
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
  })
export type ScenarioDocument = z.infer<typeof scenarioDocumentSchema>
export const scenarioDefinitionSchema = scenarioDocumentSchema
export type ScenarioDefinition = ScenarioDocument

export class ScenarioValidationError extends Error {
  readonly code: ScenarioErrorCode

  constructor(code: ScenarioErrorCode, message: string) {
    super(message)
    this.name = 'ScenarioValidationError'
    this.code = code
  }
}

function contextFrom(step: Step): string | undefined {
  if (step.type === 'echo' || step.type === 'fill') return step.input.from
  return undefined
}

/** 保存期：`from` 不得指向本步或更晚步骤的 outputKey。指向未声明的 key 是参数化，放过。 */
export function assertNoForwardFrom(steps: readonly Step[]): void {
  for (const [index, step] of steps.entries()) {
    const from = contextFrom(step)
    if (!from) continue
    const laterOrSelf = new Set(
      steps.slice(index).flatMap((item) => (item.outputKey ? [item.outputKey] : [])),
    )
    if (laterOrSelf.has(from)) {
      throw new ScenarioValidationError(
        'SCENARIO_UNRESOLVED_REF',
        `步骤「${step.name}」的 from=${from} 不得指向本步或更晚步骤的 outputKey`,
      )
    }
  }
}

/** 创建 Run：`from` 必须是 input 键或更早步骤的 outputKey。 */
export function assertRunFromResolved(
  steps: readonly Step[],
  input: Readonly<Record<string, unknown>>,
): void {
  const available = new Set(Object.keys(input))
  for (const step of steps) {
    const from = contextFrom(step)
    if (from && !available.has(from)) {
      throw new ScenarioValidationError(
        'SCENARIO_UNRESOLVED_REF',
        `步骤「${step.name}」的 from=${from} 解析不到 input 或更早步骤的 outputKey`,
      )
    }
    if (step.outputKey) available.add(step.outputKey)
  }
}

export function validateScenarioDefinition(definition: unknown): ScenarioDefinition {
  const parsed = scenarioDefinitionSchema.parse(definition)
  assertNoForwardFrom(parsed.steps)
  return parsed
}

export const scenarioSchema = z.object({
  id: entityIdSchema,
  targetId: entityIdSchema,
  name: scenarioNameSchema,
  status: scenarioStatusSchema,
  latestVersionId: entityIdSchema,
  latestVersionNo: z.number().int().min(1),
  stepCount: z.number().int().min(1).max(MAX_SCENARIO_STEPS),
  draftDirty: z.boolean().default(false),
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
})
export type CompileDiagnostic = z.infer<typeof compileDiagnosticSchema>

export const compileResultSchema = z.object({
  ok: z.boolean(),
  compilerVersion: z.literal(1),
  diagnostics: z.array(compileDiagnosticSchema),
})
export type CompileResultDto = z.infer<typeof compileResultSchema>

export const scenarioDraftDtoSchema = z.object({
  revision: z.number().int().min(1),
  document: scenarioDocumentSchema,
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
  document: scenarioDocumentSchema,
})
export type SaveScenarioDraftBody = z.infer<typeof saveScenarioDraftBodySchema>

export const publishScenarioBodySchema = z.strictObject({
  revision: z.number().int().min(1),
})
export type PublishScenarioBody = z.infer<typeof publishScenarioBodySchema>

export function scenarioDefinitionFromSteps(
  steps: ScenarioDefinition['steps'],
  inputs: ScenarioDefinition['inputs'] = [],
): ScenarioDefinition {
  return { schemaVersion: RUNTIME_SCHEMA_VERSION, inputs, steps }
}
