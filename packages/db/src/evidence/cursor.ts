import { createHash } from 'node:crypto'
import { and, asc, desc, eq, gt, lt, or, sql, type SQL } from 'drizzle-orm'
import {
  evidenceSearchCursorPayload,
  type EvidenceSortKey,
  type NormalizedEvidenceSearch,
} from '@cairn/shared'
import { driverOf } from '../native.js'
import { badRequest } from '../runs/errors.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * PostgreSQL 的 timestamptz 是微秒精度，node-pg 读回 JS Date 会截到毫秒；
 * 游标若用截断值做 `<` / `=` 比较，同一毫秒内不同微秒的行会被翻页跳过。
 * 因此 PG 下 createdAt 的游标键直接取数据库文本（保留微秒），比较时也以该文本入参；
 * MySQL 的 DATETIME(3) 本身就是毫秒，沿用 Date。
 */
export function createdAtKeySql(db: object, column: unknown): SQL<string | null> {
  return driverOf(db) === 'postgres'
    ? sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
    : sql<string | null>`null`
}

export type EvidenceCursorPayload = {
  v: 1
  digest: string
  sort: EvidenceSortKey
  asOf: string
  dir: 'next' | 'prev'
  k: string
  id: string
}

export function digestEvidenceSearch(normalized: NormalizedEvidenceSearch): string {
  return createHash('sha256').update(JSON.stringify(evidenceSearchCursorPayload(normalized))).digest('hex')
}

export function encodeEvidenceCursor(input: Omit<EvidenceCursorPayload, 'v'>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...input }), 'utf8').toString('base64url')
}

export function decodeEvidenceCursor(cursor: string): EvidenceCursorPayload {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<EvidenceCursorPayload>
    if (
      raw.v !== 1 ||
      typeof raw.digest !== 'string' ||
      typeof raw.sort !== 'string' ||
      typeof raw.asOf !== 'string' ||
      typeof raw.id !== 'string' ||
      !UUID_PATTERN.test(raw.id) ||
      (raw.dir !== 'next' && raw.dir !== 'prev') ||
      typeof raw.k !== 'string' ||
      (raw.k !== '' && Number.isNaN(Date.parse(raw.k)))
    ) {
      throw new Error('bad cursor')
    }
    return raw as EvidenceCursorPayload
  } catch {
    throw badRequest('INVALID_CURSOR', '游标无效')
  }
}

export function assertEvidenceCursorMatch(
  cursor: EvidenceCursorPayload,
  normalized: NormalizedEvidenceSearch,
): void {
  const digest = digestEvidenceSearch(normalized)
  if (
    cursor.digest !== digest ||
    cursor.sort !== normalized.sort ||
    cursor.asOf !== normalized.asOf.toISOString()
  ) {
    throw badRequest('INVALID_CURSOR', '游标与当前筛选不匹配，请从第一页重新查询')
  }
}

export function evidenceCursorKey(sort: EvidenceSortKey, row: {
  createdAt: Date
  /** 数据库原始精度的 createdAt 文本；MySQL 下为 null，回退到 Date。 */
  createdAtKey?: string | null
  retainUntil: Date | null
  lastPurgeErrorAt: Date | null
}): string {
  if (sort === 'retainUntil_asc') return row.retainUntil?.toISOString() ?? ''
  if (sort === 'lastPurgeErrorAt_desc') return row.lastPurgeErrorAt?.toISOString() ?? ''
  return row.createdAtKey ?? row.createdAt.toISOString()
}

export function evidenceSortOrder(
  sort: EvidenceSortKey,
  dir: 'next' | 'prev',
  columns: {
    createdAt: any
    id: any
    retainUntil: any
    lastPurgeErrorAt: any
  },
): SQL[] {
  const forward = dir === 'next'
  if (sort === 'retainUntil_asc') {
    return forward
      ? [sql`(${columns.retainUntil} is null)`, asc(columns.retainUntil), asc(columns.id)]
      : [sql`(${columns.retainUntil} is not null)`, desc(columns.retainUntil), desc(columns.id)]
  }
  if (sort === 'lastPurgeErrorAt_desc') {
    return forward
      ? [sql`(${columns.lastPurgeErrorAt} is null)`, desc(columns.lastPurgeErrorAt), desc(columns.id)]
      : [sql`(${columns.lastPurgeErrorAt} is not null)`, asc(columns.lastPurgeErrorAt), asc(columns.id)]
  }
  return forward
    ? [desc(columns.createdAt), desc(columns.id)]
    : [asc(columns.createdAt), asc(columns.id)]
}

export function evidenceCursorPredicate(
  db: object,
  cursor: EvidenceCursorPayload,
  columns: {
    createdAt: any
    id: any
    retainUntil: any
    lastPurgeErrorAt: any
  },
): SQL | undefined {
  const after = cursor.dir === 'next'
  if (cursor.sort === 'retainUntil_asc') {
    if (!cursor.k) {
      return after
        ? and(sql`${columns.retainUntil} is null`, gt(columns.id, cursor.id))
        : or(sql`${columns.retainUntil} is not null`, and(sql`${columns.retainUntil} is null`, lt(columns.id, cursor.id)))
    }
    const key = new Date(cursor.k)
    return after
      ? or(
          sql`${columns.retainUntil} is null`,
          gt(columns.retainUntil, key),
          and(eq(columns.retainUntil, key), gt(columns.id, cursor.id)),
        )
      : or(
          and(sql`${columns.retainUntil} is not null`, lt(columns.retainUntil, key)),
          and(eq(columns.retainUntil, key), lt(columns.id, cursor.id)),
        )
  }
  if (cursor.sort === 'lastPurgeErrorAt_desc') {
    if (!cursor.k) {
      return after
        ? and(sql`${columns.lastPurgeErrorAt} is null`, lt(columns.id, cursor.id))
        : or(
            sql`${columns.lastPurgeErrorAt} is not null`,
            and(sql`${columns.lastPurgeErrorAt} is null`, gt(columns.id, cursor.id)),
          )
    }
    const key = new Date(cursor.k)
    return after
      ? or(
          lt(columns.lastPurgeErrorAt, key),
          and(eq(columns.lastPurgeErrorAt, key), lt(columns.id, cursor.id)),
          sql`${columns.lastPurgeErrorAt} is null`,
        )
      : or(
          gt(columns.lastPurgeErrorAt, key),
          and(eq(columns.lastPurgeErrorAt, key), gt(columns.id, cursor.id)),
        )
  }
  if (!cursor.k) throw badRequest('INVALID_CURSOR', '游标无效')
  if (driverOf(db) === 'postgres') {
    // 文本入参由 PG 按 timestamptz 解析，保留微秒。
    return after
      ? sql`(${columns.createdAt} < ${cursor.k} or (${columns.createdAt} = ${cursor.k} and ${columns.id} < ${cursor.id}))`
      : sql`(${columns.createdAt} > ${cursor.k} or (${columns.createdAt} = ${cursor.k} and ${columns.id} > ${cursor.id}))`
  }
  const key = new Date(cursor.k)
  return after
    ? or(lt(columns.createdAt, key), and(eq(columns.createdAt, key), lt(columns.id, cursor.id)))
    : or(gt(columns.createdAt, key), and(eq(columns.createdAt, key), gt(columns.id, cursor.id)))
}
