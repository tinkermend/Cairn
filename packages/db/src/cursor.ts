import { and, eq, lt, or, type SQL } from 'drizzle-orm'
import { failure } from './runs/errors.js'

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const sep = raw.lastIndexOf('|')
    if (sep <= 0) throw new Error('bad cursor')
    const createdAt = new Date(raw.slice(0, sep))
    const id = raw.slice(sep + 1)
    if (Number.isNaN(createdAt.getTime()) || !id) throw new Error('bad cursor')
    return { createdAt, id }
  } catch {
    throw failure('bad_request', { code: 'INVALID_CURSOR', message: '游标无效' })
  }
}

export function cursorFilter(
  createdAtColumn: any,
  idColumn: any,
  cursor?: string,
): SQL | undefined {
  if (!cursor) return undefined
  const { createdAt, id } = decodeCursor(cursor)
  return or(
    lt(createdAtColumn, createdAt),
    and(eq(createdAtColumn, createdAt), lt(idColumn, id)),
  )!
}

export function paginateResults<T extends { id: string; createdAt: Date | string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | undefined; hasMore: boolean } {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items.at(-1)
  const nextCursor =
    hasMore && last
      ? encodeCursor(
          last.createdAt instanceof Date ? last.createdAt : new Date(last.createdAt),
          last.id,
        )
      : undefined
  return { items, nextCursor, hasMore }
}
