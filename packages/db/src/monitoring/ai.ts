import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import {
  MONITOR_AI_P95_SAMPLE_LIMIT,
  MONITOR_AI_WINDOW_HOURS,
  knownMetric,
  percentile,
  unknownMetric,
  type MonitorAiCard,
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
