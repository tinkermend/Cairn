import { z } from 'zod'
import { entityIdSchema, utcInstantSchema } from './wire.js'
import { scenarioInputDeclSchema, scenarioNameSchema } from './scenario.js'
import {
  authoringDiffSchema,
  authoringIntentCoverageItemSchema,
  authoringOperationSchema,
  digestHexSchema,
  type AuthoringDiff,
  type AuthoringIntentCoverageItem,
  type AuthoringOperation,
} from './authoring-proposals.js'
import { compileDiagnosticSchema, type CompileDiagnostic } from './scenario.js'
import {
  demonstrationDecisionSchema,
  DEMONSTRATION_ADAPTER_VERSION,
  DEMONSTRATION_PROTOCOL,
  DEMONSTRATION_RULE_VERSION,
  type DemonstrationDecision,
} from './demonstration.js'
import { scenarioAuthoringDocumentV2Schema, type ScenarioAuthoringDocumentV2 } from './authoring-document.js'

export const RECORDING_GENERALIZATION_RULE_VERSION = 'recording-generalization@1' as const

export const generalizationDecisionPatchSchema = z.strictObject({
  id: z.string().min(1).max(128),
  parameter: scenarioInputDeclSchema.optional(),
})
export type GeneralizationDecisionPatch = z.infer<typeof generalizationDecisionPatchSchema>

export const generalizationRoundStatusSchema = z.enum([
  'proposed',
  'accepted',
  'rejected',
  'reverted',
  'invalidated',
])
export type GeneralizationRoundStatus = z.infer<typeof generalizationRoundStatusSchema>

export const generalizationRoundSourceSchema = z.enum(['rule', 'model'])
export type GeneralizationRoundSource = z.infer<typeof generalizationRoundSourceSchema>

export const generalizationRoundSchema = z.strictObject({
  roundId: entityIdSchema,
  source: generalizationRoundSourceSchema,
  intent: z.string().max(4096).optional(),
  modelRoute: z
    .strictObject({
      model: z.string().min(1).max(128),
      route: z.string().min(1).max(128),
    })
    .optional(),
  decisionPatches: z.array(generalizationDecisionPatchSchema).default([]),
  operations: z.array(authoringOperationSchema),
  intentCoverage: z.array(authoringIntentCoverageItemSchema).default([]),
  diffs: z.array(authoringDiffSchema).default([]),
  diagnostics: z.array(compileDiagnosticSchema).default([]),
  status: generalizationRoundStatusSchema,
  createdAt: utcInstantSchema,
})
export type GeneralizationRound = z.infer<typeof generalizationRoundSchema>

export const recordingGeneralizationStatusSchema = z.enum(['editing', 'handed_off'])
export type RecordingGeneralizationStatus = z.infer<typeof recordingGeneralizationStatusSchema>

export const recordingGeneralizationDtoSchema = z.strictObject({
  id: entityIdSchema,
  recordingDraftId: entityIdSchema,
  revision: z.number().int().positive(),
  status: recordingGeneralizationStatusSchema,
  factDigest: digestHexSchema,
  suggestionDigest: digestHexSchema,
  adapterVersion: z.string(),
  ruleVersion: z.string(),
  candidateDigest: digestHexSchema,
  decisions: z.array(demonstrationDecisionSchema),
  rounds: z.array(generalizationRoundSchema),
  candidateDocument: scenarioAuthoringDocumentV2Schema.optional(),
  handedOffScenarioId: entityIdSchema.nullable().optional(),
  handedOffReceiptId: entityIdSchema.nullable().optional(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type RecordingGeneralizationDto = z.infer<typeof recordingGeneralizationDtoSchema>

export const saveGeneralizationDecisionsBodySchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  decisions: z.array(demonstrationDecisionSchema),
})
export type SaveGeneralizationDecisionsBody = z.infer<typeof saveGeneralizationDecisionsBodySchema>

export const submitGeneralizationRoundBodySchema = z
  .strictObject({
    revision: z.number().int().nonnegative(),
    intent: z.string().trim().max(4096).optional(),
    quickAction: z
      .enum(['relax_timeout', 'extract', 'parameterize', 'expect_outcome', 'clean_login', 'clean_misfires'])
      .optional(),
    targetStepId: z.string().min(1).max(128).optional(),
    targetSourceId: z.string().min(1).max(128).optional(),
  })
  .refine((b) => Boolean(b.intent || b.quickAction), {
    message: '必须提供自然语言意图或快捷操作',
  })
export type SubmitGeneralizationRoundBody = z.infer<typeof submitGeneralizationRoundBodySchema>

export const handoffCreateScenarioBodySchema = z.strictObject({
  name: scenarioNameSchema,
  candidateDigest: digestHexSchema,
  revision: z.number().int().nonnegative(),
})
export type HandoffCreateScenarioBody = z.infer<typeof handoffCreateScenarioBodySchema>
