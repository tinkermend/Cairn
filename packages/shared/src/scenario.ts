import { z } from 'zod'
import { nextCursorSchema } from './rbac.js'
import { stepSchema, type Step } from './step.js'
import { entityIdSchema, RUNTIME_SCHEMA_VERSION, runtimeSchemaVersionSchema, utcInstantSchema } from './wire.js'

export const SCENARIO_STATUSES = ['active', 'disabled'] as const
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number]
export const scenarioStatusSchema = z.enum(SCENARIO_STATUSES)

export const SCENARIO_ERROR_CODES = [
  'SCENARIO_NOT_FOUND',
  'SCENARIO_VERSION_NOT_FOUND',
  'SCENARIO_NAME_CONFLICT',
  'SCENARIO_HAS_RUNS',
  'SCENARIO_UNRESOLVED_REF',
  'SCENARIO_DISABLED',
] as const
export type ScenarioErrorCode = (typeof SCENARIO_ERROR_CODES)[number]

export const MAX_SCENARIO_STEPS = 32

export const scenarioNameSchema = z.string().trim().min(1).max(128)

export const scenarioDefinitionSchema = z
  .strictObject({
    schemaVersion: runtimeSchemaVersionSchema,
    steps: z.array(stepSchema).min(1).max(MAX_SCENARIO_STEPS),
  })
  .superRefine((definition, ctx) => {
    const stepIds = new Set<string>()
    const outputKeys = new Set<string>()
    for (const [index, step] of definition.steps.entries()) {
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
export type ScenarioDefinition = z.infer<typeof scenarioDefinitionSchema>

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
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type ScenarioDto = z.infer<typeof scenarioSchema>

export const scenarioDetailSchema = scenarioSchema.extend({
  steps: z.array(stepSchema),
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
  versionNo: z.number().int().min(1),
  definition: scenarioDefinitionSchema,
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
  status: scenarioStatusSchema.optional(),
})
export type CreateScenarioBody = z.infer<typeof createScenarioBodySchema>

export const updateScenarioBodySchema = z
  .strictObject({
    name: scenarioNameSchema.optional(),
    steps: z.array(stepSchema).min(1).max(MAX_SCENARIO_STEPS).optional(),
    status: scenarioStatusSchema.optional(),
  })
  .refine((body) => body.name !== undefined || body.steps !== undefined || body.status !== undefined, {
    message: '至少提供一个要修改的字段',
  })
export type UpdateScenarioBody = z.infer<typeof updateScenarioBodySchema>

export function scenarioDefinitionFromSteps(steps: ScenarioDefinition['steps']): ScenarioDefinition {
  return { schemaVersion: RUNTIME_SCHEMA_VERSION, steps }
}
