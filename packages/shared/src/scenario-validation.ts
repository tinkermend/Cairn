import { z } from 'zod'
import { entityIdSchema, utcInstantSchema } from './wire.js'

export const VALIDATION_SUBJECT_PROTOCOL = 'validationSubjectDigest@1' as const
export const EXECUTION_SCOPE_PROTOCOL = 'executionScopeDigest@1' as const
export const sampleValidationStateSchema = z.enum([
  'not_run',
  'running',
  'sample_passed',
  'failed',
  'inconclusive',
  'stale',
])
export type SampleValidationState = z.infer<typeof sampleValidationStateSchema>
export const scenarioValidationSampleSchema = z.strictObject({
  runId: entityIdSchema,
  scenarioVersionId: entityIdSchema,
  targetAccountId: entityIdSchema.nullable(),
  createdAt: utcInstantSchema,
  state: sampleValidationStateSchema,
  executionStatus: z.string(),
  outcomeStatus: z.string(),
  evidenceStatus: z.string(),
  subjectDigest: z.string().nullable(),
  executionScopeDigest: z.string().nullable(),
  inputDigest: z.string().nullable(),
  platformConfigRevision: z.number().int().nullable(),
  modelName: z.string().nullable(),
  reasons: z.array(z.string()),
})
export type ScenarioValidationSample = z.infer<typeof scenarioValidationSampleSchema>
export const scenarioValidationSchema = z.strictObject({
  scenarioId: entityIdSchema,
  revision: z.number().int().positive(),
  subjectDigest: z.string().nullable(),
  state: sampleValidationStateSchema,
  publishedSubjectDigest: z.string().nullable(),
  samples: z.array(scenarioValidationSampleSchema),
  sampleLimit: z.number().int().positive(),
  diagnostics: z.array(z.string()),
})
export type ScenarioValidation = z.infer<typeof scenarioValidationSchema>
