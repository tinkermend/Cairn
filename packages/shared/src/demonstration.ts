import { z } from 'zod'
import { entityIdSchema, utcInstantSchema } from './wire.js'
import { idempotencyKeySchema } from './run-api.js'
import { scenarioInputDeclSchema, scenarioNameSchema } from './scenario.js'
import { stepSchema } from './step.js'
import { outcomeRuleSchema } from './outcome.js'
import { targetDescriptorSchema } from './target-descriptor.js'

export const DEMONSTRATION_PROTOCOL = 'demonstration@1' as const
export const DEMONSTRATION_ADAPTER_VERSION = 'demonstration-adapters@1' as const
export const DEMONSTRATION_RULE_VERSION = 'demonstration-rules@1' as const
export const DEMONSTRATION_REDACTION_VERSION = 'demonstration-redaction@1' as const
export const DEMONSTRATION_LIMITS = {
  actions: 200,
  envelopeBytes: 1_048_576,
  fileBytes: 33_554_432,
  imageBytes: 2_097_152,
  imagePixels: 4_000_000,
  totalImageBytes: 25_165_824,
  images: 60,
  depth: 24,
} as const
export const demonstrationProfileSchema = z.enum([
  'playwright-crx@0.15.0',
  'cairn-crx-capture@1',
  'midscene-recorder-json@1',
  'midscene-yaml-flow@1',
])
export type DemonstrationProfile = z.infer<typeof demonstrationProfileSchema>
const shortText = z.string().max(512)
const sourceId = z.string().min(1).max(128)
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const demonstrationObservationSchema = z
  .strictObject({
    status: z.enum(['captured', 'approximate', 'missing', 'omitted']),
    observedAt: utcInstantSchema.optional(),
    ageMs: z.number().int().nonnegative().optional(),
    url: z.string().max(2048).optional(),
    readyState: z.enum(['loading', 'interactive', 'complete']).optional(),
    documentEpoch: sourceId.optional(),
    regionSummary: z.string().max(1024).optional(),
    reasonCode: z
      .enum([
        'not_provided',
        'timeout',
        'frame_unavailable',
        'document_changed',
        'post_action_only',
        'capture_failed',
      ])
      .optional(),
    screenshotAssetId: sourceId.optional(),
    reason: shortText.optional(),
  })
  .superRefine((observation, ctx) => {
    if (['captured', 'approximate'].includes(observation.status) && !observation.observedAt)
      ctx.addIssue({ code: 'custom', message: '采集观察必须包含时点' })
    if (['missing', 'omitted'].includes(observation.status) && !observation.reason)
      ctx.addIssue({ code: 'custom', message: '缺失观察必须说明原因' })
  })
export type DemonstrationObservation = z.infer<typeof demonstrationObservationSchema>

// This is a sanitized fact whitelist, never an arbitrary SDK dump or executable source.
export const demonstrationFactSchema = z.strictObject({
  id: sourceId,
  sourceIds: z.array(sourceId).min(1).max(200),
  sequence: z.number().int().nonnegative(),
  kind: z.enum(['action', 'observation']),
  action: z.string().min(1).max(64),
  pageId: sourceId.nullable(),
  documentEpoch: sourceId.nullable(),
  framePath: z.array(shortText).max(8).nullable(),
  observedAt: utcInstantSchema.optional(),
  timestampPrecision: z.enum(['millisecond', 'unknown']),
  semanticSource: z.enum(['aiDescribe', 'recorderAI', 'heuristic', 'unknown']).optional(),
  data: z.strictObject({
    url: z.string().max(2048).optional(),
    targetDescription: z.string().max(4096).optional(),
    instruction: z.string().max(4096).optional(),
    target: targetDescriptorSchema.optional(),
    value: z
      .discriminatedUnion('state', [
        z.strictObject({ state: z.literal('literal'), text: z.string().max(16_384) }),
        z.strictObject({ state: z.enum(['redacted', 'missing']), reason: shortText }),
      ])
      .optional(),
    mode: z.enum(['replace', 'type_only', 'clear']).optional(),
    key: z.string().max(64).optional(),
    direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    distance: z.number().finite().optional(),
    scrollType: z.string().max(64).optional(),
    durationMs: z.number().finite().optional(),
    button: z.enum(['left', 'right', 'middle']).optional(),
    clickCount: z.union([z.literal(1), z.literal(2)]).optional(),
    modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
    selectBy: z.enum(['label', 'value', 'index']).optional(),
    selectIndex: z.number().int().nonnegative().optional(),
    assertion: outcomeRuleSchema.optional(),
  }),
  before: demonstrationObservationSchema,
  after: demonstrationObservationSchema,
  diagnostics: z.array(shortText).max(32),
})
export type DemonstrationFact = z.infer<typeof demonstrationFactSchema>

export const demonstrationAssetSchema = z
  .strictObject({
    clientAssetId: sourceId,
    kind: z.literal('screenshot'),
    digest: digestSchema,
    byteSize: z.number().int().min(1).max(DEMONSTRATION_LIMITS.imageBytes),
    contentType: z.enum(['image/png', 'image/jpeg']),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    redaction: z.literal('locally_reviewed'),
  })
  .refine((a) => a.width * a.height <= DEMONSTRATION_LIMITS.imagePixels, '截图像素超限')

export const demonstrationSourceSchema = z
  .strictObject({
    protocolVersion: z.literal(DEMONSTRATION_PROTOCOL),
    captureId: entityIdSchema,
    targetId: entityIdSchema,
    bindingId: entityIdSchema.optional(),
    sourceKind: z.enum(['interaction_trace', 'script', 'legacy_normalized']),
    channel: z.enum(['extension', 'file']),
    producerKind: z.enum(['cairn_crx', 'chrome_recorder', 'studio_preview', 'unknown']),
    actorKind: z.enum(['human', 'ai', 'unknown']),
    authorship: z.enum(['human', 'ai', 'unknown']),
    importProfile: demonstrationProfileSchema,
    producerVersion: z.string().max(64).nullable(),
    detectedShape: shortText,
    adapterVersion: z.literal(DEMONSTRATION_ADAPTER_VERSION),
    redactionVersion: z.literal(DEMONSTRATION_REDACTION_VERSION),
    capturedAt: utcInstantSchema.optional(),
    facts: z.array(demonstrationFactSchema).min(1).max(DEMONSTRATION_LIMITS.actions),
    omittedConfig: z.array(shortText).max(64),
    assetManifest: z.array(demonstrationAssetSchema).max(DEMONSTRATION_LIMITS.images),
  })
  .superRefine((source, ctx) => {
    const ids = source.facts.map((f) => f.id)
    if (new Set(ids).size !== ids.length || source.facts.some((f, i) => f.sequence !== i))
      ctx.addIssue({ code: 'custom', message: '来源 ID 必须唯一、sequence 必须连续' })
    const assets = source.assetManifest
    if (
      new Set(assets.map((a) => a.clientAssetId)).size !== assets.length ||
      assets.reduce((n, a) => n + a.byteSize, 0) > DEMONSTRATION_LIMITS.totalImageBytes
    )
      ctx.addIssue({ code: 'custom', message: '截图 ID 重复或总字节超限' })
    const assetIds = new Set(assets.map((a) => a.clientAssetId))
    if (
      source.facts.some((fact) =>
        [fact.before, fact.after].some(
          (phase) => phase.screenshotAssetId && !assetIds.has(phase.screenshotAssetId),
        ),
      )
    )
      ctx.addIssue({ code: 'custom', message: '截图引用必须存在于附件清单' })
  })
export type DemonstrationSource = z.infer<typeof demonstrationSourceSchema>
export const createDemonstrationBodySchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  name: scenarioNameSchema,
  source: demonstrationSourceSchema,
  acknowledgedOmittedConfig: z.boolean(),
})
export type CreateDemonstrationBody = z.infer<typeof createDemonstrationBodySchema>

export const demonstrationPlacementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('start') }),
  z.strictObject({ kind: z.literal('after'), nodeId: entityIdSchema }),
  z.strictObject({ kind: z.literal('replace'), nodeId: entityIdSchema }),
])
export type DemonstrationPlacement = z.infer<typeof demonstrationPlacementSchema>
export const demonstrationOutcomeCandidateSchema = z.strictObject({
  meaning: z.string().min(1).max(512),
  rule: outcomeRuleSchema,
  severity: z.literal('MUST'),
  onViolation: z.literal('halt'),
  provenance: z.literal('imported'),
  afterSourceId: sourceId,
})
export const demonstrationSuggestionSchema = z.strictObject({
  id: sourceId,
  sourceIds: z.array(sourceId).min(1),
  action: z.string(),
  status: z.enum(['mapped', 'unresolved', 'observation']),
  step: stepSchema.optional(),
  outcome: demonstrationOutcomeCandidateSchema.optional(),
  parameter: z.strictObject({ key: z.string(), label: z.string(), value: z.string() }).optional(),
  diagnostics: z.array(z.string()),
})
export type DemonstrationSuggestion = z.infer<typeof demonstrationSuggestionSchema>
export const previewDemonstrationBodySchema = z.strictObject({
  protocolVersion: z.literal(DEMONSTRATION_PROTOCOL),
  recordingDraftId: entityIdSchema,
  baseRevision: z.number().int().positive(),
  placement: demonstrationPlacementSchema,
})
export type PreviewDemonstrationBody = z.infer<typeof previewDemonstrationBodySchema>
export const demonstrationPreviewSchema = previewDemonstrationBodySchema.extend({
  scenarioId: entityIdSchema,
  targetId: entityIdSchema,
  importProfile: demonstrationProfileSchema,
  factDigest: digestSchema,
  adapterVersion: z.literal(DEMONSTRATION_ADAPTER_VERSION),
  ruleVersion: z.literal(DEMONSTRATION_RULE_VERSION),
  suggestionDigest: digestSchema,
  suggestions: z.array(demonstrationSuggestionSchema),
  remainingCapacity: z.number().int().nonnegative(),
})
export type DemonstrationPreview = z.infer<typeof demonstrationPreviewSchema>
export const demonstrationDecisionSchema = z.discriminatedUnion('disposition', [
  z.strictObject({
    id: sourceId,
    disposition: z.literal('accept'),
    parameter: scenarioInputDeclSchema.optional(),
  }),
  z.strictObject({ id: sourceId, disposition: z.literal('replace'), step: stepSchema }),
  z.strictObject({
    id: sourceId,
    disposition: z.literal('discard'),
    reason: z.string().trim().min(1).max(200),
  }),
])
export const applyDemonstrationBodySchema = previewDemonstrationBodySchema.extend({
  idempotencyKey: idempotencyKeySchema,
  factDigest: digestSchema,
  suggestionDigest: digestSchema,
  adapterVersion: z.literal(DEMONSTRATION_ADAPTER_VERSION),
  ruleVersion: z.literal(DEMONSTRATION_RULE_VERSION),
  decisions: z.array(demonstrationDecisionSchema).min(1).max(DEMONSTRATION_LIMITS.actions),
})
export type ApplyDemonstrationBody = z.infer<typeof applyDemonstrationBodySchema>

export const demonstrationReceiptMetadataSchema = z.strictObject({
  protocolVersion: z.literal(DEMONSTRATION_PROTOCOL),
  factDigest: digestSchema,
  suggestionDigest: digestSchema,
  adapterVersion: z.string(),
  ruleVersion: z.string(),
  placement: demonstrationPlacementSchema,
  decisions: z.array(demonstrationDecisionSchema),
  sourceMap: z.array(
    z.strictObject({
      sourceIds: z.array(sourceId),
      nodeId: entityIdSchema.optional(),
      contractId: entityIdSchema.optional(),
      disposition: z.string(),
    }),
  ),
})

export const recordingArtifactDtoSchema = z.strictObject({
  id: entityIdSchema,
  clientAssetId: sourceId,
  status: z.enum(['pending', 'available', 'missing', 'deleting', 'purged']),
  expiresAt: utcInstantSchema,
  generationId: entityIdSchema.nullable(),
})
export const demonstrationDetailSchema = z.strictObject({
  recordingDraftId: entityIdSchema,
  source: demonstrationSourceSchema,
  factDigest: digestSchema,
  receivedAt: utcInstantSchema,
  createdBy: entityIdSchema,
  artifacts: z.array(recordingArtifactDtoSchema),
})
export type DemonstrationDetail = z.infer<typeof demonstrationDetailSchema>
