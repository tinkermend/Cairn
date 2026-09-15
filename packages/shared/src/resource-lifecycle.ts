import { z } from 'zod'

export const RESOURCE_DELETED_BY_KINDS = ['console', 'service'] as const
export type ResourceDeletedByKind = (typeof RESOURCE_DELETED_BY_KINDS)[number]

export const resourceDeletedBySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  kind: z.enum(RESOURCE_DELETED_BY_KINDS).default('console'),
})
export type ResourceDeletedBy = z.infer<typeof resourceDeletedBySchema>

export const deletePreviewCountsSchema = z.object({
  targetAccounts: z.number().int().nonnegative().optional(),
  scenarios: z.number().int().nonnegative().optional(),
  recordings: z.number().int().nonnegative().optional(),
  runs: z.number().int().nonnegative().optional(),
  storedObjects: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
})
export type DeletePreviewCounts = z.infer<typeof deletePreviewCountsSchema>

export const deletePreviewBlockerSchema = z.object({
  code: z.string().min(1),
  id: z.string().min(1),
  message: z.string().min(1),
})
export type DeletePreviewBlocker = z.infer<typeof deletePreviewBlockerSchema>

export const deletePreviewResponseSchema = z.object({
  previewToken: z.string().min(1),
  counts: deletePreviewCountsSchema,
  blockers: z.array(deletePreviewBlockerSchema),
})
export type DeletePreviewResponse = z.infer<typeof deletePreviewResponseSchema>

export const deleteResourceBodySchema = z.strictObject({
  expectedCounts: z
    .object({
      targetAccounts: z.number().int().nonnegative().optional(),
      scenarios: z.number().int().nonnegative().optional(),
      recordings: z.number().int().nonnegative().optional(),
      runs: z.number().int().nonnegative().optional(),
    })
    .optional(),
})
export type DeleteResourceBody = z.infer<typeof deleteResourceBodySchema>

export const CLEANUP_STATUSES = ['pending', 'in_progress', 'completed', 'failed'] as const
export type CleanupStatus = (typeof CLEANUP_STATUSES)[number]
export const cleanupStatusSchema = z.enum(CLEANUP_STATUSES)

export const cleanupStatusResponseSchema = z.object({
  resourceId: z.string().min(1),
  resourceType: z.enum(['target', 'run']),
  status: cleanupStatusSchema,
  totalObjects: z.number().int().nonnegative(),
  purgedObjects: z.number().int().nonnegative(),
  failedObjects: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  purgedBytes: z.number().int().nonnegative(),
  lastError: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
})
export type CleanupStatusResponse = z.infer<typeof cleanupStatusResponseSchema>

export const deleteResourceResultSchema = z.object({
  id: z.string().min(1),
  deletedAt: z.string().min(1),
  deletedBy: resourceDeletedBySchema,
  accepted: z.boolean(),
  cleanup: cleanupStatusResponseSchema.optional(),
})
export type DeleteResourceResult = z.infer<typeof deleteResourceResultSchema>
