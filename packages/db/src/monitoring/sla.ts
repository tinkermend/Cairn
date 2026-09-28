import { desc, sql } from 'drizzle-orm'
import {
  percentile,
  type MonitorSlaCard,
  type MonitorTargetSlaItem,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { jsonHasKey, schemaFor } from '../native.js'

export const DEFAULT_SLA_WINDOW_HOURS = 24
const TARGET_SLA_DURATION_SAMPLE_LIMIT = 2000

export async function summarizeSla(
  db: Db,
  asOf: Date,
  windowHours = DEFAULT_SLA_WINDOW_HOURS,
): Promise<MonitorSlaCard> {
  const { runs } = schemaFor(db)
  const since = new Date(asOf.getTime() - windowHours * 3600 * 1000)

  const [totals] = await db
    .select({
      total: sql`count(*)`,
      succeeded: sql`sum(case when ${runs.status} = 'SUCCEEDED' then 1 else 0 end)`,
      failed: sql`sum(case when ${runs.status} = 'FAILED' then 1 else 0 end)`,
    })
    .from(runs)
    .where(sql`${runs.createdAt} >= ${since}`)

  const totalRuns = Number(totals?.total ?? 0)
  const succeededRuns = Number(totals?.succeeded ?? 0)
  const failedRuns = Number(totals?.failed ?? 0)
  const successRate = totalRuns > 0 ? Math.round((succeededRuns / totalRuns) * 100) : 100

  // 计算已完成运行的 P95 耗时 (毫秒)
  const durationRows = await db
    .select({
      durationMs: sql`extract(epoch from (${runs.finishedAt} - ${runs.startedAt})) * 1000`,
    })
    .from(runs)
    .where(
      sql`${runs.createdAt} >= ${since} AND ${runs.finishedAt} IS NOT NULL AND ${runs.startedAt} IS NOT NULL`,
    )
    .orderBy(desc(runs.createdAt))
    .limit(1000)

  const durations = durationRows
    .map((r) => Number(r.durationMs))
    .filter((v) => Number.isFinite(v) && v >= 0)
  const p = durations.length > 0 ? percentile(durations, 95) : null
  const p95DurationMs = p != null ? Math.round(p) : null

  const windowMinutes = Math.max(1, windowHours * 60)
  const throughputRpm = Math.round((totalRuns / windowMinutes) * 100) / 100

  return {
    windowHours,
    totalRuns,
    succeededRuns,
    failedRuns,
    successRate,
    p95DurationMs,
    throughputRpm,
  }
}

export async function summarizeTargetSla(
  db: Db,
  asOf: Date,
  windowHours = DEFAULT_SLA_WINDOW_HOURS,
): Promise<MonitorTargetSlaItem[]> {
  const { targets, runs, targetAccounts, sessionOperations } = schemaFor(db)
  const since = new Date(asOf.getTime() - windowHours * 3600 * 1000)

  // 1. 获取所有有效目标
  const allTargets = await db
    .select({
      id: targets.id,
      name: targets.name,
    })
    .from(targets)
    .where(sql`${targets.deletedAt} IS NULL`)
    .orderBy(targets.name)

  if (allTargets.length === 0) return []

  // 2. 统计每个 Target 的运行量、成功率 (利用 runs_target_created_outcome_idx 索引)
  const runStats = await db
    .select({
      targetId: runs.targetId,
      total: sql`count(*)`,
      succeeded: sql`sum(case when ${runs.status} = 'SUCCEEDED' then 1 else 0 end)`,
      failed: sql`sum(case when ${runs.status} = 'FAILED' then 1 else 0 end)`,
    })
    .from(runs)
    .where(sql`${runs.createdAt} >= ${since}`)
    .groupBy(runs.targetId)

  const statsByTarget = new Map<string, (typeof runStats)[number]>()
  for (const s of runStats) {
    statsByTarget.set(s.targetId, s)
  }

  // P95 耗时按 Target 分组在应用层算（percentile_cont 是 PG 专有聚合函数，换库没有对应物）：
  // 抓一批最近完成的原始耗时样本，按 targetId 分桶后各自调用 percentile()。
  const durationRows = await db
    .select({
      targetId: runs.targetId,
      durationMs: sql`extract(epoch from (${runs.finishedAt} - ${runs.startedAt})) * 1000`,
    })
    .from(runs)
    .where(
      sql`${runs.createdAt} >= ${since} AND ${runs.finishedAt} IS NOT NULL AND ${runs.startedAt} IS NOT NULL`,
    )
    .orderBy(desc(runs.createdAt))
    .limit(TARGET_SLA_DURATION_SAMPLE_LIMIT)

  const durationsByTarget = new Map<string, number[]>()
  for (const row of durationRows) {
    const value = Number(row.durationMs)
    if (!Number.isFinite(value) || value < 0) continue
    const bucket = durationsByTarget.get(row.targetId) ?? []
    bucket.push(value)
    durationsByTarget.set(row.targetId, bucket)
  }

  // 3. 统计每个 Target 的账号健康度 (活跃/总数)
  const accountStats = await db
    .select({
      targetId: targetAccounts.targetId,
      totalAccounts: sql`count(*)`,
      activeAccounts: sql`sum(case when ${targetAccounts.status} = 'active' then 1 else 0 end)`,
    })
    .from(targetAccounts)
    .where(sql`${targetAccounts.deletedAt} IS NULL`)
    .groupBy(targetAccounts.targetId)

  const accountsByTarget = new Map<string, (typeof accountStats)[number]>()
  for (const a of accountStats) {
    accountsByTarget.set(a.targetId, a)
  }

  // 4. 统计每个 Target 近窗口内被验证码/风控拦截的登录次数
  //    kindParams.captchaPhase 只在 recordCaptchaLoginAttempt() 真正遇到验证码时才写入，
  //    普通登录不会带这个字段，因此可以据此区分"被拦截"与"正常登录"。
  const captchaStats = await db
    .select({
      targetId: sessionOperations.targetId,
      intercepts: sql`count(*)`,
    })
    .from(sessionOperations)
    .where(
      sql`${sessionOperations.kind} = 'LOGIN'
        AND ${sessionOperations.createdAt} >= ${since}
        AND ${jsonHasKey(db, sessionOperations.kindParams, 'captchaPhase')}`,
    )
    .groupBy(sessionOperations.targetId)

  const captchaByTarget = new Map<string, number>()
  for (const c of captchaStats) {
    captchaByTarget.set(c.targetId, Number(c.intercepts ?? 0))
  }

  return allTargets.map((t) => {
    const s = statsByTarget.get(t.id)
    const a = accountsByTarget.get(t.id)

    const totalRuns = Number(s?.total ?? 0)
    const succeededRuns = Number(s?.succeeded ?? 0)
    const failedRuns = Number(s?.failed ?? 0)
    const successRate = totalRuns > 0 ? Math.round((succeededRuns / totalRuns) * 100) : 100
    const targetDurations = durationsByTarget.get(t.id) ?? []
    const p95Raw = targetDurations.length > 0 ? percentile(targetDurations, 95) : null
    const p95Duration = p95Raw != null ? Math.round(p95Raw) : null

    return {
      targetId: t.id,
      targetName: t.name,
      totalRuns,
      successRate,
      failedRuns,
      p95DurationMs: p95Duration,
      activeAccounts: Number(a?.activeAccounts ?? 0),
      totalAccounts: Number(a?.totalAccounts ?? 0),
      captchaIntercepts: captchaByTarget.get(t.id) ?? 0,
    }
  })
}
