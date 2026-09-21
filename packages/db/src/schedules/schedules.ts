import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { z } from 'zod'
import {
  ANALYSIS_MODE_LABELS,
  SCHEDULE_CONSUMER_LABELS,
  SCHEDULE_CONSUMER_MAP_REFRESH,
  SCHEDULE_TICK_BATCH,
  SCHEDULE_TIME_RULE_VERSION,
  addLocalDays,
  assertRunFromResolved,
  canonicalJson,
  consumerTargetAccountId,
  hasAllPermissions,
  isMapRefreshConsumer,
  isoWeekdayOfDate,
  localDateInTimeZone,
  nextDueFromWindows,
  previewScheduleWindows,
  resolveScheduleWindow,
  scheduleDefinitionSchema,
  scheduleDtoSchema,
  scheduleEnabledBodySchema,
  scheduleEventDtoSchema,
  scheduleIdentityGuard,
  scheduleListResponseSchema,
  schedulePreviewQuerySchema,
  scheduleLocalSlotKey,
  scheduleOccurrenceDtoSchema,
  scheduleOccurrenceListResponseSchema,
  scheduleEventListResponseSchema,
  scheduleTriggerBodySchema,
  scheduleTriggerResponseSchema,
  scheduledAnalysisCommandKey,
  scheduledRunCommandKey,
  scheduledSuiteCommandKey,
  scheduleWriteBodySchema,
  scheduleWriteResponseSchema,
  timeRuleFromPreviewQuery,
  type ExecutionActor,
  type PlatformConfigDocument,
  type ResolvedScheduleWindow,
  type ScheduleConsumer,
  type ScheduleConsumerType,
  type ScheduleDefinition,
  type ScheduleDto,
  type ScheduleEventDto,
  type ScheduleListQuery,
  type ScheduleOccurrenceDto,
  type SchedulePreviewQuery,
  type ScheduleSkipReason,
  type ScheduleTickOutcome,
  type ScheduleTriggerBody,
  type ScheduleWriteResponse,
  type Step,
} from '@cairn/shared'
import { requireMapCapableAccount } from '../console/account-usage.js'
import type { Db } from '../client.js'
import { recordAudit } from '../audit/record.js'
import { decodeAuditCursor, encodeAuditCursor } from '../audit/cursor.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertIgnoreRows, insertRows, jsonTextEquals, locked, onCommit, schemaFor } from '../native.js'
import { DomainError, conflict, forbidden, isUniqueViolation, notFound } from '../runs/errors.js'
import { sha256Hex } from '../runs/digest.js'
import { cancelMapJob, createMapJob, getMapJob, getMapJobPolicy } from '../map/jobs.js'
import { getOrCreatePlatformConfig } from '../platform-config/store.js'
import { liveTargetExists } from '../lifecycle.js'
import { assertTargetPermission, lockConsoleAuthorization, scopedTargetFilter } from '../console/target-authorization.js'
import { requireLiveTarget } from '../map/view.js'
import { publishChangeHint } from '../observe/hint.js'
import { requestRunCancel, resolveRunTargetAccountId, writeRunWithSnapshot } from '../runs/runs.js'
import { loadResolutionLayers, stepsNeedAiExecute } from '../runs/resolution-layers.js'
import { loadScenarioVersion } from '../runs/scenarios.js'
import { cancelSuiteRun, createSuiteRun, previewSuiteRun } from '../suites/runs.js'
import { cancelAnalysisJob, createAnalysisJob } from '../analysis/jobs.js'
import { analysisScopeDigest } from '../analysis/sources.js'

function definitionFromVersion(row: {
  name?: string | null
  timezone: string
  weekdays: unknown
  windowStart: string
  windowEnd: string
  misfire: string
  consumer: unknown
  timeRule?: unknown
  effectiveAt?: Date | null
  expiresAt?: Date | null
}): ScheduleDefinition {
  const payload: Record<string, unknown> = {
    name: row.name ?? undefined,
    timezone: row.timezone,
    weekdays: row.weekdays,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    misfire: row.misfire,
    consumer: row.consumer,
    effectiveAt: row.effectiveAt?.toISOString(),
    expiresAt: row.expiresAt?.toISOString(),
  }
  if (row.timeRule) payload.timeRule = row.timeRule
  return scheduleDefinitionSchema.parse(payload)
}

function factoryEnabledFor(document: PlatformConfigDocument, type: ScheduleConsumerType): boolean {
  if (type === 'scenario_run') return document.scenarioScheduledRunEnabled
  if (type === 'suite_run') return document.suiteScheduledRunEnabled
  if (type === 'knowledge_analysis') return document.knowledgeAnalysisEnabled
  return document.mapScheduledRefreshEnabled
}

function writePermissionsFor(consumer: ScheduleConsumer): string[] {
  if (consumer.type === 'map_refresh') return ['schedule:write', 'map:maintain']
  if (consumer.type === 'knowledge_analysis') {
    return ['schedule:write', 'map:analyze', consumer.mode === 'run_incremental' ? 'run:read' : 'map:read', ...(consumer.budget.useAi ? ['ai:execute'] : [])]
  }
  return ['schedule:write', 'run:execute']
}

function identityConflictMessage(type: ScheduleConsumerType): string {
  return type === 'knowledge_analysis' ? '同范围已有启用中的知识分析计划' : '该账号已有自动复查计划'
}

function identityConflictCode(type: ScheduleConsumerType): string {
  return type === 'knowledge_analysis' ? 'SCHEDULE_IDENTITY_CONFLICT' : 'SCHEDULE_ACCOUNT_CONFLICT'
}

function occurrenceToDto(
  row: {
    id: string
    scheduleId: string
    scheduleVersionId: string
    source?: string | null
    ruleId?: string | null
    localSlotKey: string
    occurrenceKey: string | null
    localStartDate: string
    windowStartUtc: Date | null
    windowEndUtc: Date | null
    startOffsetMinutes: number | null
    endOffsetMinutes: number | null
    timeRuleVersion: string
    admissionStatus: string
    reason: string | null
    jobId: string | null
    runId?: string | null
    suiteRunId?: string | null
    analysisJobId?: string | null
    createdAt: Date
    admittedAt: Date | null
  },
  firstRunId?: string,
): ScheduleOccurrenceDto {
  return scheduleOccurrenceDtoSchema.parse({
    occurrenceId: row.id,
    scheduleId: row.scheduleId,
    scheduleVersionId: row.scheduleVersionId,
    source: row.source ?? 'scheduled',
    ruleId: row.ruleId ?? null,
    localSlotKey: row.localSlotKey,
    occurrenceKey: row.occurrenceKey,
    localStartDate: row.localStartDate,
    windowStartUtc: row.windowStartUtc?.toISOString() ?? null,
    windowEndUtc: row.windowEndUtc?.toISOString() ?? null,
    startOffsetMinutes: row.startOffsetMinutes,
    endOffsetMinutes: row.endOffsetMinutes,
    timeRuleVersion: row.timeRuleVersion,
    admissionStatus: row.admissionStatus,
    reason: row.reason,
    jobId: row.jobId,
    runId: row.runId ?? null,
    suiteRunId: row.suiteRunId ?? null,
    analysisJobId: row.analysisJobId ?? null,
    firstRunId: firstRunId ?? row.runId ?? undefined,
    createdAt: row.createdAt.toISOString(),
    admittedAt: row.admittedAt?.toISOString() ?? null,
  })
}

async function lastOccurrence(db: Db, scheduleId: string): Promise<ScheduleOccurrenceDto | null> {
  const { scheduleOccurrences } = schemaFor(db)
  const [row] = await db
    .select()
    .from(scheduleOccurrences)
    .where(eq(scheduleOccurrences.scheduleId, scheduleId))
    .orderBy(desc(scheduleOccurrences.createdAt), desc(scheduleOccurrences.id))
    .limit(1)
  return row ? occurrenceToDto(row) : null
}

async function scheduleToDto(db: Db, scheduleId: string): Promise<ScheduleDto> {
  const { schedules, scheduleVersions } = schemaFor(db)
  const [schedule] = await db.select().from(schedules).where(eq(schedules.id, scheduleId)).limit(1)
  if (!schedule) throw notFound('SCHEDULE_NOT_FOUND', '调度计划不存在')
  const [version] = await db
    .select()
    .from(scheduleVersions)
    .where(eq(scheduleVersions.id, schedule.currentVersionId))
    .limit(1)
  if (!version) throw notFound('SCHEDULE_NOT_FOUND', '调度计划修订不存在')
  const definition = definitionFromVersion(version)
  const config = await getOrCreatePlatformConfig(db)
  const objectLabel = await objectLabelFor(db, definition.consumer)
  const blockReasons: string[] = []
  if (!factoryEnabledFor(config.document, definition.consumer.type)) blockReasons.push('FACTORY_DISABLED')
  if (definition.consumer.type === 'map_refresh' && !schedule.targetAccountId) blockReasons.push('ACCOUNT_UNAVAILABLE')
  return scheduleDtoSchema.parse({
    scheduleId: schedule.id,
    name: schedule.name ?? version.name ?? objectLabel,
    targetId: schedule.targetId,
    targetAccountId: schedule.targetAccountId,
    consumerKey: schedule.consumerKey,
    enabled: schedule.enabled === 1,
    revision: schedule.revision,
    currentVersionId: schedule.currentVersionId,
    definition,
    nextDueAt: schedule.nextDueAt?.toISOString() ?? null,
    lastOccurrence: await lastOccurrence(db, scheduleId),
    objectLabel,
    blockReasons,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  })
}

async function appendEvent(
  tx: Db,
  scheduleId: string,
  eventType: string,
  payload: Record<string, unknown>,
  now: Date,
) {
  const { scheduleEvents } = schemaFor(tx)
  const [max] = await tx
    .select({ seq: sql<number>`COALESCE(MAX(${scheduleEvents.seq}), 0)` })
    .from(scheduleEvents)
    .where(eq(scheduleEvents.scheduleId, scheduleId))
  const seq = Number(max?.seq ?? 0) + 1
  await insertRows(tx, scheduleEvents, {
    id: newId(),
    scheduleId,
    seq,
    eventType,
    payload,
    createdAt: now,
  })
  onCommit(tx, () => publishChangeHint({ objectType: 'schedule', objectId: scheduleId, eventSeq: seq }))
}

async function accountPermissions(db: Db, accountId: string): Promise<string[]> {
  const { consoleAccountRoles, consoleRolePermissions } = schemaFor(db)
  const rows = await db
    .select({ permission: consoleRolePermissions.permission })
    .from(consoleAccountRoles)
    .innerJoin(
      consoleRolePermissions,
      eq(consoleRolePermissions.consoleRoleId, consoleAccountRoles.consoleRoleId),
    )
    .where(eq(consoleAccountRoles.consoleAccountId, accountId))
  return [...new Set(rows.map((row) => row.permission))]
}

export async function actorCanAdmitConsumer(
  db: Db,
  accountId: string,
  consumer: ScheduleConsumer,
): Promise<boolean> {
  try {
    for (const permission of writePermissionsFor(consumer)) {
      await assertTargetPermission(db, accountId, consumer.targetId, permission)
    }
    return true
  } catch (error) {
    if (error instanceof DomainError) return false
    throw error
  }
}

// Admission is historical. Only the linked execution's current lifecycle can
// establish an overlap; a completed occurrence must never block the next one.
async function activeOccurrences(db: Db, scheduleId: string, includePending = false) {
  const { scheduleOccurrences: occurrences, runs, suiteRuns, mapJobs, analysisJobs } = schemaFor(db)
  return db.select({ id: occurrences.id }).from(occurrences).where(and(
    eq(occurrences.scheduleId, scheduleId),
    or(
      includePending ? eq(occurrences.admissionStatus, 'PENDING') : undefined,
      and(eq(occurrences.admissionStatus, 'ADMITTED'), or(
        sql`EXISTS (SELECT 1 FROM ${runs} WHERE ${runs.id} = ${occurrences.runId} AND ${runs.status} NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED'))`,
        sql`EXISTS (SELECT 1 FROM ${suiteRuns} WHERE ${suiteRuns.id} = ${occurrences.suiteRunId} AND ${suiteRuns.status} IN ('QUEUED', 'RUNNING', 'WAITING', 'NEEDS_REVIEW'))`,
        sql`EXISTS (SELECT 1 FROM ${mapJobs} WHERE ${mapJobs.id} = ${occurrences.jobId} AND ${mapJobs.jobStatus} IN ('queued', 'running'))`,
        sql`EXISTS (SELECT 1 FROM ${analysisJobs} WHERE ${analysisJobs.id} = ${occurrences.analysisJobId} AND ${analysisJobs.status} IN ('QUEUED', 'RUNNING', 'RETRY_WAIT'))`,
      )),
    ),
  )).limit(1)
}

function identityGuard(consumer: ScheduleConsumer) {
  return consumer.type === 'knowledge_analysis' ? analysisScopeDigest(consumer) : scheduleIdentityGuard(consumer)
}

async function assertAnalysisIdentityAvailable(db: Db, consumer: ScheduleConsumer, scheduleId: string) {
  if (consumer.type !== 'knowledge_analysis') return
  const { schedules, scheduleVersions } = schemaFor(db)
  // Also compare pre-upgrade plans whose stored guard was an unbounded string.
  // New writes share a canonical, fixed-size guard protected by the unique index.
  const enabled = await db.select({ id: schedules.id, consumer: scheduleVersions.consumer }).from(schedules)
    .innerJoin(scheduleVersions, eq(scheduleVersions.id, schedules.currentVersionId))
    .where(and(eq(schedules.targetId, consumer.targetId), eq(schedules.consumerKey, 'knowledge_analysis'), eq(schedules.enabled, 1)))
  if (enabled.some(plan => plan.id !== scheduleId && identityGuard(plan.consumer as ScheduleConsumer) === identityGuard(consumer))) {
    throw conflict('SCHEDULE_IDENTITY_CONFLICT', identityConflictMessage(consumer.type))
  }
}

export async function actorCanAdmitSchedules(db: Db, accountId: string): Promise<boolean> {
  return hasAllPermissions(await accountPermissions(db, accountId), ['schedule:write', 'map:maintain'])
}

async function objectLabelFor(db: Db, consumer: ScheduleConsumer): Promise<string> {
  if (consumer.type === 'scenario_run') {
    const { scenarios } = schemaFor(db)
    const [row] = await db.select({ name: scenarios.name }).from(scenarios).where(eq(scenarios.id, consumer.scenarioId)).limit(1)
    return row?.name ?? SCHEDULE_CONSUMER_LABELS.scenario_run
  }
  if (consumer.type === 'suite_run') {
    const { scenarioSuites } = schemaFor(db)
    const [row] = await db
      .select({ name: scenarioSuites.name })
      .from(scenarioSuites)
      .where(eq(scenarioSuites.id, consumer.suiteId))
      .limit(1)
    return row?.name ?? SCHEDULE_CONSUMER_LABELS.suite_run
  }
  if (consumer.type === 'knowledge_analysis') {
    return `${SCHEDULE_CONSUMER_LABELS.knowledge_analysis} · ${ANALYSIS_MODE_LABELS[consumer.mode]}`
  }
  return SCHEDULE_CONSUMER_LABELS.map_refresh
}

async function assertScheduleWritePermission(db: Db, actorId: string, consumer: ScheduleConsumer) {
  if (!(await actorCanAdmitConsumer(db, actorId, consumer))) {
    throw forbidden('SCHEDULE_FORBIDDEN', '没有该类调度的写入或执行权限')
  }
}

async function assertConsumerResources(db: Db, definition: ScheduleDefinition, actorId: string) {
  const consumer = definition.consumer
  const target = await requireLiveTarget(db, consumer.targetId)
  if (target.status !== 'active') throw conflict('TARGET_DISABLED', '目标系统已停用')
  if (consumer.type === 'knowledge_analysis') {
    const { scenarios, scenarioSuites } = schemaFor(db)
    for (const scenarioId of consumer.source.scenarioIds ?? []) {
      const [row] = await db.select({ id: scenarios.id }).from(scenarios).where(and(eq(scenarios.id, scenarioId), eq(scenarios.targetId, consumer.targetId), isNull(scenarios.deletedAt))).limit(1)
      if (!row) throw notFound('ANALYSIS_SOURCE_NOT_FOUND', '来源场景不存在或不属于当前目标')
    }
    for (const suiteId of consumer.source.suiteIds ?? []) {
      const [row] = await db.select({ id: scenarioSuites.id }).from(scenarioSuites).where(and(eq(scenarioSuites.id, suiteId), eq(scenarioSuites.targetId, consumer.targetId), isNull(scenarioSuites.deletedAt))).limit(1)
      if (!row) throw notFound('ANALYSIS_SOURCE_NOT_FOUND', '来源场景集不存在或不属于当前目标')
    }
  }
  if (consumer.type === 'scenario_run') {
    const loaded = await loadScenarioVersion(db, consumer.scenarioId, consumer.scenarioVersionId)
    if (loaded.scenario.targetId !== consumer.targetId) throw conflict('SCHEDULE_TARGET_MISMATCH', '场景不属于该目标')
    if (loaded.version.kind === 'trial') throw conflict('SCHEDULE_VERSION_INVALID', '正式调度只能使用已发布场景版本')
    assertRunFromResolved(loaded.version.definition.steps, consumer.input)
    const layers = await loadResolutionLayers(db, consumer.targetId)
    if (stepsNeedAiExecute(loaded.version.definition.steps, layers, loaded.version.definition.resolution)) {
      await assertTargetPermission(db, actorId, consumer.targetId, 'ai:execute')
    }
    return
  }
  if (consumer.type === 'suite_run') {
    const preview = await previewSuiteRun(
      db,
      {
        suiteId: consumer.suiteId,
        suiteVersionId: consumer.suiteVersionId,
        sharedInput: consumer.sharedInput,
        defaultTargetAccountId: consumer.defaultTargetAccountId,
        memberOverrides: Object.fromEntries(
          consumer.members.map((member) => [
            member.memberId,
            { input: member.input, targetAccountId: member.targetAccountId },
          ]),
        ),
        idempotencyKey: `preview-${consumer.suiteId}`.padEnd(8, '0'),
      },
      actorId,
      Object.fromEntries(consumer.members.filter(member => member.accountResolved).map(member => [member.memberId, member.targetAccountId ?? null])),
    )
    if (preview.targetId !== consumer.targetId) throw conflict('SCHEDULE_TARGET_MISMATCH', '场景集不属于该目标')
    if (preview.issues.some(issue => issue.severity === 'error')) throw conflict('SUITE_VALIDATION_FAILED', '场景集调度输入未通过校验', preview.issues)
    if (consumer.policy.failurePolicy && consumer.policy.failurePolicy !== preview.failurePolicy) throw conflict('SCHEDULE_POLICY_MISMATCH', '调度失败策略须与固定集合版本一致')
    if (consumer.members.length !== preview.members.length || consumer.members.some(member => !preview.members.some(published => published.memberId === member.memberId && published.scenarioId === member.scenarioId && published.scenarioVersionId === member.scenarioVersionId))) throw conflict('SCHEDULE_VERSION_INVALID', '调度成员须与固定集合版本一致')
    const layers = await loadResolutionLayers(db, consumer.targetId)
    for (const member of consumer.members) {
      const loaded = await loadScenarioVersion(db, member.scenarioId, member.scenarioVersionId)
      if (stepsNeedAiExecute(loaded.version.definition.steps, layers, loaded.version.definition.resolution)) {
        await assertTargetPermission(db, actorId, consumer.targetId, 'ai:execute')
      }
    }
    return
  }
}

function nextDueAfter(scheduleId: string, definition: ScheduleDefinition, localDate: { year: number; month: number; day: number }, asOf: Date): Date | null {
  const windows = previewScheduleWindows({
    scheduleId,
    definition,
    asOf: new Date(Date.UTC(localDate.year, localDate.month - 1, localDate.day + 1, 0, 0, 0)),
    limit: 1,
  })
  return nextDueFromWindows(windows, asOf)
}

function nextDueAfterResolved(
  scheduleId: string,
  definition: ScheduleDefinition,
  resolved: ResolvedScheduleWindow,
  asOf: Date,
): Date | null {
  const after =
    resolved.kind === 'ok'
      ? new Date(new Date(resolved.windowEndUtc).getTime())
      : new Date(`${resolved.localStartDate}T00:00:00.000Z`)
  if (resolved.kind === 'skipped') {
    const [year, month, day] = resolved.localStartDate.split('-').map(Number)
    return nextDueAfter(scheduleId, definition, { year: year!, month: month!, day: day! }, asOf)
  }
  if (definition.timeRule.kind === 'interval' && resolved.kind === 'ok') {
    return new Date(new Date(resolved.windowStartUtc).getTime() + definition.timeRule.intervalMs)
  }
  return nextDueFromWindows(previewScheduleWindows({ scheduleId, definition, asOf: after, limit: 1 }), after)
}

function windowRow(
  resolved: ResolvedScheduleWindow,
  scheduleId: string,
  versionId: string,
  now: Date,
  status: 'PENDING' | 'SKIPPED',
  reason?: ScheduleSkipReason,
  source: 'scheduled' | 'manual' = 'scheduled',
) {
  return {
    id: newId(),
    scheduleId,
    scheduleVersionId: versionId,
    source,
    ruleId: resolved.ruleId ?? null,
    localSlotKey: resolved.localSlotKey,
    occurrenceKey: resolved.kind === 'ok' ? resolved.occurrenceKey : null,
    localStartDate: resolved.localStartDate,
    windowStartUtc: resolved.kind === 'ok' ? new Date(resolved.windowStartUtc) : null,
    windowEndUtc: resolved.kind === 'ok' ? new Date(resolved.windowEndUtc) : null,
    startOffsetMinutes: resolved.kind === 'ok' ? resolved.startOffsetMinutes : null,
    endOffsetMinutes: resolved.kind === 'ok' ? resolved.endOffsetMinutes : null,
    timeRuleVersion: resolved.timeRuleVersion,
    admissionStatus: status,
    reason: reason ?? (resolved.kind === 'skipped' ? resolved.reason : null),
    jobId: null,
    runId: null,
    suiteRunId: null,
    analysisJobId: null,
    createdAt: now,
    admittedAt: null,
  }
}

export async function getSchedule(db: Db, scheduleId: string, actorId?: string): Promise<ScheduleDto> {
  const dto = await scheduleToDto(db, scheduleId)
  if (actorId) await assertTargetPermission(db, actorId, dto.targetId, 'schedule:read')
  return dto
}

export async function listScheduleEventsAfter(db: Db, scheduleId: string, after: number, actorId: string) {
  await getSchedule(db, scheduleId, actorId)
  const { scheduleEvents } = schemaFor(db)
  const rows = await db.select().from(scheduleEvents)
    .where(and(eq(scheduleEvents.scheduleId, scheduleId), sql`${scheduleEvents.seq} > ${after}`))
    .orderBy(asc(scheduleEvents.seq)).limit(100)
  return rows.map(({ id, ...row }) => scheduleEventDtoSchema.parse({ ...row, eventId: id, createdAt: row.createdAt.toISOString() }))
}

export async function retireSchedulesForOwner(
  tx: Db,
  input: { targetId?: string; targetAccountId?: string },
  now: Date,
  actor: ExecutionActor,
): Promise<number> {
  const { schedules, scheduleOccurrences } = schemaFor(tx)
  const ownerFilter = [
    input.targetId ? eq(schedules.targetId, input.targetId) : undefined,
    input.targetAccountId ? eq(schedules.targetAccountId, input.targetAccountId) : undefined,
  ].filter((item): item is NonNullable<typeof item> => item !== undefined)
  if (ownerFilter.length === 0) return 0
  const rows = await tx
    .select({ id: schedules.id, enabled: schedules.enabled })
    .from(schedules)
    .where(and(...ownerFilter))
  for (const row of rows) {
    if (row.enabled === 1) {
      const admitted = await tx
        .select()
        .from(scheduleOccurrences)
        .where(and(eq(scheduleOccurrences.scheduleId, row.id), eq(scheduleOccurrences.admissionStatus, 'ADMITTED')))
      for (const occurrence of admitted) {
        if (occurrence.jobId) await cancelMapJob(tx, occurrence.jobId, actor).catch(() => undefined)
      }
    }
    await tx
      .update(schedules)
      .set({
        enabled: 0,
        enabledGuard: null,
        nextDueAt: null,
        updatedAt: now,
      })
      .where(eq(schedules.id, row.id))
  }
  return rows.length
}

export async function listSchedules(db: Db, query: ScheduleListQuery, actorId?: string): Promise<{ items: ScheduleDto[]; nextCursor?: string }> {
  const { schedules, scheduleVersions, scheduleOccurrences, scenarios, scenarioSuites } = schemaFor(db)
  const decoded = query.cursor ? decodeAuditCursor(query.cursor) : null
  const rows = await db
    .select()
    .from(schedules)
    .where(
      and(
        query.targetId ? eq(schedules.targetId, query.targetId) : undefined,
        liveTargetExists(db, schedules.targetId),
        await scopedTargetFilter(db, actorId, schedules.targetId, 'schedule:read'),
        query.consumerKey ? eq(schedules.consumerKey, query.consumerKey) : undefined,
        query.scenarioId || query.suiteId || query.mode ? sql`EXISTS (${db.select({ id: scheduleVersions.id }).from(scheduleVersions).where(and(
          eq(scheduleVersions.id, schedules.currentVersionId),
          query.scenarioId ? and(eq(schedules.consumerKey, 'scenario_run'), jsonTextEquals(db, scheduleVersions.consumer, ['scenarioId'], query.scenarioId)) : undefined,
          query.suiteId ? and(eq(schedules.consumerKey, 'suite_run'), jsonTextEquals(db, scheduleVersions.consumer, ['suiteId'], query.suiteId)) : undefined,
          query.mode ? and(eq(schedules.consumerKey, 'knowledge_analysis'), jsonTextEquals(db, scheduleVersions.consumer, ['mode'], query.mode)) : undefined,
        ))})` : undefined,
        query.enabled === undefined ? undefined : eq(schedules.enabled, query.enabled ? 1 : 0),
        decoded
          ? or(
              sql`${schedules.createdAt} < ${decoded.createdAt}`,
              and(eq(schedules.createdAt, decoded.createdAt), sql`${schedules.id} < ${decoded.id}`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(schedules.createdAt), desc(schedules.id))
    .limit(query.limit + 1)
  const page = rows.slice(0, query.limit)
  if (page.length === 0) {
    return scheduleListResponseSchema.parse({ items: [], nextCursor: undefined })
  }

  const versionIds = [...new Set(page.map((r) => r.currentVersionId).filter(Boolean))]
  const versionRows = versionIds.length > 0
    ? await db.select().from(scheduleVersions).where(inArray(scheduleVersions.id, versionIds))
    : []
  const versionsById = new Map(versionRows.map((v) => [v.id, v]))

  const scheduleIds = page.map((r) => r.id)
  const occurrenceRanked = db
    .select({
      id: scheduleOccurrences.id,
      scheduleId: scheduleOccurrences.scheduleId,
      rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${scheduleOccurrences.scheduleId} ORDER BY ${scheduleOccurrences.createdAt} DESC, ${scheduleOccurrences.id} DESC)`.as('rn'),
    })
    .from(scheduleOccurrences)
    .where(inArray(scheduleOccurrences.scheduleId, scheduleIds))
    .as('ranked_occurrences')

  const latestOccurrenceRows = await db
    .select({
      occurrence: scheduleOccurrences,
    })
    .from(scheduleOccurrences)
    .innerJoin(
      occurrenceRanked,
      and(
        eq(scheduleOccurrences.id, occurrenceRanked.id),
        eq(occurrenceRanked.rn, 1),
      ),
    )
  const lastOccurrenceByScheduleId = new Map<string, ScheduleOccurrenceDto>()
  for (const row of latestOccurrenceRows) {
    lastOccurrenceByScheduleId.set(row.occurrence.scheduleId, occurrenceToDto(row.occurrence))
  }

  const config = await getOrCreatePlatformConfig(db)

  const scenarioIdsToFetch: string[] = []
  const suiteIdsToFetch: string[] = []
  for (const row of page) {
    const version = versionsById.get(row.currentVersionId)
    if (!version) continue
    const def = definitionFromVersion(version)
    if (def.consumer.type === 'scenario_run') {
      scenarioIdsToFetch.push(def.consumer.scenarioId)
    } else if (def.consumer.type === 'suite_run') {
      suiteIdsToFetch.push(def.consumer.suiteId)
    }
  }

  const scenarioNamesById = new Map<string, string>()
  if (scenarioIdsToFetch.length > 0) {
    const scenarioRows = await db
      .select({ id: scenarios.id, name: scenarios.name })
      .from(scenarios)
      .where(inArray(scenarios.id, [...new Set(scenarioIdsToFetch)]))
    for (const s of scenarioRows) {
      scenarioNamesById.set(s.id, s.name)
    }
  }

  const suiteNamesById = new Map<string, string>()
  if (suiteIdsToFetch.length > 0) {
    const suiteRows = await db
      .select({ id: scenarioSuites.id, name: scenarioSuites.name })
      .from(scenarioSuites)
      .where(inArray(scenarioSuites.id, [...new Set(suiteIdsToFetch)]))
    for (const s of suiteRows) {
      suiteNamesById.set(s.id, s.name)
    }
  }

  const loaded: ScheduleDto[] = []
  for (const schedule of page) {
    const version = versionsById.get(schedule.currentVersionId)
    if (!version) continue
    const definition = definitionFromVersion(version)
    let objectLabel = SCHEDULE_CONSUMER_LABELS.map_refresh
    if (definition.consumer.type === 'scenario_run') {
      objectLabel = scenarioNamesById.get(definition.consumer.scenarioId) ?? SCHEDULE_CONSUMER_LABELS.scenario_run
    } else if (definition.consumer.type === 'suite_run') {
      objectLabel = suiteNamesById.get(definition.consumer.suiteId) ?? SCHEDULE_CONSUMER_LABELS.suite_run
    } else if (definition.consumer.type === 'knowledge_analysis') {
      objectLabel = `${SCHEDULE_CONSUMER_LABELS.knowledge_analysis} · ${ANALYSIS_MODE_LABELS[definition.consumer.mode]}`
    }

    const blockReasons: string[] = []
  if (!factoryEnabledFor(config.document, definition.consumer.type)) blockReasons.push('FACTORY_DISABLED')
    if (definition.consumer.type === 'map_refresh' && !schedule.targetAccountId) blockReasons.push('ACCOUNT_UNAVAILABLE')

    loaded.push(
      scheduleDtoSchema.parse({
        scheduleId: schedule.id,
        name: schedule.name ?? version.name ?? objectLabel,
        targetId: schedule.targetId,
        targetAccountId: schedule.targetAccountId,
        consumerKey: schedule.consumerKey,
        enabled: schedule.enabled === 1,
        revision: schedule.revision,
        currentVersionId: schedule.currentVersionId,
        definition,
        nextDueAt: schedule.nextDueAt?.toISOString() ?? null,
        lastOccurrence: lastOccurrenceByScheduleId.get(schedule.id) ?? null,
        objectLabel,
        blockReasons,
        createdAt: schedule.createdAt.toISOString(),
        updatedAt: schedule.updatedAt.toISOString(),
      }),
    )
  }

  const items = query.mode
    ? loaded.filter(
        (item) => item.definition.consumer.type === 'knowledge_analysis' && item.definition.consumer.mode === query.mode,
      )
    : loaded
  return scheduleListResponseSchema.parse({
    items,
    nextCursor: rows.length > query.limit ? encodeAuditCursor(page.at(-1)!.createdAt, page.at(-1)!.id) : undefined,
  })
}

export async function writeSchedule(
  db: Db,
  body: z.input<typeof scheduleWriteBodySchema>,
  actor: ExecutionActor,
  existingId?: string,
): Promise<ScheduleWriteResponse> {
  const parsed = scheduleWriteBodySchema.parse(body)
  await requireLiveTarget(db, parsed.definition.consumer.targetId)
  await assertScheduleWritePermission(db, actor.id, parsed.definition.consumer)
  await assertConsumerResources(db, parsed.definition, actor.id)
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actor.id)
    await assertScheduleWritePermission(tx, actor.id, parsed.definition.consumer)
    await assertConsumerResources(tx, parsed.definition, actor.id)
    const { scheduleCommands, schedules, scheduleVersions, targetAccounts } = schemaFor(tx)
    const [receipt] = await tx
      .select()
      .from(scheduleCommands)
      .where(eq(scheduleCommands.commandKey, parsed.idempotencyKey))
      .limit(1)
    const payload = { body: structuredClone(parsed), existingId: existingId ?? null, actorId: actor.id }
    if (receipt) {
      if (canonicalJson(receipt.payload) !== canonicalJson(payload)) {
        throw conflict('SCHEDULE_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同的调度命令')
      }
      return scheduleWriteResponseSchema.parse({ ...(receipt.result as ScheduleWriteResponse), created: false })
    }
    const consumer = parsed.definition.consumer
    if (consumer.type === 'scenario_run' && !consumer.accountBinding.resolved) {
      consumer.accountBinding = { targetAccountId: await resolveRunTargetAccountId(tx, { targetId: consumer.targetId, requestedAccountId: consumer.accountBinding.targetAccountId }), resolved: true }
    }
    if (consumer.type === 'suite_run' && consumer.members.some(member => !member.accountResolved)) {
      const preview = await previewSuiteRun(tx, { suiteId: consumer.suiteId, suiteVersionId: consumer.suiteVersionId, sharedInput: consumer.sharedInput, defaultTargetAccountId: consumer.defaultTargetAccountId,
        memberOverrides: Object.fromEntries(consumer.members.map(member => [member.memberId, { input: member.input, targetAccountId: member.targetAccountId }])), idempotencyKey: 'schedule-freeze-accounts' }, actor.id)
      consumer.members = consumer.members.map(member => ({ ...member, targetAccountId: preview.members.find(item => item.memberId === member.memberId)?.targetAccountId ?? undefined, accountResolved: true }))
    }
    const targetAccountId = consumerTargetAccountId(consumer)
    if (targetAccountId) {
      const [account] = await tx
        .select()
        .from(targetAccounts)
        .where(eq(targetAccounts.id, targetAccountId))
        .limit(1)
      if (!account || account.targetId !== consumer.targetId || account.status !== 'active') {
        throw notFound('TARGET_ACCOUNT_NOT_FOUND', '目标账号不存在或已停用')
      }
      if (isMapRefreshConsumer(consumer)) {
        await requireMapCapableAccount(tx, consumer.targetId, targetAccountId)
      }
    }
    const now = await clockNow(tx)
    const digest = sha256Hex(parsed.definition)
    let scheduleId = existingId
    let created = false
    if (existingId) {
      const [current] = await locked(tx, tx.select().from(schedules).where(eq(schedules.id, existingId)))
      if (!current) throw notFound('SCHEDULE_NOT_FOUND', '调度计划不存在')
      if (current.revision !== parsed.expectedRevision) throw conflict('SCHEDULE_REVISION_CONFLICT', '调度修订已变更')
      if (current.targetId !== parsed.definition.consumer.targetId) throw forbidden('SCHEDULE_TARGET_MISMATCH', '不能改到其他目标')
      if (current.consumerKey !== consumer.type) throw forbidden('SCHEDULE_CONSUMER_IMMUTABLE', '不能更换调度任务类型')
      if (current.enabled === 1) await assertAnalysisIdentityAvailable(tx, consumer, current.id)
      const [previousVersion] = await tx.select({ authorizedActorId: scheduleVersions.authorizedActorId })
        .from(scheduleVersions).where(eq(scheduleVersions.id, current.currentVersionId)).limit(1)
      if (!previousVersion) throw notFound('SCHEDULE_NOT_FOUND', '调度计划修订不存在')
      const versionId = newId()
      const nextRevision = current.revision + 1
      await insertRows(tx, scheduleVersions, {
        id: versionId,
        scheduleId: current.id,
        revision: nextRevision,
        name: parsed.definition.name ?? null,
        timezone: parsed.definition.timezone,
        weekdays: parsed.definition.weekdays,
        windowStart: parsed.definition.windowStart,
        windowEnd: parsed.definition.windowEnd,
        misfire: parsed.definition.misfire,
        timeRule: parsed.definition.timeRule,
        consumer: parsed.definition.consumer,
        effectiveAt: parsed.definition.effectiveAt ? new Date(parsed.definition.effectiveAt) : null,
        expiresAt: parsed.definition.expiresAt ? new Date(parsed.definition.expiresAt) : null,
        authorizedActorId: previousVersion.authorizedActorId,
        contentDigest: digest,
        createdAt: now,
      })
      const nextDue = nextDueFromWindows(
        previewScheduleWindows({ scheduleId: current.id, definition: parsed.definition, asOf: now, limit: 1 }),
        now,
      )
      try {
        await tx
          .update(schedules)
          .set({
            name: parsed.definition.name ?? null,
            targetAccountId,
            identityGuard: current.enabled === 1 ? identityGuard(consumer) : null,
            revision: nextRevision,
            currentVersionId: versionId,
            nextDueAt: nextDue,
            updatedAt: now,
          })
          .where(eq(schedules.id, current.id))
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict(identityConflictCode(consumer.type), identityConflictMessage(consumer.type))
        throw error
      }
      await appendEvent(tx, current.id, 'revised', { revision: nextRevision, digest }, now)
      await recordAudit(tx, actor, 'schedule.update', 'target', current.targetId, `修订调度 ${current.id}`)
    } else {
      if (parsed.expectedRevision !== 0) throw conflict('SCHEDULE_REVISION_CONFLICT', '新建调度的期望修订须为 0')
      scheduleId = newId()
      const versionId = newId()
      try {
        await insertRows(tx, schedules, {
          id: scheduleId,
          name: parsed.definition.name ?? null,
          targetId: parsed.definition.consumer.targetId,
          targetAccountId,
          consumerKey: parsed.definition.consumer.type,
          identityGuard: null,
          enabled: 0,
          enabledGuard: null,
          revision: 1,
          currentVersionId: versionId,
          nextDueAt: nextDueFromWindows(
            previewScheduleWindows({ scheduleId, definition: parsed.definition, asOf: now, limit: 1 }),
            now,
          ),
          createdBy: actor.id,
          createdAt: now,
          updatedAt: now,
        })
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict(identityConflictCode(consumer.type), identityConflictMessage(consumer.type))
        throw error
      }
      await insertRows(tx, scheduleVersions, {
        id: versionId,
        scheduleId,
        revision: 1,
        name: parsed.definition.name ?? null,
        timezone: parsed.definition.timezone,
        weekdays: parsed.definition.weekdays,
        windowStart: parsed.definition.windowStart,
        windowEnd: parsed.definition.windowEnd,
        misfire: parsed.definition.misfire,
        timeRule: parsed.definition.timeRule,
        consumer: parsed.definition.consumer,
        effectiveAt: parsed.definition.effectiveAt ? new Date(parsed.definition.effectiveAt) : null,
        expiresAt: parsed.definition.expiresAt ? new Date(parsed.definition.expiresAt) : null,
        authorizedActorId: actor.id,
        contentDigest: digest,
        createdAt: now,
      })
      await appendEvent(tx, scheduleId, 'created', { revision: 1, digest }, now)
      await recordAudit(tx, actor, 'schedule.create', 'target', parsed.definition.consumer.targetId, `创建调度 ${scheduleId}`)
      created = true
    }
    const result = scheduleWriteResponseSchema.parse({ schedule: await scheduleToDto(tx, scheduleId!), created })
    await insertRows(tx, scheduleCommands, { id: newId(), commandKey: parsed.idempotencyKey, payload, result })
    return result
  })
}

export async function setScheduleEnabled(
  db: Db,
  scheduleId: string,
  body: z.input<typeof scheduleEnabledBodySchema>,
  actor: ExecutionActor,
): Promise<ScheduleDto> {
  const parsed = scheduleEnabledBodySchema.parse(body)
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actor.id)
    const authorized = await scheduleToDto(tx, scheduleId)
    await assertScheduleWritePermission(tx, actor.id, authorized.definition.consumer)
    const { scheduleCommands, schedules } = schemaFor(tx)
    const commandKey = `enabled:${parsed.idempotencyKey}`
    const [receipt] = await tx.select().from(scheduleCommands).where(eq(scheduleCommands.commandKey, commandKey)).limit(1)
    const payload = { body: parsed, scheduleId, actorId: actor.id }
    if (receipt) {
      if (canonicalJson(receipt.payload) !== canonicalJson(payload)) {
        throw conflict('SCHEDULE_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同的启停命令')
      }
      return scheduleDtoSchema.parse((receipt.result as { schedule: ScheduleDto }).schedule)
    }
    const [current] = await locked(tx, tx.select().from(schedules).where(eq(schedules.id, scheduleId)))
    if (!current) throw notFound('SCHEDULE_NOT_FOUND', '调度计划不存在')
    if (current.revision !== parsed.expectedRevision) throw conflict('SCHEDULE_REVISION_CONFLICT', '调度修订已变更')
    const dto = await scheduleToDto(tx, scheduleId)
    await assertScheduleWritePermission(tx, actor.id, dto.definition.consumer)
    if (parsed.enabled) {
      await assertConsumerResources(tx, dto.definition, actor.id)
      await assertAnalysisIdentityAvailable(tx, dto.definition.consumer, scheduleId)
    }
    if (parsed.enabled && isMapRefreshConsumer(dto.definition.consumer)) {
      await requireMapCapableAccount(tx, current.targetId, dto.definition.consumer.targetAccountId)
    }
    const now = await clockNow(tx)
    const nextDue = parsed.enabled
      ? nextDueFromWindows(previewScheduleWindows({ scheduleId, definition: dto.definition, asOf: now, limit: 1 }), now)
      : current.nextDueAt
    try {
      await tx
        .update(schedules)
        .set({
          enabled: parsed.enabled ? 1 : 0,
          enabledGuard: parsed.enabled ? 'Y' : null,
          identityGuard: parsed.enabled ? identityGuard(dto.definition.consumer) : null,
          revision: current.revision + 1,
          nextDueAt: nextDue,
          updatedAt: now,
        })
        .where(eq(schedules.id, scheduleId))
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(identityConflictCode(dto.consumerKey), identityConflictMessage(dto.consumerKey))
      throw error
    }
    if (!parsed.enabled) {
      const { scheduleOccurrences } = schemaFor(tx)
      await tx.update(scheduleOccurrences).set({ admissionStatus: 'SKIPPED', reason: 'SCHEDULE_DISABLED' })
        .where(and(eq(scheduleOccurrences.scheduleId, scheduleId), eq(scheduleOccurrences.admissionStatus, 'PENDING'), eq(scheduleOccurrences.source, 'scheduled')))
    }
    if (parsed.cancelAdmittedJobs && !parsed.enabled) {
      const { scheduleOccurrences } = schemaFor(tx)
      if (dto.consumerKey === 'scenario_run' || dto.consumerKey === 'suite_run') {
        await assertTargetPermission(tx, actor.id, current.targetId, 'run:cancel')
      }
      const admitted = await tx
        .select()
        .from(scheduleOccurrences)
        .where(and(eq(scheduleOccurrences.scheduleId, scheduleId), eq(scheduleOccurrences.admissionStatus, 'ADMITTED')))
      for (const row of admitted) {
        if (row.runId) await requestRunCancel(tx, row.runId, actor)
        if (row.suiteRunId) await cancelSuiteRun(tx, row.suiteRunId, actor)
        if (row.jobId) {
          const job = await getMapJob(tx, row.jobId)
          if (['queued', 'running'].includes(job.jobStatus)) await cancelMapJob(tx, row.jobId, actor)
        }
        if (row.analysisJobId) {
          await cancelAnalysisJob(tx, row.analysisJobId, actor, `cancel-enabled:${parsed.idempotencyKey}:${row.id}`)
        }
      }
    }
    await appendEvent(tx, scheduleId, parsed.enabled ? 'enabled' : 'disabled', { cancelAdmittedJobs: parsed.cancelAdmittedJobs }, now)
    await recordAudit(tx, actor, 'schedule.enable', 'target', current.targetId, parsed.enabled ? '启用调度' : '停用调度')
    const result = await scheduleToDto(tx, scheduleId)
    await insertRows(tx, scheduleCommands, { id: newId(), commandKey, payload, result: { schedule: result } })
    return result
  })
}

export async function triggerScheduleOnce(db: Db, scheduleId: string, body: ScheduleTriggerBody, actor: ExecutionActor) {
  const parsed = scheduleTriggerBodySchema.parse(body)
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actor.id)
    const authorized = await scheduleToDto(tx, scheduleId)
    await assertScheduleWritePermission(tx, actor.id, authorized.definition.consumer)
    const { scheduleCommands, scheduleOccurrences, scheduleVersions, schedules } = schemaFor(tx)
    const commandKey = `trigger:${parsed.idempotencyKey}`
    const [receipt] = await tx.select().from(scheduleCommands).where(eq(scheduleCommands.commandKey, commandKey)).limit(1)
    const payload = { body: parsed, scheduleId, actorId: actor.id }
    if (receipt) {
      if (canonicalJson(receipt.payload) !== canonicalJson(payload)) {
        throw conflict('SCHEDULE_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同的触发命令')
      }
      return scheduleTriggerResponseSchema.parse(receipt.result)
    }
    const [schedule] = await locked(tx, tx.select().from(schedules).where(eq(schedules.id, scheduleId)))
    if (!schedule) throw notFound('SCHEDULE_NOT_FOUND', '调度计划不存在')
    const [version] = await tx.select().from(scheduleVersions).where(eq(scheduleVersions.id, schedule.currentVersionId)).limit(1)
    if (!version) throw notFound('SCHEDULE_NOT_FOUND', '调度计划修订不存在')
    const definition = definitionFromVersion(version)
    await assertScheduleWritePermission(tx, actor.id, definition.consumer)
    const config = await getOrCreatePlatformConfig(tx)
    if (!factoryEnabledFor(config.document, definition.consumer.type)) {
      throw conflict('SCHEDULE_FACTORY_DISABLED', '该类调度尚未在工厂设置中开启')
    }
    const now = await clockNow(tx)
    const busy = await activeOccurrences(tx, scheduleId, true)
    const localSlotKey = scheduleLocalSlotKey(scheduleId, `manual:${parsed.idempotencyKey}`)
    const values = {
      id: newId(),
      scheduleId,
      scheduleVersionId: version.id,
      source: 'manual' as const,
      ruleId: 'manual',
      localSlotKey,
      occurrenceKey: `manual:${scheduleId}:${parsed.idempotencyKey}`,
      localStartDate: now.toISOString().slice(0, 10),
      windowStartUtc: now,
      windowEndUtc: new Date(now.getTime() + 60 * 60 * 1000),
      startOffsetMinutes: 0,
      endOffsetMinutes: 0,
      timeRuleVersion: SCHEDULE_TIME_RULE_VERSION,
      admissionStatus: 'PENDING' as any,
      reason: null as ScheduleSkipReason | null,
      jobId: null,
      runId: null,
      suiteRunId: null,
      analysisJobId: null,
      createdAt: now,
      admittedAt: null,
    }
    if (busy.length > 0 && definition.misfire === 'skip') {
      values.admissionStatus = 'SKIPPED'
      values.reason = 'OVERLAP_ACTIVE'
    }
    if (busy.length > 0 && definition.misfire === 'coalesce') {
      await tx
        .update(scheduleOccurrences)
        .set({ admissionStatus: 'SKIPPED', reason: 'COALESCED' })
        .where(
          and(eq(scheduleOccurrences.scheduleId, scheduleId), eq(scheduleOccurrences.admissionStatus, 'PENDING')),
        )
    }
    await insertRows(tx, scheduleOccurrences, values)
    await appendEvent(tx, scheduleId, 'triggered', { occurrenceId: values.id, source: 'manual' }, now)
    await recordAudit(tx, actor, 'schedule.trigger', 'target', schedule.targetId, `手动触发调度 ${scheduleId}`)
    const result = scheduleTriggerResponseSchema.parse({ occurrence: occurrenceToDto(values) })
    await insertRows(tx, scheduleCommands, { id: newId(), commandKey, payload, result })
    return result
  })
}

export async function listScheduleOccurrences(
  db: Db,
  scheduleId: string,
  query: { cursor?: string; limit: number },
) {
  await scheduleToDto(db, scheduleId)
  const { scheduleOccurrences } = schemaFor(db)
  const decoded = query.cursor ? decodeAuditCursor(query.cursor) : null
  const rows = await db
    .select()
    .from(scheduleOccurrences)
    .where(
      and(
        eq(scheduleOccurrences.scheduleId, scheduleId),
        decoded
          ? or(
              sql`${scheduleOccurrences.createdAt} < ${decoded.createdAt}`,
              and(eq(scheduleOccurrences.createdAt, decoded.createdAt), sql`${scheduleOccurrences.id} < ${decoded.id}`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(scheduleOccurrences.createdAt), desc(scheduleOccurrences.id))
    .limit(query.limit + 1)
  const page = rows.slice(0, query.limit)
  const items = await Promise.all(
    page.map(async (row) => {
      const firstRunId = row.jobId ? (await getMapJob(db, row.jobId).catch(() => null))?.firstRunId : undefined
      return occurrenceToDto(row, firstRunId)
    }),
  )
  return scheduleOccurrenceListResponseSchema.parse({
    items,
    nextCursor: rows.length > query.limit ? encodeAuditCursor(page.at(-1)!.createdAt, page.at(-1)!.id) : undefined,
  })
}

export async function listScheduleEvents(
  db: Db,
  scheduleId: string,
  query: { cursor?: string; limit: number },
) {
  await scheduleToDto(db, scheduleId)
  const { scheduleEvents } = schemaFor(db)
  const decoded = query.cursor ? decodeAuditCursor(query.cursor) : null
  const rows = await db
    .select()
    .from(scheduleEvents)
    .where(
      and(
        eq(scheduleEvents.scheduleId, scheduleId),
        decoded
          ? or(
              sql`${scheduleEvents.createdAt} < ${decoded.createdAt}`,
              and(eq(scheduleEvents.createdAt, decoded.createdAt), sql`${scheduleEvents.id} < ${decoded.id}`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(scheduleEvents.seq), desc(scheduleEvents.id))
    .limit(query.limit + 1)
  const page = rows.slice(0, query.limit)
  return scheduleEventListResponseSchema.parse({
    items: page.map((row) =>
      scheduleEventDtoSchema.parse({
        eventId: row.id,
        scheduleId: row.scheduleId,
        seq: row.seq,
        eventType: row.eventType,
        payload: row.payload,
        createdAt: row.createdAt.toISOString(),
      }),
    ),
    nextCursor: rows.length > query.limit ? encodeAuditCursor(page.at(-1)!.createdAt, page.at(-1)!.id) : undefined,
  })
}

export async function previewScheduleDefinition(
  db: Db,
  definition: unknown,
  asOf?: Date,
) {
  const now = asOf ?? (await clockNow(db))
  const config = await getOrCreatePlatformConfig(db)
  const parsed = scheduleDefinitionSchema.parse(definition)
  const windows = previewScheduleWindows({
    scheduleId: '00000000-0000-4000-8000-000000000000',
    definition: parsed,
    asOf: now,
  })
  const gaps = []
  if (!factoryEnabledFor(config.document, parsed.consumer.type)) {
    gaps.push({ code: 'FACTORY_DISABLED', message: '该类调度尚未在工厂设置中开启' })
  }
  gaps.push({ code: 'ADMIT_RECHECK', message: '准入时再检查权限、资源和重叠规则' })
  return { asOf: now.toISOString(), windows, gaps }
}

export async function previewScheduleQuery(db: Db, input: SchedulePreviewQuery | z.input<typeof schedulePreviewQuerySchema>) {
  const query = schedulePreviewQuerySchema.parse({ ...input, weekdays: Array.isArray(input.weekdays) ? input.weekdays.join(',') : input.weekdays })
  const now = query.asOf ? new Date(query.asOf) : await clockNow(db)
  const timeRule = timeRuleFromPreviewQuery(query)
  const definition = scheduleDefinitionSchema.parse({
    timeRule,
    consumer: {
      type: 'knowledge_analysis',
      targetId: '00000000-0000-4000-8000-000000000001',
      mode: 'map_quality',
    },
  })
  const result = await previewScheduleDefinition(db, definition, now)
  // This endpoint previews time only; factory availability depends on the
  // actual consumer selected later, not the placeholder used for parsing.
  return { ...result, gaps: result.gaps.filter(gap => gap.code !== 'FACTORY_DISABLED') }
}

async function insertOccurrenceIfAbsent(
  tx: Db,
  values: ReturnType<typeof windowRow>,
): Promise<{ row: ScheduleOccurrenceDto; created: boolean }> {
  const { scheduleOccurrences } = schemaFor(tx)
  const created = await insertIgnoreRows(tx, scheduleOccurrences, values)
  if (created > 0) return { row: occurrenceToDto(values), created: true }
  const [existing] = await tx
    .select()
    .from(scheduleOccurrences)
    .where(
      and(eq(scheduleOccurrences.scheduleId, values.scheduleId), eq(scheduleOccurrences.localSlotKey, values.localSlotKey)),
    )
    .limit(1)
  if (!existing) throw conflict('SCHEDULE_OCCURRENCE_CONFLICT', '调度窗口写入冲突')
  return { row: occurrenceToDto(existing), created: false }
}

export async function expireClosedScheduleWindows(db: Db): Promise<number> {
  return atomic(db, async (tx) => {
    const { schedules, scheduleOccurrences, scheduleVersions } = schemaFor(tx)
    const now = await clockNow(tx)
    const rows = await tx
      .select({ occurrence: scheduleOccurrences, misfire: scheduleVersions.misfire })
      .from(scheduleOccurrences)
      .innerJoin(scheduleVersions, eq(scheduleOccurrences.scheduleVersionId, scheduleVersions.id))
      .where(
        and(
          eq(scheduleOccurrences.admissionStatus, 'PENDING'),
          sql`${scheduleOccurrences.windowEndUtc} IS NOT NULL`,
          lte(scheduleOccurrences.windowEndUtc, now),
          eq(scheduleVersions.misfire, 'skip'),
        ),
      )
      .orderBy(scheduleOccurrences.scheduleId, scheduleOccurrences.id)
      .limit(SCHEDULE_TICK_BATCH)
    for (const row of rows) {
      await locked(tx, tx.select({ id: schedules.id }).from(schedules).where(eq(schedules.id, row.occurrence.scheduleId)))
      const [lockedRow] = await locked(
        tx,
        tx.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.id, row.occurrence.id)),
      )
      if (!lockedRow || lockedRow.admissionStatus !== 'PENDING') continue
      await tx
        .update(scheduleOccurrences)
        .set({ admissionStatus: 'SKIPPED', reason: 'WINDOW_CLOSED' })
        .where(eq(scheduleOccurrences.id, row.occurrence.id))
      await appendEvent(tx, row.occurrence.scheduleId, 'skipped', { occurrenceId: row.occurrence.id, reason: 'WINDOW_CLOSED' }, now)
    }
    return rows.length
  })
}

export async function expireScheduledMapJobs(db: Db): Promise<number> {
  return atomic(db, async (tx) => {
    const { scheduleOccurrences, mapJobs } = schemaFor(tx)
    const now = await clockNow(tx)
    const rows = await tx
      .select({ occurrence: scheduleOccurrences, job: mapJobs })
      .from(scheduleOccurrences)
      .innerJoin(mapJobs, eq(mapJobs.id, scheduleOccurrences.jobId))
      .where(
        and(
          eq(scheduleOccurrences.admissionStatus, 'ADMITTED'),
          sql`${scheduleOccurrences.windowEndUtc} IS NOT NULL`,
          lte(scheduleOccurrences.windowEndUtc, now),
          inArray(mapJobs.jobStatus, ['queued']),
        ),
      )
    for (const row of rows) {
      const [lockedOccurrence] = await locked(
        tx,
        tx.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.id, row.occurrence.id)),
      )
      if (!lockedOccurrence || lockedOccurrence.admissionStatus !== 'ADMITTED' || !lockedOccurrence.jobId) continue
      await cancelMapJob(tx, lockedOccurrence.jobId, { kind: 'console', id: row.job.createdBy }).catch(() => undefined)
      await tx
        .update(mapJobs)
        .set({ jobStatus: 'cancelled', stopReason: 'window_closed', activeGuard: null, updatedAt: now })
        .where(eq(mapJobs.id, lockedOccurrence.jobId))
    }
    return rows.length
  })
}

export type PendingScheduleAdmit = {
  occurrence: ScheduleOccurrenceDto
  definition: ScheduleDefinition
  authorizedActorId: string
}

export async function materializeDueSchedules(db: Db, limit = SCHEDULE_TICK_BATCH): Promise<{
  outcome: ScheduleTickOutcome
  pending: PendingScheduleAdmit[]
}> {
  const config = await getOrCreatePlatformConfig(db)
  const pending: PendingScheduleAdmit[] = []
  const outcome: ScheduleTickOutcome = { scanned: 0, materialized: 0, skipped: 0, admitted: 0, conflicts: 0 }
  const { schedules } = schemaFor(db)
  const nowProbe = await clockNow(db)
  const due = await db
    .select({ id: schedules.id })
    .from(schedules)
    .where(and(eq(schedules.enabled, 1), sql`${schedules.nextDueAt} IS NOT NULL`, lte(schedules.nextDueAt, nowProbe)))
    .orderBy(asc(schedules.nextDueAt), asc(schedules.id))
    .limit(limit)
  for (const item of due) {
    outcome.scanned += 1
    await atomic(db, async (tx) => {
      const { schedules: scheduleTable, scheduleVersions } = schemaFor(tx)
      const [schedule] = await locked(tx, tx.select().from(scheduleTable).where(eq(scheduleTable.id, item.id)))
      if (!schedule || schedule.enabled !== 1 || !schedule.nextDueAt) return
      const { targets, targetAccounts } = schemaFor(tx)
      const [target] = await tx.select({ deletedAt: targets.deletedAt }).from(targets).where(eq(targets.id, schedule.targetId)).limit(1)
      const targetAccountId = schedule.targetAccountId
      const [account] = targetAccountId
        ? await tx
            .select({ deletedAt: targetAccounts.deletedAt })
            .from(targetAccounts)
            .where(eq(targetAccounts.id, targetAccountId))
            .limit(1)
        : [null]
      const now = await clockNow(tx)
      if (!target || target.deletedAt || (schedule.targetAccountId && (!account || account.deletedAt))) {
        await tx
          .update(scheduleTable)
          .set({ enabled: 0, enabledGuard: null, nextDueAt: null, updatedAt: now })
          .where(eq(scheduleTable.id, schedule.id))
        return
      }
      const [version] = await tx.select().from(scheduleVersions).where(eq(scheduleVersions.id, schedule.currentVersionId)).limit(1)
      if (!version) return
      const definition = definitionFromVersion(version)
      if (!factoryEnabledFor(config.document, definition.consumer.type)) return
      if (definition.effectiveAt && new Date(definition.effectiveAt).getTime() > now.getTime()) {
        await tx
          .update(scheduleTable)
          .set({ nextDueAt: new Date(definition.effectiveAt), updatedAt: now })
          .where(eq(scheduleTable.id, schedule.id))
        return
      }
      if (definition.expiresAt && new Date(definition.expiresAt).getTime() <= now.getTime()) {
        await tx.update(scheduleTable).set({ nextDueAt: null, updatedAt: now }).where(eq(scheduleTable.id, schedule.id))
        return
      }
      if (schedule.nextDueAt.getTime() > now.getTime()) return
      const { scheduleOccurrences } = schemaFor(tx)
      const windows = previewScheduleWindows({
        scheduleId: schedule.id,
        definition,
        asOf: schedule.nextDueAt,
        limit: 4,
      })
      let advanced: Date | null = null
      for (const resolved of windows) {
        if (resolved.kind === 'skipped') {
          const inserted = await insertOccurrenceIfAbsent(
            tx,
            windowRow(resolved, schedule.id, version.id, now, 'SKIPPED', resolved.reason),
          )
          if (inserted.created) {
            outcome.skipped += 1
            outcome.materialized += 1
            await appendEvent(tx, schedule.id, 'skipped', { occurrenceId: inserted.row.occurrenceId, reason: resolved.reason }, now)
          }
          advanced = nextDueAfterResolved(schedule.id, definition, resolved, now)
          continue
        }
        if (definition.expiresAt && new Date(resolved.windowStartUtc).getTime() >= new Date(definition.expiresAt).getTime()) {
          advanced = null
          break
        }
        const end = new Date(resolved.windowEndUtc)
        const start = new Date(resolved.windowStartUtc)
        if (end.getTime() <= now.getTime()) {
          const skipClosed = definition.misfire !== 'coalesce'
          const [existingPending] = skipClosed ? [] : await tx.select({ id: scheduleOccurrences.id }).from(scheduleOccurrences)
            .where(and(eq(scheduleOccurrences.scheduleId, schedule.id), eq(scheduleOccurrences.admissionStatus, 'PENDING'))).limit(1)
          const skipReason = skipClosed ? 'WINDOW_CLOSED' : existingPending ? 'COALESCED' : undefined
          const inserted = await insertOccurrenceIfAbsent(
            tx,
            windowRow(resolved, schedule.id, version.id, now, skipReason ? 'SKIPPED' : 'PENDING', skipReason),
          )
          if (inserted.created) {
            outcome.materialized += 1
            if (skipReason) outcome.skipped += 1
            await appendEvent(
              tx,
              schedule.id,
              skipReason ? 'skipped' : 'materialized',
              { occurrenceId: inserted.row.occurrenceId, reason: skipReason },
              now,
            )
          }
          if (!skipClosed && inserted.row.admissionStatus === 'PENDING') {
            pending.push({ occurrence: inserted.row, definition, authorizedActorId: version.authorizedActorId })
          }
          advanced = nextDueAfterResolved(schedule.id, definition, resolved, now)
          continue
        }
        if (start.getTime() > now.getTime()) {
          advanced = start
          break
        }
        const [existingPending] = await tx
          .select({ id: scheduleOccurrences.id })
          .from(scheduleOccurrences)
          .where(and(eq(scheduleOccurrences.scheduleId, schedule.id), eq(scheduleOccurrences.admissionStatus, 'PENDING')))
          .limit(1)
        const coalesce = definition.misfire === 'coalesce' && existingPending
        const inserted = await insertOccurrenceIfAbsent(
          tx,
          windowRow(resolved, schedule.id, version.id, now, coalesce ? 'SKIPPED' : 'PENDING', coalesce ? 'COALESCED' : undefined),
        )
        if (inserted.created) {
          outcome.materialized += 1
          if (coalesce) outcome.skipped += 1
          await appendEvent(
            tx,
            schedule.id,
            coalesce ? 'skipped' : 'materialized',
            { occurrenceId: inserted.row.occurrenceId, reason: coalesce ? 'COALESCED' : undefined },
            now,
          )
        }
        if (inserted.row.admissionStatus === 'PENDING') {
          pending.push({ occurrence: inserted.row, definition, authorizedActorId: version.authorizedActorId })
        }
        advanced = nextDueAfterResolved(schedule.id, definition, resolved, now)
        break
      }
      await tx.update(scheduleTable).set({ nextDueAt: advanced, updatedAt: now }).where(eq(scheduleTable.id, schedule.id))
    })
  }
  return { outcome, pending }
}

export async function admitScheduleOccurrence(
  db: Db,
  occurrenceId: string,
  compiled: { steps: Step[]; releaseId?: string; includedCount: number; skipReason?: ScheduleSkipReason },
  actor: ExecutionActor,
): Promise<ScheduleOccurrenceDto> {
  return atomic(db, async (tx) => {
    const { scheduleOccurrences, scheduleVersions, schedules } = schemaFor(tx)
    const [peek] = await tx.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.id, occurrenceId)).limit(1)
    if (!peek) throw notFound('SCHEDULE_OCCURRENCE_NOT_FOUND', '调度窗口不存在')
    const [authorization] = await tx.select({ actorId: scheduleVersions.authorizedActorId }).from(scheduleVersions).where(eq(scheduleVersions.id, peek.scheduleVersionId)).limit(1)
    if (authorization) await lockConsoleAuthorization(tx, authorization.actorId, false)
    const [schedule] = await locked(tx, tx.select().from(schedules).where(eq(schedules.id, peek.scheduleId)))
    if (!schedule) throw notFound('SCHEDULE_NOT_FOUND', '调度计划不存在')
    const [occurrence] = await locked(tx, tx.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.id, occurrenceId)))
    if (!occurrence) throw notFound('SCHEDULE_OCCURRENCE_NOT_FOUND', '调度窗口不存在')
    if (occurrence.admissionStatus !== 'PENDING') return occurrenceToDto(occurrence)
    const [version] = await tx.select().from(scheduleVersions).where(eq(scheduleVersions.id, occurrence.scheduleVersionId)).limit(1)
    if (!version) throw notFound('SCHEDULE_NOT_FOUND', '调度计划修订不存在')
    const definition = definitionFromVersion(version)
    const now = await clockNow(tx)
    const skip = async (reason: ScheduleSkipReason) => {
      await tx
        .update(scheduleOccurrences)
        .set({ admissionStatus: 'SKIPPED', reason })
        .where(eq(scheduleOccurrences.id, occurrence.id))
      await appendEvent(tx, schedule.id, 'skipped', { occurrenceId: occurrence.id, reason }, now)
      return occurrenceToDto({ ...occurrence, admissionStatus: 'SKIPPED', reason })
    }
    if (schedule.enabled !== 1 && occurrence.source !== 'manual') return skip('SCHEDULE_DISABLED')
    if (
      occurrence.windowEndUtc &&
      occurrence.windowEndUtc.getTime() <= now.getTime() &&
      definition.misfire !== 'coalesce'
    ) {
      return skip('WINDOW_CLOSED')
    }
    const config = await getOrCreatePlatformConfig(tx)
    if (!factoryEnabledFor(config.document, definition.consumer.type)) return skip('FACTORY_DISABLED')
    if (!(await actorCanAdmitConsumer(tx, version.authorizedActorId, definition.consumer))) {
      return skip('PERMISSION_REVOKED')
    }
    await assertConsumerResources(tx, definition, version.authorizedActorId)
    if (compiled.skipReason) return skip(compiled.skipReason)
    const overlap = await activeOccurrences(tx, schedule.id)
    if (overlap[0] && definition.misfire === 'skip') return skip('OVERLAP_ACTIVE')
    if (overlap[0]) return occurrenceToDto(occurrence)
    actor = { kind: 'console', id: version.authorizedActorId }
      if (definition.consumer.type === 'scenario_run') {
        const created = await writeRunWithSnapshot(tx, {
          scenarioId: definition.consumer.scenarioId,
          scenarioVersionId: definition.consumer.scenarioVersionId,
          targetAccountId: definition.consumer.accountBinding.targetAccountId,
          resolvedTargetAccountId: definition.consumer.accountBinding.resolved ? definition.consumer.accountBinding.targetAccountId ?? null : undefined,
          input: definition.consumer.input,
          actor,
          idempotencyKey: scheduledRunCommandKey(occurrence.id),
        })
        await tx
          .update(scheduleOccurrences)
          .set({ admissionStatus: 'ADMITTED', runId: created.runId, admittedAt: now, reason: null })
          .where(eq(scheduleOccurrences.id, occurrence.id))
        await appendEvent(tx, schedule.id, 'admitted', { occurrenceId: occurrence.id, runId: created.runId }, now)
        return occurrenceToDto({ ...occurrence, admissionStatus: 'ADMITTED', runId: created.runId, admittedAt: now, reason: null })
      }
      if (definition.consumer.type === 'suite_run') {
        const created = await createSuiteRun(
          tx,
          {
            suiteId: definition.consumer.suiteId,
            suiteVersionId: definition.consumer.suiteVersionId,
            sharedInput: definition.consumer.sharedInput,
            defaultTargetAccountId: definition.consumer.defaultTargetAccountId,
            memberOverrides: Object.fromEntries(
              definition.consumer.members.map((member) => [
                member.memberId,
                { input: member.input, targetAccountId: member.targetAccountId },
              ]),
            ),
            deadlineMs: definition.consumer.policy.deadlineMs,
            idempotencyKey: scheduledSuiteCommandKey(occurrence.id),
          },
          actor,
          Object.fromEntries(definition.consumer.members.filter(member => member.accountResolved).map(member => [member.memberId, member.targetAccountId ?? null])),
        )
        await tx
          .update(scheduleOccurrences)
          .set({ admissionStatus: 'ADMITTED', suiteRunId: created.observation.id, admittedAt: now, reason: null })
          .where(eq(scheduleOccurrences.id, occurrence.id))
        await appendEvent(tx, schedule.id, 'admitted', { occurrenceId: occurrence.id, suiteRunId: created.observation.id }, now)
        return occurrenceToDto({
          ...occurrence,
          admissionStatus: 'ADMITTED',
          suiteRunId: created.observation.id,
          admittedAt: now,
          reason: null,
        })
      }
      if (definition.consumer.type === 'knowledge_analysis') {
        const created = await createAnalysisJob(tx, {
          targetId: definition.consumer.targetId,
          scheduleId: schedule.id,
          occurrenceId: occurrence.id,
          mode: definition.consumer.mode,
          source: definition.consumer.source,
          strategyVersion: definition.consumer.strategyVersion,
          budget: definition.consumer.budget,
          actor,
        })
        await tx
          .update(scheduleOccurrences)
          .set({ admissionStatus: 'ADMITTED', analysisJobId: created.analysisJobId, admittedAt: now, reason: null })
          .where(eq(scheduleOccurrences.id, occurrence.id))
        await appendEvent(tx, schedule.id, 'admitted', { occurrenceId: occurrence.id, analysisJobId: created.analysisJobId }, now)
        return occurrenceToDto({
          ...occurrence,
          admissionStatus: 'ADMITTED',
          analysisJobId: created.analysisJobId,
          admittedAt: now,
          reason: null,
        })
      }
      if (compiled.includedCount <= 0) return skip('NO_ELIGIBLE_ASSETS')
      const mapConsumer = isMapRefreshConsumer(definition.consumer) ? definition.consumer : null
      if (!mapConsumer) return skip('RESOURCE_UNAVAILABLE')
      const policy = await getMapJobPolicy(tx, mapConsumer.targetId)
      const created = await createMapJob(
        tx,
        mapConsumer.targetId,
        {
          source: 'scheduled',
          occurrenceId: occurrence.id,
          startBefore: occurrence.windowEndUtc?.toISOString(),
          expectedPolicyRevision: policy.revision,
          jobKind: 'map_refresh',
          targetAccountId: mapConsumer.targetAccountId,
          entryId: mapConsumer.entryId,
          selectedAssetRefs: mapConsumer.selectedAssetRefs,
        },
        actor,
        { steps: compiled.steps, releaseId: compiled.releaseId },
      )
      await tx
        .update(scheduleOccurrences)
        .set({ admissionStatus: 'ADMITTED', jobId: created.job.jobId, admittedAt: now, reason: null })
        .where(eq(scheduleOccurrences.id, occurrence.id))
      await appendEvent(tx, schedule.id, 'admitted', { occurrenceId: occurrence.id, jobId: created.job.jobId }, now)
      return occurrenceToDto(
        { ...occurrence, admissionStatus: 'ADMITTED', jobId: created.job.jobId, admittedAt: now, reason: null },
        created.job.firstRunId,
      )
  }).catch(async error => {
    // Roll back consumer creation before recording a rejection. Catching inside
    // the transaction could commit a partially created suite and its children.
    if (!(error instanceof DomainError)) throw error
    const retry = ['ANALYSIS_ACTIVE_EXISTS', 'MAP_ACTIVE_SLICE_EXISTS'].includes(error.code)
    const reason: ScheduleSkipReason | undefined =
      error.code === 'FORBIDDEN' || error.message.includes('无权访问') ? 'PERMISSION_REVOKED'
      : error.code === 'AUTH_PREPARATION_REQUIRED' ? 'AUTH_PREPARATION_REQUIRED'
      : error.code === 'MAP_CONSUMER_UNAVAILABLE' ? 'WORKER_UNAVAILABLE'
      : error.code === 'MAP_ACCOUNT_USAGE_REQUIRED' ? 'MAP_ACCOUNT_USAGE_REQUIRED'
      : error.code === 'ANALYSIS_CONFIG_INVALID' ? 'ANALYSIS_CONFIG_INVALID'
      : error.message.includes('手工地图作业尚未对该目标开放') ? 'MANUAL_JOBS_DISABLED'
      : /VERSION|NOT_PUBLISHED/.test(error.code) ? 'VERSION_INVALID'
      : /ACCOUNT/.test(error.code) ? 'ACCOUNT_UNAVAILABLE'
      : /VALIDATION|INPUT|BAD_REQUEST|UNRESOLVED_REF/.test(error.code) ? 'INPUT_MISSING'
      : /NOT_FOUND|DISABLED|DELETED/.test(error.code) ? 'RESOURCE_UNAVAILABLE' : undefined
    if (!retry && !reason) throw error
    return atomic(db, async tx => {
      const { schedules, scheduleOccurrences } = schemaFor(tx)
      const [peek] = await tx.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.id, occurrenceId)).limit(1)
      if (!peek) throw error
      await locked(tx, tx.select({ id: schedules.id }).from(schedules).where(eq(schedules.id, peek.scheduleId)))
      const [occurrence] = await locked(tx, tx.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.id, occurrenceId)))
      if (!occurrence) throw error
      if (occurrence.admissionStatus !== 'PENDING' || retry) return occurrenceToDto(occurrence)
      await tx.update(scheduleOccurrences).set({ admissionStatus: 'SKIPPED', reason }).where(eq(scheduleOccurrences.id, occurrenceId))
      await appendEvent(tx, occurrence.scheduleId, 'skipped', { occurrenceId, reason }, await clockNow(tx))
      return occurrenceToDto({ ...occurrence, admissionStatus: 'SKIPPED', reason: reason! })
    })
  })
}

export async function listPendingScheduleAdmits(db: Db, now?: Date): Promise<PendingScheduleAdmit[]> {
  const asOf = now ?? (await clockNow(db))
  const { scheduleOccurrences, schedules, scheduleVersions } = schemaFor(db)
  const rows = await db
    .select({
      occurrence: scheduleOccurrences,
      schedule: schedules,
      version: scheduleVersions,
    })
    .from(scheduleOccurrences)
    .innerJoin(schedules, eq(scheduleOccurrences.scheduleId, schedules.id))
    .innerJoin(scheduleVersions, eq(scheduleOccurrences.scheduleVersionId, scheduleVersions.id))
    .where(
      and(
        eq(scheduleOccurrences.admissionStatus, 'PENDING'),
        or(eq(schedules.enabled, 1), eq(scheduleOccurrences.source, 'manual')),
        or(isNull(scheduleOccurrences.windowStartUtc), lte(scheduleOccurrences.windowStartUtc, asOf)),
      ),
    )
    .orderBy(asc(scheduleOccurrences.createdAt))
    .limit(SCHEDULE_TICK_BATCH)
  return rows.map((row) => ({
    occurrence: occurrenceToDto(row.occurrence),
    definition: definitionFromVersion(row.version),
    authorizedActorId: row.version.authorizedActorId,
  }))
}

export type { ScheduleEventDto }
