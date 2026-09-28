import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import {
  MONITOR_AI_P95_SAMPLE_LIMIT,
  MONITOR_AI_WINDOW_HOURS,
  knownMetric,
  percentile,
  unknownMetric,
  type MonitorAiCard,
  type MonitorAiModelItem,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'

export async function summarizeAi(db: Db, asOf: Date): Promise<MonitorAiCard> {
  const { scenarioAiCalls } = schemaFor(db)
  const since = new Date(asOf.getTime() - MONITOR_AI_WINDOW_HOURS * 3600 * 1000)
  const [totals] = await db
    .select({
      calls: sql`count(*)`,
      errors: sql`sum(case when ${scenarioAiCalls.phase} = 'failed' then 1 else 0 end)`,
      inputTokens: sql`sum(${scenarioAiCalls.inputTokens})`,
      outputTokens: sql`sum(${scenarioAiCalls.outputTokens})`,
      inputPresent: sql`sum(case when ${scenarioAiCalls.inputTokens} is not null then 1 else 0 end)`,
      outputPresent: sql`sum(case when ${scenarioAiCalls.outputTokens} is not null then 1 else 0 end)`,
      textCalls: sql`sum(case when ${scenarioAiCalls.route} = 'aria_text' then 1 else 0 end)`,
      visionCalls: sql`sum(case when ${scenarioAiCalls.route} = 'vision' or ${scenarioAiCalls.route} is null then 1 else 0 end)`,
      textTokens: sql`sum(case when ${scenarioAiCalls.route} = 'aria_text' then coalesce(${scenarioAiCalls.inputTokens}, 0) + coalesce(${scenarioAiCalls.outputTokens}, 0) else 0 end)`,
      visionTokens: sql`sum(case when ${scenarioAiCalls.route} = 'vision' or ${scenarioAiCalls.route} is null then coalesce(${scenarioAiCalls.inputTokens}, 0) + coalesce(${scenarioAiCalls.outputTokens}, 0) else 0 end)`,
      lastCallAt: sql`max(${scenarioAiCalls.createdAt})`,
    })
    .from(scenarioAiCalls)
    .where(sql`${scenarioAiCalls.createdAt} >= ${since}`)

  const calls = Number(totals?.calls ?? 0)
  if (calls === 0) {
    return {
      calls: knownMetric(0),
      errors: knownMetric(0),
      inputTokens: knownMetric(0),
      outputTokens: knownMetric(0),
      textCalls: knownMetric(0),
      visionCalls: knownMetric(0),
      textTokens: knownMetric(0),
      visionTokens: knownMetric(0),
      durationP95Ms: unknownMetric('not_collected'),
      cost: unknownMetric('not_collected'),
      lastCallAt: null,
      lastErrorAt: null,
      lastErrorClass: null,
    }
  }

  const [durationRows, lastError] = await Promise.all([
    db
      .select({ durationMs: scenarioAiCalls.durationMs })
      .from(scenarioAiCalls)
      .where(and(sql`${scenarioAiCalls.createdAt} >= ${since}`, isNotNull(scenarioAiCalls.durationMs)))
      .orderBy(desc(scenarioAiCalls.createdAt))
      .limit(MONITOR_AI_P95_SAMPLE_LIMIT),
    db
      .select({ createdAt: scenarioAiCalls.createdAt, errorCode: scenarioAiCalls.errorCode })
      .from(scenarioAiCalls)
      .where(and(sql`${scenarioAiCalls.createdAt} >= ${since}`, eq(scenarioAiCalls.phase, 'failed')))
      .orderBy(desc(scenarioAiCalls.createdAt))
      .limit(1)
      .then((rows) => rows[0]),
  ])

  const durations = durationRows
    .map((row) => row.durationMs)
    .filter((value): value is number => value != null && Number.isFinite(value))
  const p95 = durations.length ? percentile(durations, 95) : null
  return {
    calls: knownMetric(calls),
    errors: knownMetric(Number(totals?.errors ?? 0)),
    inputTokens: tokenMetric(calls, totals?.inputPresent, totals?.inputTokens),
    outputTokens: tokenMetric(calls, totals?.outputPresent, totals?.outputTokens),
    textCalls: knownMetric(Number(totals?.textCalls ?? 0)),
    visionCalls: knownMetric(Number(totals?.visionCalls ?? 0)),
    textTokens: knownMetric(Number(totals?.textTokens ?? 0)),
    visionTokens: knownMetric(Number(totals?.visionTokens ?? 0)),
    durationP95Ms: p95 == null ? unknownMetric('not_collected') : knownMetric(p95),
    cost: unknownMetric('not_collected'),
    lastCallAt: instant(totals?.lastCallAt),
    lastErrorAt: instant(lastError?.createdAt),
    lastErrorClass: lastError?.errorCode ?? null,
  }
}

function tokenMetric(calls: number, present: unknown, sum: unknown): MonitorAiCard['inputTokens'] {
  const known = Number(present ?? 0)
  if (calls > 0 && known === 0) return unknownMetric('not_reported')
  return knownMetric(Number(sum ?? 0))
}

function instant(value: unknown): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export async function summarizeAiModels(db: Db, asOf: Date): Promise<MonitorAiModelItem[]> {
  const { scenarioAiCalls } = schemaFor(db)
  const since = new Date(asOf.getTime() - MONITOR_AI_WINDOW_HOURS * 3600 * 1000)
  const windowMinutes = Math.max(1, MONITOR_AI_WINDOW_HOURS * 60)

  const rows = await db
    .select({
      model: scenarioAiCalls.model,
      totalCalls: sql`count(*)`,
      failedCalls: sql`sum(case when ${scenarioAiCalls.phase} = 'failed' then 1 else 0 end)`,
      inputTokens: sql`coalesce(sum(${scenarioAiCalls.inputTokens}), 0)`,
      outputTokens: sql`coalesce(sum(${scenarioAiCalls.outputTokens}), 0)`,
      rateLimitHits: sql`sum(case when ${scenarioAiCalls.errorCode} in ('RATE_LIMITED', '429', 'RESOURCE_EXHAUSTED') then 1 else 0 end)`,
    })
    .from(scenarioAiCalls)
    .where(sql`${scenarioAiCalls.createdAt} >= ${since}`)
    .groupBy(scenarioAiCalls.model)

  // P95 按模型分组在应用层算（percentile_cont 是 PG 专有聚合函数，换库没有对应物）：
  // 抓一批最近的原始耗时样本，按 model 分桶后各自调用 percentile()。
  const durationRows = await db
    .select({ model: scenarioAiCalls.model, durationMs: scenarioAiCalls.durationMs })
    .from(scenarioAiCalls)
    .where(and(sql`${scenarioAiCalls.createdAt} >= ${since}`, isNotNull(scenarioAiCalls.durationMs)))
    .orderBy(desc(scenarioAiCalls.createdAt))
    .limit(MONITOR_AI_P95_SAMPLE_LIMIT)

  const durationsByModel = new Map<string, number[]>()
  for (const row of durationRows) {
    if (row.durationMs == null || !Number.isFinite(row.durationMs)) continue
    const key = row.model ?? 'default'
    const bucket = durationsByModel.get(key) ?? []
    bucket.push(row.durationMs)
    durationsByModel.set(key, bucket)
  }

  return rows.map((r) => {
    const total = Number(r.totalCalls ?? 0)
    const failed = Number(r.failedCalls ?? 0)
    const errorRate = total > 0 ? Math.round((failed / total) * 100) : 0
    const inTokens = Number(r.inputTokens ?? 0)
    const outTokens = Number(r.outputTokens ?? 0)
    const model = r.model ?? 'default'
    const durations = durationsByModel.get(model) ?? []
    const p95 = durations.length ? percentile(durations, 95) : null
    return {
      model,
      totalCalls: total,
      failedCalls: failed,
      errorRate,
      p95DurationMs: p95 != null ? Math.round(p95) : 0,
      inputTokensPerMin: Math.round((inTokens / windowMinutes) * 10) / 10,
      outputTokensPerMin: Math.round((outTokens / windowMinutes) * 10) / 10,
      rateLimitHits: Number(r.rateLimitHits ?? 0),
    }
  })
}
