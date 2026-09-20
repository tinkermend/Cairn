import { z } from 'zod'
import { nextCursorSchema } from './rbac.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/, 'idempotencyKey 须为 8–128 位 [A-Za-z0-9._:-]')

export const CREDENTIAL_ERROR_CODES = [
  'CREDENTIAL_NOT_FOUND',
  'CREDENTIAL_REVISION_CONFLICT',
  'CREDENTIAL_VALIDITY_INVALID',
  'CREDENTIAL_START_TIME_REQUIRED',
  'CREDENTIAL_BINDING_MISMATCH',
  'CREDENTIAL_IDENTITY_RECONFIRM_REQUIRED',
  'CREDENTIAL_DISABLED',
  'CREDENTIAL_VERSION_REVOKED',
  'CREDENTIAL_TYPE_ACTION_UNSUPPORTED',
  'CREDENTIAL_MATERIAL_UNAVAILABLE',
  'CREDENTIAL_BATCH_LIMIT_EXCEEDED',
  'CREDENTIAL_BATCH_NOT_FOUND',
  'CREDENTIAL_CONSUMER_REQUIRED',
] as const
export type CredentialErrorCode = (typeof CREDENTIAL_ERROR_CODES)[number]

export const CREDENTIAL_TYPES = ['target_password', 'model_key', 'alert_webhook', 'service_key'] as const
export type CredentialType = (typeof CREDENTIAL_TYPES)[number]

export const CREDENTIAL_SOURCES = [
  'target_account',
  'platform_ai',
  'alert_channel',
  'service_credential',
] as const
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number]

export const CREDENTIAL_MANAGEMENT_STATUSES = ['active', 'disabled'] as const
export type CredentialManagementStatus = (typeof CREDENTIAL_MANAGEMENT_STATUSES)[number]

export const CREDENTIAL_VALIDITY_MODES = ['days', 'months', 'permanent', 'unknown'] as const
export type CredentialValidityMode = (typeof CREDENTIAL_VALIDITY_MODES)[number]

export const CREDENTIAL_VALIDITY_WRITE_MODES = ['days', 'months', 'permanent'] as const
export type CredentialValidityWriteMode = (typeof CREDENTIAL_VALIDITY_WRITE_MODES)[number]

export const ISSUER_EXPIRY_SOURCES = [
  'manual_declaration',
  'provider',
  'issued_by_cairn',
  'unknown',
] as const
export type IssuerExpirySource = (typeof ISSUER_EXPIRY_SOURCES)[number]

export const CREDENTIAL_MAINTENANCE_STATUSES = [
  'unknown',
  'not_due',
  'approaching',
  'due',
  'permanent',
] as const
export type CredentialMaintenanceStatus = (typeof CREDENTIAL_MAINTENANCE_STATUSES)[number]

export const CREDENTIAL_OWNER_STATUSES = ['assigned', 'unclaimed', 'needs_handover'] as const
export type CredentialOwnerStatus = (typeof CREDENTIAL_OWNER_STATUSES)[number]

export const CREDENTIAL_VERIFICATION_STATUSES = [
  'not_applicable',
  'pending',
  'verified',
  'failed',
  'inconclusive',
] as const
export type CredentialVerificationStatus = (typeof CREDENTIAL_VERIFICATION_STATUSES)[number]

export const CREDENTIAL_IDENTITY_BINDING_STATUSES = ['confirmed', 'pending_reconfirm'] as const
export type CredentialIdentityBindingStatus = (typeof CREDENTIAL_IDENTITY_BINDING_STATUSES)[number]

export const CREDENTIAL_MATERIAL_STATUSES = [
  'current',
  'superseded',
  'revoked',
  'cleared',
  'unavailable',
] as const
export type CredentialMaterialStatus = (typeof CREDENTIAL_MATERIAL_STATUSES)[number]

export const CREDENTIAL_BATCH_KINDS = ['password_replace', 'metadata'] as const
export type CredentialBatchKind = (typeof CREDENTIAL_BATCH_KINDS)[number]

export const CREDENTIAL_BATCH_ITEM_STATUSES = [
  'pending_material',
  'succeeded',
  'failed',
  'conflict',
] as const
export type CredentialBatchItemStatus = (typeof CREDENTIAL_BATCH_ITEM_STATUSES)[number]

export const CREDENTIAL_USAGE_KINDS = ['confirmed', 'possible', 'active'] as const
export type CredentialUsageKind = (typeof CREDENTIAL_USAGE_KINDS)[number]

export const CREDENTIAL_SESSION_BROWSER_STATES = [
  'unprepared',
  'online',
  'lost',
  'closed',
  'unknown',
  'not_applicable',
  'forbidden',
  'unavailable',
] as const
export type CredentialSessionBrowserState = (typeof CREDENTIAL_SESSION_BROWSER_STATES)[number]

export const CREDENTIAL_SESSION_AUTH_STATES = [
  'verified',
  'pending',
  'expired',
  'manual_required',
  'unknown',
  'not_applicable',
  'forbidden',
  'unavailable',
] as const
export type CredentialSessionAuthState = (typeof CREDENTIAL_SESSION_AUTH_STATES)[number]

export const CREDENTIAL_REMINDER_STAGES = ['approaching', 'due'] as const
export type CredentialReminderStage = (typeof CREDENTIAL_REMINDER_STAGES)[number]

export const CREDENTIAL_PASSWORD_BATCH_LIMIT = 50
export const CREDENTIAL_METADATA_BATCH_LIMIT = 200
export const CREDENTIAL_VALIDITY_DAYS_MAX = 36_500
export const CREDENTIAL_VALIDITY_MONTHS_MAX = 1_200
export const CREDENTIAL_REMINDER_LEAD_DAYS_DEFAULT = 14
export const CREDENTIAL_NOTES_MAX = 512
export const CREDENTIAL_TAG_MAX = 32
export const CREDENTIAL_TAG_LIMIT = 16
export const CREDENTIAL_CONSOLE_PATH = '/credentials' as const

export const credentialTypeSchema = z.enum(CREDENTIAL_TYPES)
export const credentialValidityModeSchema = z.enum(CREDENTIAL_VALIDITY_MODES)
export const credentialValidityWriteModeSchema = z.enum(CREDENTIAL_VALIDITY_WRITE_MODES)
export const issuerExpirySourceSchema = z.enum(ISSUER_EXPIRY_SOURCES)
export const credentialMaintenanceStatusSchema = z.enum(CREDENTIAL_MAINTENANCE_STATUSES)
export const credentialOwnerStatusSchema = z.enum(CREDENTIAL_OWNER_STATUSES)
export const credentialVerificationStatusSchema = z.enum(CREDENTIAL_VERIFICATION_STATUSES)
export const credentialIdentityBindingStatusSchema = z.enum(CREDENTIAL_IDENTITY_BINDING_STATUSES)

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
    return true
  } catch {
    return false
  }
}

export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, '须为有效 IANA 时区')

export const credentialValidityPolicySchema = z
  .strictObject({
    mode: credentialValidityModeSchema,
    amount: z.number().int().positive().max(CREDENTIAL_VALIDITY_DAYS_MAX).nullable(),
    timeZone: z.string().min(1).max(64).nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'days') {
      if (value.amount == null || value.amount < 1 || value.amount > CREDENTIAL_VALIDITY_DAYS_MAX) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: '按天有效期须为 1–36500' })
      }
      if (!value.timeZone || !isValidTimeZone(value.timeZone)) {
        ctx.addIssue({ code: 'custom', path: ['timeZone'], message: '有限期限必须给出有效时区' })
      }
    } else if (value.mode === 'months') {
      if (value.amount == null || value.amount < 1 || value.amount > CREDENTIAL_VALIDITY_MONTHS_MAX) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: '按月有效期须为 1–1200' })
      }
      if (!value.timeZone || !isValidTimeZone(value.timeZone)) {
        ctx.addIssue({ code: 'custom', path: ['timeZone'], message: '有限期限必须给出有效时区' })
      }
    } else if (value.amount != null) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: '永久或未知期限不得带数量' })
    }
  })
export type CredentialValidityPolicy = z.infer<typeof credentialValidityPolicySchema>

export const credentialValidityWriteSchema = z
  .strictObject({
    mode: credentialValidityWriteModeSchema,
    amount: z.number().int().positive().optional(),
    timeZone: z.string().trim().min(1).max(64).optional(),
    startedAt: utcInstantSchema.optional(),
    expiryReminderLeadDays: z.number().int().min(0).max(365).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'days') {
      if (value.amount == null || value.amount > CREDENTIAL_VALIDITY_DAYS_MAX) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: '按天有效期须为 1–36500' })
      }
      if (!value.timeZone || !isValidTimeZone(value.timeZone)) {
        ctx.addIssue({ code: 'custom', path: ['timeZone'], message: '有限期限必须给出有效时区' })
      }
    } else if (value.mode === 'months') {
      if (value.amount == null || value.amount > CREDENTIAL_VALIDITY_MONTHS_MAX) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: '按月有效期须为 1–1200' })
      }
      if (!value.timeZone || !isValidTimeZone(value.timeZone)) {
        ctx.addIssue({ code: 'custom', path: ['timeZone'], message: '有限期限必须给出有效时区' })
      }
    } else if (value.amount != null) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: '永久不得带数量' })
    }
  })
export type CredentialValidityWrite = z.infer<typeof credentialValidityWriteSchema>

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function addCalendarMonths(
  year: number,
  month: number,
  day: number,
  months: number,
): { year: number; month: number; day: number } {
  const index = year * 12 + (month - 1) + months
  const nextYear = Math.floor(index / 12)
  const nextMonth = (index % 12) + 1
  return { year: nextYear, month: nextMonth, day: Math.min(day, daysInMonth(nextYear, nextMonth)) }
}

type LocalDateTime = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  millisecond: number
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function formatInTimeZone(instant: Date, timeZone: string): LocalDateTime {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  })
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    millisecond: Number(parts.fractionalSecond ?? '0'),
  }
}

function partsEqual(left: LocalDateTime, right: LocalDateTime): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second &&
    left.millisecond === right.millisecond
  )
}

function wallUtcMs(local: LocalDateTime): number {
  return Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
    local.millisecond,
  )
}

function localWallToUtcCandidates(timeZone: string, local: LocalDateTime): Date[] {
  const wall = wallUtcMs(local)
  const found = new Map<number, Date>()
  for (const hours of [-36, -25, -24, -13, -12, -2, -1, 0, 1, 2, 12, 13, 24, 25, 36]) {
    const probe = new Date(wall + hours * 3_600_000)
    const formatted = formatInTimeZone(probe, timeZone)
    const offsetMs = wallUtcMs(formatted) - probe.getTime()
    const candidate = new Date(wall - offsetMs)
    if (partsEqual(formatInTimeZone(candidate, timeZone), local)) {
      found.set(candidate.getTime(), candidate)
    }
  }
  return [...found.values()].sort((left, right) => left.getTime() - right.getTime())
}

function offsetAt(instant: Date, timeZone: string): number {
  const formatted = formatInTimeZone(instant, timeZone)
  return wallUtcMs(formatted) - instant.getTime()
}

/** 把当地墙上时间转为 UTC。重叠取较早；缺口按缺口长度向后移。 */
export function localWallToUtc(timeZone: string, local: LocalDateTime): Date {
  const matches = localWallToUtcCandidates(timeZone, local)
  if (matches.length > 0) return matches[0]!
  const noon = localWallToUtcCandidates(timeZone, { ...local, hour: 12, minute: 0, second: 0, millisecond: 0 })
  const midnight = localWallToUtcCandidates(timeZone, {
    ...local,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  })
  const before = midnight[0] ? offsetAt(midnight[0], timeZone) : 0
  const after = noon[0] ? offsetAt(noon[0], timeZone) : before
  const preGapOffset = before !== after ? (Math.abs(before) > Math.abs(after) ? before : after) : before
  return new Date(wallUtcMs(local) - preGapOffset)
}

export function addValidityDuration(
  startedAt: Date,
  policy: Pick<CredentialValidityPolicy, 'mode' | 'amount' | 'timeZone'>,
): Date | null {
  if (policy.mode === 'permanent' || policy.mode === 'unknown') return null
  if (policy.amount == null || !policy.timeZone) return null
  if (policy.mode === 'days') {
    return new Date(startedAt.getTime() + policy.amount * 24 * 60 * 60 * 1000)
  }
  const local = formatInTimeZone(startedAt, policy.timeZone)
  const next = addCalendarMonths(local.year, local.month, local.day, policy.amount)
  return localWallToUtc(policy.timeZone, { ...local, ...next })
}

export function computeMaintenanceDueAt(input: {
  policy: Pick<CredentialValidityPolicy, 'mode' | 'amount' | 'timeZone'>
  startedAt: Date | null
}): Date | null {
  if (!input.startedAt) return null
  return addValidityDuration(input.startedAt, input.policy)
}

export function deriveMaintenanceStatus(input: {
  policy: Pick<CredentialValidityPolicy, 'mode'>
  dueAt: Date | null
  now: Date
  reminderLeadDays: number
}): CredentialMaintenanceStatus {
  if (input.policy.mode === 'unknown') return 'unknown'
  if (input.policy.mode === 'permanent') return 'permanent'
  if (!input.dueAt) return 'unknown'
  if (input.now.getTime() >= input.dueAt.getTime()) return 'due'
  const leadMs = Math.max(0, input.reminderLeadDays) * 24 * 60 * 60 * 1000
  if (input.now.getTime() >= input.dueAt.getTime() - leadMs) return 'approaching'
  return 'not_due'
}

export function formatValidityPreview(input: {
  policy: CredentialValidityPolicy
  startedAt: Date | null
  dueAt: Date | null
}): string {
  if (input.policy.mode === 'permanent') return '不设维护截止'
  if (input.policy.mode === 'unknown' || !input.dueAt) return '期限待补充'
  const zone = input.policy.timeZone ?? 'UTC'
  const local = formatInTimeZone(input.dueAt, zone)
  return `${local.year}-${pad2(local.month)}-${pad2(local.day)} ${pad2(local.hour)}:${pad2(local.minute)} ${zone}`
}

export const credentialCapabilitiesSchema = z.strictObject({
  canEditAccount: z.boolean().optional(),
  canDelete: z.boolean().optional(),
  canImport: z.boolean().optional(),
  canReplace: z.boolean(),
  canSetMaintenance: z.boolean(),
  canVerify: z.boolean(),
  canDisable: z.boolean(),
  externallyRenewed: z.boolean(),
})
export type CredentialCapabilities = z.infer<typeof credentialCapabilitiesSchema>

export function capabilitiesForType(type: CredentialType): CredentialCapabilities {
  if (type === 'service_key') {
    return {
      canReplace: false,
      canSetMaintenance: false,
      canVerify: false,
      canDisable: false,
      externallyRenewed: false,
    }
  }
  return {
    canReplace: true,
    canSetMaintenance: true,
    canVerify: type === 'target_password',
    canDisable: true,
    externallyRenewed: type === 'alert_webhook',
  }
}

export const credentialSessionSummarySchema = z.strictObject({
  browser: z.enum(CREDENTIAL_SESSION_BROWSER_STATES),
  auth: z.enum(CREDENTIAL_SESSION_AUTH_STATES),
  identityState: z.enum(['MATCH', 'MISMATCH', 'UNVERIFIED', 'not_applicable', 'forbidden', 'unavailable']),
  occupancy: z.enum([
    'idle',
    'executing',
    'maintenance',
    'auth_wait',
    'not_applicable',
    'forbidden',
    'unavailable',
  ]),
  sessionId: z.string().nullable(),
  generation: z.number().int().nullable(),
  observedAt: utcInstantSchema.nullable(),
  lastAuthCheckedAt: utcInstantSchema.nullable(),
  lastAuthSuccessAt: utcInstantSchema.nullable(),
  occupyingLabel: z.string().max(256).nullable(),
})
export type CredentialSessionSummary = z.infer<typeof credentialSessionSummarySchema>

export const credentialListItemSchema = z.object({
  id: entityIdSchema,
  type: credentialTypeSchema,
  source: z.enum(CREDENTIAL_SOURCES),
  name: z.string().min(1).max(128),
  safeIdentifier: z.string().max(256),
  subjectLabel: z.string().max(256),
  targetId: entityIdSchema.nullable(),
  targetAccountId: entityIdSchema.nullable(),
  target: z.object({
    id: entityIdSchema, name: z.string(), code: z.string(),
    accountId: entityIdSchema, accountName: z.string(), username: z.string(),
  }).optional(),
  hasPassword: z.boolean().optional(),
  revision: z.number().int().positive(),
  managementStatus: z.enum(CREDENTIAL_MANAGEMENT_STATUSES),
  maintenanceStatus: credentialMaintenanceStatusSchema,
  maintenanceDueAt: utcInstantSchema.nullable(),
  validityStartedAt: utcInstantSchema.nullable(),
  validityPolicy: credentialValidityPolicySchema,
  issuerExpiresAt: utcInstantSchema.nullable(),
  issuerExpirySource: issuerExpirySourceSchema,
  verificationStatus: credentialVerificationStatusSchema,
  identityBindingStatus: credentialIdentityBindingStatusSchema,
  ownerConsoleAccountId: entityIdSchema.nullable(),
  ownerDisplayName: z.string().max(128).nullable(),
  ownerStatus: credentialOwnerStatusSchema,
  session: credentialSessionSummarySchema,
  capabilities: credentialCapabilitiesSchema,
  currentVersionId: entityIdSchema.nullable(),
  updatedAt: utcInstantSchema,
  createdAt: utcInstantSchema,
})
export type CredentialListItem = z.infer<typeof credentialListItemSchema>

export const credentialStatsSchema = z.strictObject({
  visible: z.number().int().nonnegative(),
  approaching: z.number().int().nonnegative(),
  due: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  authAbnormal: z.number().int().nonnegative(),
  pendingVerification: z.number().int().nonnegative(),
  unclaimed: z.number().int().nonnegative(),
})
export type CredentialStats = z.infer<typeof credentialStatsSchema>

export const credentialShortcutSchema = z.enum([
  'approaching',
  'due',
  'unknown',
  'auth_abnormal',
  'pending_verification',
  'unclaimed',
])
export type CredentialShortcut = z.infer<typeof credentialShortcutSchema>

export const credentialListQuerySchema = z.object({
  search: z.string().trim().max(128).optional(),
  type: credentialTypeSchema.optional(),
  targetId: entityIdSchema.optional(),
  ownerConsoleAccountId: entityIdSchema.optional(),
  mine: z.coerce.boolean().optional(),
  maintenanceStatus: credentialMaintenanceStatusSchema.optional(),
  shortcut: credentialShortcutSchema.optional(),
  managementStatus: z.enum(CREDENTIAL_MANAGEMENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
})
export type CredentialListQuery = z.input<typeof credentialListQuerySchema>

export const credentialListResponseSchema = z.object({
  items: z.array(credentialListItemSchema),
  nextCursor: nextCursorSchema,
  stats: credentialStatsSchema,
  asOf: utcInstantSchema,
  realtime: z.boolean(),
})
export type CredentialListResponse = z.infer<typeof credentialListResponseSchema>

export const credentialVersionSummarySchema = z.strictObject({
  id: entityIdSchema,
  materialStatus: z.enum(CREDENTIAL_MATERIAL_STATUSES),
  identityRevision: z.number().int().positive().nullable(),
  identityUsername: z.string().max(256).nullable(),
  registeredAt: utcInstantSchema,
  revokedAt: utcInstantSchema.nullable(),
})
export type CredentialVersionSummary = z.infer<typeof credentialVersionSummarySchema>

export const credentialDetailSchema = credentialListItemSchema.extend({
  notes: z.string().max(CREDENTIAL_NOTES_MAX).nullable(),
  purpose: z.string().max(256).nullable(),
  tags: z.array(z.string().max(CREDENTIAL_TAG_MAX)).max(CREDENTIAL_TAG_LIMIT),
  expiryReminderLeadDays: z.number().int().min(0).max(365),
  policyRevision: z.number().int().positive(),
  currentVersion: credentialVersionSummarySchema.nullable(),
  domainHref: z.string().min(1).max(256),
  sessionHref: z.string().min(1).max(256).nullable(),
})
export type CredentialDetail = z.infer<typeof credentialDetailSchema>

export const credentialUsageItemSchema = z.strictObject({
  kind: z.enum(CREDENTIAL_USAGE_KINDS),
  resource: z.enum(['run', 'schedule', 'session', 'target_account', 'model_config', 'alert_channel', 'service']),
  id: z.string().min(1).max(128).nullable(),
  label: z.string().max(256).nullable(),
  href: z.string().max(256).nullable(),
})
export type CredentialUsageItem = z.infer<typeof credentialUsageItemSchema>

export const credentialUsageResponseSchema = z.strictObject({
  asOf: utcInstantSchema,
  items: z.array(credentialUsageItemSchema),
  withheld: z.boolean(),
})
export type CredentialUsageResponse = z.infer<typeof credentialUsageResponseSchema>

export const credentialHistoryItemSchema = z.strictObject({
  id: entityIdSchema,
  action: z.string().min(1).max(64),
  summary: z.string().max(512),
  actorDisplayName: z.string().max(128).nullable(),
  createdAt: utcInstantSchema,
})
export type CredentialHistoryItem = z.infer<typeof credentialHistoryItemSchema>

export const credentialHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
})
export type CredentialHistoryQuery = z.infer<typeof credentialHistoryQuerySchema>

export const credentialHistoryResponseSchema = z.object({
  items: z.array(credentialHistoryItemSchema),
  nextCursor: nextCursorSchema,
})
export type CredentialHistoryResponse = z.infer<typeof credentialHistoryResponseSchema>

export const credentialRegisterBodySchema = z
  .strictObject({
    type: z.enum(['target_password', 'model_key', 'alert_webhook']),
    targetAccountId: entityIdSchema.optional(),
    modelSlot: z.enum(['browserAi', 'platformAi']).optional(),
    alertChannelId: entityIdSchema.optional(),
    name: z.string().trim().min(1).max(128).optional(),
    password: z.string().min(1).max(256).optional(),
    apiKey: z.string().min(1).max(4096).optional(),
    webhookUrl: z.string().min(1).max(2048).optional(),
    webhookToken: z.string().min(1).max(1024).optional(),
    validity: credentialValidityWriteSchema,
    ownerConsoleAccountId: entityIdSchema.nullable().optional(),
    notes: z.string().trim().max(CREDENTIAL_NOTES_MAX).optional(),
    purpose: z.string().trim().max(256).optional(),
    tags: z.array(z.string().trim().min(1).max(CREDENTIAL_TAG_MAX)).max(CREDENTIAL_TAG_LIMIT).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.type === 'target_password' && !body.targetAccountId) {
      ctx.addIssue({ code: 'custom', path: ['targetAccountId'], message: '目标登录凭据必须选择已有账号' })
    }
    if (body.type === 'model_key' && !body.modelSlot) {
      ctx.addIssue({ code: 'custom', path: ['modelSlot'], message: '模型密钥必须选择已有配置槽位' })
    }
    if (body.type === 'alert_webhook' && !body.alertChannelId) {
      ctx.addIssue({ code: 'custom', path: ['alertChannelId'], message: '告警凭据必须选择已有渠道' })
    }
  })
export type CredentialRegisterBody = z.infer<typeof credentialRegisterBodySchema>

export const credentialMetadataBodySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  name: z.string().trim().min(1).max(128).optional(),
  ownerConsoleAccountId: entityIdSchema.nullable().optional(),
  notes: z.string().trim().max(CREDENTIAL_NOTES_MAX).nullable().optional(),
  purpose: z.string().trim().max(256).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(CREDENTIAL_TAG_MAX)).max(CREDENTIAL_TAG_LIMIT).optional(),
  validity: credentialValidityWriteSchema.optional(),
  startedAt: utcInstantSchema.optional(),
  expiryReminderLeadDays: z.number().int().min(0).max(365).optional(),
})
export type CredentialMetadataBody = z.infer<typeof credentialMetadataBodySchema>

export const credentialReplaceBodySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  password: z.string().min(1).max(256).optional(),
  apiKey: z.string().min(1).max(4096).optional(),
  webhookUrl: z.string().min(1).max(2048).optional(),
  webhookToken: z.string().min(1).max(1024).optional(),
  validity: credentialValidityWriteSchema,
  confirmIdentityMaterial: z.literal(true).optional(),
})
export type CredentialReplaceBody = z.infer<typeof credentialReplaceBodySchema>

export const credentialRevisionBodySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
})
export type CredentialRevisionBody = z.infer<typeof credentialRevisionBodySchema>

export const credentialBatchCreateBodySchema = z
  .strictObject({
    kind: z.enum(CREDENTIAL_BATCH_KINDS),
    source: z.enum(['selection', 'excel']).optional(),
    idempotencyKey: idempotencyKeySchema,
    items: z
      .array(
        z.strictObject({
          itemId: entityIdSchema,
          credentialId: entityIdSchema,
          targetId: entityIdSchema.optional(),
          targetAccountId: entityIdSchema.optional(),
          expectedRevision: z.number().int().positive(),
          validity: credentialValidityWriteSchema.optional(),
          startedAt: utcInstantSchema.optional(),
          ownerConsoleAccountId: entityIdSchema.nullable().optional(),
          tags: z.array(z.string().trim().min(1).max(CREDENTIAL_TAG_MAX)).max(CREDENTIAL_TAG_LIMIT).optional(),
        }),
      )
      .min(1)
      .max(CREDENTIAL_METADATA_BATCH_LIMIT),
  })
  .superRefine((body, ctx) => {
    const limit = body.kind === 'password_replace' ? CREDENTIAL_PASSWORD_BATCH_LIMIT : CREDENTIAL_METADATA_BATCH_LIMIT
    if (body.items.length > limit) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: `批次最多 ${limit} 条` })
    }
  })
export type CredentialBatchCreateBody = z.infer<typeof credentialBatchCreateBodySchema>

export const credentialBatchItemSubmitBodySchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  password: z.string().min(1).max(256).optional(),
  validity: credentialValidityWriteSchema.optional(),
  startedAt: utcInstantSchema.optional(),
  ownerConsoleAccountId: entityIdSchema.nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(CREDENTIAL_TAG_MAX)).max(CREDENTIAL_TAG_LIMIT).optional(),
})
export type CredentialBatchItemSubmitBody = z.infer<typeof credentialBatchItemSubmitBodySchema>

export const credentialBatchItemSchema = z.strictObject({
  itemId: entityIdSchema,
  credentialId: entityIdSchema.nullable(),
  targetId: entityIdSchema.nullable(),
  targetAccountId: entityIdSchema.nullable(),
  expectedRevision: z.number().int().positive(),
  status: z.enum(CREDENTIAL_BATCH_ITEM_STATUSES),
  errorCode: z.string().max(64).nullable(),
  errorMessage: z.string().max(256).nullable(),
  resultRevision: z.number().int().positive().nullable(),
})
export type CredentialBatchItem = z.infer<typeof credentialBatchItemSchema>

export const credentialBatchSchema = z.strictObject({
  batchId: entityIdSchema,
  kind: z.enum(CREDENTIAL_BATCH_KINDS),
  items: z.array(credentialBatchItemSchema),
  createdAt: utcInstantSchema,
})
export type CredentialBatch = z.infer<typeof credentialBatchSchema>

export const credentialImportResolveBodySchema = z.strictObject({
  version: z.literal(1),
  rows: z.array(z.strictObject({
    row: z.number().int().positive(),
    credentialId: entityIdSchema.optional(), targetId: entityIdSchema.optional(), targetAccountId: entityIdSchema.optional(),
    targetCode: z.string().min(1).max(256).optional(), username: z.string().min(1).max(256).optional(),
  })).min(1).max(1000),
})
export type CredentialImportResolveBody = z.infer<typeof credentialImportResolveBodySchema>
export const credentialImportResolveResponseSchema = z.object({
  rows: z.array(z.object({ row: z.number().int(), item: credentialListItemSchema.nullable(), error: z.string().nullable() })),
})
export type CredentialImportResolveResponse = z.infer<typeof credentialImportResolveResponseSchema>

export const frozenCredentialBindingSchema = z.strictObject({
  credentialId: entityIdSchema,
  versionId: entityIdSchema,
  identityRevision: z.number().int().positive(),
  identityUsername: z.string().min(1).max(256),
})
export type FrozenCredentialBinding = z.infer<typeof frozenCredentialBindingSchema>

export function policyFromWrite(
  input: CredentialValidityWrite,
): CredentialValidityPolicy {
  if (input.mode === 'permanent') {
    return { mode: 'permanent', amount: null, timeZone: input.timeZone ?? null }
  }
  return {
    mode: input.mode,
    amount: input.amount ?? null,
    timeZone: input.timeZone ?? null,
  }
}

export function unknownValidityPolicy(): CredentialValidityPolicy {
  return { mode: 'unknown', amount: null, timeZone: null }
}
