import { and, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm'
import {
  CAPTURE_UPLOAD_MISSING_REASONS,
  CLEANUP_FAILURE_MIN_ATTEMPTS,
  EVIDENCE_DISPLAY_STATUS_LABELS,
  EVIDENCE_EXPIRING_SOON_MS,
  evidenceDetailResponseSchema,
  evidenceErrorSummary,
  evidenceSearchQuerySchema,
  evidenceSearchResponseSchema,
  normalizeEvidenceSearchQuery,
  projectEvidenceDisplay,
  redactJson,
  type EvidenceAvailabilityFilter,
  type EvidenceSearchItem,
  type EvidenceSearchQueryInput,
  type EvidenceSearchResponse,
  type EvidenceDetailResponse,
  type NormalizedEvidenceSearch,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { scopedTargetFilter } from '../console/target-authorization.js'
import { schemaFor } from '../native.js'
import { toEvidenceMetadata as mapEvidenceRow } from '../objects/evidence-map.js'
import { badRequest, notFound } from '../runs/errors.js'
import {
  assertEvidenceCursorMatch,
  createdAtKeySql,
  decodeEvidenceCursor,
  digestEvidenceSearch,
  encodeEvidenceCursor,
  evidenceCursorKey,
  evidenceCursorPredicate,
  evidenceSortOrder,
} from './cursor.js'

export function objectJoin(evidences: ReturnType<typeof schemaFor>['evidences'], storedObjects: ReturnType<typeof schemaFor>['storedObjects']) {
  return sql`(
    case
      when ${evidences.objectId} is not null then ${storedObjects.id} = ${evidences.objectId}
      else ${evidences.objectKey} is not null and ${storedObjects.objectKey} = ${evidences.objectKey}
    end
  )`
}

function availabilityClause(
  filter: EvidenceAvailabilityFilter,
  asOf: Date,
  tables: ReturnType<typeof schemaFor>,
): SQL {
  const { evidences, storedObjects } = tables
  const expiringUntil = new Date(asOf.getTime() + EVIDENCE_EXPIRING_SOON_MS)
  switch (filter) {
    case 'collecting':
      return eq(evidences.status, 'pending')
    case 'available':
      return or(
        and(eq(evidences.status, 'available'), isNull(evidences.objectId), isNull(evidences.objectKey)),
        and(eq(evidences.status, 'available'), isNotNull(storedObjects.id)),
      )!
    case 'capture_upload_anomaly':
      return or(
        and(eq(evidences.status, 'missing'), inArray(evidences.missingReason, [...CAPTURE_UPLOAD_MISSING_REASONS])),
        and(
          eq(evidences.status, 'missing'),
          eq(evidences.missingReason, 'object_purged'),
          eq(storedObjects.purgeReason, 'upload_incomplete'),
        ),
      )!
    case 'purged':
      return and(
        eq(evidences.status, 'missing'),
        eq(evidences.missingReason, 'object_purged'),
        or(
          inArray(storedObjects.purgeReason, ['expired', 'run_deleted']),
          and(isNotNull(storedObjects.id), isNull(storedObjects.purgeReason)),
        ),
      )!
    case 'deleting':
      return sql`false`
    case 'unlinked':
      return and(or(isNotNull(evidences.objectId), isNotNull(evidences.objectKey)), isNull(storedObjects.id))!
    case 'protected':
      return sql`false`
    case 'expiring_soon':
      return and(
        eq(evidences.status, 'available'),
        eq(storedObjects.status, 'available'),
        isNotNull(storedObjects.retainUntil),
        gt(storedObjects.retainUntil, asOf),
        lte(storedObjects.retainUntil, expiringUntil),
      )!
    case 'due_for_purge':
      return and(eq(storedObjects.status, 'available'), lte(storedObjects.retainUntil, asOf))!
    case 'purge_failed':
      return and(
        ne(storedObjects.status, 'purged'),
        or(
          isNotNull(storedObjects.lastPurgeErrorAt),
          gte(storedObjects.purgeAttempts, CLEANUP_FAILURE_MIN_ATTEMPTS),
        ),
      )!
    case 'released':
      return eq(evidences.externalAccess, 1)
    default:
      return sql`false`
  }
}

function gt(column: any, value: Date) {
  return sql`${column} > ${value}`
}

function recentFailureClause(tables: ReturnType<typeof schemaFor>): SQL {
  const { evidences, runs, attempts, stepRuns } = tables
  return or(
    eq(attempts.status, 'FAILED'),
    and(
      isNull(evidences.attemptId),
      inArray(evidences.type, ['error', 'video']),
      or(
        sql`exists (
          select 1 from ${attempts} fa
          inner join ${stepRuns} fsr on fsr.id = fa.step_run_id
          where fsr.run_id = ${runs.id} and fa.status = 'FAILED'
        )`,
        and(
          eq(runs.status, 'FAILED'),
          sql`not exists (
            select 1 from ${attempts} fa
            inner join ${stepRuns} fsr on fsr.id = fa.step_run_id
            where fsr.run_id = ${runs.id} and fa.status = 'FAILED'
          )`,
        ),
      ),
    ),
  )!
}

function retriedSuccessClause(tables: ReturnType<typeof schemaFor>): SQL {
  const { evidences, attempts, stepRuns } = tables
  return and(
    eq(stepRuns.status, 'SUCCEEDED'),
    isNotNull(evidences.attemptId),
    sql`exists (select 1 from ${attempts} fa where fa.step_run_id = ${stepRuns.id} and fa.status = 'FAILED')`,
    sql`exists (select 1 from ${attempts} sa where sa.step_run_id = ${stepRuns.id} and sa.status = 'SUCCEEDED')`,
  )!
}

function searchFilters(normalized: NormalizedEvidenceSearch, tables: ReturnType<typeof schemaFor>): SQL[] {
  const { evidences, runs, stepRuns, attempts, scenarioVersions } = tables
  const filters: (SQL | undefined)[] = [
    isNull(runs.deletedAt),
    lte(evidences.createdAt, normalized.asOf),
    normalized.createdFrom ? gte(evidences.createdAt, normalized.createdFrom) : undefined,
    normalized.createdTo ? sql`${evidences.createdAt} < ${normalized.createdTo}` : undefined,
    normalized.targetId ? eq(runs.targetId, normalized.targetId) : undefined,
    normalized.targetAccountId ? eq(runs.targetAccountId, normalized.targetAccountId) : undefined,
    normalized.scenarioId ? eq(runs.scenarioId, normalized.scenarioId) : undefined,
    normalized.scenarioVersionId ? eq(runs.scenarioVersionId, normalized.scenarioVersionId) : undefined,
    normalized.isTrial === true
      ? eq(scenarioVersions.kind, 'trial')
      : normalized.isTrial === false
        ? ne(scenarioVersions.kind, 'trial')
        : undefined,
    normalized.runId ? eq(evidences.runId, normalized.runId) : undefined,
    normalized.suiteRunId ? eq(runs.suiteRunId, normalized.suiteRunId) : undefined,
    normalized.suiteId
      ? sql`exists (select 1 from ${tables.suiteRuns} sr where sr.id = ${runs.suiteRunId} and sr.suite_id = ${normalized.suiteId})`
      : undefined,
    normalized.memberId ? eq(runs.suiteMemberId, normalized.memberId) : undefined,
    normalized.executionOrigin ? eq(runs.executionOrigin, normalized.executionOrigin) : undefined,
    normalized.evidenceId ? eq(evidences.id, normalized.evidenceId) : undefined,
    normalized.stepRunId ? eq(evidences.stepRunId, normalized.stepRunId) : undefined,
    normalized.attemptId ? eq(evidences.attemptId, normalized.attemptId) : undefined,
    normalized.types?.length ? inArray(evidences.type, normalized.types) : undefined,
    normalized.runStatuses?.length ? inArray(runs.status, normalized.runStatuses) : undefined,
    normalized.stepRunStatuses?.length ? inArray(stepRuns.status, normalized.stepRunStatuses) : undefined,
    normalized.attemptStatuses?.length ? inArray(attempts.status, normalized.attemptStatuses) : undefined,
    normalized.outcomeStatuses?.length ? inArray(runs.outcomeStatus, normalized.outcomeStatuses) : undefined,
    normalized.runEvidenceStatuses?.length
      ? inArray(runs.evidenceStatus, normalized.runEvidenceStatuses)
      : undefined,
    normalized.released === true
      ? eq(evidences.externalAccess, 1)
      : normalized.released === false
        ? eq(evidences.externalAccess, 0)
        : undefined,
    normalized.availability?.length
      ? or(...normalized.availability.map((item) => availabilityClause(item, normalized.asOf, tables)))
      : undefined,
    normalized.view === 'recent_failures' ? recentFailureClause(tables) : undefined,
    normalized.view === 'retried_success' ? retriedSuccessClause(tables) : undefined,
    normalized.view === 'capture_upload_anomaly'
      ? availabilityClause('capture_upload_anomaly', normalized.asOf, tables)
      : undefined,
    normalized.view === 'expiring_soon' ? availabilityClause('expiring_soon', normalized.asOf, tables) : undefined,
    normalized.view === 'purge_failed' ? availabilityClause('purge_failed', normalized.asOf, tables) : undefined,
  ]
  return filters.filter((item): item is SQL => item !== undefined)
}

function toSearchItem(row: {
  evidence: ReturnType<typeof schemaFor>['evidences']['$inferSelect']
  targetId: string
  scenarioId: string
  scenarioVersionId: string
  runStatus: EvidenceSearchItem['runStatus']
  outcomeStatus: EvidenceSearchItem['outcomeStatus'] | null
  runEvidenceStatus: EvidenceSearchItem['runEvidenceStatus']
  targetName: string
  targetDeletedAt: Date | null
  scenarioName: string
  scenarioDeletedAt: Date | null
  scenarioVersionNo: number | null
  scenarioVersionKind: 'published' | 'trial'
  stepName: string | null
  stepOrdinal: number | null
  stepRunStatus: EvidenceSearchItem['stepRunStatus']
  attemptNo: number | null
  attemptStatus: EvidenceSearchItem['attemptStatus']
  attemptError: unknown
  objectId: string | null
  objectStatus: string | null
  purgeReason: string | null
  retainUntil: Date | null
  lastPurgeErrorAt: Date | null
  purgeAttempts: number | null
  objectByteSize: number | null
}, asOf: Date): EvidenceSearchItem {
  const evidence = mapEvidenceRow(row.evidence)
  const projection = projectEvidenceDisplay({
    evidenceStatus: evidence.status,
    missingReason: evidence.missingReason,
    objectId: row.evidence.objectId,
    objectKey: row.evidence.objectKey,
    objectStatus: row.objectStatus,
    purgeReason: row.purgeReason,
    retainUntil: row.retainUntil?.toISOString() ?? null,
    lastPurgeErrorAt: row.lastPurgeErrorAt?.toISOString() ?? null,
    purgeAttempts: row.purgeAttempts ?? 0,
    externalAccess: evidence.externalAccess,
    asOf: asOf.toISOString(),
  })
  // 命中类型只按事实标注：失败的尝试，或最终失败运行上的运行级证据。
  // 成功运行里的运行级录像／错误不是“运行失败”。
  const hitKind =
    row.attemptStatus === 'FAILED'
      ? 'attempt_failed'
      : row.attemptStatus == null && !row.evidence.attemptId && row.runStatus === 'FAILED'
        ? 'run_failed'
        : undefined
  return {
    evidence,
    targetId: row.targetId,
    targetName: row.targetName,
    targetNameCurrent: row.targetName,
    targetDeleted: Boolean(row.targetDeletedAt),
    scenarioId: row.scenarioId,
    scenarioName: row.scenarioName,
    scenarioNameCurrent: row.scenarioName,
    scenarioDeleted: Boolean(row.scenarioDeletedAt),
    scenarioVersionId: row.scenarioVersionId,
    scenarioVersionNo: row.scenarioVersionNo,
    scenarioVersionKind: row.scenarioVersionKind,
    stepName: row.stepName,
    stepOrdinal: row.stepOrdinal,
    attemptNo: row.attemptNo,
    runStatus: row.runStatus,
    stepRunStatus: row.stepRunStatus,
    attemptStatus: row.attemptStatus,
    outcomeStatus: row.outcomeStatus ?? 'NOT_EVALUATED',
    runEvidenceStatus: row.runEvidenceStatus,
    displayStatus: projection.displayStatus,
    displayStatusLabel: EVIDENCE_DISPLAY_STATUS_LABELS[projection.displayStatus],
    filterBuckets: projection.filterBuckets,
    overlayProtected: projection.overlayProtected,
    retainUntil: row.retainUntil?.toISOString() ?? null,
    retainUntilUnknown: Boolean(row.objectStatus) && !row.retainUntil,
    byteSize: row.objectByteSize ?? evidence.byteSize ?? null,
    byteSizeUnknown: (row.objectByteSize ?? evidence.byteSize) == null && Boolean(row.objectStatus),
    errorSummary: errorSummaryOf(row.evidence.type, row.attemptStatus, row.attemptError, evidence.payload),
    ...(hitKind ? { hitKind } : {}),
    objectId: row.objectId ?? undefined,
    objectLinked: row.objectStatus != null,
    reasonCode: projection.reasonCode,
    reasonUnknown: projection.reasonUnknown,
  }
}

/**
 * 列表里的“错误摘要”只来自错误证据本身，或挂在失败尝试上的尝试错误；
 * input / output / log 等证据的 payload 不是错误，不能借这一列展示。
 * 与详情一致，输出前再过一遍脱敏。
 */
function errorSummaryOf(
  type: string,
  attemptStatus: string | null,
  attemptError: unknown,
  payload: unknown,
): string | null {
  if (type === 'error' && payload != null) return evidenceErrorSummary(redactJson(payload as never, []))
  if (attemptStatus === 'FAILED' && attemptError != null) {
    return evidenceErrorSummary(redactJson(attemptError as never, []))
  }
  return null
}

function parseEvidenceSearch(query: EvidenceSearchQueryInput) {
  const parsed = evidenceSearchQuerySchema.safeParse(query)
  if (!parsed.success) {
    throw badRequest('INVALID_EVIDENCE_SEARCH', '请求参数校验失败', parsed.error.issues)
  }
  return parsed.data
}

function evidenceItemColumns(tables: ReturnType<typeof schemaFor>) {
  const { evidences, runs, stepRuns, attempts, targets, scenarios, scenarioVersions, storedObjects } = tables
  return {
    evidence: evidences,
    targetId: runs.targetId,
    scenarioId: runs.scenarioId,
    scenarioVersionId: runs.scenarioVersionId,
    runStatus: runs.status,
    outcomeStatus: runs.outcomeStatus,
    runEvidenceStatus: runs.evidenceStatus,
    targetName: targets.name,
    targetDeletedAt: targets.deletedAt,
    scenarioName: scenarios.name,
    scenarioDeletedAt: scenarios.deletedAt,
    scenarioVersionNo: scenarioVersions.versionNo,
    scenarioVersionKind: scenarioVersions.kind,
    stepName: stepRuns.name,
    stepOrdinal: stepRuns.ordinal,
    stepRunStatus: stepRuns.status,
    attemptNo: attempts.attemptNo,
    attemptStatus: attempts.status,
    attemptError: attempts.error,
    objectId: storedObjects.id,
    objectStatus: storedObjects.status,
    purgeReason: storedObjects.purgeReason,
    retainUntil: storedObjects.retainUntil,
    lastPurgeErrorAt: storedObjects.lastPurgeErrorAt,
    purgeAttempts: storedObjects.purgeAttempts,
    objectByteSize: storedObjects.byteSize,
  }
}

function joinEvidenceItem(db: Db, tables: ReturnType<typeof schemaFor>) {
  const { evidences, runs, stepRuns, attempts, targets, scenarios, scenarioVersions, storedObjects } = tables
  return db
    .select({
      ...evidenceItemColumns(tables),
      createdAtKey: createdAtKeySql(db, evidences.createdAt),
    })
    .from(evidences)
    .innerJoin(runs, eq(runs.id, evidences.runId))
    .innerJoin(targets, eq(targets.id, runs.targetId))
    .innerJoin(scenarios, eq(scenarios.id, runs.scenarioId))
    .innerJoin(scenarioVersions, eq(scenarioVersions.id, runs.scenarioVersionId))
    .leftJoin(stepRuns, eq(stepRuns.id, evidences.stepRunId))
    .leftJoin(attempts, eq(attempts.id, evidences.attemptId))
    .leftJoin(storedObjects, objectJoin(evidences, storedObjects))
}

function countJoinNeeds(normalized: NormalizedEvidenceSearch) {
  return {
    scenarioVersions: normalized.isTrial !== undefined,
    stepRuns:
      Boolean(normalized.stepRunStatuses?.length) || normalized.view === 'retried_success',
    attempts:
      Boolean(normalized.attemptStatuses?.length) ||
      normalized.view === 'recent_failures' ||
      normalized.view === 'retried_success',
  }
}

export async function evidenceRunScope(db: Db, actorId: string | undefined) {
  return scopedTargetFilter(db, actorId, schemaFor(db).runs.targetId, 'run:read')
}

export async function searchEvidence(
  db: Db,
  query: EvidenceSearchQueryInput = {},
  actorId?: string,
): Promise<EvidenceSearchResponse> {
  const parsed = parseEvidenceSearch(query)
  const normalized = normalizeEvidenceSearchQuery(parsed)
  const tables = schemaFor(db)
  const { evidences, runs, stepRuns, attempts, scenarioVersions, storedObjects } = tables
  const decoded = normalized.cursor ? decodeEvidenceCursor(normalized.cursor) : undefined
  if (decoded) assertEvidenceCursorMatch(decoded, normalized)
  const scope = await evidenceRunScope(db, actorId)
  const filters = searchFilters(normalized, tables)
  if (scope) filters.push(scope)
  if (decoded) {
    const cursorFilter = evidenceCursorPredicate(db, decoded, {
      createdAt: evidences.createdAt,
      id: evidences.id,
      retainUntil: storedObjects.retainUntil,
      lastPurgeErrorAt: storedObjects.lastPurgeErrorAt,
    })
    if (cursorFilter) filters.push(cursorFilter)
  }

  const where = and(...filters)
  const order = evidenceSortOrder(normalized.sort, decoded?.dir ?? 'next', {
    createdAt: evidences.createdAt,
    id: evidences.id,
    retainUntil: storedObjects.retainUntil,
    lastPurgeErrorAt: storedObjects.lastPurgeErrorAt,
  })

  const rows = await joinEvidenceItem(db, tables)
    .where(where)
    .orderBy(...order)
    .limit(normalized.limit + 1)

  const pageRows = decoded?.dir === 'prev' ? [...rows].reverse() : rows
  const hasExtra = pageRows.length > normalized.limit
  const sliced = hasExtra
    ? decoded?.dir === 'prev'
      ? pageRows.slice(pageRows.length - normalized.limit)
      : pageRows.slice(0, normalized.limit)
    : pageRows
  const items = sliced.map((row) =>
    toSearchItem(
      {
        ...row,
        stepRunStatus: row.stepRunStatus ?? null,
        attemptStatus: row.attemptStatus ?? null,
      },
      normalized.asOf,
    ),
  )

  const digest = digestEvidenceSearch(normalized)
  const first = sliced[0]
  const last = sliced.at(-1)
  const nextCursor =
    (decoded?.dir === 'prev' ? true : hasExtra) && last
      ? encodeEvidenceCursor({
          digest,
          sort: normalized.sort,
          asOf: normalized.asOf.toISOString(),
          dir: 'next',
          k: evidenceCursorKey(normalized.sort, {
            createdAt: last.evidence.createdAt,
            createdAtKey: last.createdAtKey,
            retainUntil: last.retainUntil,
            lastPurgeErrorAt: last.lastPurgeErrorAt,
          }),
          id: last.evidence.id,
        })
      : undefined
  const prevCursor =
    (decoded ? decoded.dir === 'next' || hasExtra : false) && first
      ? encodeEvidenceCursor({
          digest,
          sort: normalized.sort,
          asOf: normalized.asOf.toISOString(),
          dir: 'prev',
          k: evidenceCursorKey(normalized.sort, {
            createdAt: first.evidence.createdAt,
            createdAtKey: first.createdAtKey,
            retainUntil: first.retainUntil,
            lastPurgeErrorAt: first.lastPurgeErrorAt,
          }),
          id: first.evidence.id,
        })
      : undefined

  const countNeeds = countJoinNeeds(normalized)
  const countWhere = and(...searchFilters(normalized, tables), scope)
  const countSelect = {
    evidenceCount: sql<number>`count(*)`,
    objectCount: sql<number>`count(distinct ${storedObjects.id})`,
    knownBytes: sql<number>`coalesce(sum(case when ${storedObjects.byteSize} is null then 0 else ${storedObjects.byteSize} end), 0)`,
    unknownByteObjects: sql<number>`count(distinct case when ${storedObjects.id} is not null and ${storedObjects.byteSize} is null then ${storedObjects.id} end)`,
  }
  let countQuery = db
    .select(countSelect)
    .from(evidences)
    .innerJoin(runs, eq(runs.id, evidences.runId))
    .leftJoin(storedObjects, objectJoin(evidences, storedObjects))
    .$dynamic()
  if (countNeeds.scenarioVersions) {
    countQuery = countQuery.innerJoin(scenarioVersions, eq(scenarioVersions.id, runs.scenarioVersionId))
  }
  if (countNeeds.stepRuns) {
    countQuery = countQuery.leftJoin(stepRuns, eq(stepRuns.id, evidences.stepRunId))
  }
  if (countNeeds.attempts) {
    countQuery = countQuery.leftJoin(attempts, eq(attempts.id, evidences.attemptId))
  }
  const [agg] = await countQuery.where(countWhere)

  let relatedRunGaps: EvidenceSearchResponse['relatedRunGaps']
  if (normalized.view === 'capture_upload_anomaly') {
    const gapWhere = and(
      isNull(runs.deletedAt),
      eq(runs.evidenceStatus, 'INCOMPLETE'),
      lte(runs.createdAt, normalized.asOf),
      normalized.createdFrom ? gte(runs.createdAt, normalized.createdFrom) : undefined,
      normalized.targetId ? eq(runs.targetId, normalized.targetId) : undefined,
      scope,
      sql`not exists (
        select 1 from ${evidences} ev
        left join ${storedObjects} so on (
          case
            when ev.object_id is not null then so.id = ev.object_id
            else ev.object_key is not null and so.object_key = ev.object_key
          end
        )
        where ev.run_id = ${runs.id}
          and (
            (ev.status = 'missing' and ev.missing_reason in (${sql.join(
              CAPTURE_UPLOAD_MISSING_REASONS.map((reason) => sql`${reason}`),
              sql`, `,
            )}))
            or (ev.status = 'missing' and ev.missing_reason = 'object_purged' and so.purge_reason = 'upload_incomplete')
          )
      )`,
    )
    const [gapCount] = await db.select({ n: sql<number>`count(*)` }).from(runs).where(gapWhere)
    const gapRows = await db
      .select({ runId: runs.id, evidenceStatus: runs.evidenceStatus, status: runs.status })
      .from(runs)
      .where(gapWhere)
      .orderBy(sql`${runs.createdAt} desc`, sql`${runs.id} desc`)
      .limit(20)
    relatedRunGaps = {
      count: Number(gapCount?.n ?? 0),
      items: gapRows,
    }
  }

  return evidenceSearchResponseSchema.parse({
    items,
    nextCursor: decoded?.dir === 'prev' || hasExtra ? nextCursor : undefined,
    prevCursor: decoded ? (decoded.dir === 'prev' && !hasExtra ? undefined : prevCursor) : undefined,
    asOf: normalized.asOf.toISOString(),
    readAt: new Date().toISOString(),
    timeZone: normalized.timeZone,
    timeWindowLifted: normalized.timeWindowLifted,
    sort: normalized.sort,
    summary: {
      evidenceCount: Number(agg?.evidenceCount ?? 0),
      objectCount: Number(agg?.objectCount ?? 0),
      knownBytes: Number(agg?.knownBytes ?? 0),
      unknownByteObjects: Number(agg?.unknownByteObjects ?? 0),
    },
    relatedRunGaps,
  })
}

export async function getEvidence(db: Db, evidenceId: string, actorId?: string): Promise<EvidenceDetailResponse> {
  const tables = schemaFor(db)
  const { evidences, runs } = tables
  const scope = await evidenceRunScope(db, actorId)
  const asOf = new Date()
  const [row] = await joinEvidenceItem(db, tables)
    .where(and(eq(evidences.id, evidenceId), isNull(runs.deletedAt), scope))
    .limit(1)
  if (!row) throw notFound('EVIDENCE_NOT_FOUND', '证据不存在')
  const listedAsOf = asOf.toISOString()
  const item = toSearchItem(
    {
      ...row,
      stepRunStatus: row.stepRunStatus ?? null,
      attemptStatus: row.attemptStatus ?? null,
    },
    asOf,
  )
  // 关联引用只需要定位与状态字段；payload 不随整次运行一起读出。
  const relatedRows = await db
    .select({
      id: evidences.id,
      type: evidences.type,
      status: evidences.status,
      missingReason: evidences.missingReason,
      objectId: evidences.objectId,
      objectKey: evidences.objectKey,
      stepRunId: evidences.stepRunId,
      attemptId: evidences.attemptId,
    })
    .from(evidences)
    .where(eq(evidences.runId, item.evidence.runId))
  const objectById = new Map<string, { status: string | null; purgeReason: string | null }>()
  const relatedIds = relatedRows.map((row) => row.objectId).filter((id): id is string => Boolean(id))
  if (relatedIds.length > 0) {
    const objectRows = await db
      .select({
        id: tables.storedObjects.id,
        status: tables.storedObjects.status,
        purgeReason: tables.storedObjects.purgeReason,
      })
      .from(tables.storedObjects)
      .where(inArray(tables.storedObjects.id, relatedIds))
    for (const row of objectRows) objectById.set(row.id, row)
  }
  const projectRelated = (row: (typeof relatedRows)[number]) =>
    projectEvidenceDisplay({
      evidenceStatus: row.status,
      missingReason: row.missingReason,
      objectId: row.objectId,
      objectKey: row.objectKey,
      objectStatus: row.objectId ? objectById.get(row.objectId)?.status ?? null : null,
      purgeReason: row.objectId ? objectById.get(row.objectId)?.purgeReason ?? null : null,
      asOf: listedAsOf,
    }).displayStatus
  const sameAttempt = relatedRows
    .filter((row) => item.evidence.attemptId && row.attemptId === item.evidence.attemptId && row.id !== item.evidence.id)
    .map((row) => ({
      evidenceId: row.id,
      type: row.type,
      displayStatus: projectRelated(row),
    }))
  const video = relatedRows.find((row) => row.type === 'video' && !row.attemptId && !row.stepRunId)
  let attemptError: EvidenceDetailResponse['attemptError']
  if (item.evidence.attemptId) {
    const [attempt] = await db
      .select({ error: tables.attempts.error })
      .from(tables.attempts)
      .where(eq(tables.attempts.id, item.evidence.attemptId))
      .limit(1)
    if (attempt?.error !== undefined && attempt.error !== null) attemptError = redactJson(attempt.error, [])
  }
  return evidenceDetailResponseSchema.parse({
    item,
    related: {
      sameAttempt,
      runVideo: video
        ? {
            evidenceId: video.id,
            type: video.type,
            displayStatus: projectRelated(video),
          }
        : null,
    },
    payload:
      item.evidence.payload === undefined || item.evidence.payload === null
        ? undefined
        : redactJson(item.evidence.payload, []),
    attemptError,
  })
}

export function assertRelatedIds(input: {
  runId?: string
  stepRunId?: string
  attemptId?: string
  evidenceRunId: string
  evidenceStepRunId?: string
  evidenceAttemptId?: string
}): void {
  if (input.runId && input.runId !== input.evidenceRunId) {
    throw badRequest('EVIDENCE_RELATION_MISMATCH', '关联运行与证据不属于同一来源')
  }
  if (input.stepRunId && input.evidenceStepRunId && input.stepRunId !== input.evidenceStepRunId) {
    throw badRequest('EVIDENCE_RELATION_MISMATCH', '关联步骤与证据不属于同一来源')
  }
  if (input.attemptId && input.evidenceAttemptId && input.attemptId !== input.evidenceAttemptId) {
    throw badRequest('EVIDENCE_RELATION_MISMATCH', '关联尝试与证据不属于同一来源')
  }
}
