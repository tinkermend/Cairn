import { eq } from 'drizzle-orm'
import {
  MONITOR_OBJECT_STORE_KIND,
  knownMetric,
  unknownMetric,
  type MonitorObjectStoreCard,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { clockNow, insertIgnoreRows, schemaFor } from '../native.js'

export type ObjectStoreProbeWrite = {
  status: 'ok' | 'failed'
  latencyMs: number | null
  errorClass: string | null
  probedBy: string
  probedAt?: Date
}

export async function upsertObjectStoreProbe(db: Db, input: ObjectStoreProbeWrite): Promise<void> {
  const { objectStoreProbes } = schemaFor(db)
  const probedAt = input.probedAt ?? (await clockNow(db))
  const values = {
    storeKind: MONITOR_OBJECT_STORE_KIND,
    status: input.status,
    latencyMs: input.latencyMs,
    errorClass: input.errorClass,
    probedAt,
    probedBy: input.probedBy,
  }
  const inserted = await insertIgnoreRows(db, objectStoreProbes, values)
  if (inserted === 0) {
    await db.update(objectStoreProbes).set(values).where(eq(objectStoreProbes.storeKind, MONITOR_OBJECT_STORE_KIND))
  }
}

export async function readObjectStoreCard(
  db: Db,
  asOf: Date,
  staleAfterMs: number,
): Promise<MonitorObjectStoreCard> {
  const { objectStoreProbes } = schemaFor(db)
  const [row] = await db
    .select()
    .from(objectStoreProbes)
    .where(eq(objectStoreProbes.storeKind, MONITOR_OBJECT_STORE_KIND))
    .limit(1)
  if (!row) {
    return {
      status: unknownMetric('not_collected'),
      latencyMs: unknownMetric('not_collected'),
      probedAt: null,
      errorClass: null,
    }
  }
  const age = asOf.getTime() - row.probedAt.getTime()
  if (age > staleAfterMs) {
    return {
      status: unknownMetric('sample_stale'),
      latencyMs: unknownMetric('sample_stale'),
      probedAt: row.probedAt.toISOString(),
      errorClass: row.errorClass,
    }
  }
  return {
    status: knownMetric(row.status === 'ok' ? 1 : 0),
    latencyMs: row.latencyMs == null ? unknownMetric('not_reported') : knownMetric(row.latencyMs),
    probedAt: row.probedAt.toISOString(),
    errorClass: row.errorClass,
  }
}

export async function recordManualObjectStoreProbe(
  db: Db,
  input: ObjectStoreProbeWrite & { actor: AuditActor },
): Promise<MonitorObjectStoreCard> {
  return db.transaction(async (tx) => {
    const probedAt = input.probedAt ?? (await clockNow(tx))
    await upsertObjectStoreProbe(tx as unknown as Db, { ...input, probedAt })
    await recordAudit(
      tx as unknown as Db,
      input.actor,
      'monitor.probe',
      'object_store',
      null,
      '触发对象存储探测',
    )
    return readObjectStoreCard(tx as unknown as Db, probedAt, Number.MAX_SAFE_INTEGER)
  })
}
