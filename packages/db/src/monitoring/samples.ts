import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  DEFAULT_MONITOR_SAMPLE_INTERVAL_MS,
  DEFAULT_MONITOR_SAMPLE_RETENTION_DAYS,
  DEFAULT_MONITOR_SERIES_WINDOW_MS,
  MAX_MONITOR_SERIES_POINTS,
  MAX_MONITOR_SERIES_WINDOW_MS,
  downsampleMonitorSeries,
  type MonitorSampleKey,
  type MonitorSampleScope,
  type MonitorSeriesItem,
  type MonitorSeriesResponse,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { afterSeconds, clockNow, driverOf, insertIgnoreRows, sampleBucketAt, schemaFor } from '../native.js'
import { failure } from '../runs/errors.js'

export type MonitorSampleWrite = {
  key: MonitorSampleKey
  scope: MonitorSampleScope
  scopeId?: string
  value: number
}

export async function insertMonitorSamples(
  db: Db,
  samples: MonitorSampleWrite[],
  intervalMs = DEFAULT_MONITOR_SAMPLE_INTERVAL_MS,
): Promise<number> {
  const known = samples.filter((sample) => Number.isFinite(sample.value))
  if (known.length === 0) return 0
  const { monitorSamples } = schemaFor(db)
  const [row] = await db.select({ at: sampleBucketAt(db, intervalMs) }).from(sql`(SELECT 1) AS sample_bucket`)
  const bucketAt = new Date(
    driverOf(db) === 'mysql' && typeof row?.at === 'string' ? `${String(row.at).replace(' ', 'T')}Z` : (row!.at as string),
  )
  return insertIgnoreRows(
    db,
    monitorSamples,
    known.map((sample) => ({
      metricKey: sample.key,
      scope: sample.scope,
      scopeId: sample.scope === 'platform' ? '' : (sample.scopeId ?? ''),
      bucketAt,
      value: sample.value,
    })),
  )
}

function rowsAffected(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result
  if (!header || typeof header !== 'object') return 0
  const row = header as { rowCount?: number; affectedRows?: number; rowsAffected?: number }
  return Number(row.rowCount ?? row.affectedRows ?? row.rowsAffected ?? 0)
}

export async function purgeMonitorSamples(
  db: Db,
  retainDays = DEFAULT_MONITOR_SAMPLE_RETENTION_DAYS,
): Promise<number> {
  const { monitorSamples } = schemaFor(db)
  if (retainDays <= 0) {
    return rowsAffected(await db.delete(monitorSamples))
  }
  const cutoff = afterSeconds(db, -retainDays * 86_400)
  return rowsAffected(await db.delete(monitorSamples).where(sql`${monitorSamples.bucketAt} < ${cutoff}`))
}

export async function readMonitorSeries(
  db: Db,
  input: {
    keys: MonitorSampleKey[]
    from?: string
    to?: string
    scope?: MonitorSampleScope
    scopeId?: string
  },
): Promise<MonitorSeriesResponse> {
  const asOf = await clockNow(db)
  const to = input.to ? new Date(input.to) : asOf
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - DEFAULT_MONITOR_SERIES_WINDOW_MS)
  if (to.getTime() - from.getTime() > MAX_MONITOR_SERIES_WINDOW_MS) {
    throw failure('bad_request', { code: 'MONITOR_SERIES_WINDOW', message: '查询跨度不得超过 30 天' })
  }
  const scope = input.scope ?? 'platform'
  const scopeId = scope === 'platform' ? '' : (input.scopeId ?? '')
  const { monitorSamples } = schemaFor(db)
  const rows = await db
    .select()
    .from(monitorSamples)
    .where(
      and(
        inArray(monitorSamples.metricKey, input.keys),
        eq(monitorSamples.scope, scope),
        eq(monitorSamples.scopeId, scopeId),
        sql`${monitorSamples.bucketAt} >= ${from}`,
        sql`${monitorSamples.bucketAt} <= ${to}`,
      ),
    )
    .orderBy(asc(monitorSamples.metricKey), asc(monitorSamples.bucketAt))

  const grouped = new Map<string, MonitorSeriesItem['points']>()
  for (const key of input.keys) grouped.set(key, [])
  for (const row of rows) {
    grouped.get(row.metricKey as MonitorSampleKey)?.push({
      bucketAt: row.bucketAt.toISOString(),
      value: row.value,
    })
  }
  const items: MonitorSeriesItem[] = input.keys.map((key) => ({
    key,
    scope,
    scopeId,
    points: downsampleMonitorSeries(grouped.get(key) ?? [], MAX_MONITOR_SERIES_POINTS),
  }))
  return {
    asOf: asOf.toISOString(),
    from: from.toISOString(),
    to: to.toISOString(),
    scope,
    scopeId,
    items,
  }
}

export async function readLatestClaimScanCount(
  db: Db,
  freshnessMs = DEFAULT_MONITOR_SAMPLE_INTERVAL_MS * 4,
): Promise<number | null> {
  const { monitorSamples } = schemaFor(db)
  const asOf = await clockNow(db)
  const cutoff = new Date(asOf.getTime() - freshnessMs)
  const [row] = await db
    .select({ value: sql`max(${monitorSamples.value})` })
    .from(monitorSamples)
    .where(
      and(
        eq(monitorSamples.metricKey, 'queue.lastClaimScanCount'),
        sql`${monitorSamples.bucketAt} >= ${cutoff}`,
      ),
    )
  if (row?.value == null) return null
  const value = Number(row.value)
  return Number.isFinite(value) ? value : null
}

export async function countScenarioAiInBucket(
  db: Db,
  intervalMs = DEFAULT_MONITOR_SAMPLE_INTERVAL_MS,
): Promise<{
  calls: number
  errors: number
  inputTokens: number | null
  outputTokens: number | null
}> {
  const { scenarioAiCalls } = schemaFor(db)
  const bucket = sampleBucketAt(db, intervalMs)
  const [row] = await db
    .select({
      calls: sql`count(*)`,
      errors: sql`sum(case when ${scenarioAiCalls.phase} = 'failed' then 1 else 0 end)`,
      inputTokens: sql`sum(${scenarioAiCalls.inputTokens})`,
      outputTokens: sql`sum(${scenarioAiCalls.outputTokens})`,
      inputPresent: sql`sum(case when ${scenarioAiCalls.inputTokens} is not null then 1 else 0 end)`,
      outputPresent: sql`sum(case when ${scenarioAiCalls.outputTokens} is not null then 1 else 0 end)`,
    })
    .from(scenarioAiCalls)
    .where(sql`${scenarioAiCalls.createdAt} >= ${bucket}`)
  const calls = Number(row?.calls ?? 0)
  const inputPresent = Number(row?.inputPresent ?? 0)
  const outputPresent = Number(row?.outputPresent ?? 0)
  return {
    calls,
    errors: Number(row?.errors ?? 0),
    inputTokens: calls > 0 && inputPresent === 0 ? null : Number(row?.inputTokens ?? 0),
    outputTokens: calls > 0 && outputPresent === 0 ? null : Number(row?.outputTokens ?? 0),
  }
}
