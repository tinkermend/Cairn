import { z } from 'zod'
import { mapAssetRefSchema } from './map-c0.js'
import { nextCursorSchema } from './rbac.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

export const MAP_SCHEDULER_PROTOCOL = 'map-scheduler@1' as const
export const SCHEDULE_TIME_RULE_VERSION = 'schedule-time@1' as const
export const SCHEDULE_TICK_INTERVAL_MS = 15_000
export const SCHEDULE_TICK_BATCH = 100
export const SCHEDULE_PREVIEW_LIMIT = 10
export const SCHEDULE_CONSUMER_MAP_REFRESH = 'map_refresh' as const

export const SCHEDULE_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const
export type ScheduleWeekday = (typeof SCHEDULE_WEEKDAYS)[number]
export const scheduleWeekdaySchema = z.number().int().min(1).max(7).transform(value => value as ScheduleWeekday)

export const SCHEDULE_ADMISSION_STATUSES = ['PENDING', 'ADMITTED', 'SKIPPED', 'FAILED'] as const
export type ScheduleAdmissionStatus = (typeof SCHEDULE_ADMISSION_STATUSES)[number]
export const scheduleAdmissionStatusSchema = z.enum(SCHEDULE_ADMISSION_STATUSES)

export const SCHEDULE_SKIP_REASONS = [
  'WINDOW_CLOSED',
  'DST_NONEXISTENT',
  'INVALID_RESOLVED_WINDOW',
  'FACTORY_DISABLED',
  'SCHEDULE_DISABLED',
  'MANUAL_JOBS_DISABLED',
  'AUTH_PREPARATION_REQUIRED',
  'SAFETY_BASIS_REQUIRED',
  'NO_ELIGIBLE_ASSETS',
  'COVERED_BY_RUN',
  'PERMISSION_REVOKED',
  'WORKER_UNAVAILABLE',
  'TARGET_PAUSED',
  'ACTIVE_SLICE_EXISTS',
] as const
export type ScheduleSkipReason = (typeof SCHEDULE_SKIP_REASONS)[number]
export const scheduleSkipReasonSchema = z.enum(SCHEDULE_SKIP_REASONS)

const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '本地时间须为 HH:mm')

export const mapRefreshScheduleConsumerSchema = z.strictObject({
  type: z.literal(SCHEDULE_CONSUMER_MAP_REFRESH),
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema,
  entryId: entityIdSchema,
  selectedAssetRefs: z.array(mapAssetRefSchema).max(32).default([]),
})
export type MapRefreshScheduleConsumer = z.infer<typeof mapRefreshScheduleConsumerSchema>

export const scheduleDefinitionSchema = z
  .strictObject({
    timezone: z.string().trim().min(1).max(64),
    weekdays: z.array(scheduleWeekdaySchema).min(1).max(7),
    windowStart: localTimeSchema,
    windowEnd: localTimeSchema,
    misfire: z.literal('skip'),
    consumer: mapRefreshScheduleConsumerSchema,
  })
  .superRefine((value, ctx) => {
    if (new Set(value.weekdays).size !== value.weekdays.length) {
      ctx.addIssue({ code: 'custom', path: ['weekdays'], message: '星期集合不能重复' })
    }
    if (value.windowStart === value.windowEnd) {
      ctx.addIssue({ code: 'custom', path: ['windowEnd'], message: '结束时间不能等于开始时间' })
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value.timezone }).format()
    } catch {
      ctx.addIssue({ code: 'custom', path: ['timezone'], message: '须为有效 IANA 时区' })
    }
  })
export type ScheduleDefinition = z.infer<typeof scheduleDefinitionSchema>

export const scheduleWriteBodySchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  definition: scheduleDefinitionSchema,
})
export type ScheduleWriteBody = z.infer<typeof scheduleWriteBodySchema>

export const scheduleEnabledBodySchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  enabled: z.boolean(),
  cancelAdmittedJobs: z.boolean().default(false),
})
export type ScheduleEnabledBody = z.infer<typeof scheduleEnabledBodySchema>

export const schedulePreviewRequestSchema = z.strictObject({
  definition: scheduleDefinitionSchema,
  asOf: utcInstantSchema.optional(),
})
export type SchedulePreviewRequest = z.infer<typeof schedulePreviewRequestSchema>

export const resolvedValidWindowSchema = z.strictObject({
  kind: z.literal('ok'),
  localSlotKey: z.string().min(1).max(128),
  occurrenceKey: z.string().min(1).max(160),
  localStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  windowStartUtc: utcInstantSchema,
  windowEndUtc: utcInstantSchema,
  startOffsetMinutes: z.number().int(),
  endOffsetMinutes: z.number().int(),
  timeRuleVersion: z.literal(SCHEDULE_TIME_RULE_VERSION),
})
export type ResolvedValidWindow = z.infer<typeof resolvedValidWindowSchema>

export const resolvedSkippedWindowSchema = z.strictObject({
  kind: z.literal('skipped'),
  localSlotKey: z.string().min(1).max(128),
  localStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.enum(['DST_NONEXISTENT', 'INVALID_RESOLVED_WINDOW']),
  timeRuleVersion: z.literal(SCHEDULE_TIME_RULE_VERSION),
})
export type ResolvedSkippedWindow = z.infer<typeof resolvedSkippedWindowSchema>

export const resolvedScheduleWindowSchema = z.discriminatedUnion('kind', [
  resolvedValidWindowSchema,
  resolvedSkippedWindowSchema,
])
export type ResolvedScheduleWindow = z.infer<typeof resolvedScheduleWindowSchema>

export const scheduleOccurrenceDtoSchema = z.strictObject({
  occurrenceId: entityIdSchema,
  scheduleId: entityIdSchema,
  scheduleVersionId: entityIdSchema,
  localSlotKey: z.string().min(1).max(128),
  occurrenceKey: z.string().min(1).max(160).nullable(),
  localStartDate: z.string(),
  windowStartUtc: utcInstantSchema.nullable(),
  windowEndUtc: utcInstantSchema.nullable(),
  startOffsetMinutes: z.number().int().nullable(),
  endOffsetMinutes: z.number().int().nullable(),
  timeRuleVersion: z.string().min(1).max(32),
  admissionStatus: scheduleAdmissionStatusSchema,
  reason: scheduleSkipReasonSchema.nullable(),
  jobId: entityIdSchema.nullable(),
  firstRunId: entityIdSchema.optional(),
  createdAt: utcInstantSchema,
  admittedAt: utcInstantSchema.nullable(),
})
export type ScheduleOccurrenceDto = z.infer<typeof scheduleOccurrenceDtoSchema>

export const scheduleDtoSchema = z.strictObject({
  scheduleId: entityIdSchema,
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema,
  consumerKey: z.literal(SCHEDULE_CONSUMER_MAP_REFRESH),
  enabled: z.boolean(),
  revision: z.number().int().min(1),
  currentVersionId: entityIdSchema,
  definition: scheduleDefinitionSchema,
  nextDueAt: utcInstantSchema.nullable(),
  lastOccurrence: scheduleOccurrenceDtoSchema.nullable(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type ScheduleDto = z.infer<typeof scheduleDtoSchema>

export const scheduleWriteResponseSchema = z.strictObject({
  schedule: scheduleDtoSchema,
  created: z.boolean(),
})
export type ScheduleWriteResponse = z.infer<typeof scheduleWriteResponseSchema>

export const scheduleListQuerySchema = z.strictObject({
  targetId: entityIdSchema.optional(),
  enabled: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  cursor: nextCursorSchema,
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type ScheduleListQuery = z.infer<typeof scheduleListQuerySchema>

export const scheduleListResponseSchema = z.strictObject({
  items: z.array(scheduleDtoSchema),
  nextCursor: z.string().min(1).optional(),
})
export type ScheduleListResponse = z.infer<typeof scheduleListResponseSchema>

export const scheduleOccurrenceListQuerySchema = z.strictObject({
  cursor: nextCursorSchema,
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type ScheduleOccurrenceListQuery = z.infer<typeof scheduleOccurrenceListQuerySchema>

export const scheduleOccurrenceListResponseSchema = z.strictObject({
  items: z.array(scheduleOccurrenceDtoSchema),
  nextCursor: z.string().min(1).optional(),
})
export type ScheduleOccurrenceListResponse = z.infer<typeof scheduleOccurrenceListResponseSchema>

export const scheduleEventDtoSchema = z.strictObject({
  eventId: entityIdSchema,
  scheduleId: entityIdSchema,
  seq: z.number().int().min(1),
  eventType: z.string().min(1).max(64),
  payload: z.record(z.string(), z.unknown()),
  createdAt: utcInstantSchema,
})
export type ScheduleEventDto = z.infer<typeof scheduleEventDtoSchema>

export const scheduleEventListQuerySchema = z.strictObject({
  cursor: nextCursorSchema,
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type ScheduleEventListQuery = z.infer<typeof scheduleEventListQuerySchema>

export const scheduleEventListResponseSchema = z.strictObject({
  items: z.array(scheduleEventDtoSchema),
  nextCursor: z.string().min(1).optional(),
})
export type ScheduleEventListResponse = z.infer<typeof scheduleEventListResponseSchema>

export const schedulePreviewGapSchema = z.strictObject({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(256),
})

export const schedulePreviewResponseSchema = z.strictObject({
  asOf: utcInstantSchema,
  windows: z.array(resolvedScheduleWindowSchema).max(SCHEDULE_PREVIEW_LIMIT),
  gaps: z.array(schedulePreviewGapSchema),
})
export type SchedulePreviewResponse = z.infer<typeof schedulePreviewResponseSchema>

export const scheduleTickOutcomeSchema = z.strictObject({
  scanned: z.number().int().min(0),
  materialized: z.number().int().min(0),
  skipped: z.number().int().min(0),
  admitted: z.number().int().min(0),
  conflicts: z.number().int().min(0),
})
export type ScheduleTickOutcome = z.infer<typeof scheduleTickOutcomeSchema>

export function scheduleOccurrenceKey(scheduleId: string, windowStartUtc: string): string {
  return `schedule:${scheduleId}:${windowStartUtc}`
}

export function scheduleLocalSlotKey(scheduleId: string, localStartDate: string): string {
  return `${scheduleId}:${localStartDate}`
}

export function scheduledMapJobCommandKey(occurrenceId: string): string {
  return `map:scheduled:${occurrenceId}`
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number }

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function localDateString(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`
}

export function parseLocalHm(value: string): { hour: number; minute: number } {
  const [hour, minute] = localTimeSchema.parse(value).split(':')
  return { hour: Number(hour), minute: Number(minute) }
}

export function addLocalDays(year: number, month: number, day: number, delta: number): { year: number; month: number; day: number } {
  const utc = new Date(Date.UTC(year, month - 1, day + delta))
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() }
}

export function isoWeekdayOfDate(year: number, month: number, day: number): ScheduleWeekday {
  const js = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return (js === 0 ? 7 : js) as ScheduleWeekday
}

function formatInTimeZone(instant: Date, timeZone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  }
}

function partsEqual(left: LocalParts, right: LocalParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  )
}

export function localWallToUtcCandidates(timeZone: string, local: LocalParts): Date[] {
  const wallUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0)
  const found = new Map<number, Date>()
  for (const hours of [-36, -25, -24, -13, -12, -2, -1, 0, 1, 2, 12, 13, 24, 25, 36]) {
    const probe = new Date(wallUtc + hours * 3_600_000)
    const formatted = formatInTimeZone(probe, timeZone)
    const formattedAsUtc = Date.UTC(formatted.year, formatted.month - 1, formatted.day, formatted.hour, formatted.minute, 0)
    const offsetMs = formattedAsUtc - probe.getTime()
    const candidate = new Date(wallUtc - offsetMs)
    if (partsEqual(formatInTimeZone(candidate, timeZone), local)) {
      found.set(candidate.getTime(), candidate)
    }
  }
  return [...found.values()].sort((left, right) => left.getTime() - right.getTime())
}

export function resolveLocalInstant(
  timeZone: string,
  local: LocalParts,
): { kind: 'ok'; instant: Date; offsetMinutes: number } | { kind: 'nonexistent' } {
  const matches = localWallToUtcCandidates(timeZone, local)
  if (matches.length === 0) return { kind: 'nonexistent' }
  const instant = matches[0]!
  const formattedAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0)
  return { kind: 'ok', instant, offsetMinutes: (formattedAsUtc - instant.getTime()) / 60_000 }
}

export function resolveScheduleWindow(input: {
  scheduleId: string
  timezone: string
  windowStart: string
  windowEnd: string
  localDate: { year: number; month: number; day: number }
}): ResolvedScheduleWindow {
  const startHm = parseLocalHm(input.windowStart)
  const endHm = parseLocalHm(input.windowEnd)
  const startLocal = { ...input.localDate, ...startHm }
  const endDate =
    endHm.hour * 60 + endHm.minute < startHm.hour * 60 + startHm.minute
      ? addLocalDays(input.localDate.year, input.localDate.month, input.localDate.day, 1)
      : input.localDate
  const endLocal = { ...endDate, ...endHm }
  const localStartDate = localDateString(input.localDate.year, input.localDate.month, input.localDate.day)
  const localSlotKey = scheduleLocalSlotKey(input.scheduleId, localStartDate)
  const start = resolveLocalInstant(input.timezone, startLocal)
  const end = resolveLocalInstant(input.timezone, endLocal)
  if (start.kind === 'nonexistent' || end.kind === 'nonexistent') {
    return {
      kind: 'skipped',
      localSlotKey,
      localStartDate,
      reason: 'DST_NONEXISTENT',
      timeRuleVersion: SCHEDULE_TIME_RULE_VERSION,
    }
  }
  if (end.instant.getTime() <= start.instant.getTime()) {
    return {
      kind: 'skipped',
      localSlotKey,
      localStartDate,
      reason: 'INVALID_RESOLVED_WINDOW',
      timeRuleVersion: SCHEDULE_TIME_RULE_VERSION,
    }
  }
  const windowStartUtc = start.instant.toISOString()
  return {
    kind: 'ok',
    localSlotKey,
    occurrenceKey: scheduleOccurrenceKey(input.scheduleId, windowStartUtc),
    localStartDate,
    windowStartUtc,
    windowEndUtc: end.instant.toISOString(),
    startOffsetMinutes: start.offsetMinutes,
    endOffsetMinutes: end.offsetMinutes,
    timeRuleVersion: SCHEDULE_TIME_RULE_VERSION,
  }
}

export function localDateInTimeZone(instant: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = formatInTimeZone(instant, timeZone)
  return { year: parts.year, month: parts.month, day: parts.day }
}

export function previewScheduleWindows(input: {
  scheduleId: string
  definition: ScheduleDefinition
  asOf: Date
  limit?: number
}): ResolvedScheduleWindow[] {
  const limit = input.limit ?? SCHEDULE_PREVIEW_LIMIT
  const weekdays = new Set(input.definition.weekdays)
  const startDate = localDateInTimeZone(input.asOf, input.definition.timezone)
  const windows: ResolvedScheduleWindow[] = []
  for (let offset = 0; offset < 400 && windows.length < limit; offset += 1) {
    const date = addLocalDays(startDate.year, startDate.month, startDate.day, offset)
    if (!weekdays.has(isoWeekdayOfDate(date.year, date.month, date.day))) continue
    const resolved = resolveScheduleWindow({
      scheduleId: input.scheduleId,
      timezone: input.definition.timezone,
      windowStart: input.definition.windowStart,
      windowEnd: input.definition.windowEnd,
      localDate: date,
    })
    if (resolved.kind === 'ok' && new Date(resolved.windowEndUtc).getTime() <= input.asOf.getTime()) continue
    if (resolved.kind === 'skipped' && offset === 0) {
      const startHm = parseLocalHm(input.definition.windowStart)
      const start = resolveLocalInstant(input.definition.timezone, { ...date, ...startHm })
      if (start.kind === 'ok' && start.instant.getTime() <= input.asOf.getTime()) continue
    }
    windows.push(resolved)
  }
  return windows
}

export function nextDueFromWindows(windows: readonly ResolvedScheduleWindow[], asOf: Date): Date | null {
  for (const window of windows) {
    if (window.kind === 'ok') {
      const start = new Date(window.windowStartUtc)
      return start.getTime() > asOf.getTime() ? start : asOf
    }
    const [year, month, day] = window.localStartDate.split('-').map(Number)
    const nextMorning = addLocalDays(year!, month!, day!, 1)
    return new Date(Date.UTC(nextMorning.year, nextMorning.month - 1, nextMorning.day, 0, 0, 0))
  }
  return null
}
