import { z } from 'zod'
import { targetDescriptorSchema } from './target-descriptor.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

const commandKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/)

export const mapMenuAnchorSchema = z.strictObject({
  label: z.string().trim().min(1).max(128),
  locator: targetDescriptorSchema.optional(),
})
export type MapMenuAnchor = z.infer<typeof mapMenuAnchorSchema>

export const mapMenuEntrySchema = z.strictObject({
  entryId: entityIdSchema,
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(128),
  url: z.string().url().max(2048).optional(),
  menuAnchor: mapMenuAnchorSchema.optional(),
  enabled: z.boolean(),
  orderIndex: z.number().int().min(0),
  arrivalName: z.string().trim().min(1).max(128),
  arrivalTarget: targetDescriptorSchema,
}).refine(value => value.url !== undefined || value.menuAnchor !== undefined, '一级菜单须提供 URL 或菜单锚点')
export type MapMenuEntry = z.infer<typeof mapMenuEntrySchema>

export const mapMenuEntryDtoSchema = mapMenuEntrySchema.safeExtend({
  targetId: entityIdSchema,
  createdBy: entityIdSchema,
  updatedBy: entityIdSchema,
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
  archivedAt: utcInstantSchema.nullable(),
  lastIngest: z.strictObject({
    jobId: entityIdSchema,
    finishedAt: utcInstantSchema,
    outcome: z.enum(['complete', 'partial', 'failed']),
    pageCount: z.number().int().min(0),
    elementCount: z.number().int().min(0),
  }).nullable(),
})
export type MapMenuEntryDto = z.infer<typeof mapMenuEntryDtoSchema>

const menuInputFields = {
  name: z.string().trim().min(1).max(128),
  url: z.string().url().max(2048).optional(),
  menuAnchor: mapMenuAnchorSchema.optional(),
  enabled: z.boolean().default(true),
  arrivalName: z.string().trim().min(1).max(128),
  arrivalTarget: targetDescriptorSchema,
}

export const mapMenuEntryCreateBodySchema = z.strictObject({
  ...menuInputFields,
  idempotencyKey: commandKeySchema,
}).refine(value => value.url !== undefined || value.menuAnchor !== undefined, '一级菜单须提供 URL 或菜单锚点')
export type MapMenuEntryCreateBody = z.infer<typeof mapMenuEntryCreateBodySchema>

export const mapMenuEntryUpdateBodySchema = z.strictObject({
  ...menuInputFields,
  expectedVersion: z.number().int().min(1),
  idempotencyKey: commandKeySchema,
}).refine(value => value.url !== undefined || value.menuAnchor !== undefined, '一级菜单须提供 URL 或菜单锚点')
export type MapMenuEntryUpdateBody = z.infer<typeof mapMenuEntryUpdateBodySchema>

export const mapMenuEntryArchiveBodySchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  idempotencyKey: commandKeySchema,
  reason: z.string().trim().max(512).optional(),
})
export type MapMenuEntryArchiveBody = z.infer<typeof mapMenuEntryArchiveBodySchema>

export const mapMenuEntryReorderBodySchema = z.strictObject({
  entries: z.array(z.strictObject({
    entryId: entityIdSchema,
    expectedVersion: z.number().int().min(1),
    enabled: z.boolean(),
  })).min(1).max(64),
  idempotencyKey: commandKeySchema,
})
export type MapMenuEntryReorderBody = z.infer<typeof mapMenuEntryReorderBodySchema>

export const MAP_INGEST_SCOPES = ['full', 'entries', 'detect_top_menus'] as const
export const mapIngestScopeSchema = z.enum(MAP_INGEST_SCOPES)
export type MapIngestScope = z.infer<typeof mapIngestScopeSchema>

export const mapIngestCreateBodySchema = z.strictObject({
  manualId: commandKeySchema,
  expectedPolicyRevision: z.number().int().min(0),
  targetAccountId: entityIdSchema.optional(),
  scope: mapIngestScopeSchema.default('full'),
  entryIds: z.array(entityIdSchema).min(1).max(64).optional(),
}).superRefine((value, ctx) => {
  if (value.scope === 'entries' && !value.entryIds) ctx.addIssue({ code: 'custom', path: ['entryIds'], message: 'entries 范围须指定入口' })
  if (value.scope !== 'entries' && value.entryIds) ctx.addIssue({ code: 'custom', path: ['entryIds'], message: '仅 entries 范围可指定入口' })
})
export type MapIngestCreateBody = z.infer<typeof mapIngestCreateBodySchema>

export const mapIngestJobListQuerySchema = z.strictObject({
  cursor: entityIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type MapIngestJobListQuery = z.infer<typeof mapIngestJobListQuerySchema>

export const mapIngestNodeResultCodeSchema = z.enum([
  'collected', 'out_of_scope', 'anchor_unresolved', 'menu_container_unresolved',
  'unsafe_label', 'page_timeout', 'budget_exhausted', 'navigation_blocked',
  'dialog_dismissed', 'view_unresolved',
])
export type MapIngestNodeResultCode = z.infer<typeof mapIngestNodeResultCodeSchema>

export const mapIngestQueueNodeSchema = z.strictObject({
  entryId: entityIdSchema,
  kind: z.enum(['explicit_url', 'reveal', 'opaque_navigation']),
  label: z.string().trim().min(1).max(128),
  url: z.string().url().max(2048).optional(),
  locator: targetDescriptorSchema.optional(),
  depth: z.number().int().min(0).max(5),
  menuPath: z.array(z.string().trim().min(1).max(128)).max(8),
  parentFingerprint: z.string().max(128).optional(),
})
export type MapIngestQueueNode = z.infer<typeof mapIngestQueueNodeSchema>

export const mapIngestCursorSchema = z.strictObject({
  entryIndex: z.number().int().min(0),
  queue: z.array(mapIngestQueueNodeSchema).max(500),
  visitedPageKeys: z.array(z.string().min(1).max(512)).max(500),
  attemptedNodeKeys: z.array(z.string().min(1).max(2300)).max(1000).default([]),
  entryPageCounts: z.record(entityIdSchema, z.number().int().min(0).max(100)).default({}),
  elapsedSeconds: z.number().int().min(0),
  completedEntries: z.array(entityIdSchema).max(64),
  processedNodes: z.number().int().min(0),
})
export type MapIngestCursor = z.infer<typeof mapIngestCursorSchema>

export const mapIngestProgressSchema = z.strictObject({
  totalEntries: z.number().int().min(0),
  completedEntries: z.number().int().min(0),
  pagesCollected: z.number().int().min(0),
  currentEntryName: z.string().max(128).nullable(),
})
export type MapIngestProgress = z.infer<typeof mapIngestProgressSchema>

export const mapIngestElementSchema = z.strictObject({
  fingerprint: z.string().min(8).max(128),
  category: z.enum(['navigation', 'input', 'action_button', 'table_column', 'display']),
  role: z.string().max(64),
  name: z.string().trim().min(1).max(128),
  locator: targetDescriptorSchema.optional(),
  /** 当前页面上排序后的首选定位是否恰好命中一个节点；缺省表示未测量。 */
  locatorUnique: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
  unsafeAction: z.boolean().optional(),
})
export type MapIngestElement = z.infer<typeof mapIngestElementSchema>

export const mapIngestPageSnapshotSchema = z.strictObject({
  jobId: entityIdSchema,
  entryId: entityIdSchema,
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema,
  pageKey: z.string().min(1).max(512),
  viewStateKey: z.string().min(1).max(512),
  presentationStateKey: z.string().min(1).max(512),
  arrivalMethod: z.enum(['goto', 'reveal', 'opaque_click']),
  menuPath: z.array(z.string().trim().min(1).max(128)).max(8),
  title: z.string().max(200),
  urlPattern: z.string().max(512),
  elements: z.array(mapIngestElementSchema).max(500),
  completeness: z.enum(['complete', 'partial']),
  reasons: z.array(mapIngestNodeResultCodeSchema).max(16),
  observedAt: utcInstantSchema,
})
export type MapIngestPageSnapshot = z.infer<typeof mapIngestPageSnapshotSchema>

export const mapIngestSummarySchema = z.strictObject({
  outcome: z.enum(['complete', 'partial', 'failed']),
  entries: z.number().int().min(0),
  pages: z.number().int().min(0),
  elements: z.number().int().min(0),
  partialPages: z.number().int().min(0),
  resultCounts: z.record(z.string(), z.number().int().min(0)),
  blockedPostPaths: z.array(z.strictObject({ path: z.string().max(512), count: z.number().int().min(1) })).max(20),
  /** POSTs admitted by bounded query-intent inference; separate from page completeness and verified-read rules. */
  inferredReadPostPaths: z.array(z.strictObject({ path: z.string().max(512), count: z.number().int().min(1) })).max(20).optional(),
  inferredReadPostCount: z.number().int().min(0).optional(),
  blockedImpactCounts: z.strictObject({
    unclassified: z.number().int().min(0),
    unreadable_ping: z.number().int().min(0),
    verified_non_content_rule: z.number().int().min(0),
  }).optional(),
  changes: z.array(z.strictObject({
    kind: z.enum(['page_added', 'page_removed', 'view_added', 'view_removed', 'element_added', 'element_removed', 'locator_changed', 'options_changed']),
    pageKey: z.string().max(512),
    name: z.string().max(128).optional(),
  })).max(2000),
  changesTruncated: z.boolean(),
  durationSeconds: z.number().int().min(0),
  slices: z.number().int().min(0),
  detectedMenus: z.array(z.strictObject({
    label: z.string().trim().min(1).max(128),
    url: z.string().url().max(2048).optional(),
    menuAnchor: mapMenuAnchorSchema,
    hasChildren: z.boolean(),
  })).max(64).optional(),
})
export type MapIngestSummary = z.infer<typeof mapIngestSummarySchema>

export const mapIngestSurfaceQuerySchema = z.strictObject({
  targetAccountId: entityIdSchema.optional(),
})
export type MapIngestSurfaceQuery = z.infer<typeof mapIngestSurfaceQuerySchema>

export const mapIngestSurfaceResponseSchema = z.strictObject({
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema.nullable(),
  sourceJobId: entityIdSchema.nullable(),
  truncated: z.boolean(),
  pages: z.array(z.strictObject({
    entryId: entityIdSchema,
    pageKey: z.string().min(1).max(512),
    title: z.string().max(200),
    urlPattern: z.string().max(512),
    menuPath: z.array(z.string().max(128)).max(8),
    observedAt: utcInstantSchema,
    elementCount: z.number().int().min(0),
    viewCount: z.number().int().min(0),
    categories: z.strictObject({
      navigation: z.number().int().min(0), input: z.number().int().min(0),
      action_button: z.number().int().min(0), table_column: z.number().int().min(0),
      display: z.number().int().min(0),
    }),
    completeness: z.enum(['complete', 'partial']),
    lifecycle: z.enum(['observed', 'stale']),
    staleElements: z.number().int().min(0),
    changeKinds: z.array(mapIngestSummarySchema.shape.changes.element.shape.kind).max(8),
  })).max(1000),
})
export type MapIngestSurfaceResponse = z.infer<typeof mapIngestSurfaceResponseSchema>

export const targetKnowledgeContextQuerySchema = z.strictObject({
  targetAccountId: entityIdSchema.optional(),
  intent: z.string().trim().max(512).optional(),
  pageKey: z.string().max(512).optional(),
  menuPath: z.array(z.string().trim().max(128)).max(8).optional(),
  include: z.array(z.enum(['elements', 'options', 'changes', 'scenarios'])).max(4).optional(),
  maxPages: z.coerce.number().int().min(1).max(10).default(3),
})
export type TargetKnowledgeContextQuery = z.infer<typeof targetKnowledgeContextQuerySchema>

export const targetKnowledgeContextSchema = z.strictObject({
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema.nullable(),
  accountSelectionAmbiguous: z.boolean(),
  releaseId: entityIdSchema.nullable(),
  generatedAt: utcInstantSchema,
  menuTree: z.array(z.strictObject({
    entryId: entityIdSchema,
    name: z.string().max(128),
    pageKeys: z.array(z.string().max(512)).max(100),
  })).max(64),
  pages: z.array(z.strictObject({
    pageKey: z.string().max(512),
    menuPath: z.array(z.string().max(128)).max(8),
    title: z.string().max(200),
    urlPattern: z.string().max(512),
    views: z.array(z.strictObject({
      viewStateKey: z.string().max(512),
      label: z.string().max(128),
      elements: z.array(z.strictObject({
        /** 投影尚未追平或身份有歧义时为空，避免向助手提供虚构的资产引用。 */
        assetRef: z.string().max(256).nullable(),
        category: mapIngestElementSchema.shape.category,
        name: z.string().max(128),
        locator: targetDescriptorSchema,
        stability: z.enum(['high', 'medium', 'low']),
        options: z.array(z.string().max(128)).max(50).optional(),
        unsafeAction: z.boolean().optional(),
      })).max(100),
    })).max(20),
    recentChanges: mapIngestSummarySchema.shape.changes.optional(),
    relatedScenarios: z.array(z.strictObject({
      scenarioId: entityIdSchema,
      name: z.string().max(128),
    })).max(20).optional(),
  })).max(10),
  truncated: z.boolean(),
})
export type TargetKnowledgeContext = z.infer<typeof targetKnowledgeContextSchema>
