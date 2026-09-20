import { eq } from 'drizzle-orm'
import type { Db } from '../client.js'
import { clockNow, schemaFor } from '../native.js'
import { isUniqueViolation } from '../runs/errors.js'

export const GLOBAL_RECLAIM_WATERMARK = 'global_reclaim'

export async function touchRuntimeWatermark(db: Db, name: string): Promise<Date> {
  const { runtimeWatermarks } = schemaFor(db)
  const now = await clockNow(db)
  const [existing] = await db.select().from(runtimeWatermarks).where(eq(runtimeWatermarks.name, name)).limit(1)
  if (existing) {
    await db.update(runtimeWatermarks).set({ occurredAt: now }).where(eq(runtimeWatermarks.name, name))
    return now
  }
  try {
    await db.insert(runtimeWatermarks).values({ name, occurredAt: now })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    await db.update(runtimeWatermarks).set({ occurredAt: now }).where(eq(runtimeWatermarks.name, name))
  }
  return now
}

export async function readRuntimeWatermark(db: Db, name: string): Promise<Date | null> {
  const { runtimeWatermarks } = schemaFor(db)
  const [row] = await db.select().from(runtimeWatermarks).where(eq(runtimeWatermarks.name, name)).limit(1)
  return row?.occurredAt ?? null
}
