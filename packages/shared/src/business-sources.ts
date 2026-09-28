import { z } from 'zod'

export const BUSINESS_SOURCE_CURSOR_EXPIRED = 'BUSINESS_SOURCE_CURSOR_EXPIRED' as const

export const businessSourceStatusSchema = z.enum(['draft', 'active', 'revoked'])
export type BusinessSourceStatus = z.infer<typeof businessSourceStatusSchema>

export const businessSourceBuildStatusSchema = z.enum(['building', 'ready', 'rejected', 'failed'])
export type BusinessSourceBuildStatus = z.infer<typeof businessSourceBuildStatusSchema>

export const businessSourceMappingConfigSchema = z.strictObject({
  keyColumn: z.string().trim().min(1).max(128),
  displayNameColumn: z.string().trim().min(1).max(128),
  statusColumn: z.string().trim().min(1).max(128).optional(),
  fieldWhitelist: z.array(z.string().trim().min(1).max(128)).min(1),
  sensitiveFields: z.array(z.string().trim().min(1).max(128)).optional(),
})
export type BusinessSourceMappingConfig = z.infer<typeof businessSourceMappingConfigSchema>

export const targetBusinessSourceDtoSchema = z.strictObject({
  id: z.string(),
  targetId: z.string(),
  entityType: z.string(),
  sourceKind: z.literal('dataset_snapshot'),
  currentSnapshotId: z.string().nullable(),
  bindingRevision: z.number().int().min(1),
  status: businessSourceStatusSchema,
  ownerAccountId: z.string(),
  approverAccountId: z.string().nullable(),
  approvedAt: z.string().nullable(),
  declaredSourceAsOf: z.string().nullable(),
  declaredByAccountId: z.string().nullable(),
  declarationBasis: z.string().nullable(),
  validUntil: z.string().nullable(),
  completenessBasis: z.string(),
  completenessStatus: z.enum(['complete', 'partial', 'unknown']),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type TargetBusinessSourceDto = z.infer<typeof targetBusinessSourceDtoSchema>

export const validationIssueSampleSchema = z.strictObject({
  rowIndex: z.number().int(),
  recordKey: z.string().optional(),
  reason: z.string(),
})
export type ValidationIssueSample = z.infer<typeof validationIssueSampleSchema>

export const validationSummarySchema = z.strictObject({
  totalRows: z.number().int(),
  validCount: z.number().int(),
  rejectedCount: z.number().int(),
  issues: z.array(validationIssueSampleSchema).max(5),
})
export type ValidationSummary = z.infer<typeof validationSummarySchema>

export const targetBusinessSourceSnapshotDtoSchema = z.strictObject({
  id: z.string(),
  sourceBindingId: z.string(),
  targetId: z.string(),
  entityType: z.string(),
  datasetId: z.string(),
  datasetName: z.string().optional(),
  buildStatus: businessSourceBuildStatusSchema,
  rulesVersion: z.number().int(),
  mappingConfig: businessSourceMappingConfigSchema,
  validationSummary: validationSummarySchema.nullable(),
  sourceObservedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type TargetBusinessSourceSnapshotDto = z.infer<typeof targetBusinessSourceSnapshotDtoSchema>

export const businessRecordDtoSchema = z.strictObject({
  id: z.string(),
  snapshotId: z.string(),
  targetId: z.string(),
  entityType: z.string(),
  recordKey: z.string(),
  displayName: z.string(),
  recordStatus: z.string().nullable().optional(),
  originalDatasetId: z.string(),
  datasetRowId: z.string(),
  datasetRowIndex: z.number().int(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
})
export type BusinessRecordDto = z.infer<typeof businessRecordDtoSchema>

export const businessRecordsListQuerySchema = z.object({
  entityType: z.string().default('manufacturer'),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type BusinessRecordsListQuery = z.infer<typeof businessRecordsListQuerySchema>

export const businessRecordsResponseSchema = z.strictObject({
  items: z.array(businessRecordDtoSchema),
  nextCursor: z.string().optional(),
  snapshotId: z.string(),
  bindingRevision: z.number().int(),
  coverage: z.strictObject({
    status: z.enum(['complete', 'partial', 'unknown']),
    completenessBasis: z.string(),
    sourceName: z.string().optional(),
    observedAt: z.string().nullable(),
    importedAt: z.string(),
  }),
})
export type BusinessRecordsResponse = z.infer<typeof businessRecordsResponseSchema>

export const previewBusinessSourceBodySchema = z.strictObject({
  datasetId: z.string(),
  entityType: z.string().default('manufacturer'),
  mappingConfig: businessSourceMappingConfigSchema,
})
export type PreviewBusinessSourceBody = z.infer<typeof previewBusinessSourceBodySchema>

export const previewRowSchema = z.strictObject({
  rowIndex: z.number().int(),
  recordKey: z.string().nullable(),
  displayName: z.string().nullable(),
  recordStatus: z.string().nullable().optional(),
  payload: z.record(z.string(), z.unknown()),
  isValid: z.boolean(),
  rejectReason: z.string().optional(),
})
export type PreviewRow = z.infer<typeof previewRowSchema>

export const previewBusinessSourceResponseSchema = z.strictObject({
  previewRows: z.array(previewRowSchema),
  validationDigest: z.strictObject({
    sampleCount: z.number().int(),
    sampleValidCount: z.number().int(),
    sampleRejectedCount: z.number().int(),
    potentialDuplicateKeys: z.array(z.string()).max(5),
  }),
})
export type PreviewBusinessSourceResponse = z.infer<typeof previewBusinessSourceResponseSchema>

export const createBusinessSourceCandidateBodySchema = z.strictObject({
  datasetId: z.string(),
  entityType: z.string().default('manufacturer'),
  mappingConfig: businessSourceMappingConfigSchema,
  sourceObservedAt: z.string().nullable().optional(),
  declaredSourceAsOf: z.string().nullable().optional(),
  declarationBasis: z.string().nullable().optional(),
  validUntil: z.string().nullable().optional(),
  completenessBasis: z.string().default('快照全量扫描校验'),
})
export type CreateBusinessSourceCandidateBody = z.infer<typeof createBusinessSourceCandidateBodySchema>

export const approveCandidateBodySchema = z.strictObject({
  expectedRevision: z.number().int().min(1),
  approvalBasis: z.string().min(1).max(500),
})
export type ApproveCandidateBody = z.infer<typeof approveCandidateBodySchema>

export const revokeSourceBodySchema = z.strictObject({
  entityType: z.string().default('manufacturer').optional(),
  expectedRevision: z.number().int().min(1),
  revocationReason: z.string().min(1).max(500),
})
export type RevokeSourceBody = z.infer<typeof revokeSourceBodySchema>

export const targetBusinessSourceQuerySchema = z.object({
  entityType: z.string().default('manufacturer'),
})
export type TargetBusinessSourceQuery = z.infer<typeof targetBusinessSourceQuerySchema>

export const previewBusinessSourceQuerySchema = z.object({
  datasetId: z.string(),
  entityType: z.string().default('manufacturer'),
  keyColumn: z.string().trim().min(1).max(128),
  displayNameColumn: z.string().trim().min(1).max(128),
  statusColumn: z.string().trim().min(1).max(128).optional(),
  fieldWhitelist: z.union([z.string(), z.array(z.string())]).transform((val) =>
    Array.isArray(val) ? val : val.split(',').map((s) => s.trim()).filter(Boolean),
  ),
  sensitiveFields: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((val) => {
      if (!val) return undefined
      return Array.isArray(val) ? val : val.split(',').map((s) => s.trim()).filter(Boolean)
    }),
})
export type PreviewBusinessSourceQuery = z.infer<typeof previewBusinessSourceQuerySchema>
