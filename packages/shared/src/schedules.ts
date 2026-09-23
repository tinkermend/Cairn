import { z } from 'zod'
import { mapAssetRefSchema } from './map-c0.js'
import { nextCursorSchema } from './rbac.js'
import { suiteFailurePolicySchema, suiteMemberIdSchema } from './suites.js'
import { entityIdSchema, jsonValueSchema, utcInstantSchema } from './wire.js'

export const MAP_SCHEDULER_PROTOCOL = 'map-scheduler@1' as const
export const UNIFIED_SCHEDULER_PROTOCOL = 'unified-scheduler@1' as const
export const SCHEDULE_TIME_RULE_VERSION = 'schedule-time@2' as const
export const SCHEDULE_TICK_INTERVAL_MS = 15_000
export const SCHEDULE_TICK_BATCH = 100
export const SCHEDULE_PREVIEW_LIMIT = 10
export const SCHEDULE_INTERVAL_MIN_MS = 5 * 60 * 1000
export const SCHEDULE_INTERVAL_MAX_MS = 30 * 24 * 60 * 60 * 1000

export const SCHEDULE_CONSUMER_SCENARIO_RUN = 'scenario_run' as const
export const SCHEDULE_CONSUMER_SUITE_RUN = 'suite_run' as const
export const SCHEDULE_CONSUMER_MAP_REFRESH = 'map_refresh' as const
export const SCHEDULE_CONSUMER_KNOWLEDGE_ANALYSIS = 'knowledge_analysis' as const
export const SCHEDULE_CONSUMER_TYPES = [
  SCHEDULE_CONSUMER_SCENARIO_RUN,
  SCHEDULE_CONSUMER_SUITE_RUN,
  SCHEDULE_CONSUMER_MAP_REFRESH,
  SCHEDULE_CONSUMER_KNOWLEDGE_ANALYSIS,
] as const
export type ScheduleConsumerType = (typeof SCHEDULE_CONSUMER_TYPES)[number]
export const scheduleConsumerTypeSchema = z.enum(SCHEDULE_CONSUMER_TYPES)

export const ANALYSIS_MODES = ['map_quality', 'run_incremental'] as const
export type AnalysisMode = (typeof ANALYSIS_MODES)[number]
export const analysisModeSchema = z.enum(ANALYSIS_MODES)

export const SCHEDULE_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const
export type ScheduleWeekday = (typeof SCHEDULE_WEEKDAYS)[number]
export const scheduleWeekdaySchema = z.number().int().min(1).max(7).transform(value => value as ScheduleWeekday)

export const SCHEDULE_ADMISSION_STATUSES = ['PENDING', 'ADMITTED', 'SKIPPED', 'FAILED'] as const
export type ScheduleAdmissionStatus = (typeof SCHEDULE_ADMISSION_STATUSES)[number]
export const scheduleAdmissionStatusSchema = z.enum(SCHEDULE_ADMISSION_STATUSES)

export const SCHEDULE_OCCURRENCE_SOURCES = ['scheduled', 'manual'] as const
export type ScheduleOccurrenceSource = (typeof SCHEDULE_OCCURRENCE_SOURCES)[number]
export const scheduleOccurrenceSourceSchema = z.enum(SCHEDULE_OCCURRENCE_SOURCES)

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
  'MAP_ACCOUNT_USAGE_REQUIRED',
  'WORKER_UNAVAILABLE',
  'TARGET_PAUSED',
  'ACTIVE_SLICE_EXISTS',
  'OVERLAP_ACTIVE',
  'NO_NEW_DATA',
  'COALESCED',
  'START_DEADLINE_ELAPSED',
  'RESOURCE_UNAVAILABLE',
  'INPUT_MISSING',
  'VERSION_INVALID',
  'ACCOUNT_UNAVAILABLE',
  'ANALYSIS_BUDGET_EXHAUSTED',
  'ANALYSIS_CONFIG_INVALID',
  'DUPLICATE_ANALYSIS_SCOPE',
] as const
export type ScheduleSkipReason = (typeof SCHEDULE_SKIP_REASONS)[number]
export const scheduleSkipReasonSchema = z.enum(SCHEDULE_SKIP_REASONS)

const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '本地时间须为 HH:mm')
const ruleIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/, '窗口标识须为 1–64 位 [A-Za-z0-9._:-]')

export const calendarWindowSchema = z.strictObject({
  ruleId: ruleIdSchema,
  windowStart: localTimeSchema,
  windowEnd: localTimeSchema,
})
export type CalendarWindow = z.infer<typeof calendarWindowSchema>

function assertIanaTimezone(timezone: string, ctx: z.RefinementCtx, path: (string | number)[]) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
  } catch {
    ctx.addIssue({ code: 'custom', path, message: '须为有效 IANA 时区' })
  }
}

function minutesOf(value: string): number {
  const { hour, minute } = parseLocalHm(value)
  return hour * 60 + minute
}

function windowOverlaps(left: CalendarWindow, right: CalendarWindow): boolean {
  const leftStart = minutesOf(left.windowStart)
  const leftEnd = minutesOf(left.windowEnd)
  const rightStart = minutesOf(right.windowStart)
  const rightEnd = minutesOf(right.windowEnd)
  const leftSpans = leftEnd <= leftStart
  const rightSpans = rightEnd <= rightStart
  const leftRange: ReadonlyArray<readonly [number, number]> = leftSpans
    ? [[leftStart, 24 * 60], [0, leftEnd]]
    : [[leftStart, leftEnd]]
  const rightRange: ReadonlyArray<readonly [number, number]> = rightSpans
    ? [[rightStart, 24 * 60], [0, rightEnd]]
    : [[rightStart, rightEnd]]
  return leftRange.some(([ls, le]) => rightRange.some(([rs, re]) => ls < re && rs < le))
}

export const calendarTimeRuleSchema = z
  .strictObject({
    kind: z.literal('calendar'),
    timezone: z.string().trim().min(1).max(64),
    weekdays: z.array(scheduleWeekdaySchema).min(1).max(7),
    windows: z.array(calendarWindowSchema).min(1).max(8),
    misfire: z.enum(['skip', 'coalesce']),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.weekdays).size !== value.weekdays.length) {
      ctx.addIssue({ code: 'custom', path: ['weekdays'], message: '星期集合不能重复' })
    }
    assertIanaTimezone(value.timezone, ctx, ['timezone'])
    const ids = new Set<string>()
    for (const [index, window] of value.windows.entries()) {
      if (ids.has(window.ruleId)) {
        ctx.addIssue({ code: 'custom', path: ['windows', index, 'ruleId'], message: '窗口标识不能重复' })
      }
      ids.add(window.ruleId)
      if (window.windowStart === window.windowEnd) {
        ctx.addIssue({ code: 'custom', path: ['windows', index, 'windowEnd'], message: '结束时间不能等于开始时间' })
      }
    }
    for (let i = 0; i < value.windows.length; i += 1) {
      for (let j = i + 1; j < value.windows.length; j += 1) {
        if (windowOverlaps(value.windows[i]!, value.windows[j]!)) {
          ctx.addIssue({ code: 'custom', path: ['windows', j], message: '执行窗口不能相互重叠' })
        }
      }
    }
  })
export type CalendarTimeRule = z.infer<typeof calendarTimeRuleSchema>

export const intervalTimeRuleSchema = z.strictObject({
  kind: z.literal('interval'),
  intervalMs: z.number().int().min(SCHEDULE_INTERVAL_MIN_MS).max(SCHEDULE_INTERVAL_MAX_MS),
  anchorUtc: utcInstantSchema,
  startDelayMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
  misfire: z.enum(['skip', 'coalesce']),
})
export type IntervalTimeRule = z.infer<typeof intervalTimeRuleSchema>

export const scheduleTimeRuleSchema = z.discriminatedUnion('kind', [calendarTimeRuleSchema, intervalTimeRuleSchema])
export type ScheduleTimeRule = z.infer<typeof scheduleTimeRuleSchema>

export const resolvedAccountBindingSchema = z.strictObject({
  resolved: z.boolean().optional(),
  targetAccountId: entityIdSchema.optional(),
})
export type ResolvedAccountBinding = z.infer<typeof resolvedAccountBindingSchema>

export const scenarioRunScheduleConsumerSchema = z.strictObject({
  type: z.literal(SCHEDULE_CONSUMER_SCENARIO_RUN),
  targetId: entityIdSchema,
  scenarioId: entityIdSchema,
  scenarioVersionId: entityIdSchema,
  accountBinding: resolvedAccountBindingSchema.default({}),
  input: z.record(z.string(), jsonValueSchema).default({}),
})
export type ScenarioRunScheduleConsumer = z.infer<typeof scenarioRunScheduleConsumerSchema>

export const resolvedSuiteMemberBindingSchema = z.strictObject({
  accountResolved: z.boolean().optional(),
  memberId: suiteMemberIdSchema,
  scenarioId: entityIdSchema,
  scenarioVersionId: entityIdSchema,
  targetAccountId: entityIdSchema.optional(),
  input: z.record(z.string(), jsonValueSchema).optional(),
})
export type ResolvedSuiteMemberBinding = z.infer<typeof resolvedSuiteMemberBindingSchema>

export const suiteRunScheduleConsumerSchema = z.strictObject({
  type: z.literal(SCHEDULE_CONSUMER_SUITE_RUN),
  targetId: entityIdSchema,
  suiteId: entityIdSchema,
  suiteVersionId: entityIdSchema,
  members: z.array(resolvedSuiteMemberBindingSchema).min(1).max(32),
  sharedInput: z.record(z.string(), jsonValueSchema).optional(),
  defaultTargetAccountId: entityIdSchema.optional(),
  policy: z
    .strictObject({
      deadlineMs: z.number().int().positive().optional(),
      failurePolicy: suiteFailurePolicySchema.optional(),
    })
    .default({}),
})
export type SuiteRunScheduleConsumer = z.infer<typeof suiteRunScheduleConsumerSchema>

export const mapRefreshScheduleConsumerSchema = z.strictObject({
  type: z.literal(SCHEDULE_CONSUMER_MAP_REFRESH),
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema,
  entryId: entityIdSchema,
  selectedAssetRefs: z.array(mapAssetRefSchema).max(32).default([]),
})
export type MapRefreshScheduleConsumer = z.infer<typeof mapRefreshScheduleConsumerSchema>

export const analysisSourceScopeSchema = z.strictObject({
  scenarioIds: z.array(entityIdSchema).max(32).optional(),
  suiteIds: z.array(entityIdSchema).max(32).optional(),
  includeFailures: z.boolean().default(true),
})
export type AnalysisSourceScope = z.infer<typeof analysisSourceScopeSchema>

export const analysisBudgetSchema = z.strictObject({
  maxItems: z.number().int().min(1).max(500).default(50),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
  useAi: z.boolean().default(false),
})
export type AnalysisBudget = z.infer<typeof analysisBudgetSchema>

export const knowledgeAnalysisScheduleConsumerSchema = z.strictObject({
  type: z.literal(SCHEDULE_CONSUMER_KNOWLEDGE_ANALYSIS),
  targetId: entityIdSchema,
  mode: analysisModeSchema,
  source: analysisSourceScopeSchema.default({ includeFailures: true }),
  strategyVersion: z.string().trim().min(1).max(64).default('analysis-strategy@1'),
  budget: analysisBudgetSchema.default({ maxItems: 50, useAi: false }),
})
export type KnowledgeAnalysisScheduleConsumer = z.infer<typeof knowledgeAnalysisScheduleConsumerSchema>

export const scheduleConsumerSchema = z.discriminatedUnion('type', [
  scenarioRunScheduleConsumerSchema,
  suiteRunScheduleConsumerSchema,
  mapRefreshScheduleConsumerSchema,
  knowledgeAnalysisScheduleConsumerSchema,
])
export type ScheduleConsumer = z.infer<typeof scheduleConsumerSchema>

const modernDefinitionFields = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  timeRule: scheduleTimeRuleSchema,
  consumer: scheduleConsumerSchema,
  effectiveAt: utcInstantSchema.optional(),
  expiresAt: utcInstantSchema.optional(),
})

const flattenedDefinitionFields = z.object({
  timezone: z.string().trim().min(1).max(64),
  weekdays: z.array(scheduleWeekdaySchema).min(1).max(7),
  windowStart: localTimeSchema,
  windowEnd: localTimeSchema,
  misfire: z.enum(['skip', 'coalesce']),
})

export const scheduleDefinitionOutputSchema = modernDefinitionFields.merge(flattenedDefinitionFields).superRefine((value, ctx) => {
  if (value.consumer.type !== 'knowledge_analysis' && value.timeRule.misfire === 'coalesce') {
    ctx.addIssue({ code: 'custom', path: ['timeRule', 'misfire'], message: '业务执行和知识地图采集须跳过错过窗口，只有知识分析支持合并补跑' })
  }
  if (value.effectiveAt && value.expiresAt && value.expiresAt <= value.effectiveAt) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: '停止时间必须晚于生效时间' })
  }
})

function flattenDefinition(input: z.infer<typeof modernDefinitionFields>): z.infer<typeof scheduleDefinitionOutputSchema> {
  const timeRule = input.timeRule
  if (timeRule.kind === 'calendar') {
    const first = timeRule.windows[0]!
    return scheduleDefinitionOutputSchema.parse({
      ...input,
      timezone: timeRule.timezone,
      weekdays: timeRule.weekdays,
      windowStart: first.windowStart,
      windowEnd: first.windowEnd,
      misfire: timeRule.misfire,
    })
  }
  return scheduleDefinitionOutputSchema.parse({
    ...input,
    timezone: 'UTC',
    weekdays: [...SCHEDULE_WEEKDAYS],
    windowStart: '00:00',
    windowEnd: '23:59',
    misfire: timeRule.misfire,
  })
}

function pickRecord(value: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]))
}

export const scheduleDefinitionSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw
  const value = raw as Record<string, unknown>
  if ('timeRule' in value) {
    const parsed = modernDefinitionFields.safeParse(pickRecord(value, ['name', 'timeRule', 'consumer', 'effectiveAt', 'expiresAt']))
    return parsed.success ? flattenDefinition(parsed.data) : raw
  }
  const legacy = z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      timezone: z.string().trim().min(1).max(64),
      weekdays: z.array(scheduleWeekdaySchema).min(1).max(7),
      windowStart: localTimeSchema,
      windowEnd: localTimeSchema,
      misfire: z.literal('skip'),
      consumer: scheduleConsumerSchema,
      effectiveAt: utcInstantSchema.optional(),
      expiresAt: utcInstantSchema.optional(),
    })
    .safeParse(pickRecord(value, ['name', 'timezone', 'weekdays', 'windowStart', 'windowEnd', 'misfire', 'consumer', 'effectiveAt', 'expiresAt']))
  if (!legacy.success) return raw
  return flattenDefinition({
    name: legacy.data.name,
    timeRule: {
      kind: 'calendar',
      timezone: legacy.data.timezone,
      weekdays: legacy.data.weekdays,
      windows: [{ ruleId: 'default', windowStart: legacy.data.windowStart, windowEnd: legacy.data.windowEnd }],
      misfire: 'skip',
    },
    consumer: legacy.data.consumer,
    effectiveAt: legacy.data.effectiveAt,
    expiresAt: legacy.data.expiresAt,
  })
}, scheduleDefinitionOutputSchema)
export type ScheduleDefinition = z.infer<typeof scheduleDefinitionOutputSchema>

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

export const scheduleTriggerBodySchema = z.strictObject({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
})
export type ScheduleTriggerBody = z.infer<typeof scheduleTriggerBodySchema>

export const schedulePreviewRequestSchema = z.strictObject({
  definition: scheduleDefinitionSchema,
  asOf: utcInstantSchema.optional(),
})
export type SchedulePreviewRequest = z.infer<typeof schedulePreviewRequestSchema>

export const schedulePreviewQuerySchema = z.strictObject({
  kind: z.enum(['calendar', 'interval']).default('calendar'),
  timezone: z.string().trim().min(1).max(64).optional(),
  weekdays: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').map((item) => Number(item.trim())) : undefined)),
  windowStart: localTimeSchema.optional(),
  windowEnd: localTimeSchema.optional(),
  windows: z.string().max(256).optional(),
  intervalMs: z.coerce.number().int().min(SCHEDULE_INTERVAL_MIN_MS).max(SCHEDULE_INTERVAL_MAX_MS).optional(),
  anchorUtc: utcInstantSchema.optional(),
  startDelayMs: z.coerce.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
  misfire: z.enum(['skip', 'coalesce']).optional(),
  asOf: utcInstantSchema.optional(),
})
export type SchedulePreviewQuery = z.infer<typeof schedulePreviewQuerySchema>

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
  ruleId: z.string().min(1).max(64).optional(),
})
export type ResolvedValidWindow = z.infer<typeof resolvedValidWindowSchema>

export const resolvedSkippedWindowSchema = z.strictObject({
  kind: z.literal('skipped'),
  localSlotKey: z.string().min(1).max(128),
  localStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.enum(['DST_NONEXISTENT', 'INVALID_RESOLVED_WINDOW']),
  timeRuleVersion: z.literal(SCHEDULE_TIME_RULE_VERSION),
  ruleId: z.string().min(1).max(64).optional(),
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
  source: scheduleOccurrenceSourceSchema.default('scheduled'),
  ruleId: z.string().min(1).max(64).nullable().optional(),
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
  runId: entityIdSchema.nullable().optional(),
  suiteRunId: entityIdSchema.nullable().optional(),
  analysisJobId: entityIdSchema.nullable().optional(),
  firstRunId: entityIdSchema.optional(),
  createdAt: utcInstantSchema,
  admittedAt: utcInstantSchema.nullable(),
})
export type ScheduleOccurrenceDto = z.infer<typeof scheduleOccurrenceDtoSchema>

export const scheduleDtoSchema = z.strictObject({
  scheduleId: entityIdSchema,
  name: z.string().min(1).max(120).nullable().optional(),
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema.nullable(),
  consumerKey: scheduleConsumerTypeSchema,
  enabled: z.boolean(),
  revision: z.number().int().min(1),
  currentVersionId: entityIdSchema,
  definition: scheduleDefinitionSchema,
  nextDueAt: utcInstantSchema.nullable(),
  lastOccurrence: scheduleOccurrenceDtoSchema.nullable(),
  objectLabel: z.string().max(160).nullable().optional(),
  blockReasons: z.array(z.string().min(1).max(64)).optional(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type ScheduleDto = z.infer<typeof scheduleDtoSchema>

export const scheduleWriteResponseSchema = z.strictObject({
  schedule: scheduleDtoSchema,
  created: z.boolean(),
})
export type ScheduleWriteResponse = z.infer<typeof scheduleWriteResponseSchema>

export const scheduleTriggerResponseSchema = z.strictObject({
  occurrence: scheduleOccurrenceDtoSchema,
})
export type ScheduleTriggerResponse = z.infer<typeof scheduleTriggerResponseSchema>

export const scheduleListQuerySchema = z.strictObject({
  targetId: entityIdSchema.optional(),
  scenarioId: entityIdSchema.optional(),
  suiteId: entityIdSchema.optional(),
  consumerKey: scheduleConsumerTypeSchema.optional(),
  mode: analysisModeSchema.optional(),
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

export function scheduleOccurrenceKey(scheduleId: string, windowStartUtc: string, ruleId?: string): string {
  return ruleId && ruleId !== 'default'
    ? `schedule:${scheduleId}:${ruleId}:${windowStartUtc}`
    : `schedule:${scheduleId}:${windowStartUtc}`
}

export function scheduleLocalSlotKey(scheduleId: string, localStartDate: string, ruleId?: string): string {
  return ruleId && ruleId !== 'default' ? `${scheduleId}:${ruleId}:${localStartDate}` : `${scheduleId}:${localStartDate}`
}

export function scheduledMapJobCommandKey(occurrenceId: string): string {
  return `map:scheduled:${occurrenceId}`
}

export function scheduledRunCommandKey(occurrenceId: string): string {
  return `run:scheduled:${occurrenceId}`
}

export function scheduledSuiteCommandKey(occurrenceId: string): string {
  return `suite:scheduled:${occurrenceId}`
}

export function scheduledAnalysisCommandKey(occurrenceId: string): string {
  return `analysis:scheduled:${occurrenceId}`
}

export function scheduleIdentityGuard(consumer: ScheduleConsumer): string | null {
  if (consumer.type === SCHEDULE_CONSUMER_MAP_REFRESH) return `map_refresh:${consumer.targetAccountId}`
  if (consumer.type === SCHEDULE_CONSUMER_KNOWLEDGE_ANALYSIS) {
    const digest = [
      consumer.mode,
      consumer.strategyVersion,
      JSON.stringify(consumer.source),
    ].join(':')
    return `knowledge_analysis:${consumer.targetId}:${digest}`
  }
  return null
}

export function consumerTargetAccountId(consumer: ScheduleConsumer): string | null {
  if (consumer.type === SCHEDULE_CONSUMER_MAP_REFRESH) return consumer.targetAccountId
  if (consumer.type === SCHEDULE_CONSUMER_SCENARIO_RUN) return consumer.accountBinding.targetAccountId ?? null
  return null
}

export function isMapRefreshConsumer(consumer: ScheduleConsumer): consumer is MapRefreshScheduleConsumer {
  return consumer.type === SCHEDULE_CONSUMER_MAP_REFRESH
}

export function calendarWindowsOf(definition: ScheduleDefinition): CalendarWindow[] {
  return definition.timeRule.kind === 'calendar'
    ? definition.timeRule.windows
    : [{ ruleId: 'interval', windowStart: definition.windowStart, windowEnd: definition.windowEnd }]
}

export function timeRuleOf(definition: ScheduleDefinition): ScheduleTimeRule {
  return definition.timeRule
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
  ruleId?: string
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
  const localSlotKey = scheduleLocalSlotKey(input.scheduleId, localStartDate, input.ruleId)
  const start = resolveLocalInstant(input.timezone, startLocal)
  const end = resolveLocalInstant(input.timezone, endLocal)
  if (start.kind === 'nonexistent' || end.kind === 'nonexistent') {
    return {
      kind: 'skipped',
      localSlotKey,
      localStartDate,
      reason: 'DST_NONEXISTENT',
      timeRuleVersion: SCHEDULE_TIME_RULE_VERSION,
      ruleId: input.ruleId,
    }
  }
  if (end.instant.getTime() <= start.instant.getTime()) {
    return {
      kind: 'skipped',
      localSlotKey,
      localStartDate,
      reason: 'INVALID_RESOLVED_WINDOW',
      timeRuleVersion: SCHEDULE_TIME_RULE_VERSION,
      ruleId: input.ruleId,
    }
  }
  const windowStartUtc = start.instant.toISOString()
  return {
    kind: 'ok',
    localSlotKey,
    occurrenceKey: scheduleOccurrenceKey(input.scheduleId, windowStartUtc, input.ruleId),
    localStartDate,
    windowStartUtc,
    windowEndUtc: end.instant.toISOString(),
    startOffsetMinutes: start.offsetMinutes,
    endOffsetMinutes: end.offsetMinutes,
    timeRuleVersion: SCHEDULE_TIME_RULE_VERSION,
    ruleId: input.ruleId,
  }
}

export function localDateInTimeZone(instant: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = formatInTimeZone(instant, timeZone)
  return { year: parts.year, month: parts.month, day: parts.day }
}

export function previewIntervalWindows(input: {
  scheduleId: string
  rule: IntervalTimeRule
  asOf: Date
  limit?: number
}): ResolvedScheduleWindow[] {
  const limit = input.limit ?? SCHEDULE_PREVIEW_LIMIT
  const interval = input.rule.intervalMs
  const anchor = new Date(input.rule.anchorUtc).getTime()
  const delay = input.rule.startDelayMs || interval
  const asOfMs = input.asOf.getTime()
  const firstEligible = Math.max(asOfMs, anchor)
  const offset = firstEligible <= anchor ? 0 : Math.ceil((firstEligible - anchor) / interval)
  const windows: ResolvedScheduleWindow[] = []
  for (let index = 0; windows.length < limit && index < limit + 8; index += 1) {
    const planned = anchor + (offset + index) * interval
    if (planned + interval <= asOfMs) continue
    const start = new Date(planned)
    const end = new Date(planned + delay)
    const local = localDateInTimeZone(start, 'UTC')
    const localStartDate = localDateString(local.year, local.month, local.day)
    const windowStartUtc = start.toISOString()
    windows.push({
      kind: 'ok',
      localSlotKey: scheduleLocalSlotKey(input.scheduleId, windowStartUtc, 'interval'),
      occurrenceKey: scheduleOccurrenceKey(input.scheduleId, windowStartUtc, 'interval'),
      localStartDate,
      windowStartUtc,
      windowEndUtc: end.toISOString(),
      startOffsetMinutes: 0,
      endOffsetMinutes: 0,
      timeRuleVersion: SCHEDULE_TIME_RULE_VERSION,
      ruleId: 'interval',
    })
  }
  return windows
}

export function previewScheduleWindows(input: {
  scheduleId: string
  definition: ScheduleDefinition
  asOf: Date
  limit?: number
}): ResolvedScheduleWindow[] {
  const limit = input.limit ?? SCHEDULE_PREVIEW_LIMIT
  const rule = timeRuleOf(input.definition)
  if (rule.kind === 'interval') {
    return previewIntervalWindows({ scheduleId: input.scheduleId, rule, asOf: input.asOf, limit })
  }
  const weekdays = new Set(rule.weekdays)
  const startDate = localDateInTimeZone(input.asOf, rule.timezone)
  const windows: ResolvedScheduleWindow[] = []
  for (let offset = -1; offset < 400 && windows.length < limit; offset += 1) {
    const date = addLocalDays(startDate.year, startDate.month, startDate.day, offset)
    if (!weekdays.has(isoWeekdayOfDate(date.year, date.month, date.day))) continue
    for (const window of [...rule.windows].sort((a, b) => a.windowStart.localeCompare(b.windowStart))) {
      if (windows.length >= limit) break
      const resolved = resolveScheduleWindow({
        scheduleId: input.scheduleId,
        timezone: rule.timezone,
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        localDate: date,
        ruleId: window.ruleId,
      })
      if (resolved.kind === 'ok' && new Date(resolved.windowEndUtc).getTime() <= input.asOf.getTime()) continue
      if (resolved.kind === 'skipped' && offset < 0) continue
      if (resolved.kind === 'skipped' && offset === 0) {
        const startHm = parseLocalHm(window.windowStart)
        const start = resolveLocalInstant(rule.timezone, { ...date, ...startHm })
        if (start.kind === 'ok' && start.instant.getTime() <= input.asOf.getTime()) continue
      }
      windows.push(resolved)
    }
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

export function timeRuleFromPreviewQuery(query: SchedulePreviewQuery): ScheduleTimeRule {
  if (query.kind === 'interval') {
    return intervalTimeRuleSchema.parse({
      kind: 'interval',
      intervalMs: query.intervalMs ?? SCHEDULE_INTERVAL_MIN_MS,
      anchorUtc: query.anchorUtc ?? new Date(0).toISOString(),
      startDelayMs: query.startDelayMs,
      misfire: query.misfire === 'skip' ? 'skip' : 'coalesce',
    })
  }
  const windows = query.windows
    ? query.windows.split('|').map((item, index) => {
        const [windowStart, windowEnd] = item.split('-')
        return { ruleId: index === 0 ? 'default' : `w${index + 1}`, windowStart, windowEnd }
      })
    : [{ ruleId: 'default', windowStart: query.windowStart ?? '02:00', windowEnd: query.windowEnd ?? '03:00' }]
  return calendarTimeRuleSchema.parse({
    kind: 'calendar',
    timezone: query.timezone ?? 'Asia/Shanghai',
    weekdays: (query.weekdays?.length ? query.weekdays : [1, 2, 3, 4, 5]) as ScheduleWeekday[],
    windows,
    misfire: 'skip',
  })
}

export const SCHEDULE_CONSUMER_LABELS: Record<ScheduleConsumerType, string> = {
  scenario_run: '场景执行',
  suite_run: '场景集执行',
  map_refresh: '知识地图采集',
  knowledge_analysis: '知识分析',
}

export const ANALYSIS_MODE_LABELS: Record<AnalysisMode, string> = {
  map_quality: '地图质量分析',
  run_incremental: '运行增量提炼',
}
