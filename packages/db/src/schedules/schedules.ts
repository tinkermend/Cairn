import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import {
  SCHEDULE_CONSUMER_MAP_REFRESH,
  SCHEDULE_TICK_BATCH,
  addLocalDays,
  canonicalJson,
  hasAllPermissions,
  isoWeekdayOfDate,
  localDateInTimeZone,
  nextDueFromWindows,
  previewScheduleWindows,
  resolveScheduleWindow,
  scheduleDefinitionSchema,
  scheduleDtoSchema,
  scheduleEnabledBodySchema,
  scheduleEventDtoSchema,
  scheduleListResponseSchema,
  scheduleOccurrenceDtoSchema,
  scheduleOccurrenceListResponseSchema,
  scheduleEventListResponseSchema,
  scheduleWriteBodySchema,
  scheduleWriteResponseSchema,
  type ExecutionActor,
  type ResolvedScheduleWindow,
  type ScheduleDefinition,
  type ScheduleDto,
  type ScheduleEnabledBody,
  type ScheduleEventDto,
  type ScheduleListQuery,
  type ScheduleOccurrenceDto,
  type ScheduleSkipReason,
  type ScheduleTickOutcome,
  type ScheduleWriteBody,
  type ScheduleWriteResponse,
  type Step,
} from '@cairn/shared'
import { requireMapCapableAccount } from '../console/account-usage.js'
import type { Db } from '../client.js'
import { recordAudit } from '../audit/record.js'
import { decodeAuditCursor, encodeAuditCursor } from '../audit/cursor.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import { DomainError, conflict, forbidden, isUniqueViolation, notFound } from '../runs/errors.js'
import { sha256Hex } from '../runs/digest.js'
import { cancelMapJob, createMapJob, getMapJob, getMapJobPolicy } from '../map/jobs.js'
import { getOrCreatePlatformConfig } from '../platform-config/store.js'
import { requireLiveTarget } from '../map/view.js'

function definitionFromVersion(row: {
  timezone: string
  weekdays: unknown
  windowStart: string
  windowEnd: string
  misfire: string
  consumer: unknown
}): ScheduleDefinition {
  return scheduleDefinitionSchema.parse({
    timezone: row.timezone,
    weekdays: row.weekdays,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    misfire: row.misfire,
    consumer: row.consumer,
  })
}

function occurrenceToDto(
  row: {
    id: string
    scheduleId: string
    scheduleVersionId: string
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
    createdAt: Date
    admittedAt: Date | null
  },
  firstRunId?: string,
): ScheduleOccurrenceDto {
  return scheduleOccurrenceDtoSchema.parse({
    occurrenceId: row.id,
    scheduleId: row.scheduleId,
    scheduleVersionId: row.scheduleVersionId,
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
    firstRunId,
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
  return scheduleDtoSchema.parse({
    scheduleId: schedule.id,
    targetId: schedule.targetId,
    targetAccountId: schedule.targetAccountId,
    consumerKey: SCHEDULE_CONSUMER_MAP_REFRESH,
    enabled: schedule.enabled === 1,
    revision: schedule.revision,
    currentVersionId: schedule.currentVersionId,
    definition: definitionFromVersion(version),
    nextDueAt: schedule.nextDueAt?.toISOString() ?? null,
    lastOccurrence: await lastOccurrence(db, scheduleId),
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
  await insertRows(tx, scheduleEvents, {
    id: newId(),
    scheduleId,
    seq: Number(max?.seq ?? 0) + 1,
    eventType,
    payload,
    createdAt: now,
  })
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

export async function actorCanAdmitSchedules(db: Db, accountId: string): Promise<boolean> {
  return hasAllPermissions(await accountPermissions(db, accountId), ['schedule:write', 'map:maintain'])
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

function windowRow(resolved: ResolvedScheduleWindow, scheduleId: string, versionId: string, now: Date, status: 'PENDING' | 'SKIPPED', reason?: ScheduleSkipReason) {
  return {
    id: newId(),
    scheduleId,
    scheduleVersionId: versionId,
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
    createdAt: now,
    admittedAt: null,
  }
}

export async function getSchedule(db: Db, scheduleId: string): Promise<ScheduleDto> {
  return scheduleToDto(db, scheduleId)
}

export async function listSchedules(db: Db, query: ScheduleListQuery, actorId?: string): Promise<{ items: ScheduleDto[]; nextCursor?: string }> {
  const { schedules } = schemaFor(db)
  const decoded = query.cursor ? decodeAuditCursor(query.cursor) : null
  const rows = await db
    .select()
    .from(schedules)
    .where(
      and(
        query.targetId ? eq(schedules.targetId, query.targetId) : undefined,
        await (await import('../console/target-authorization.js')).scopedTargetFilter(db, actorId, schedules.targetId, 'schedule:read'),
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
  const items = await Promise.all(page.map((row) => scheduleToDto(db, row.id)))
  return scheduleListResponseSchema.parse({
    items,
    nextCursor: rows.length > query.limit ? encodeAuditCursor(page.at(-1)!.createdAt, page.at(-1)!.id) : undefined,
  })
}

export async function writeSchedule(
  db: Db,
  body: ScheduleWriteBody,
  actor: ExecutionActor,
  existingId?: string,
): Promise<ScheduleWriteResponse> {
  const parsed = scheduleWriteBodySchema.parse(body)
  await requireLiveTarget(db, parsed.definition.consumer.targetId)
  return atomic(db, async (tx) => {
    const { scheduleCommands, schedules, scheduleVersions, targetAccounts } = schemaFor(tx)
    const [receipt] = await tx
      .select()
      .from(scheduleCommands)
      .where(eq(scheduleCommands.commandKey, parsed.idempotencyKey))
      .limit(1)
    const payload = { body: parsed, existingId: existingId ?? null }
    if (receipt) {
      if (canonicalJson(receipt.payload) !== canonicalJson(payload)) {
        throw conflict('SCHEDULE_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同的调度命令')
      }
      return scheduleWriteResponseSchema.parse({ ...(receipt.result as ScheduleWriteResponse), created: false })
    }
    const [account] = await tx
      .select()
      .from(targetAccounts)
      .where(eq(targetAccounts.id, parsed.definition.consumer.targetAccountId))
      .limit(1)
    if (!account || account.targetId !== parsed.definition.consumer.targetId || account.status !== 'active') {
      throw notFound('TARGET_ACCOUNT_NOT_FOUND', '目标账号不存在或已停用')
    }
    await requireMapCapableAccount(tx, parsed.definition.consumer.targetId, parsed.definition.consumer.targetAccountId)
    const now = await clockNow(tx)
    const digest = sha256Hex(parsed.definition)
    let scheduleId = existingId
    let created = false
    if (existingId) {
      const [current] = await locked(tx, tx.select().from(schedules).where(eq(schedules.id, existingId)))
      if (!current) throw notFound('SCHEDULE_NOT_FOUND', '调度计划不存在')
      if (current.revision !== parsed.expectedRevision) throw conflict('SCHEDULE_REVISION_CONFLICT', '调度修订已变更')
      if (current.targetId !== parsed.definition.consumer.targetId) throw forbidden('SCHEDULE_TARGET_MISMATCH', '不能改到其他目标')
      const versionId = newId()
      const nextRevision = current.revision + 1
      await insertRows(tx, scheduleVersions, {
        id: versionId,
        scheduleId: current.id,
        revision: nextRevision,
        timezone: parsed.definition.timezone,
        weekdays: parsed.definition.weekdays,
        windowStart: parsed.definition.windowStart,
        windowEnd: parsed.definition.windowEnd,
        misfire: parsed.definition.misfire,
        consumer: parsed.definition.consumer,
        authorizedActorId: actor.id,
        contentDigest: digest,
        createdAt: now,
      })
      const nextDue = nextDueFromWindows(
        previewScheduleWindows({ scheduleId: current.id, definition: parsed.definition, asOf: now, limit: 1 }),
        now,
      )
      await tx
        .update(schedules)
        .set({
          targetAccountId: parsed.definition.consumer.targetAccountId,
          revision: nextRevision,
          currentVersionId: versionId,
          nextDueAt: nextDue,
          updatedAt: now,
        })
        .where(eq(schedules.id, current.id))
      await appendEvent(tx, current.id, 'revised', { revision: nextRevision, digest }, now)
      await recordAudit(tx, actor, 'schedule.update', 'target', current.targetId, `修订调度 ${current.id}`)
    } else {
      if (parsed.expectedRevision !== 0) throw conflict('SCHEDULE_REVISION_CONFLICT', '新建调度的期望修订须为 0')
      scheduleId = newId()
      const versionId = newId()
      try {
        await insertRows(tx, schedules, {
          id: scheduleId,
          targetId: parsed.definition.consumer.targetId,
          targetAccountId: parsed.definition.consumer.targetAccountId,
          consumerKey: SCHEDULE_CONSUMER_MAP_REFRESH,
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
        if (isUniqueViolation(error)) throw conflict('SCHEDULE_ACCOUNT_CONFLICT', '该账号已有自动复查计划')
        throw error
      }
      await insertRows(tx, scheduleVersions, {
        id: versionId,
        scheduleId,
        revision: 1,
        timezone: parsed.definition.timezone,
        weekdays: parsed.definition.weekdays,
        windowStart: parsed.definition.windowStart,
        windowEnd: parsed.definition.windowEnd,
        misfire: parsed.definition.misfire,
        consumer: parsed.definition.consumer,
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
  body: ScheduleEnabledBody,
  actor: ExecutionActor,
): Promise<ScheduleDto> {
  const parsed = scheduleEnabledBodySchema.parse(body)
  return atomic(db, async (tx) => {
    const { scheduleCommands, schedules } = schemaFor(tx)
    const commandKey = `enabled:${parsed.idempotencyKey}`
    const [receipt] = await tx.select().from(scheduleCommands).where(eq(scheduleCommands.commandKey, commandKey)).limit(1)
    const payload = { body: parsed, scheduleId }
    if (receipt) {
      if (canonicalJson(receipt.payload) !== canonicalJson(payload)) {
        throw conflict('SCHEDULE_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同的启停命令')
      }
      return scheduleDtoSchema.parse((receipt.result as { schedule: ScheduleDto }).schedule)
    }
    const [current] = await locked(tx, tx.select().from(schedules).where(eq(schedules.id, scheduleId)))
    if (!current) throw notFound('SCHEDULE_NOT_FOUND', '调度计划不存在')
    if (current.revision !== parsed.expectedRevision) throw conflict('SCHEDULE_REVISION_CONFLICT', '调度修订已变更')
    if (parsed.enabled) {
      await requireMapCapableAccount(tx, current.targetId, current.targetAccountId)
    }
    const now = await clockNow(tx)
    const dto = await scheduleToDto(tx, scheduleId)
    const nextDue = parsed.enabled
      ? nextDueFromWindows(previewScheduleWindows({ scheduleId, definition: dto.definition, asOf: now, limit: 1 }), now)
      : current.nextDueAt
    try {
      await tx
        .update(schedules)
        .set({
          enabled: parsed.enabled ? 1 : 0,
          enabledGuard: parsed.enabled ? 'Y' : null,
          revision: current.revision + 1,
          nextDueAt: nextDue,
          updatedAt: now,
        })
        .where(eq(schedules.id, scheduleId))
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('SCHEDULE_ACCOUNT_CONFLICT', '该账号已有启用中的自动复查计划')
      throw error
    }
    if (parsed.cancelAdmittedJobs && current.enabled === 1 && !parsed.enabled) {
      const { scheduleOccurrences } = schemaFor(tx)
      const admitted = await tx
        .select()
        .from(scheduleOccurrences)
        .where(and(eq(scheduleOccurrences.scheduleId, scheduleId), eq(scheduleOccurrences.admissionStatus, 'ADMITTED')))
      for (const row of admitted) {
        if (row.jobId) await cancelMapJob(tx, row.jobId, actor).catch(() => undefined)
      }
    }
    await appendEvent(tx, scheduleId, parsed.enabled ? 'enabled' : 'disabled', { cancelAdmittedJobs: parsed.cancelAdmittedJobs }, now)
    await recordAudit(tx, actor, 'schedule.enable', 'target', current.targetId, parsed.enabled ? '启用调度' : '停用调度')
    const result = await scheduleToDto(tx, scheduleId)
    await insertRows(tx, scheduleCommands, { id: newId(), commandKey, payload, result: { schedule: result } })
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
  definition: ScheduleDefinition,
  asOf?: Date,
) {
  const now = asOf ?? (await clockNow(db))
  const config = await getOrCreatePlatformConfig(db)
  const windows = previewScheduleWindows({
    scheduleId: '00000000-0000-4000-8000-000000000000',
    definition,
    asOf: now,
  })
  const gaps = []
  if (!config.document.mapScheduledRefreshEnabled) {
    gaps.push({ code: 'FACTORY_DISABLED', message: '平台尚未开放自动复查' })
  }
  gaps.push({ code: 'ADMIT_RECHECK', message: '准入时再检查认证、作业政策、权限和资产' })
  return { asOf: now.toISOString(), windows, gaps }
}

async function insertOccurrenceIfAbsent(
  tx: Db,
  values: ReturnType<typeof windowRow>,
): Promise<{ row: ScheduleOccurrenceDto; created: boolean }> {
  const { scheduleOccurrences } = schemaFor(tx)
  try {
    await insertRows(tx, scheduleOccurrences, values)
    return { row: occurrenceToDto(values), created: true }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const [existing] = await tx
      .select()
      .from(scheduleOccurrences)
      .where(
        and(eq(scheduleOccurrences.scheduleId, values.scheduleId), eq(scheduleOccurrences.localSlotKey, values.localSlotKey)),
      )
      .limit(1)
    if (!existing) throw error
    return { row: occurrenceToDto(existing), created: false }
  }
}

export async function expireClosedScheduleWindows(db: Db): Promise<number> {
  return atomic(db, async (tx) => {
    const { scheduleOccurrences } = schemaFor(tx)
    const now = await clockNow(tx)
    const rows = await tx
      .select()
      .from(scheduleOccurrences)
      .where(
        and(
          eq(scheduleOccurrences.admissionStatus, 'PENDING'),
          sql`${scheduleOccurrences.windowEndUtc} IS NOT NULL`,
          lte(scheduleOccurrences.windowEndUtc, now),
        ),
      )
    for (const row of rows) {
      const [lockedRow] = await locked(tx, tx.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.id, row.id)))
      if (!lockedRow || lockedRow.admissionStatus !== 'PENDING') continue
      await tx
        .update(scheduleOccurrences)
        .set({ admissionStatus: 'SKIPPED', reason: 'WINDOW_CLOSED' })
        .where(eq(scheduleOccurrences.id, row.id))
      await appendEvent(tx, row.scheduleId, 'skipped', { occurrenceId: row.id, reason: 'WINDOW_CLOSED' }, now)
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
  if (!config.document.mapScheduledRefreshEnabled) {
    return { outcome: { scanned: 0, materialized: 0, skipped: 0, admitted: 0, conflicts: 0 }, pending: [] }
  }
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
      const [version] = await tx.select().from(scheduleVersions).where(eq(scheduleVersions.id, schedule.currentVersionId)).limit(1)
      if (!version) return
      const definition = definitionFromVersion(version)
      const now = await clockNow(tx)
      if (schedule.nextDueAt.getTime() > now.getTime()) return
      const startDate = localDateInTimeZone(schedule.nextDueAt, definition.timezone)
      const weekdays = new Set(definition.weekdays)
      let advanced: Date | null = null
      for (let offset = 0; offset < 40; offset += 1) {
        const date = addLocalDays(startDate.year, startDate.month, startDate.day, offset)
        if (!weekdays.has(isoWeekdayOfDate(date.year, date.month, date.day))) continue
        const resolved = resolveScheduleWindow({
          scheduleId: schedule.id,
          timezone: definition.timezone,
          windowStart: definition.windowStart,
          windowEnd: definition.windowEnd,
          localDate: date,
        })
        if (resolved.kind === 'skipped') {
          const inserted = await insertOccurrenceIfAbsent(tx, windowRow(resolved, schedule.id, version.id, now, 'SKIPPED', resolved.reason))
          if (inserted.created) {
            outcome.skipped += 1
            outcome.materialized += 1
            await appendEvent(tx, schedule.id, 'skipped', { occurrenceId: inserted.row.occurrenceId, reason: resolved.reason }, now)
          }
          advanced = nextDueAfter(schedule.id, definition, date, now)
          continue
        }
        const end = new Date(resolved.windowEndUtc)
        const start = new Date(resolved.windowStartUtc)
        if (end.getTime() <= now.getTime()) {
          const inserted = await insertOccurrenceIfAbsent(tx, windowRow(resolved, schedule.id, version.id, now, 'SKIPPED', 'WINDOW_CLOSED'))
          if (inserted.created) {
            outcome.skipped += 1
            outcome.materialized += 1
            await appendEvent(tx, schedule.id, 'skipped', { occurrenceId: inserted.row.occurrenceId, reason: 'WINDOW_CLOSED' }, now)
          }
          advanced = nextDueAfter(schedule.id, definition, date, now)
          continue
        }
        if (start.getTime() > now.getTime()) {
          advanced = start
          break
        }
        const inserted = await insertOccurrenceIfAbsent(tx, windowRow(resolved, schedule.id, version.id, now, 'PENDING'))
        if (inserted.created) {
          outcome.materialized += 1
          await appendEvent(tx, schedule.id, 'materialized', { occurrenceId: inserted.row.occurrenceId }, now)
        }
        if (inserted.row.admissionStatus === 'PENDING') {
          pending.push({ occurrence: inserted.row, definition, authorizedActorId: version.authorizedActorId })
        }
        advanced = nextDueAfter(schedule.id, definition, date, now)
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
    if (schedule.enabled !== 1) return skip('SCHEDULE_DISABLED')
    if (occurrence.windowEndUtc && occurrence.windowEndUtc.getTime() <= now.getTime()) return skip('WINDOW_CLOSED')
    const config = await getOrCreatePlatformConfig(tx)
    if (!config.document.mapScheduledRefreshEnabled) return skip('FACTORY_DISABLED')
    if (!(await actorCanAdmitSchedules(tx, version.authorizedActorId))) return skip('PERMISSION_REVOKED')
    if (compiled.skipReason) return skip(compiled.skipReason)
    if (compiled.includedCount <= 0) return skip('NO_ELIGIBLE_ASSETS')
    try {
      const policy = await getMapJobPolicy(tx, definition.consumer.targetId)
      const created = await createMapJob(
        tx,
        definition.consumer.targetId,
        {
          source: 'scheduled',
          occurrenceId: occurrence.id,
          startBefore: occurrence.windowEndUtc?.toISOString(),
          expectedPolicyRevision: policy.revision,
          jobKind: 'map_refresh',
          targetAccountId: definition.consumer.targetAccountId,
          entryId: definition.consumer.entryId,
          selectedAssetRefs: definition.consumer.selectedAssetRefs,
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
    } catch (error) {
      if (error instanceof DomainError && error.code === 'MAP_ACTIVE_SLICE_EXISTS') {
        if (occurrence.windowEndUtc && occurrence.windowEndUtc.getTime() <= now.getTime()) return skip('WINDOW_CLOSED')
        return occurrenceToDto(occurrence)
      }
      if (error instanceof DomainError && error.code === 'AUTH_PREPARATION_REQUIRED') return skip('AUTH_PREPARATION_REQUIRED')
      if (error instanceof DomainError && error.message.includes('手工地图作业尚未对该目标开放')) return skip('MANUAL_JOBS_DISABLED')
      if (error instanceof DomainError && error.code === 'MAP_CONSUMER_UNAVAILABLE') return skip('WORKER_UNAVAILABLE')
      if (error instanceof DomainError && error.code === 'MAP_ACCOUNT_USAGE_REQUIRED') {
        return skip('MAP_ACCOUNT_USAGE_REQUIRED')
      }
      throw error
    }
  })
}

export type { ScheduleEventDto }
