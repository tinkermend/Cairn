import { z } from 'zod'
import { evidenceMetadataSchema, evidenceTypeSchema, runEvidenceStatusSchema } from './evidence.js'
import { OBJECT_MISSING_REASONS } from './object-store.js'
import { outcomeStatusSchema } from './outcome.js'
import { attemptStatusSchema, runStatusSchema, stepRunStatusSchema } from './run.js'
import { entityIdSchema, jsonValueSchema, utcInstantSchema, type JsonValue } from './wire.js'

export const CLEANUP_FAILURE_MIN_ATTEMPTS = 5
export const EVIDENCE_EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000

export const CAPTURE_UPLOAD_MISSING_REASONS = [
  OBJECT_MISSING_REASONS.captureFailed,
  OBJECT_MISSING_REASONS.storeUnavailable,
  OBJECT_MISSING_REASONS.uploadIncomplete,
  OBJECT_MISSING_REASONS.workerLost,
  OBJECT_MISSING_REASONS.traceTooLarge,
  OBJECT_MISSING_REASONS.videoTooLarge,
] as const

export const EVIDENCE_DISPLAY_STATUSES = [
  'collecting',
  'available',
  'available_structured',
  'capture_upload_anomaly',
  'policy_purged',
  'run_deleted',
  'upload_incomplete_finalized',
  'manual_purged',
  'force_purged',
  'purged_unknown',
  'deleting',
  'unlinked',
] as const
export type EvidenceDisplayStatus = (typeof EVIDENCE_DISPLAY_STATUSES)[number]
export const evidenceDisplayStatusSchema = z.enum(EVIDENCE_DISPLAY_STATUSES)

export const EVIDENCE_AVAILABILITY_FILTERS = [
  'available',
  'collecting',
  'capture_upload_anomaly',
  'purged',
  'deleting',
  'protected',
  'unlinked',
  'expiring_soon',
  'due_for_purge',
  'purge_failed',
  'released',
] as const
export type EvidenceAvailabilityFilter = (typeof EVIDENCE_AVAILABILITY_FILTERS)[number]
export const evidenceAvailabilityFilterSchema = z.enum(EVIDENCE_AVAILABILITY_FILTERS)

export const EVIDENCE_SEARCH_VIEWS = [
  'recent_failures',
  'retried_success',
  'capture_upload_anomaly',
  'expiring_soon',
  'purge_failed',
] as const
export type EvidenceSearchView = (typeof EVIDENCE_SEARCH_VIEWS)[number]
export const evidenceSearchViewSchema = z.enum(EVIDENCE_SEARCH_VIEWS)

export const EVIDENCE_SORT_KEYS = ['createdAt_desc', 'retainUntil_asc', 'lastPurgeErrorAt_desc'] as const
export type EvidenceSortKey = (typeof EVIDENCE_SORT_KEYS)[number]
export const evidenceSortKeySchema = z.enum(EVIDENCE_SORT_KEYS)

export const EVIDENCE_TIME_PRESETS = ['24h', '7d', '30d', 'custom'] as const
export type EvidenceTimePreset = (typeof EVIDENCE_TIME_PRESETS)[number]
export const evidenceTimePresetSchema = z.enum(EVIDENCE_TIME_PRESETS)

export const EVIDENCE_HIT_KINDS = ['attempt_failed', 'run_failed'] as const
export type EvidenceHitKind = (typeof EVIDENCE_HIT_KINDS)[number]
export const evidenceHitKindSchema = z.enum(EVIDENCE_HIT_KINDS)

export const EVIDENCE_CENTER_TABS = ['search', 'reports', 'retention'] as const
export type EvidenceCenterTab = (typeof EVIDENCE_CENTER_TABS)[number]
export const evidenceCenterTabSchema = z.enum(EVIDENCE_CENTER_TABS)

export const EVIDENCE_RETENTION_OBJECT_VIEWS = [
  'pending_cleanup',
  'expiring_soon',
  'purge_failed',
  'deleted_run',
] as const
export type EvidenceRetentionObjectView = (typeof EVIDENCE_RETENTION_OBJECT_VIEWS)[number]
export const evidenceRetentionObjectViewSchema = z.enum(EVIDENCE_RETENTION_OBJECT_VIEWS)

export const EVIDENCE_DISPLAY_STATUS_LABELS: Record<EvidenceDisplayStatus, string> = {
  collecting: '收集中',
  available: '可查看',
  available_structured: '可查看（结构化）',
  capture_upload_anomaly: '采集／上传异常',
  policy_purged: '已按策略清理',
  run_deleted: '来源运行已删除',
  upload_incomplete_finalized: '未完成上传已收尾',
  manual_purged: '已人工清理',
  force_purged: '已强制清除',
  purged_unknown: '已清理（原因未知）',
  deleting: '删除处理中',
  unlinked: '关联未知',
}

export const EVIDENCE_AVAILABILITY_FILTER_LABELS: Record<EvidenceAvailabilityFilter, string> = {
  available: '可查看',
  collecting: '收集中',
  capture_upload_anomaly: '采集／上传异常',
  purged: '已清理',
  deleting: '删除处理中',
  protected: '保护中',
  unlinked: '关联未知',
  expiring_soon: '即将到期',
  due_for_purge: '已到期待清理',
  purge_failed: '清理失败',
  released: '已对外发布',
}

export const EVIDENCE_SEARCH_VIEW_LABELS: Record<EvidenceSearchView, string> = {
  recent_failures: '最近失败',
  retried_success: '重试后成功',
  capture_upload_anomaly: '采集与上传异常',
  expiring_soon: '即将过期',
  purge_failed: '清理失败',
}

export const EVIDENCE_TYPE_LABELS = {
  input: '输入',
  output: '输出',
  error: '错误',
  screenshot: '截图',
  log: '诊断',
  trace: 'Trace',
  video: '录像',
} as const

export function isCaptureUploadMissingReason(reason: string | null | undefined): boolean {
  return reason != null && (CAPTURE_UPLOAD_MISSING_REASONS as readonly string[]).includes(reason)
}

export function isCleanupFailed(input: {
  status: string
  purgeAttempts: number
  lastPurgeErrorAt: string | Date | null | undefined
}): boolean {
  if (input.status === 'purged') return false
  return input.purgeAttempts >= CLEANUP_FAILURE_MIN_ATTEMPTS || input.lastPurgeErrorAt != null
}

export function tallyKnownBytes(sizes: readonly (number | null | undefined)[]): {
  knownBytes: number
  unknownCount: number
} {
  let knownBytes = 0
  let unknownCount = 0
  for (const size of sizes) {
    if (size == null) unknownCount += 1
    else knownBytes += size
  }
  return { knownBytes, unknownCount }
}

export type EvidenceDisplayInput = {
  evidenceStatus: 'pending' | 'available' | 'missing'
  missingReason?: string | null
  objectId?: string | null
  objectKey?: string | null
  objectStatus?: string | null
  purgeReason?: string | null
  retainUntil?: string | null
  lastPurgeErrorAt?: string | null
  purgeAttempts?: number
  protectedUntil?: string | null | 'until_released'
  externalAccess?: boolean
  asOf: string
}

export type EvidenceDisplayProjection = {
  displayStatus: EvidenceDisplayStatus
  filterBuckets: EvidenceAvailabilityFilter[]
  overlayProtected: boolean
  reasonCode: string | null
  reasonUnknown: boolean
}

function isProtectedAt(protectedUntil: EvidenceDisplayInput['protectedUntil'], asOf: string): boolean {
  if (!protectedUntil) return false
  if (protectedUntil === 'until_released') return true
  return Date.parse(protectedUntil) > Date.parse(asOf)
}

export function projectEvidenceDisplay(input: EvidenceDisplayInput): EvidenceDisplayProjection {
  const overlayProtected = isProtectedAt(input.protectedUntil, input.asOf)
  const hasPointer = Boolean(input.objectId || input.objectKey)
  const objectLinked = input.objectStatus != null

  if (input.objectStatus === 'deleting') {
    return finishProjection('deleting', overlayProtected ? ['deleting', 'protected'] : ['deleting'], input.purgeReason ?? null, false, overlayProtected)
  }

  if (input.evidenceStatus === 'pending') {
    return finishProjection('collecting', overlayProtected ? ['collecting', 'protected'] : ['collecting'], null, false, overlayProtected)
  }

  if (input.evidenceStatus === 'available') {
    if (!hasPointer) {
      const buckets: EvidenceAvailabilityFilter[] = overlayProtected ? ['available', 'protected'] : ['available']
      if (input.externalAccess) buckets.push('released')
      return finishProjection('available_structured', buckets, null, false, overlayProtected)
    }
    if (!objectLinked) {
      return finishProjection('unlinked', ['unlinked'], null, true, false)
    }
    const buckets: EvidenceAvailabilityFilter[] = overlayProtected ? ['available', 'protected'] : ['available']
    if (input.retainUntil) {
      const retain = Date.parse(input.retainUntil)
      const asOf = Date.parse(input.asOf)
      if (Number.isFinite(retain) && Number.isFinite(asOf)) {
        if (retain <= asOf) buckets.push('due_for_purge')
        else if (retain <= asOf + EVIDENCE_EXPIRING_SOON_MS) buckets.push('expiring_soon')
      }
    }
    if (input.externalAccess) buckets.push('released')
    if (isCleanupFailed({
      status: input.objectStatus ?? 'available',
      purgeAttempts: input.purgeAttempts ?? 0,
      lastPurgeErrorAt: input.lastPurgeErrorAt,
    })) {
      buckets.push('purge_failed')
    }
    return finishProjection('available', buckets, null, false, overlayProtected)
  }

  if (isCaptureUploadMissingReason(input.missingReason)) {
    return finishProjection('capture_upload_anomaly', ['capture_upload_anomaly'], input.missingReason ?? null, false, false)
  }

  if (input.missingReason === OBJECT_MISSING_REASONS.purged) {
    if (!objectLinked) {
      return finishProjection('unlinked', ['unlinked'], OBJECT_MISSING_REASONS.purged, true, false)
    }
    if (input.purgeReason === 'expired') {
      return finishProjection('policy_purged', ['purged'], 'expired', false, false)
    }
    if (input.purgeReason === 'run_deleted') {
      return finishProjection('run_deleted', ['purged'], 'run_deleted', false, false)
    }
    if (input.purgeReason === 'upload_incomplete') {
      return finishProjection('upload_incomplete_finalized', ['capture_upload_anomaly'], 'upload_incomplete', false, false)
    }
    if (input.purgeReason === 'manual') {
      return finishProjection('manual_purged', ['purged'], 'manual', false, false)
    }
    if (input.purgeReason === 'force') {
      return finishProjection('force_purged', ['purged'], 'force', false, false)
    }
    return finishProjection('purged_unknown', ['purged'], input.purgeReason ?? null, true, false)
  }

  if (hasPointer && !objectLinked) {
    return finishProjection('unlinked', ['unlinked'], input.missingReason ?? null, true, false)
  }

  return finishProjection(
    'capture_upload_anomaly',
    ['capture_upload_anomaly'],
    input.missingReason ?? null,
    !input.missingReason,
    false,
  )
}

function finishProjection(
  displayStatus: EvidenceDisplayStatus,
  filterBuckets: EvidenceAvailabilityFilter[],
  reasonCode: string | null,
  reasonUnknown: boolean,
  overlayProtected: boolean,
): EvidenceDisplayProjection {
  return { displayStatus, filterBuckets, overlayProtected, reasonCode, reasonUnknown }
}

export function evidenceErrorSummary(value: JsonValue | null | undefined): string | null {
  if (value == null) return null
  if (typeof value === 'string') return clipSummary(value)
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, JsonValue>
    for (const key of ['safeMessage', 'message', 'code'] as const) {
      const candidate = record[key]
      if (typeof candidate === 'string' && candidate.trim()) return clipSummary(candidate)
    }
  }
  try {
    return clipSummary(JSON.stringify(value))
  } catch {
    return null
  }
}

function clipSummary(value: string): string {
  return value.length > 2000 ? `${value.slice(0, 1999)}…` : value
}

function emptyToUndefined(value: unknown): unknown {
  return value === '' || value === null ? undefined : value
}

function csvValues(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parts = (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item).split(','))
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts : undefined
}

function optionalId() {
  return z.preprocess(emptyToUndefined, entityIdSchema.optional())
}

function csvEnum<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(csvValues, z.array(schema).optional())
}

export const evidenceSearchQuerySchema = z.strictObject({
  asOf: z.preprocess(emptyToUndefined, utcInstantSchema.optional()),
  timePreset: z.preprocess(emptyToUndefined, evidenceTimePresetSchema.optional()),
  createdFrom: z.preprocess(emptyToUndefined, utcInstantSchema.optional()),
  createdTo: z.preprocess(emptyToUndefined, utcInstantSchema.optional()),
  timeZone: z.preprocess(emptyToUndefined, z.string().min(1).max(64).optional()),
  targetId: optionalId(),
  targetAccountId: optionalId(),
  scenarioId: optionalId(),
  scenarioVersionId: optionalId(),
  isTrial: z.preprocess(emptyToUndefined, z.coerce.boolean().optional()),
  runId: optionalId(),
  suiteId: optionalId(),
  suiteRunId: optionalId(),
  memberId: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(64).optional()),
  executionOrigin: z.preprocess(emptyToUndefined, z.enum(['standalone', 'suite_member']).optional()),
  evidenceId: optionalId(),
  stepRunId: optionalId(),
  attemptId: optionalId(),
  types: csvEnum(evidenceTypeSchema),
  runStatuses: csvEnum(runStatusSchema),
  stepRunStatuses: csvEnum(stepRunStatusSchema),
  attemptStatuses: csvEnum(attemptStatusSchema),
  outcomeStatuses: csvEnum(outcomeStatusSchema),
  runEvidenceStatuses: csvEnum(runEvidenceStatusSchema),
  availability: csvEnum(evidenceAvailabilityFilterSchema),
  view: z.preprocess(emptyToUndefined, evidenceSearchViewSchema.optional()),
  released: z.preprocess(emptyToUndefined, z.coerce.boolean().optional()),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
}).superRefine((query, ctx) => {
  if (query.memberId && !query.suiteRunId) {
    ctx.addIssue({ code: 'custom', path: ['memberId'], message: 'memberId 必须伴随 suiteRunId' })
  }
})
export type EvidenceSearchQuery = z.infer<typeof evidenceSearchQuerySchema>
export type EvidenceSearchQueryInput = z.input<typeof evidenceSearchQuerySchema>

export type NormalizedEvidenceSearch = {
  asOf: Date
  timePreset?: EvidenceTimePreset
  createdFrom?: Date
  createdTo?: Date
  timeZone?: string
  timeWindowLifted: boolean
  targetId?: string
  targetAccountId?: string
  scenarioId?: string
  scenarioVersionId?: string
  isTrial?: boolean
  runId?: string
  suiteId?: string
  suiteRunId?: string
  memberId?: string
  executionOrigin?: 'standalone' | 'suite_member'
  evidenceId?: string
  stepRunId?: string
  attemptId?: string
  types?: EvidenceSearchQuery['types']
  runStatuses?: EvidenceSearchQuery['runStatuses']
  stepRunStatuses?: EvidenceSearchQuery['stepRunStatuses']
  attemptStatuses?: EvidenceSearchQuery['attemptStatuses']
  outcomeStatuses?: EvidenceSearchQuery['outcomeStatuses']
  runEvidenceStatuses?: EvidenceSearchQuery['runEvidenceStatuses']
  availability?: EvidenceSearchQuery['availability']
  view?: EvidenceSearchView
  released?: boolean
  limit: number
  cursor?: string
  sort: EvidenceSortKey
}

export function liftsEvidenceTimeWindow(
  query: Pick<EvidenceSearchQuery, 'runId' | 'evidenceId' | 'view' | 'suiteId' | 'suiteRunId'>,
): boolean {
  return Boolean(
    query.runId ||
      query.evidenceId ||
      query.suiteId ||
      query.suiteRunId ||
      query.view === 'expiring_soon' ||
      query.view === 'purge_failed',
  )
}

export function sortKeyForEvidenceView(view?: EvidenceSearchView): EvidenceSortKey {
  if (view === 'expiring_soon') return 'retainUntil_asc'
  if (view === 'purge_failed') return 'lastPurgeErrorAt_desc'
  return 'createdAt_desc'
}

export function normalizeEvidenceSearchQuery(query: EvidenceSearchQuery, now = new Date()): NormalizedEvidenceSearch {
  const asOf = query.asOf ? new Date(query.asOf) : now
  const lift = liftsEvidenceTimeWindow(query)
  const preset = query.timePreset ?? (query.createdFrom || query.createdTo ? 'custom' : lift ? undefined : '7d')
  let createdFrom = query.createdFrom ? new Date(query.createdFrom) : undefined
  let createdTo = query.createdTo ? new Date(query.createdTo) : undefined
  if (!createdFrom && !createdTo) {
    if (preset === '24h') createdFrom = new Date(asOf.getTime() - 24 * 60 * 60 * 1000)
    else if (preset === '7d') createdFrom = new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000)
    else if (preset === '30d') createdFrom = new Date(asOf.getTime() - 30 * 24 * 60 * 60 * 1000)
  }
  if (createdTo && createdTo > asOf) createdTo = asOf
  return {
    asOf,
    timePreset: preset,
    createdFrom,
    createdTo,
    timeZone: query.timeZone,
    timeWindowLifted: lift && !query.timePreset && !query.createdFrom && !query.createdTo,
    targetId: query.targetId,
    targetAccountId: query.targetAccountId,
    scenarioId: query.scenarioId,
    scenarioVersionId: query.scenarioVersionId,
    isTrial: query.isTrial,
    runId: query.runId,
    suiteId: query.suiteId,
    suiteRunId: query.suiteRunId,
    memberId: query.memberId,
    executionOrigin: query.executionOrigin,
    evidenceId: query.evidenceId,
    stepRunId: query.stepRunId,
    attemptId: query.attemptId,
    types: query.types,
    runStatuses: query.runStatuses,
    stepRunStatuses: query.stepRunStatuses,
    attemptStatuses: query.attemptStatuses,
    outcomeStatuses: query.outcomeStatuses,
    runEvidenceStatuses: query.runEvidenceStatuses,
    availability: query.availability,
    view: query.view,
    released: query.released,
    limit: query.limit,
    cursor: query.cursor,
    sort: sortKeyForEvidenceView(query.view),
  }
}

export function evidenceSearchCursorPayload(normalized: NormalizedEvidenceSearch): Record<string, unknown> {
  return {
    asOf: normalized.asOf.toISOString(),
    sort: normalized.sort,
    limit: normalized.limit,
    timePreset: normalized.timePreset ?? null,
    createdFrom: normalized.createdFrom?.toISOString() ?? null,
    createdTo: normalized.createdTo?.toISOString() ?? null,
    targetId: normalized.targetId ?? null,
    targetAccountId: normalized.targetAccountId ?? null,
    scenarioId: normalized.scenarioId ?? null,
    scenarioVersionId: normalized.scenarioVersionId ?? null,
    isTrial: normalized.isTrial ?? null,
    runId: normalized.runId ?? null,
    suiteId: normalized.suiteId ?? null,
    suiteRunId: normalized.suiteRunId ?? null,
    memberId: normalized.memberId ?? null,
    executionOrigin: normalized.executionOrigin ?? null,
    evidenceId: normalized.evidenceId ?? null,
    stepRunId: normalized.stepRunId ?? null,
    attemptId: normalized.attemptId ?? null,
    types: normalized.types ?? null,
    runStatuses: normalized.runStatuses ?? null,
    stepRunStatuses: normalized.stepRunStatuses ?? null,
    attemptStatuses: normalized.attemptStatuses ?? null,
    outcomeStatuses: normalized.outcomeStatuses ?? null,
    runEvidenceStatuses: normalized.runEvidenceStatuses ?? null,
    availability: normalized.availability ?? null,
    view: normalized.view ?? null,
    released: normalized.released ?? null,
  }
}

export const evidenceSearchItemSchema = z.object({
  evidence: evidenceMetadataSchema,
  targetId: entityIdSchema,
  targetName: z.string(),
  targetNameCurrent: z.string(),
  targetDeleted: z.boolean(),
  scenarioId: entityIdSchema,
  scenarioName: z.string(),
  scenarioNameCurrent: z.string(),
  scenarioDeleted: z.boolean(),
  scenarioVersionId: entityIdSchema,
  scenarioVersionNo: z.number().int().nullable(),
  scenarioVersionKind: z.enum(['published', 'trial']),
  stepName: z.string().nullable(),
  stepOrdinal: z.number().int().nullable(),
  attemptNo: z.number().int().nullable(),
  runStatus: runStatusSchema,
  stepRunStatus: stepRunStatusSchema.nullable(),
  attemptStatus: attemptStatusSchema.nullable(),
  outcomeStatus: outcomeStatusSchema,
  runEvidenceStatus: runEvidenceStatusSchema,
  displayStatus: evidenceDisplayStatusSchema,
  displayStatusLabel: z.string(),
  filterBuckets: z.array(evidenceAvailabilityFilterSchema),
  overlayProtected: z.boolean(),
  retainUntil: utcInstantSchema.nullable(),
  retainUntilUnknown: z.boolean(),
  byteSize: z.number().int().nonnegative().nullable(),
  byteSizeUnknown: z.boolean(),
  errorSummary: z.string().nullable(),
  hitKind: evidenceHitKindSchema.optional(),
  objectId: entityIdSchema.optional(),
  objectLinked: z.boolean(),
  reasonCode: z.string().nullable(),
  reasonUnknown: z.boolean(),
})
export type EvidenceSearchItem = z.infer<typeof evidenceSearchItemSchema>

export const evidenceRelatedRunGapSchema = z.object({
  runId: entityIdSchema,
  evidenceStatus: runEvidenceStatusSchema,
  status: runStatusSchema,
})
export type EvidenceRelatedRunGap = z.infer<typeof evidenceRelatedRunGapSchema>

export const evidenceSearchSummarySchema = z.object({
  evidenceCount: z.number().int().nonnegative(),
  objectCount: z.number().int().nonnegative(),
  knownBytes: z.number().int().nonnegative(),
  unknownByteObjects: z.number().int().nonnegative(),
})
export type EvidenceSearchSummary = z.infer<typeof evidenceSearchSummarySchema>

export const evidenceSearchResponseSchema = z.object({
  items: z.array(evidenceSearchItemSchema),
  nextCursor: z.string().min(1).optional(),
  prevCursor: z.string().min(1).optional(),
  asOf: utcInstantSchema,
  readAt: utcInstantSchema,
  timeZone: z.string().optional(),
  timeWindowLifted: z.boolean(),
  sort: evidenceSortKeySchema,
  summary: evidenceSearchSummarySchema,
  relatedRunGaps: z
    .object({
      count: z.number().int().nonnegative(),
      items: z.array(evidenceRelatedRunGapSchema),
    })
    .optional(),
})
export type EvidenceSearchResponse = z.infer<typeof evidenceSearchResponseSchema>

export const evidenceRelatedRefSchema = z.object({
  evidenceId: entityIdSchema,
  type: evidenceTypeSchema,
  displayStatus: evidenceDisplayStatusSchema,
})
export type EvidenceRelatedRef = z.infer<typeof evidenceRelatedRefSchema>

export const evidenceDetailResponseSchema = z.object({
  item: evidenceSearchItemSchema,
  related: z.object({
    sameAttempt: z.array(evidenceRelatedRefSchema),
    runVideo: evidenceRelatedRefSchema.nullable(),
  }),
  payload: jsonValueSchema.optional(),
  attemptError: jsonValueSchema.optional(),
})
export type EvidenceDetailResponse = z.infer<typeof evidenceDetailResponseSchema>

export const evidenceByteTallySchema = z.object({
  objectCount: z.number().int().nonnegative(),
  knownBytes: z.number().int().nonnegative(),
  unknownByteObjects: z.number().int().nonnegative(),
})
export type EvidenceByteTally = z.infer<typeof evidenceByteTallySchema>

export const evidenceRetentionSummaryResponseSchema = z.object({
  asOf: utcInstantSchema,
  readAt: utcInstantSchema,
  accessible: evidenceByteTallySchema.extend({
    expiringSoon: evidenceByteTallySchema,
    pendingCleanup: evidenceByteTallySchema,
    purgeFailed: z.number().int().nonnegative(),
    byTarget: z.array(
      evidenceByteTallySchema.extend({
        targetId: entityIdSchema,
        targetName: z.string(),
      }),
    ),
    byType: z.array(
      evidenceByteTallySchema.extend({
        type: evidenceTypeSchema.or(z.literal('unlinked')),
      }),
    ),
  }),
  deletedRunCleanup: evidenceByteTallySchema.extend({
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
  }),
  canListDeletedRunObjects: z.boolean(),
})
export type EvidenceRetentionSummaryResponse = z.infer<typeof evidenceRetentionSummaryResponseSchema>

export const evidenceRetentionObjectsQuerySchema = z.strictObject({
  asOf: z.preprocess(emptyToUndefined, utcInstantSchema.optional()),
  view: z.preprocess(
    (value) => emptyToUndefined(value) ?? 'pending_cleanup',
    evidenceRetentionObjectViewSchema,
  ),
  targetId: optionalId(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
})
export type EvidenceRetentionObjectsQuery = z.infer<typeof evidenceRetentionObjectsQuerySchema>

export const evidenceRetentionObjectItemSchema = z.object({
  objectId: entityIdSchema,
  runId: entityIdSchema,
  runDeleted: z.boolean(),
  sourceIdVisible: z.boolean(),
  hasEvidence: z.boolean(),
  evidenceId: entityIdSchema.nullable(),
  type: evidenceTypeSchema.nullable(),
  status: z.string(),
  purgeReason: z.string().nullable(),
  candidateReason: z.enum(['expired', 'upload_incomplete', 'run_deleted', 'purge_failed', 'expiring_soon']),
  retainUntil: utcInstantSchema.nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  byteSizeUnknown: z.boolean(),
  purgeAttempts: z.number().int().nonnegative(),
  lastPurgeErrorAt: utcInstantSchema.nullable(),
  targetName: z.string().nullable(),
})
export type EvidenceRetentionObjectItem = z.infer<typeof evidenceRetentionObjectItemSchema>

export const evidenceRetentionObjectsResponseSchema = z.object({
  items: z.array(evidenceRetentionObjectItemSchema),
  nextCursor: z.string().min(1).optional(),
  prevCursor: z.string().min(1).optional(),
  asOf: utcInstantSchema,
  readAt: utcInstantSchema,
  view: evidenceRetentionObjectViewSchema,
  withheldDeletedRunItems: z.boolean(),
})
export type EvidenceRetentionObjectsResponse = z.infer<typeof evidenceRetentionObjectsResponseSchema>
