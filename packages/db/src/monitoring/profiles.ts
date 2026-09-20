import { and, asc, desc, eq, or, sql } from 'drizzle-orm'
import {
  knownMetric,
  monitorProfileListQuerySchema,
  monitorProfileListResponseSchema,
  unknownMetric,
  type MonitorProfileListQueryInput,
  type MonitorProfileListResponse,
  type MonitorProfileNodeItem,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, jsonArrayLength, schemaFor } from '../native.js'
import { failure } from '../runs/errors.js'

function encodeCursor(locationWorkerId: string | null, targetId: string, targetAccountId: string): string {
  return Buffer.from(`${locationWorkerId ?? ''}\t${targetId}\t${targetAccountId}`, 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): { locationWorkerId: string | null; targetId: string; targetAccountId: string } {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const [location, targetId, targetAccountId] = raw.split('\t')
    if (!targetId || !targetAccountId) throw new Error('bad cursor')
    return { locationWorkerId: location ? location : null, targetId, targetAccountId }
  } catch {
    throw failure('bad_request', { code: 'INVALID_CURSOR', message: '游标无效' })
  }
}

export async function listMonitorProfiles(
  db: Db,
  query: MonitorProfileListQueryInput,
): Promise<MonitorProfileListResponse> {
  const parsed = monitorProfileListQuerySchema.parse(query)
  const asOf = await clockNow(db)
  const { sessionProfiles, targets, targetAccounts } = schemaFor(db)
  const conditions = []
  if (parsed.cursor) {
    const cursor = decodeCursor(parsed.cursor)
    if (cursor.locationWorkerId != null) {
      conditions.push(
        or(
          sql`${sessionProfiles.locationWorkerId} > ${cursor.locationWorkerId}`,
          and(
            eq(sessionProfiles.locationWorkerId, cursor.locationWorkerId),
            or(
              sql`${sessionProfiles.targetId} > ${cursor.targetId}`,
              and(
                eq(sessionProfiles.targetId, cursor.targetId),
                sql`${sessionProfiles.targetAccountId} > ${cursor.targetAccountId}`,
              ),
            ),
          ),
          sql`${sessionProfiles.locationWorkerId} IS NULL`,
        ),
      )
    } else {
      conditions.push(
        and(
          sql`${sessionProfiles.locationWorkerId} IS NULL`,
          or(
            sql`${sessionProfiles.targetId} > ${cursor.targetId}`,
            and(
              eq(sessionProfiles.targetId, cursor.targetId),
              sql`${sessionProfiles.targetAccountId} > ${cursor.targetAccountId}`,
            ),
          ),
        ),
      )
    }
  }

  const rows = await db
    .select({
      targetId: sessionProfiles.targetId,
      targetAccountId: sessionProfiles.targetAccountId,
      revision: sessionProfiles.revision,
      locationWorkerId: sessionProfiles.locationWorkerId,
      state: sessionProfiles.state,
      pendingCleanups: jsonArrayLength(db, sessionProfiles.pendingCleanups),
      updatedAt: sessionProfiles.updatedAt,
      targetName: targets.name,
      accountLabel: targetAccounts.displayName,
    })
    .from(sessionProfiles)
    .leftJoin(targets, eq(targets.id, sessionProfiles.targetId))
    .leftJoin(targetAccounts, eq(targetAccounts.id, sessionProfiles.targetAccountId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(
      sql`case when ${sessionProfiles.locationWorkerId} is null then 1 else 0 end`,
      asc(sessionProfiles.locationWorkerId),
      asc(sessionProfiles.targetId),
      asc(sessionProfiles.targetAccountId),
    )
    .limit(parsed.limit + 1)

  const page = rows.slice(0, parsed.limit)
  const last = page.at(-1)
  return monitorProfileListResponseSchema.parse({
    asOf: asOf.toISOString(),
    nodes: await listProfileNodes(db),
    items: page.map((row) => ({
      profileKey: `${row.targetId}/${row.targetAccountId}`,
      locationWorkerId: row.locationWorkerId,
      state: row.state,
      revision: row.revision,
      pendingCleanups: Number(row.pendingCleanups ?? 0),
      targetId: row.targetId,
      targetAccountId: row.targetAccountId,
      targetName: row.targetName ?? null,
      accountLabel: row.accountLabel ?? null,
      updatedAt: row.updatedAt.toISOString(),
      diskUsageBytes: unknownMetric('not_collected'),
    })),
    nextCursor:
      rows.length > parsed.limit && last
        ? encodeCursor(last.locationWorkerId, last.targetId, last.targetAccountId)
        : undefined,
  })
}

function sampleMetric(value: number | null | undefined) {
  return value == null || Number.isNaN(value) ? unknownMetric('not_reported') : knownMetric(value)
}

async function listProfileNodes(db: Db): Promise<MonitorProfileNodeItem[]> {
  const asOf = await clockNow(db)
  const { workers } = schemaFor(db)
  const rows = await db
    .select()
    .from(workers)
    .where(
      and(
        sql`${workers.heartbeatExpiresAt} IS NOT NULL`,
        sql`${workers.heartbeatExpiresAt} > ${asOf}`,
      ),
    )
    .orderBy(
      sql`case when ${workers.sampledDiskAt} is null then 1 else 0 end`,
      desc(workers.sampledDiskAt),
      desc(workers.heartbeatAt),
    )
    .limit(32)
  return rows.map((row) => ({
    workerId: row.id,
    diskUsageBytes: sampleMetric(row.sampledProfileBytes),
    profileCount: sampleMetric(row.sampledProfileCount),
    diskFreeBytes: sampleMetric(row.sampledProfileDiskFreeBytes),
    midsceneBytes: sampleMetric(row.sampledMidsceneBytes),
    sampledAt: row.sampledDiskAt?.toISOString() ?? null,
  }))
}
