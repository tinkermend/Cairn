import { z } from 'zod'
import { pageRefSchema } from './managed-browser.js'
import type { IdentityState } from './session-auth.js'
import type { SessionAuthState, SessionStatus } from './session.js'
import { SESSION_MAINTENANCE_KINDS, type SessionLeasePurpose } from './session-occupancy.js'
export { SESSION_MAINTENANCE_KINDS } from './session-occupancy.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'
import { nextCursorSchema } from './rbac.js'

/** Worker 领取 C 的维护 kind 必须声明；与 occupancy@2 并存。 */
export const SESSION_MAINTENANCE_PROTOCOL = 'session-maintenance@1' as const

export type SessionMaintenanceKind = (typeof SESSION_MAINTENANCE_KINDS)[number]
export const sessionMaintenanceKindSchema = z.enum(SESSION_MAINTENANCE_KINDS)

export const SESSION_LEASE_CLAIM_KINDS = [
  'PREPARE',
  'VERIFY_AUTH',
  'LOGIN',
  'RENEW_AUTH',
  'REFRESH_LOGIN_PAGE',
] as const
export type SessionLeaseClaimKind = (typeof SESSION_LEASE_CLAIM_KINDS)[number]

export const SESSION_IDLE_ONLY_KINDS = ['CLOSE', 'RESTART', 'RESET_PROFILE'] as const
export type SessionIdleOnlyKind = (typeof SESSION_IDLE_ONLY_KINDS)[number]

export const ACCOUNT_SESSION_STATUSES = [
  'unprepared',
  'ready',
  'needs_check',
  'needs_login',
  'identity_mismatch',
  'maintenance',
  'executing',
  'lost',
] as const
export type AccountSessionStatus = (typeof ACCOUNT_SESSION_STATUSES)[number]
export const accountSessionStatusSchema = z.enum(ACCOUNT_SESSION_STATUSES)

export const SESSION_OVERVIEW_FILTERS = [
  'available',
  'needs_check',
  'needs_login',
  'identity_mismatch',
  'maintenance',
  'executing',
  'lost',
  'unprepared',
  'retained',
] as const
export type SessionOverviewFilter = (typeof SESSION_OVERVIEW_FILTERS)[number]
export const sessionOverviewFilterSchema = z.enum(SESSION_OVERVIEW_FILTERS)

export const SESSION_SYSTEM_OVERVIEW_FILTERS = [
  'problem',
  'unprepared',
  'ready',
  'busy',
  'retained',
] as const
export type SessionSystemOverviewFilter = (typeof SESSION_SYSTEM_OVERVIEW_FILTERS)[number]
export const sessionSystemOverviewFilterSchema = z.enum(SESSION_SYSTEM_OVERVIEW_FILTERS)

export const ACCOUNT_SESSION_BUCKETS = ['ready', 'problem', 'unprepared', 'busy'] as const
export type AccountSessionBucket = (typeof ACCOUNT_SESSION_BUCKETS)[number]

const WORST_ACCOUNT_SESSION_STATUS: readonly AccountSessionStatus[] = [
  'lost',
  'identity_mismatch',
  'needs_login',
  'needs_check',
  'maintenance',
  'executing',
  'unprepared',
  'ready',
]

export const SESSION_MAINTENANCE_ERROR_CODES = [
  'SESSION_OPERATION_CONFLICT',
  'SESSION_GENERATION_CHANGED',
  'RETENTION_QUOTA_EXCEEDED',
  'PAGE_REFRESH_UNSAFE',
  'OPERATION_INTERRUPTED',
  'OUTCOME_UNKNOWN',
  'OPERATION_QUEUE_EXPIRED',
  'AUTH_PROFILE_REQUIRED',
  'SESSION_KEEPALIVE_ABANDONED',
] as const
export type SessionMaintenanceErrorCode = (typeof SESSION_MAINTENANCE_ERROR_CODES)[number]
export const sessionMaintenanceErrorCodeSchema = z.enum(SESSION_MAINTENANCE_ERROR_CODES)

export const SESSION_MAINTENANCE_ERROR_MESSAGES: Record<SessionMaintenanceErrorCode, string> = {
  SESSION_OPERATION_CONFLICT: '会话操作冲突',
  SESSION_GENERATION_CHANGED: '会话已重建',
  RETENTION_QUOTA_EXCEEDED: '该执行节点保留配额已满',
  PAGE_REFRESH_UNSAFE: '当前页不能安全刷新到登录页',
  OPERATION_INTERRUPTED: '操作被中断',
  OUTCOME_UNKNOWN: '登录结果无法确认',
  OPERATION_QUEUE_EXPIRED: '维护操作排队已过期',
  AUTH_PROFILE_REQUIRED: '尚未发布并通过验收的主动检测规则，无法做主动核验、续登或认证保活',
  SESSION_KEEPALIVE_ABANDONED: '认证已失效且自动登录不可用，已停止保活巡检',
}

export const SESSION_EVENT_TYPES = [
  'operation.requested',
  'operation.claimed',
  'operation.waiting_for_auth',
  'operation.finished',
  'operation.cancelled',
  'retention.set',
  'retention.extended',
  'retention.cleared',
  'session.closed',
  'session.restarted',
  'session.lost',
  'profile.reset',
  'auth.control_changed',
  'auth.attempt_started',
  'auth.verified',
  'auth.unknown',
  'auth.signal_observed',
  'session.keepalive_extended',
  'session.evicted',
] as const
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number]
export const sessionEventTypeSchema = z.enum(SESSION_EVENT_TYPES)

export const DEFAULT_MAX_RETAIN_SECONDS = 28_800
export const DEFAULT_RESERVED_FREE_SLOTS_PER_WORKER = 1
export const DEFAULT_MAINTENANCE_INTERVAL_SECONDS = 300
export const DEFAULT_RENEW_BEFORE_SECONDS = 60

export const platformSessionRetentionSchema = z.strictObject({
  maxRetainSeconds: z.number().int().min(60).max(604_800),
  reservedFreeSlotsPerWorker: z.number().int().min(0).max(32),
  maintenanceIntervalSeconds: z.number().int().min(30).max(86_400),
  renewBeforeSeconds: z.number().int().min(1).max(3_600),
})
export type PlatformSessionRetention = z.infer<typeof platformSessionRetentionSchema>

export const FACTORY_SESSION_RETENTION: PlatformSessionRetention = {
  maxRetainSeconds: DEFAULT_MAX_RETAIN_SECONDS,
  reservedFreeSlotsPerWorker: DEFAULT_RESERVED_FREE_SLOTS_PER_WORKER,
  maintenanceIntervalSeconds: DEFAULT_MAINTENANCE_INTERVAL_SECONDS,
  renewBeforeSeconds: DEFAULT_RENEW_BEFORE_SECONDS,
}

export function isSessionMaintenanceKind(kind: string): kind is SessionMaintenanceKind {
  return (SESSION_MAINTENANCE_KINDS as readonly string[]).includes(kind)
}

export function isSessionLeaseClaimKind(kind: string): kind is SessionLeaseClaimKind {
  return (SESSION_LEASE_CLAIM_KINDS as readonly string[]).includes(kind)
}

export function isSessionIdleOnlyKind(kind: string): kind is SessionIdleOnlyKind {
  return (SESSION_IDLE_ONLY_KINDS as readonly string[]).includes(kind)
}

export function maintenanceIdempotencyKey(
  prefix: 'bg-verify' | 'bg-renew' | 'bg-restart',
  accountId: string,
  slot: number,
): string {
  return `${prefix}:${accountId}:${slot}`
}

export function maintenanceWindowSlot(nowMs: number, intervalSeconds: number): number {
  return Math.floor(nowMs / 1000 / intervalSeconds)
}

/** 信号与兜底巡检共用同一把尺，避免排出两个 bg-verify。 */
export function backgroundVerifyWindowSlot(
  nowMs: number,
  authProbeIntervalSeconds: number | null | undefined,
  fallbackIntervalSeconds: number,
): number {
  const interval =
    authProbeIntervalSeconds != null && authProbeIntervalSeconds > 0
      ? authProbeIntervalSeconds
      : fallbackIntervalSeconds
  return maintenanceWindowSlot(nowMs, interval)
}

export function retentionQuota(maxSessions: number, reservedFreeSlots: number): number {
  return Math.max(0, maxSessions - reservedFreeSlots)
}

export type AccountSessionFacts = {
  liveStatus: SessionStatus | null
  authState: SessionAuthState | null
  identityState: IdentityState | null
  leasePurpose: SessionLeasePurpose | null
  occupyingRunId: string | null
  occupyingOperationId: string | null
  holding: boolean
}

export function deriveAccountSessionStatus(facts: AccountSessionFacts): AccountSessionStatus {
  if (facts.liveStatus === 'LOST') return 'lost'
  if (facts.holding || facts.leasePurpose === 'EXECUTION') return 'executing'
  if (
    facts.leasePurpose === 'MAINTENANCE' ||
    facts.leasePurpose === 'AUTH_WAIT' ||
    facts.occupyingOperationId
  ) {
    return 'maintenance'
  }
  if (facts.occupyingRunId) return 'executing'
  if (facts.identityState === 'MISMATCH') return 'identity_mismatch'
  if (!facts.liveStatus || facts.liveStatus === 'CLOSED') return 'unprepared'
  if (facts.liveStatus === 'CREATING' || facts.liveStatus === 'CLOSING') return 'maintenance'
  if (facts.authState === 'EXPIRED') return 'needs_login'
  if (facts.authState === 'UNKNOWN' || !facts.authState) return 'needs_check'
  return 'ready'
}

export function matchesOverviewFilter(
  status: AccountSessionStatus,
  retained: boolean,
  filter: SessionOverviewFilter | undefined,
): boolean {
  if (!filter) return true
  if (filter === 'retained') return retained
  if (filter === 'available') return status === 'ready'
  return status === filter
}

export function accountSessionBucket(status: AccountSessionStatus): AccountSessionBucket {
  if (status === 'ready') return 'ready'
  if (status === 'unprepared') return 'unprepared'
  if (status === 'maintenance' || status === 'executing') return 'busy'
  return 'problem'
}

export function worstAccountSessionStatus(
  current: AccountSessionStatus | null,
  next: AccountSessionStatus,
): AccountSessionStatus {
  if (!current) return next
  return WORST_ACCOUNT_SESSION_STATUS.indexOf(next) < WORST_ACCOUNT_SESSION_STATUS.indexOf(current)
    ? next
    : current
}

export function canCloseAccountSession(input: {
  status: AccountSessionStatus
  sessionId: string | null
}): boolean {
  if (!input.sessionId) return false
  return (
    input.status === 'ready' ||
    input.status === 'needs_check' ||
    input.status === 'needs_login' ||
    input.status === 'identity_mismatch'
  )
}

export function matchesSystemOverviewFilter(
  item: {
    problemCount: number
    unpreparedCount: number
    readyCount: number
    busyCount: number
    retainedCount: number
    accountTotal: number
  },
  filter: SessionSystemOverviewFilter | undefined,
): boolean {
  if (!filter) return true
  if (filter === 'problem') return item.problemCount > 0
  if (filter === 'unprepared') return item.unpreparedCount > 0
  if (filter === 'busy') return item.busyCount > 0
  if (filter === 'retained') return item.retainedCount > 0
  return (
    item.accountTotal > 0 &&
    item.readyCount === item.accountTotal &&
    item.problemCount === 0 &&
    item.unpreparedCount === 0 &&
    item.busyCount === 0
  )
}

const optionalId = entityIdSchema.optional()

export const requestSessionOperationBodySchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.enum(['PREPARE', 'VERIFY_AUTH', 'LOGIN', 'RENEW_AUTH', 'CLOSE', 'RESTART']),
      idempotencyKey: z.string().trim().min(8).max(256),
      expectedSessionId: optionalId,
      expectedGeneration: z.number().int().positive().optional(),
    }),
    z.strictObject({
      kind: z.literal('REFRESH_LOGIN_PAGE'),
      idempotencyKey: z.string().trim().min(8).max(256),
      expectedSessionId: entityIdSchema,
      expectedGeneration: z.number().int().positive(),
      pageRef: pageRefSchema,
    }),
    z.strictObject({
      kind: z.literal('RESET_PROFILE'),
      idempotencyKey: z.string().trim().min(8).max(256),
      confirmAccountId: entityIdSchema,
      expectedSessionId: optionalId,
      expectedGeneration: z.number().int().positive().optional(),
    }),
  ])
  .refine((value) => (value.expectedSessionId === undefined) === (value.expectedGeneration === undefined), {
    message: '实例与代次必须同时提供',
  })
export type RequestSessionOperationBody = z.infer<typeof requestSessionOperationBodySchema>

export const sessionRetentionBodySchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.enum(['set', 'extend']),
    retainSeconds: z.number().int().min(60).max(604_800),
    reason: z.string().trim().min(1).max(256).optional(),
  }),
  z.strictObject({
    action: z.literal('clear'),
    reason: z.string().trim().min(1).max(256).optional(),
  }),
])
export type SessionRetentionBody = z.infer<typeof sessionRetentionBodySchema>

export const sessionActionSchema = z.strictObject({
  kind: z.string().min(1),
  enabled: z.boolean(),
  disabledReason: z.string().min(1).max(256).nullable(),
})
export type SessionAction = z.infer<typeof sessionActionSchema>

export const accountSessionOverviewItemSchema = z.strictObject({
  targetId: entityIdSchema,
  targetName: z.string().min(1),
  targetAccountId: entityIdSchema,
  accountDisplayName: z.string().min(1),
  accountUsername: z.string().min(1),
  accountStatus: z.enum(['active', 'disabled']),
  status: accountSessionStatusSchema,
  retained: z.boolean(),
  sessionId: entityIdSchema.nullable(),
  generation: z.number().int().positive().nullable(),
  instanceStatus: z.string().nullable(),
  authState: z.string().nullable(),
  identityState: z.string().nullable(),
  observedTier: z.string().nullable(),
  occupyingRunId: entityIdSchema.nullable(),
  occupyingOperationId: entityIdSchema.nullable(),
  retainUntil: utcInstantSchema.nullable(),
  lastAuthCheckedAt: utcInstantSchema.nullable(),
  lastAuthSuccessAt: utcInstantSchema.nullable(),
  ownerWorkerId: z.string().min(1).nullable(),
  primaryAction: z.string().min(1),
})
export type AccountSessionOverviewItem = z.infer<typeof accountSessionOverviewItemSchema>

export const sessionOverviewQuerySchema = z.object({
  search: z.string().trim().min(1).max(128).optional(),
  filter: sessionOverviewFilterSchema.optional(),
  targetId: entityIdSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
export type SessionOverviewQuery = z.infer<typeof sessionOverviewQuerySchema>

export const sessionSystemOverviewQuerySchema = z.object({
  search: z.string().trim().min(1).max(128).optional(),
  filter: sessionSystemOverviewFilterSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
export type SessionSystemOverviewQuery = z.infer<typeof sessionSystemOverviewQuerySchema>

export const sessionSystemOverviewItemSchema = z.strictObject({
  targetId: entityIdSchema,
  targetName: z.string().min(1),
  targetCode: z.string().min(1),
  targetStatus: z.enum(['active', 'disabled']),
  accountTotal: z.number().int().nonnegative(),
  readyCount: z.number().int().nonnegative(),
  problemCount: z.number().int().nonnegative(),
  unpreparedCount: z.number().int().nonnegative(),
  busyCount: z.number().int().nonnegative(),
  retainedCount: z.number().int().nonnegative(),
  worstStatus: accountSessionStatusSchema,
})
export type SessionSystemOverviewItem = z.infer<typeof sessionSystemOverviewItemSchema>

export const sessionSystemOverviewResponseSchema = z.strictObject({
  items: z.array(sessionSystemOverviewItemSchema),
  nextCursor: nextCursorSchema,
  summary: z.strictObject({
    systems: z.number().int().nonnegative(),
    readyAccounts: z.number().int().nonnegative(),
    problemAccounts: z.number().int().nonnegative(),
    unpreparedAccounts: z.number().int().nonnegative(),
  }),
  asOf: utcInstantSchema,
})
export type SessionSystemOverviewResponse = z.infer<typeof sessionSystemOverviewResponseSchema>

export const sessionOverviewResponseSchema = z.strictObject({
  items: z.array(accountSessionOverviewItemSchema),
  nextCursor: nextCursorSchema,
  summary: z.strictObject({
    total: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    needsCheck: z.number().int().nonnegative(),
    needsLogin: z.number().int().nonnegative(),
    identityMismatch: z.number().int().nonnegative(),
    maintenance: z.number().int().nonnegative(),
    executing: z.number().int().nonnegative(),
    lost: z.number().int().nonnegative(),
    unprepared: z.number().int().nonnegative(),
    retained: z.number().int().nonnegative(),
  }),
  asOf: utcInstantSchema,
})
export type SessionOverviewResponse = z.infer<typeof sessionOverviewResponseSchema>

export const accountSessionDetailSchema = z.strictObject({
  targetId: entityIdSchema,
  targetName: z.string().min(1),
  targetAccountId: entityIdSchema,
  accountDisplayName: z.string().min(1),
  accountUsername: z.string().min(1),
  accountStatus: z.enum(['active', 'disabled']),
  hasPassword: z.boolean(),
  expectedIdentity: z.string().nullable(),
  authCapability: z.string(),
  status: accountSessionStatusSchema,
  retained: z.boolean(),
  session: z
    .strictObject({
      id: entityIdSchema,
      status: z.string(),
      generation: z.number().int().positive(),
      ownerWorkerId: z.string().min(1),
      authState: z.string(),
      identityState: z.string().nullable(),
      observedTier: z.string().nullable(),
      lastAuthCheckedAt: utcInstantSchema.nullable(),
      lastAuthSuccessAt: utcInstantSchema.nullable(),
      authValidUntil: utcInstantSchema.nullable(),
      lastExpectedIdentity: z.string().nullable(),
      retainUntil: utcInstantSchema.nullable(),
      reclaimMode: z.enum(['IDLE', 'AUTH_DRIVEN']).nullable().optional(),
      keepAliveUntil: utcInstantSchema.nullable().optional(),
      nextAuthCheckAt: utcInstantSchema.nullable().optional(),
    })
    .nullable(),
  occupancy: z
    .strictObject({
      purpose: z.string(),
      occupyingRunId: entityIdSchema.nullable(),
      occupyingOperationId: entityIdSchema.nullable(),
    })
    .nullable(),
  retention: z
    .strictObject({
      retainUntil: utcInstantSchema,
      reason: z.string().nullable(),
      quotaUsed: z.number().int().nonnegative(),
      quotaLimit: z.number().int().nonnegative(),
      workerId: z.string().min(1).nullable(),
      platformConfigRevision: z.number().int().positive(),
    })
    .nullable(),
  currentOperation: z
    .strictObject({
      id: entityIdSchema,
      kind: z.string(),
      status: z.string(),
      reusedRunId: entityIdSchema.nullable(),
    })
    .nullable(),
  actions: z.array(sessionActionSchema),
  asOf: utcInstantSchema,
})
export type AccountSessionDetail = z.infer<typeof accountSessionDetailSchema>

export const sessionOperationAcceptedSchema = z.strictObject({
  operationId: entityIdSchema.nullable(),
  reusedRunId: entityIdSchema.nullable(),
  created: z.boolean(),
})
export type SessionOperationAccepted = z.infer<typeof sessionOperationAcceptedSchema>

export const sessionEventDtoSchema = z.strictObject({
  id: entityIdSchema,
  seq: z.number().int().positive(),
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema,
  sessionId: entityIdSchema.nullable(),
  generation: z.number().int().positive().nullable(),
  operationId: entityIdSchema.nullable(),
  runId: entityIdSchema.nullable(),
  type: sessionEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: utcInstantSchema,
})
export type SessionEventDto = z.infer<typeof sessionEventDtoSchema>

export const sessionEventListResponseSchema = z.strictObject({
  items: z.array(sessionEventDtoSchema),
  nextCursor: nextCursorSchema,
})
export type SessionEventListResponse = z.infer<typeof sessionEventListResponseSchema>

export const sessionObserveQuerySchema = z
  .object({
    targetId: entityIdSchema.optional(),
    accountId: entityIdSchema.optional(),
    cursor: z.string().min(1).max(262144).optional(),
  })
  .refine((value) => Boolean(value.targetId) === Boolean(value.accountId), {
    message: '目标与账号过滤必须同时提供',
  })
export type SessionObserveQuery = z.infer<typeof sessionObserveQuerySchema>

export function captchaModeBlocksAutoLogin(mode?: string | null): boolean {
  return mode === 'sms' || mode === 'other'
}

export function accountPickerHint(input: {
  liveStatus?: 'CREATING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'LOST' | null
  hasPassword: boolean
  authMethod?: string | null
  captchaMode?: string | null
}): { reuse: boolean; lost: boolean; manualLikely: boolean } {
  return {
    reuse: input.liveStatus === 'OPEN',
    lost: input.liveStatus === 'LOST',
    manualLikely:
      !input.hasPassword ||
      input.authMethod === 'manual' ||
      captchaModeBlocksAutoLogin(input.captchaMode),
  }
}
