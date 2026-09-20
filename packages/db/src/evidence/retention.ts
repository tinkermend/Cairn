import { and, eq, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm'
import {
  CLEANUP_FAILURE_MIN_ATTEMPTS,
  DEFAULT_OBJECT_PENDING_TTL_SECONDS,
  EVIDENCE_EXPIRING_SOON_MS,
  evidenceRetentionObjectsQuerySchema,
  evidenceRetentionObjectsResponseSchema,
  evidenceRetentionSummaryResponseSchema,
  normalizeEvidenceSearchQuery,
  type EvidenceRetentionObjectsQuery,
  type EvidenceRetentionObjectsResponse,
  type EvidenceRetentionSummaryResponse,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { forbidden } from '../runs/errors.js'
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
import { evidenceRunScope, objectJoin } from './search.js'

type Tables = ReturnType<typeof schemaFor>

/** 与 Worker 清理循环同一判据（`listPurgeCandidates`）：到期、运行已请求删除，或上传中超过 pendingTtl 的 pending。 */
function pendingCleanupClause(storedObjects: Tables['storedObjects'], asOf: Date, pendingTtlSeconds: number): SQL {
  const pendingBefore = new Date(asOf.getTime() - pendingTtlSeconds * 1000)
  return or(
    and(eq(storedObjects.status, 'available'), lte(storedObjects.retainUntil, asOf)),
    and(eq(storedObjects.status, 'pending'), lt(storedObjects.createdAt, pendingBefore)),
    and(ne(storedObjects.status, 'purged'), isNotNull(storedObjects.deleteRequestedAt)),
  )!
}

/** `isCleanupFailed`（shared）的 SQL 形式：未清理完，且失败次数达标或有过错误。 */
function failedClause(storedObjects: Tables['storedObjects']): SQL {
  return and(
    ne(storedObjects.status, 'purged'),
    or(
      isNotNull(storedObjects.lastPurgeErrorAt),
      sql`${storedObjects.purgeAttempts} >= ${CLEANUP_FAILURE_MIN_ATTEMPTS}`,
    ),
  )!
}

function expiringClause(storedObjects: Tables['storedObjects'], asOf: Date, until: Date): SQL {
  return and(
    eq(storedObjects.status, 'available'),
    isNotNull(storedObjects.retainUntil),
    sql`${storedObjects.retainUntil} > ${asOf}`,
    lte(storedObjects.retainUntil, until),
  )!
}

function countWhere(condition?: SQL): SQL<number> {
  return condition
    ? sql<number>`coalesce(sum(case when ${condition} then 1 else 0 end), 0)`
    : sql<number>`count(*)`
}

/** 已知字节：未知（null）不计入，也不当 0 之外的任何值。 */
function knownBytesWhere(byteSize: unknown, condition?: SQL): SQL<number> {
  return condition
    ? sql<number>`coalesce(sum(case when ${condition} then coalesce(${byteSize}, 0) else 0 end), 0)`
    : sql<number>`coalesce(sum(coalesce(${byteSize}, 0)), 0)`
}

function unknownWhere(byteSize: unknown, condition?: SQL): SQL<number> {
  return condition
    ? sql<number>`coalesce(sum(case when ${condition} and ${byteSize} is null then 1 else 0 end), 0)`
    : sql<number>`coalesce(sum(case when ${byteSize} is null then 1 else 0 end), 0)`
}

const num = (value: unknown): number => Number(value ?? 0)

function tally(row: { n?: unknown; bytes?: unknown; unknown?: unknown } | undefined) {
  return { objectCount: num(row?.n), knownBytes: num(row?.bytes), unknownByteObjects: num(row?.unknown) }
}

/**
 * 留存汇总。全部在数据库里聚合，不把对象账本读进进程内存；
 * 占用只统计尚未清理（`purged` 之外）的对象，已释放的字节不算占用。
 */
export async function summarizeEvidenceRetention(
  db: Db,
  input: { asOf?: Date; actorId?: string; canListDeletedRunObjects: boolean; pendingTtlSeconds?: number },
): Promise<EvidenceRetentionSummaryResponse> {
  const asOf = input.asOf ?? new Date()
  const expiringUntil = new Date(asOf.getTime() + EVIDENCE_EXPIRING_SOON_MS)
  const pendingTtlSeconds = input.pendingTtlSeconds ?? DEFAULT_OBJECT_PENDING_TTL_SECONDS
  const tables = schemaFor(db)
  const { storedObjects, runs, targets, evidences } = tables
  const scope = await evidenceRunScope(db, input.actorId)

  const accessibleWhere = and(isNull(runs.deletedAt), ne(storedObjects.status, 'purged'), scope)!
  const expiring = expiringClause(storedObjects, asOf, expiringUntil)
  const pending = pendingCleanupClause(storedObjects, asOf, pendingTtlSeconds)
  const failed = failedClause(storedObjects)
  const size = storedObjects.byteSize

  const [total] = await db
    .select({
      n: countWhere(),
      bytes: knownBytesWhere(size),
      unknown: unknownWhere(size),
      expN: countWhere(expiring),
      expBytes: knownBytesWhere(size, expiring),
      expUnknown: unknownWhere(size, expiring),
      pendN: countWhere(pending),
      pendBytes: knownBytesWhere(size, pending),
      pendUnknown: unknownWhere(size, pending),
      failedN: countWhere(failed),
    })
    .from(storedObjects)
    .innerJoin(runs, eq(runs.id, storedObjects.runId))
    .where(accessibleWhere)

  const targetRows = await db
    .select({
      targetId: runs.targetId,
      targetName: targets.name,
      n: countWhere(),
      bytes: knownBytesWhere(size),
      unknown: unknownWhere(size),
    })
    .from(storedObjects)
    .innerJoin(runs, eq(runs.id, storedObjects.runId))
    .innerJoin(targets, eq(targets.id, runs.targetId))
    .where(accessibleWhere)
    .groupBy(runs.targetId, targets.name)

  // 从证据一侧按主键联到对象，先去重再按类型分组；没有证据指向的对象归为 unlinked。
  const linked = db
    .selectDistinct({ id: storedObjects.id, type: evidences.type, byteSize: storedObjects.byteSize })
    .from(evidences)
    .innerJoin(storedObjects, objectJoin(evidences, storedObjects))
    .innerJoin(runs, eq(runs.id, storedObjects.runId))
    .where(accessibleWhere)
    .as('linked')
  const typeRows = await db
    .select({
      type: linked.type,
      n: countWhere(),
      bytes: knownBytesWhere(linked.byteSize),
      unknown: unknownWhere(linked.byteSize),
    })
    .from(linked)
    .groupBy(linked.type)

  const [deleted] = await db
    .select({
      n: countWhere(),
      bytes: knownBytesWhere(size),
      unknown: unknownWhere(size),
      failedN: countWhere(failed),
    })
    .from(storedObjects)
    .innerJoin(runs, eq(runs.id, storedObjects.runId))
    .where(and(isNotNull(runs.deletedAt), ne(storedObjects.status, 'purged'), scope))

  const all = tally(total)
  const linkedSum = typeRows.reduce(
    (acc, row) => ({
      objectCount: acc.objectCount + num(row.n),
      knownBytes: acc.knownBytes + num(row.bytes),
      unknownByteObjects: acc.unknownByteObjects + num(row.unknown),
    }),
    { objectCount: 0, knownBytes: 0, unknownByteObjects: 0 },
  )
  const unlinked = {
    objectCount: Math.max(0, all.objectCount - linkedSum.objectCount),
    knownBytes: Math.max(0, all.knownBytes - linkedSum.knownBytes),
    unknownByteObjects: Math.max(0, all.unknownByteObjects - linkedSum.unknownByteObjects),
  }
  const byType = [
    ...typeRows.map((row) => ({ type: row.type, ...tally(row) })),
    ...(unlinked.objectCount > 0 ? [{ type: 'unlinked' as const, ...unlinked }] : []),
  ]

  const deletedPending = num(deleted?.n)
  const deletedFailed = num(deleted?.failedN)

  return evidenceRetentionSummaryResponseSchema.parse({
    asOf: asOf.toISOString(),
    readAt: new Date().toISOString(),
    accessible: {
      ...all,
      expiringSoon: tally({ n: total?.expN, bytes: total?.expBytes, unknown: total?.expUnknown }),
      pendingCleanup: tally({ n: total?.pendN, bytes: total?.pendBytes, unknown: total?.pendUnknown }),
      purgeFailed: num(total?.failedN),
      byTarget: targetRows.map((row) => ({
        targetId: row.targetId,
        targetName: row.targetName,
        ...tally(row),
      })),
      byType,
    },
    deletedRunCleanup: {
      ...tally(deleted),
      pending: deletedPending,
      failed: deletedFailed,
      inProgress: Math.max(0, deletedPending - deletedFailed),
    },
    canListDeletedRunObjects: input.canListDeletedRunObjects,
  })
}

export async function listRetentionObjects(
  db: Db,
  query: EvidenceRetentionObjectsQuery,
  access: { actorId?: string; canListDeletedRunObjects: boolean; pendingTtlSeconds?: number },
): Promise<EvidenceRetentionObjectsResponse> {
  const parsed = evidenceRetentionObjectsQuerySchema.parse(query)
  const asOf = parsed.asOf ? new Date(parsed.asOf) : new Date()
  if (parsed.view === 'deleted_run' && !access.canListDeletedRunObjects) {
    throw forbidden('EVIDENCE_DELETED_RUN_LIST_DENIED', '查看已删除运行的逐项清理清单需要 run:delete')
  }
  const { storedObjects, runs, targets, evidences } = schemaFor(db)
  const expiringUntil = new Date(asOf.getTime() + EVIDENCE_EXPIRING_SOON_MS)
  const pendingTtlSeconds = access.pendingTtlSeconds ?? DEFAULT_OBJECT_PENDING_TTL_SECONDS
  const scope = await evidenceRunScope(db, access.actorId)
  const viewFilters: SQL[] = []
  if (scope) viewFilters.push(scope)
  if (parsed.view === 'deleted_run') {
    // 与汇总同口径：只列尚未清理完的对象。
    viewFilters.push(isNotNull(runs.deletedAt), ne(storedObjects.status, 'purged'))
  } else {
    viewFilters.push(isNull(runs.deletedAt))
  }
  if (parsed.targetId) viewFilters.push(eq(runs.targetId, parsed.targetId))
  if (parsed.view === 'expiring_soon') {
    viewFilters.push(expiringClause(storedObjects, asOf, expiringUntil))
  } else if (parsed.view === 'purge_failed') {
    viewFilters.push(failedClause(storedObjects))
  } else if (parsed.view === 'pending_cleanup') {
    viewFilters.push(pendingCleanupClause(storedObjects, asOf, pendingTtlSeconds))
  }

  const sort =
    parsed.view === 'expiring_soon'
      ? 'retainUntil_asc'
      : parsed.view === 'purge_failed'
        ? 'lastPurgeErrorAt_desc'
        : 'createdAt_desc'
  const fakeNormalized = normalizeEvidenceSearchQuery({
    asOf: asOf.toISOString(),
    view: parsed.view === 'expiring_soon' ? 'expiring_soon' : parsed.view === 'purge_failed' ? 'purge_failed' : undefined,
    limit: parsed.limit,
    cursor: parsed.cursor,
    targetId: parsed.targetId,
  })
  // 游标绑定对象清单自身的身份（视图 + Target），而不是证据检索的筛选。
  const objectDigestSource = {
    ...fakeNormalized,
    runId: `retention:${parsed.view}`,
  }
  const decoded = parsed.cursor ? decodeEvidenceCursor(parsed.cursor) : undefined
  if (decoded) assertEvidenceCursorMatch(decoded, objectDigestSource)
  const columns = {
    createdAt: storedObjects.createdAt,
    id: storedObjects.id,
    retainUntil: storedObjects.retainUntil,
    lastPurgeErrorAt: storedObjects.lastPurgeErrorAt,
  }
  if (decoded) {
    const cursorFilter = evidenceCursorPredicate(db, decoded, columns)
    if (cursorFilter) viewFilters.push(cursorFilter)
  }

  const order = evidenceSortOrder(sort, decoded?.dir ?? 'next', columns)

  const rows = await db
    .select({
      objectId: storedObjects.id,
      runId: storedObjects.runId,
      runDeletedAt: runs.deletedAt,
      status: storedObjects.status,
      purgeReason: storedObjects.purgeReason,
      retainUntil: storedObjects.retainUntil,
      byteSize: storedObjects.byteSize,
      purgeAttempts: storedObjects.purgeAttempts,
      lastPurgeErrorAt: storedObjects.lastPurgeErrorAt,
      createdAt: storedObjects.createdAt,
      createdAtKey: createdAtKeySql(db, storedObjects.createdAt),
      deleteRequestedAt: storedObjects.deleteRequestedAt,
      evidenceId: evidences.id,
      type: evidences.type,
      targetName: targets.name,
    })
    .from(storedObjects)
    .innerJoin(runs, eq(runs.id, storedObjects.runId))
    .innerJoin(targets, eq(targets.id, runs.targetId))
    .leftJoin(evidences, objectJoin(evidences, storedObjects))
    .where(and(...viewFilters))
    .orderBy(...order)
    .limit(parsed.limit + 1)

  const pageRows = decoded?.dir === 'prev' ? [...rows].reverse() : rows
  const hasExtra = pageRows.length > parsed.limit
  const sliced = hasExtra
    ? decoded?.dir === 'prev'
      ? pageRows.slice(pageRows.length - parsed.limit)
      : pageRows.slice(0, parsed.limit)
    : pageRows

  const digest = digestEvidenceSearch(objectDigestSource)
  const first = sliced[0]
  const last = sliced.at(-1)
  const cursorFor = (row: NonNullable<typeof first>, dir: 'next' | 'prev') =>
    encodeEvidenceCursor({
      digest,
      sort,
      asOf: asOf.toISOString(),
      dir,
      k: evidenceCursorKey(sort, row),
      id: row.objectId,
    })
  // 向后翻时一定还有更后面的页；向前翻回到最前一页后不再给“上一页”。
  const hasNext = decoded?.dir === 'prev' || hasExtra
  const hasPrev = decoded ? decoded.dir === 'next' || hasExtra : false

  return evidenceRetentionObjectsResponseSchema.parse({
    items: sliced.map((row) => {
      const runDeleted = Boolean(row.runDeletedAt)
      let candidateReason: 'expired' | 'upload_incomplete' | 'run_deleted' | 'purge_failed' | 'expiring_soon' =
        'expired'
      if (parsed.view === 'expiring_soon') candidateReason = 'expiring_soon'
      else if (parsed.view === 'purge_failed' || row.lastPurgeErrorAt || row.purgeAttempts >= CLEANUP_FAILURE_MIN_ATTEMPTS)
        candidateReason = 'purge_failed'
      else if (runDeleted) candidateReason = 'run_deleted'
      else if (row.status === 'pending') candidateReason = 'upload_incomplete'
      return {
        objectId: row.objectId,
        runId: row.runId,
        runDeleted,
        sourceIdVisible: !runDeleted || access.canListDeletedRunObjects,
        hasEvidence: Boolean(row.evidenceId),
        evidenceId: row.evidenceId,
        type: row.type,
        status: row.status,
        purgeReason: row.purgeReason,
        candidateReason,
        retainUntil: row.retainUntil?.toISOString() ?? null,
        byteSize: row.byteSize,
        byteSizeUnknown: row.byteSize == null,
        purgeAttempts: row.purgeAttempts,
        lastPurgeErrorAt: row.lastPurgeErrorAt?.toISOString() ?? null,
        targetName: row.targetName,
      }
    }),
    nextCursor: hasNext && last ? cursorFor(last, 'next') : undefined,
    prevCursor: hasPrev && first ? cursorFor(first, 'prev') : undefined,
    asOf: asOf.toISOString(),
    readAt: new Date().toISOString(),
    view: parsed.view,
    withheldDeletedRunItems: false,
  })
}
