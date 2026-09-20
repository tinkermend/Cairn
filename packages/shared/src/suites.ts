import { z } from 'zod'
import { nextCursorSchema } from './rbac.js'
import { resourceDeletedBySchema } from './resource-lifecycle.js'
import { outcomeStatusSchema } from './outcome.js'
import { runEvidenceStatusSchema } from './evidence.js'
import { runStatusSchema } from './run.js'
import { entityIdSchema, jsonValueSchema, runtimeSchemaVersionSchema, utcInstantSchema, type JsonValue } from './wire.js'

export const SUITE_ADMISSION_PROTOCOL = 'suite-admission@1' as const
export const SUITE_SCHEDULER_PROTOCOL = 'suite-scheduler@1' as const

export const SUITE_STATUSES = ['active', 'disabled'] as const
export type SuiteStatus = (typeof SUITE_STATUSES)[number]
export const suiteStatusSchema = z.enum(SUITE_STATUSES)

export const SUITE_FAILURE_POLICIES = ['continue', 'stop'] as const
export type SuiteFailurePolicy = (typeof SUITE_FAILURE_POLICIES)[number]
export const suiteFailurePolicySchema = z.enum(SUITE_FAILURE_POLICIES)

export const SUITE_MEMBER_ADMISSIONS = ['PENDING', 'ACTIVE', 'SETTLED', 'SKIPPED'] as const
export type SuiteMemberAdmission = (typeof SUITE_MEMBER_ADMISSIONS)[number]
export const suiteMemberAdmissionSchema = z.enum(SUITE_MEMBER_ADMISSIONS)

export const SUITE_RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'WAITING',
  'NEEDS_REVIEW',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
] as const
export type SuiteRunStatus = (typeof SUITE_RUN_STATUSES)[number]
export const suiteRunStatusSchema = z.enum(SUITE_RUN_STATUSES)

export const SUITE_VERDICTS = ['all_pass', 'pass_with_warnings', 'anomalies_found', 'incomplete'] as const
export type SuiteVerdict = (typeof SUITE_VERDICTS)[number]
export const suiteVerdictSchema = z.enum(SUITE_VERDICTS)

export const SUITE_VERDICT_LABELS: Record<SuiteVerdict, string> = {
  all_pass: '全部通过',
  pass_with_warnings: '通过但有提示',
  anomalies_found: '发现异常',
  incomplete: '无法完整判断',
}

export const EXECUTION_ORIGINS = ['standalone', 'suite_member'] as const
export type ExecutionOrigin = (typeof EXECUTION_ORIGINS)[number]
export const executionOriginSchema = z.enum(EXECUTION_ORIGINS)

export const MAX_SUITE_MEMBERS = 50
export const MAX_SUITE_SNAPSHOT_BYTES = 16 * 1024 * 1024
export const DEFAULT_SUITE_DEADLINE_MS = 60 * 60 * 1000
export const MIN_SUITE_DEADLINE_MS = 60 * 1000
export const MAX_SUITE_DEADLINE_MS = 24 * 60 * 60 * 1000

export const suiteMemberIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'memberId 须以字母开头，只含字母数字、_ 和 -')

export const suiteNameSchema = z.string().trim().min(1).max(128)

export const suiteGroupSchema = z.strictObject({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(128),
})
export type SuiteGroup = z.infer<typeof suiteGroupSchema>

export const suiteMemberSchema = z.strictObject({
  memberId: suiteMemberIdSchema,
  ordinal: z.number().int().min(0).max(MAX_SUITE_MEMBERS - 1),
  groupId: z.string().trim().min(1).max(64).optional(),
  scenarioId: entityIdSchema,
  scenarioVersionId: entityIdSchema,
  displayName: z.string().trim().min(1).max(128).optional(),
  input: z.record(z.string(), jsonValueSchema).default({}),
  targetAccountId: entityIdSchema.optional(),
  reportProfileId: entityIdSchema.optional(),
})
export type SuiteMember = z.infer<typeof suiteMemberSchema>

export const suiteDocumentSchema = z
  .strictObject({
    schemaVersion: runtimeSchemaVersionSchema,
    groups: z.array(suiteGroupSchema).max(20).default([]),
    members: z.array(suiteMemberSchema).max(MAX_SUITE_MEMBERS).default([]),
    sharedInput: z.record(z.string(), jsonValueSchema).default({}),
    defaultTargetAccountId: entityIdSchema.optional(),
    failurePolicy: suiteFailurePolicySchema.default('continue'),
    reportProfileId: entityIdSchema.optional(),
    autoGenerateFinalReport: z.boolean().default(false),
  })
  .superRefine((document, ctx) => {
    const groupIds = new Set<string>()
    for (const [index, group] of document.groups.entries()) {
      if (groupIds.has(group.id)) {
        ctx.addIssue({ code: 'custom', path: ['groups', index, 'id'], message: '分组 id 不能重复' })
      }
      groupIds.add(group.id)
    }
    const memberIds = new Set<string>()
    const ordinals = new Set<number>()
    for (const [index, member] of document.members.entries()) {
      if (memberIds.has(member.memberId)) {
        ctx.addIssue({ code: 'custom', path: ['members', index, 'memberId'], message: 'memberId 必须唯一' })
      }
      memberIds.add(member.memberId)
      if (ordinals.has(member.ordinal)) {
        ctx.addIssue({ code: 'custom', path: ['members', index, 'ordinal'], message: '成员序号不能重复' })
      }
      ordinals.add(member.ordinal)
      if (member.groupId && !groupIds.has(member.groupId)) {
        ctx.addIssue({ code: 'custom', path: ['members', index, 'groupId'], message: '分组不存在' })
      }
    }
  })
export type SuiteDocument = z.infer<typeof suiteDocumentSchema>

export const EMPTY_SUITE_DOCUMENT: SuiteDocument = suiteDocumentSchema.parse({
  schemaVersion: 1,
  groups: [],
  members: [],
})

export const suiteAdmissionSnapshotSchema = z.strictObject({
  protocol: z.literal(SUITE_ADMISSION_PROTOCOL),
  suiteRunId: entityIdSchema,
  memberId: suiteMemberIdSchema,
})
export type SuiteAdmissionSnapshot = z.infer<typeof suiteAdmissionSnapshotSchema>

export function mergeSuiteMemberInput(input: {
  sharedInput?: Record<string, JsonValue>
  memberInput?: Record<string, JsonValue>
  runOverride?: Record<string, JsonValue>
}): Record<string, JsonValue> {
  return {
    ...(input.sharedInput ?? {}),
    ...(input.memberInput ?? {}),
    ...(input.runOverride ?? {}),
  }
}

export function resolveSuiteMemberAccountId(input: {
  runMemberAccountId?: string
  memberAccountId?: string
  runDefaultAccountId?: string
  suiteDefaultAccountId?: string
}): string | undefined {
  return (
    input.runMemberAccountId ??
    input.memberAccountId ??
    input.runDefaultAccountId ??
    input.suiteDefaultAccountId
  )
}

export type SuiteMemberOutcomeSlice = {
  admission: SuiteMemberAdmission
  runStatus?: string
  outcomeStatus?: string
}

export function aggregateSuiteVerdict(members: readonly SuiteMemberOutcomeSlice[]): SuiteVerdict {
  const settled = members.filter((item) => item.admission === 'SETTLED')
  const skipped = members.filter((item) => item.admission === 'SKIPPED')
  const unfinished = members.filter((item) => item.admission === 'PENDING' || item.admission === 'ACTIVE')
  const hasFail = settled.some((item) => item.outcomeStatus === 'FAIL')
  if (hasFail) return 'anomalies_found'
  const hasIncomplete =
    unfinished.length > 0 ||
    skipped.length > 0 ||
    settled.some(
      (item) =>
        item.runStatus === 'FAILED' ||
        item.runStatus === 'CANCELLED' ||
        item.outcomeStatus === 'UNKNOWN' ||
        item.outcomeStatus === 'NOT_EVALUATED',
    )
  if (hasIncomplete) return 'incomplete'
  if (settled.some((item) => item.outcomeStatus === 'WARN')) return 'pass_with_warnings'
  return 'all_pass'
}

export const suiteListQuerySchema = z.object({
  targetId: entityIdSchema.optional(),
  status: suiteStatusSchema.optional(),
  q: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
})
export type SuiteListQuery = z.infer<typeof suiteListQuerySchema>

export const suiteSummarySchema = z.object({
  id: entityIdSchema,
  targetId: entityIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  status: suiteStatusSchema,
  draftRevision: z.number().int().positive(),
  publishedVersionNo: z.number().int().positive().nullable(),
  memberCount: z.number().int().nonnegative(),
  updatedAt: utcInstantSchema,
})
export type SuiteSummaryDto = z.infer<typeof suiteSummarySchema>

export const suiteListResponseSchema = z.object({
  items: z.array(suiteSummarySchema),
  nextCursor: nextCursorSchema,
})
export type SuiteListResponse = z.infer<typeof suiteListResponseSchema>

export const suiteDraftDtoSchema = z.object({
  revision: z.number().int().positive(),
  document: suiteDocumentSchema,
  updatedAt: utcInstantSchema,
})
export type SuiteDraftDto = z.infer<typeof suiteDraftDtoSchema>

export const suiteVersionDtoSchema = z.object({
  id: entityIdSchema,
  versionNo: z.number().int().positive(),
  document: suiteDocumentSchema,
  digest: z.string(),
  publishedAt: utcInstantSchema,
  publishedBy: entityIdSchema,
})
export type SuiteVersionDto = z.infer<typeof suiteVersionDtoSchema>

export const suiteDetailSchema = z.object({
  id: entityIdSchema,
  targetId: entityIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  status: suiteStatusSchema,
  draft: suiteDraftDtoSchema,
  published: suiteVersionDtoSchema.nullable(),
  deletedAt: utcInstantSchema.nullable(),
  deletedBy: resourceDeletedBySchema.nullable(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type SuiteDetailDto = z.infer<typeof suiteDetailSchema>

export const createSuiteBodySchema = z.strictObject({
  targetId: entityIdSchema,
  name: suiteNameSchema,
  description: z.string().trim().max(2000).optional(),
  document: suiteDocumentSchema.optional(),
})
export type CreateSuiteBody = z.infer<typeof createSuiteBodySchema>

export const saveSuiteDraftBodySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  name: suiteNameSchema.optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  document: suiteDocumentSchema,
})
export type SaveSuiteDraftBody = z.infer<typeof saveSuiteDraftBodySchema>

export const publishSuiteBodySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(8).max(128),
})
export type PublishSuiteBody = z.infer<typeof publishSuiteBodySchema>

export const updateSuiteEnabledBodySchema = z.strictObject({
  status: suiteStatusSchema,
})
export type UpdateSuiteEnabledBody = z.infer<typeof updateSuiteEnabledBodySchema>

export const suiteValidationIssueSchema = z.object({
  memberId: suiteMemberIdSchema.optional(),
  code: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
})
export type SuiteValidationIssue = z.infer<typeof suiteValidationIssueSchema>

export function assertPublishedSuiteDocument(document: SuiteDocument): SuiteValidationIssue[] {
  const issues: SuiteValidationIssue[] = []
  if (document.members.length === 0) {
    issues.push({ code: 'SUITE_EMPTY', message: '发布前至少需要一个成员', severity: 'error' })
  }
  return issues
}

export const suiteValidateResponseSchema = z.object({
  ok: z.boolean(),
  issues: z.array(suiteValidationIssueSchema),
})
export type SuiteValidateResponse = z.infer<typeof suiteValidateResponseSchema>

export const suiteRunListQuerySchema = z.object({
  targetId: entityIdSchema.optional(),
  suiteId: entityIdSchema.optional(),
  status: suiteRunStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
})
export type SuiteRunListQuery = z.infer<typeof suiteRunListQuerySchema>

export const createSuiteRunBodySchema = z.strictObject({
  suiteId: entityIdSchema,
  suiteVersionId: entityIdSchema.optional(),
  sharedInput: z.record(z.string(), jsonValueSchema).optional(),
  defaultTargetAccountId: entityIdSchema.optional(),
  memberOverrides: z
    .record(
      suiteMemberIdSchema,
      z.strictObject({
        input: z.record(z.string(), jsonValueSchema).optional(),
        targetAccountId: entityIdSchema.optional(),
      }),
    )
    .optional(),
  deadlineMs: z.number().int().min(MIN_SUITE_DEADLINE_MS).max(MAX_SUITE_DEADLINE_MS).optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
})
export type CreateSuiteRunBody = z.infer<typeof createSuiteRunBodySchema>

export const suiteRunCountsSchema = z.object({
  planned: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
})
export type SuiteRunCounts = z.infer<typeof suiteRunCountsSchema>

export const suiteRunItemDtoSchema = z.object({
  memberId: suiteMemberIdSchema,
  ordinal: z.number().int().nonnegative(),
  groupId: z.string().nullable(),
  displayName: z.string(),
  scenarioId: entityIdSchema,
  scenarioVersionId: entityIdSchema,
  childRunId: entityIdSchema,
  admission: suiteMemberAdmissionSchema,
  skipReason: z.string().nullable(),
  runStatus: runStatusSchema,
  outcomeStatus: outcomeStatusSchema,
  evidenceStatus: runEvidenceStatusSchema,
  targetAccountId: entityIdSchema.nullable(),
})
export type SuiteRunItemDto = z.infer<typeof suiteRunItemDtoSchema>

export const suiteRunObservationSchema = z.object({
  id: entityIdSchema,
  suiteId: entityIdSchema,
  suiteVersionId: entityIdSchema,
  targetId: entityIdSchema,
  status: suiteRunStatusSchema,
  verdict: suiteVerdictSchema.nullable(),
  evidenceStatus: runEvidenceStatusSchema,
  cancelRequested: z.boolean(),
  reason: z.string().nullable(),
  failurePolicy: suiteFailurePolicySchema,
  deadlineAt: utcInstantSchema,
  startedAt: utcInstantSchema.nullable(),
  finishedAt: utcInstantSchema.nullable(),
  wallClockMs: z.number().int().nonnegative().nullable(),
  childDurationMs: z.number().int().nonnegative().nullable(),
  counts: suiteRunCountsSchema,
  revision: z.number().int().nonnegative(),
  eventSeq: z.number().int().nonnegative(),
  items: z.array(suiteRunItemDtoSchema),
  readAt: utcInstantSchema,
  createdAt: utcInstantSchema,
  automaticReport: z.object({ status: z.enum(['pending', 'created', 'skipped', 'failed']), reportId: entityIdSchema.nullable(), reason: z.string().nullable() }).nullable().optional(),
})
export type SuiteRunObservation = z.infer<typeof suiteRunObservationSchema>

export const suiteRunSummarySchema = suiteRunObservationSchema.omit({ items: true }).extend({
  suiteName: z.string(),
  plannedCount: z.number().int().nonnegative(),
})
export type SuiteRunSummaryDto = z.infer<typeof suiteRunSummarySchema>

export const suiteRunListResponseSchema = z.object({
  items: z.array(suiteRunSummarySchema),
  nextCursor: nextCursorSchema,
})
export type SuiteRunListResponse = z.infer<typeof suiteRunListResponseSchema>

export const suiteRunPreviewMemberSchema = z.object({
  memberId: suiteMemberIdSchema,
  ordinal: z.number().int().nonnegative(),
  displayName: z.string(),
  scenarioId: entityIdSchema,
  scenarioName: z.string(),
  scenarioVersionId: entityIdSchema,
  effectiveInput: z.record(z.string(), jsonValueSchema),
  targetAccountId: entityIdSchema.nullable(),
  issues: z.array(suiteValidationIssueSchema),
  entryNavigationWarning: z.boolean(),
})
export type SuiteRunPreviewMember = z.infer<typeof suiteRunPreviewMemberSchema>

export const suiteRunPreviewResponseSchema = z.object({
  suiteId: entityIdSchema,
  suiteVersionId: entityIdSchema,
  targetId: entityIdSchema,
  failurePolicy: suiteFailurePolicySchema,
  deadlineAt: utcInstantSchema,
  accountInterleaveHint: z.literal(true),
  aiBudgetNotReserved: z.literal(true),
  notificationNote: z.string(),
  members: z.array(suiteRunPreviewMemberSchema),
  issues: z.array(suiteValidationIssueSchema),
})
export type SuiteRunPreviewResponse = z.infer<typeof suiteRunPreviewResponseSchema>

export const suiteRunEventDtoSchema = z.object({
  seq: z.number().int().nonnegative(),
  type: z.string(),
  payload: z.record(z.string(), jsonValueSchema).optional(),
  createdAt: utcInstantSchema,
})
export type SuiteRunEventDto = z.infer<typeof suiteRunEventDtoSchema>
