/**
 * AM-C：模块升级差异、预览、提炼与替换。
 * 唯一所有者：AM-C。消费方不得另建近似 DTO。
 */
import { z } from 'zod'
import {
  moduleContentSchema,
  moduleKeySchema,
  modulePublicationStatusSchema,
  moduleValueTypeSchema,
  type ModulePublicationStatus,
} from './action-module.js'
import { moduleExecutionModeSchema, type ModuleExecutionMode } from './action-module-vocabulary.js'
import {
  authoringModuleInvocationSchema,
  moduleInputBindingSchema,
  scenarioAuthoringDocumentV2Schema,
} from './authoring-document.js'
import { compileDiagnosticSchema, type CompileDiagnostic } from './scenario.js'
import {
  contextKeySchema,
  effectTypeSchema,
} from './step.js'
import { entityIdSchema, jsonValueSchema, utcInstantSchema, type EntityId } from './wire.js'

export const UPGRADE_DIFF_SEVERITIES = ['info', 'warning', 'blocking'] as const
export type UpgradeDiffSeverity = (typeof UPGRADE_DIFF_SEVERITIES)[number]
export const upgradeDiffSeveritySchema = z.enum(UPGRADE_DIFF_SEVERITIES)

export const UPGRADE_DIFF_CODES = [
  'MODULE_UPGRADE_IMPLEMENTATION_ONLY',
  'MODULE_UPGRADE_INPUT_REQUIRED',
  'MODULE_UPGRADE_INPUT_OPTIONAL',
  'MODULE_UPGRADE_INPUT_REMOVED',
  'MODULE_UPGRADE_INPUT_TYPE',
  'MODULE_UPGRADE_OUTPUT_REMOVED',
  'MODULE_UPGRADE_OUTPUT_FIELD_MISSING',
  'MODULE_UPGRADE_OUTPUT_UNUSED_REMOVED',
  'MODULE_UPGRADE_EFFECT_CEILING_RAISED',
  'MODULE_UPGRADE_EFFECT_CEILING_LOWERED',
  'MODULE_UPGRADE_EXECUTION_MODE',
  'MODULE_UPGRADE_CONDITIONS',
  'MODULE_UPGRADE_DEPRECATED',
  'MODULE_UPGRADE_WITHDRAWN',
] as const
export type UpgradeDiffCode = (typeof UPGRADE_DIFF_CODES)[number]
export const upgradeDiffCodeSchema = z.enum(UPGRADE_DIFF_CODES)

export const upgradeModuleVersionSchema = z.strictObject({
  versionId: entityIdSchema,
  moduleId: entityIdSchema,
  versionNo: z.number().int().min(1),
  publicationStatus: modulePublicationStatusSchema,
  contractDigest: z.string().min(1),
  implementationDigest: z.string().min(1),
  contentDigest: z.string().min(1),
  executionMode: moduleExecutionModeSchema,
  effectCeiling: effectTypeSchema,
  content: moduleContentSchema,
})
export type UpgradeModuleVersion = z.infer<typeof upgradeModuleVersionSchema>

export const upgradeImplementationChangeSchema = z.strictObject({
  added: z.array(z.string().min(1).max(128)).max(32),
  removed: z.array(z.string().min(1).max(128)).max(32),
  changed: z.array(z.string().min(1).max(128)).max(32),
})
export type UpgradeImplementationChange = z.infer<typeof upgradeImplementationChangeSchema>

export const upgradeDiffSchema = z.strictObject({
  code: upgradeDiffCodeSchema,
  severity: upgradeDiffSeveritySchema,
  message: z.string().min(1).max(512),
  inputKey: contextKeySchema.optional(),
  outputKey: contextKeySchema.optional(),
  affectedNodeIds: z.array(z.string().min(1).max(128)).max(64).optional(),
  implementationSummary: upgradeImplementationChangeSchema.optional(),
})
export type UpgradeDiff = z.infer<typeof upgradeDiffSchema>

export function upgradeWarningKey(diff: Pick<UpgradeDiff, 'code' | 'inputKey' | 'outputKey' | 'affectedNodeIds' | 'message'>): string {
  return JSON.stringify([
    diff.code,
    diff.inputKey ?? '',
    diff.outputKey ?? '',
    diff.affectedNodeIds ?? [],
    diff.message,
  ])
}

export function worstUpgradeSeverity(diffs: readonly UpgradeDiff[]): UpgradeDiffSeverity {
  if (diffs.some((item) => item.severity === 'blocking')) return 'blocking'
  if (diffs.some((item) => item.severity === 'warning')) return 'warning'
  return 'info'
}

export const moduleExtractParameterSchema = z.strictObject({
  stepId: entityIdSchema,
  key: contextKeySchema,
  label: z.string().trim().min(1).max(128),
})
export type ModuleExtractParameter = z.infer<typeof moduleExtractParameterSchema>

export const moduleExtractProposalSchema = z.strictObject({
  ok: z.boolean(),
  error: z
    .strictObject({
      code: z.literal('MODULE_EXTRACT_SELECTION_INVALID'),
      message: z.string().min(1).max(512),
    })
    .optional(),
  stepIds: z.array(entityIdSchema).max(32).default([]),
  inputs: z
    .array(
      z.strictObject({
        key: contextKeySchema,
        label: z.string().min(1).max(128),
        valueType: moduleValueTypeSchema,
        required: z.boolean(),
        source: z.enum(['scenario_input', 'prior_output']),
      }),
    )
    .max(32)
    .default([]),
  outputs: z
    .array(
      z.strictObject({
        key: contextKeySchema,
        label: z.string().min(1).max(128),
        shape: z.discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal('unknown') }),
          z.strictObject({ kind: z.literal('scalar'), type: z.enum(['string', 'number', 'boolean', 'json']) }),
          z.strictObject({
            kind: z.literal('object'),
            fields: z.array(
              z.strictObject({
                name: z.string().min(1).max(64),
                type: z.enum(['string', 'number', 'boolean']),
                required: z.boolean(),
              }),
            ),
          }),
        ]),
        internalOutputKey: contextKeySchema,
      }),
    )
    .max(32)
    .default([]),
  effectCeiling: effectTypeSchema.default('READ_ONLY'),
  postconditionCandidates: z
    .array(
      z.strictObject({
        stepId: entityIdSchema,
        name: z.string().min(1).max(128),
        meaning: z.string().min(1).max(512),
      }),
    )
    .max(16)
    .default([]),
  parameterizable: z
    .array(
      z.strictObject({
        stepId: entityIdSchema,
        stepName: z.string().min(1).max(128),
        value: jsonValueSchema,
        suggestedKey: contextKeySchema,
        suggestedLabel: z.string().min(1).max(128),
      }),
    )
    .max(32)
    .default([]),
})
export type ModuleExtractProposal = z.infer<typeof moduleExtractProposalSchema>

export const replaceStepCompareSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  original: z.strictObject({
    type: z.string(),
    name: z.string(),
    effectType: effectTypeSchema,
    outputKey: z.string().optional(),
    inputSummary: z.string(),
  }),
  expanded: z
    .strictObject({
      type: z.string(),
      name: z.string(),
      effectType: effectTypeSchema,
      outputKey: z.string().optional(),
      inputSummary: z.string(),
    })
    .optional(),
  equal: z.boolean(),
  differences: z.array(z.string().min(1).max(256)).max(16),
})
export type ReplaceStepCompare = z.infer<typeof replaceStepCompareSchema>

export function latestSelectableVersion<T extends { versionNo: number; publicationStatus: ModulePublicationStatus }>(
  versions: readonly T[],
): T | undefined {
  return [...versions]
    .filter((item) => item.publicationStatus === 'published' || item.publicationStatus === 'deprecated')
    .sort((a, b) => b.versionNo - a.versionNo)[0]
}

export const moduleReferenceUseSchema = z.strictObject({
  invocationId: entityIdSchema,
  moduleVersionId: entityIdSchema.optional(),
  versionNo: z.number().int().min(1).optional(),
  moduleDraftRevision: z.number().int().nonnegative().optional(),
})
export type ModuleReferenceUse = z.infer<typeof moduleReferenceUseSchema>

export const moduleReferenceItemSchema = z.strictObject({
  scenarioId: entityIdSchema,
  name: z.string().min(1).max(128),
  status: z.enum(['active', 'disabled']),
  purpose: z.enum(['user', 'module_verification', 'map_job']),
  draftUses: z.array(moduleReferenceUseSchema).max(64),
  publishedUses: z.array(moduleReferenceUseSchema).max(64),
  lastRun: z
    .strictObject({
      id: entityIdSchema,
      status: z.string().min(1).max(64),
      createdAt: utcInstantSchema,
    })
    .nullable(),
  upgradeAvailable: z.boolean(),
})
export type ModuleReferenceItem = z.infer<typeof moduleReferenceItemSchema>

export const moduleReferenceListQuerySchema = z.object({
  versionId: entityIdSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type ModuleReferenceListQuery = z.infer<typeof moduleReferenceListQuerySchema>

export const moduleReferenceListResponseSchema = z.strictObject({
  items: z.array(moduleReferenceItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
})
export type ModuleReferenceListResponse = z.infer<typeof moduleReferenceListResponseSchema>

export const moduleUpgradePreviewBodySchema = z.strictObject({
  invocationId: entityIdSchema,
  toVersionId: entityIdSchema,
})
export type ModuleUpgradePreviewBody = z.infer<typeof moduleUpgradePreviewBodySchema>

export const moduleUpgradePreviewResponseSchema = z.strictObject({
  invocationId: entityIdSchema,
  fromVersionId: entityIdSchema.optional(),
  toVersionId: entityIdSchema,
  severity: upgradeDiffSeveritySchema,
  diffs: z.array(upgradeDiffSchema).max(256),
  document: scenarioAuthoringDocumentV2Schema,
  diagnostics: z.array(compileDiagnosticSchema).max(256),
})
export type ModuleUpgradePreviewResponse = z.infer<typeof moduleUpgradePreviewResponseSchema>

export const moduleUpgradeBodySchema = z.strictObject({
  invocationId: entityIdSchema,
  toVersionId: entityIdSchema,
  baseRevision: z.number().int().min(0),
  bindingsPatch: z.record(contextKeySchema, moduleInputBindingSchema).default({}),
  confirmedWarnings: z.array(z.string().min(1).max(2048)).max(256).default([]),
  idempotencyKey: z.string().min(1).max(128),
})
export type ModuleUpgradeBody = z.infer<typeof moduleUpgradeBodySchema>

export const moduleBatchUpgradeBodySchema = z.strictObject({
  toVersionId: entityIdSchema,
  scenarioIds: z.array(entityIdSchema).min(1).max(100),
  idempotencyKey: z.string().min(1).max(128),
})
export type ModuleBatchUpgradeBody = z.infer<typeof moduleBatchUpgradeBodySchema>

export const moduleBatchUpgradeRowSchema = z.strictObject({
  scenarioId: entityIdSchema,
  status: z.enum(['upgraded', 'skipped', 'conflict']),
  reason: z.string().min(1).max(512).optional(),
  code: z.string().min(1).max(64).optional(),
})
export type ModuleBatchUpgradeRow = z.infer<typeof moduleBatchUpgradeRowSchema>

export const moduleBatchUpgradeResponseSchema = z.strictObject({
  toVersionId: entityIdSchema,
  results: z.array(moduleBatchUpgradeRowSchema).max(100),
})
export type ModuleBatchUpgradeResponse = z.infer<typeof moduleBatchUpgradeResponseSchema>

export const modulePublicationBodySchema = z.strictObject({
  status: z.enum(['published', 'deprecated', 'withdrawn']),
  reason: z.string().trim().min(1).max(512),
})
export type ModulePublicationBody = z.infer<typeof modulePublicationBodySchema>

export const disableAffectedScenariosBodySchema = z.strictObject({
  versionId: entityIdSchema,
  scenarioIds: z.array(entityIdSchema).min(1).max(100),
  confirm: z.literal(true),
  reason: z.string().trim().min(1).max(512),
  idempotencyKey: z.string().min(1).max(128),
})
export type DisableAffectedScenariosBody = z.infer<typeof disableAffectedScenariosBodySchema>

export const disableAffectedScenariosResponseSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      scenarioId: entityIdSchema,
      status: z.enum(['disabled', 'skipped']),
      reason: z.string().min(1).max(512).optional(),
    }),
  ),
})
export type DisableAffectedScenariosResponse = z.infer<typeof disableAffectedScenariosResponseSchema>

export const moduleDeletePreviewResponseSchema = z.strictObject({
  draftReferences: z.array(moduleReferenceItemSchema).max(100),
  publishedReferences: z.array(moduleReferenceItemSchema).max(100),
  verificationScenarioId: entityIdSchema.nullable(),
  blockers: z.array(z.strictObject({ code: z.string(), id: z.string(), message: z.string() })).max(32),
})
export type ModuleDeletePreviewResponse = z.infer<typeof moduleDeletePreviewResponseSchema>

export const moduleExtractPreviewBodySchema = z.strictObject({
  stepIds: z.array(entityIdSchema).min(1).max(32),
})
export type ModuleExtractPreviewBody = z.infer<typeof moduleExtractPreviewBodySchema>

export const moduleExtractBodySchema = z.strictObject({
  stepIds: z.array(entityIdSchema).min(1).max(32),
  name: z.string().trim().min(1).max(128),
  key: moduleKeySchema,
  parameterized: z.array(moduleExtractParameterSchema).max(32).default([]),
  confirmedPostconditionStepIds: z.array(entityIdSchema).max(16).default([]),
  description: z.string().trim().max(2048).optional(),
  idempotencyKey: z.string().min(1).max(128),
})
export type ModuleExtractBody = z.infer<typeof moduleExtractBodySchema>

export const moduleReplacePreviewBodySchema = z.strictObject({
  stepIds: z.array(entityIdSchema).min(1).max(32),
  moduleVersionId: entityIdSchema,
})
export type ModuleReplacePreviewBody = z.infer<typeof moduleReplacePreviewBodySchema>

export const moduleReplacePreviewResponseSchema = z.strictObject({
  equal: z.boolean(),
  steps: z.array(replaceStepCompareSchema).max(32),
  invocation: authoringModuleInvocationSchema,
})
export type ModuleReplacePreviewResponse = z.infer<typeof moduleReplacePreviewResponseSchema>

export const moduleReplaceBodySchema = z.strictObject({
  stepIds: z.array(entityIdSchema).min(1).max(32),
  moduleVersionId: entityIdSchema,
  baseRevision: z.number().int().min(0),
  parameterized: z.array(moduleExtractParameterSchema).max(32).default([]),
  idempotencyKey: z.string().min(1).max(128),
})
export type ModuleReplaceBody = z.infer<typeof moduleReplaceBodySchema>

export function isSelectablePublication(status: ModulePublicationStatus): boolean {
  return status === 'published' || status === 'deprecated'
}

export function describeUpgradeSkip(code: string, message: string) {
  return { code, message }
}

export function sourceDescription(input: {
  scenarioName: string
  scenarioId: string
  draftRevision: number
  stepIds: readonly string[]
  extra?: string
}): string {
  const base = `提炼自场景「${input.scenarioName}」(${input.scenarioId}) 草稿 r${input.draftRevision}，步骤 ${input.stepIds.join(', ')}`
  return input.extra ? `${input.extra}\n${base}` : base
}

export type { CompileDiagnostic, EntityId, ModuleExecutionMode }
