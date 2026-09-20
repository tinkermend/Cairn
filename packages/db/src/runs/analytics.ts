import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  percentile,
  type OverviewAnalyticsQueryParsed,
  type OverviewAnalyticsResponse,
  type ScenarioRankingItem,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, schemaFor } from '../native.js'

export async function readOverviewAnalytics(
  db: Db,
  query: OverviewAnalyticsQueryParsed,
): Promise<OverviewAnalyticsResponse> {
  const asOf = await clockNow(db)
  const range = query.range ?? '7d'

  // 确定查询窗口与分桶周期
  const rangeMs =
    range === '24h' ? 24 * 3600 * 1000 : range === '30d' ? 30 * 86400 * 1000 : 7 * 86400 * 1000
  const intervalMs = range === '24h' ? 3600 * 1000 : 86400 * 1000
  const since = new Date(asOf.getTime() - rangeMs)
  const prevSince = new Date(since.getTime() - rangeMs)

  const { runs, scenarios, targets } = schemaFor(db)

  // 1. 查询当前窗口运行记录
  const conditions = [
    sql`${runs.createdAt} >= ${since}`,
    sql`${runs.createdAt} <= ${asOf}`,
    isNull(runs.deletedAt),
  ]
  if (query.targetId) {
    conditions.push(eq(runs.targetId, query.targetId))
  }

  const [currentRuns, prevTotals] = await Promise.all([
    db
      .select({
        id: runs.id,
        scenarioId: runs.scenarioId,
        targetId: runs.targetId,
        status: runs.status,
        outcomeStatus: runs.outcomeStatus,
        executionOrigin: runs.executionOrigin,
        serviceCallerId: runs.serviceCallerId,
        createdByConsoleAccountId: runs.createdByConsoleAccountId,
        createdAt: runs.createdAt,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
      })
      .from(runs)
      .where(and(...conditions))
      .orderBy(desc(runs.createdAt))
      .limit(10000),

    // 2. 查询上一周期总量与成功数用于环比
    db
      .select({
        total: sql<number>`count(*)`,
        succeeded: sql<number>`sum(case when UPPER(${runs.status}) = 'SUCCEEDED' then 1 else 0 end)`,
      })
      .from(runs)
      .where(
        and(
          sql`${runs.createdAt} >= ${prevSince}`,
          sql`${runs.createdAt} < ${since}`,
          isNull(runs.deletedAt),
          query.targetId ? eq(runs.targetId, query.targetId) : undefined,
        ),
      ),
  ])

  // 3. 构建连续无断层的时序桶
  const bucketMap = new Map<
    number,
    {
      bucketAt: string
      total: number
      succeeded: number
      failed: number
      timedOut: number
      canceled: number
      running: number
      durations: number[]
    }
  >()

  const startBucket = Math.floor(since.getTime() / intervalMs) * intervalMs
  const endBucket = Math.floor(asOf.getTime() / intervalMs) * intervalMs

  for (let b = startBucket; b <= endBucket; b += intervalMs) {
    bucketMap.set(b, {
      bucketAt: new Date(b).toISOString(),
      total: 0,
      succeeded: 0,
      failed: 0,
      timedOut: 0,
      canceled: 0,
      running: 0,
      durations: [],
    })
  }

  // 4. 统计汇总数据
  let totalRuns = 0
  let succeededRuns = 0
  let failedRuns = 0
  let timedOutRuns = 0
  let canceledRuns = 0
  let runningRuns = 0
  let pendingRuns = 0

  const allDurations: number[] = []

  const outcomes = {
    passed: 0,
    violation: 0,
    failed: 0,
    notEvaluated: 0,
  }

  const triggers = {
    manual: 0,
    schedule: 0,
    serviceApi: 0,
    suiteMember: 0,
  }

  // 场景统计
  const scenarioStats = new Map<
    string,
    {
      scenarioId: string
      targetId: string
      total: number
      failed: number
      succeeded: number
    }
  >()

  for (const row of currentRuns) {
    totalRuns++
    const createdTime = new Date(row.createdAt).getTime()
    const bucketKey = Math.floor(createdTime / intervalMs) * intervalMs
    const bucket = bucketMap.get(bucketKey)

    // 状态归集
    const st = (row.status ?? '').toUpperCase()
    switch (st) {
      case 'SUCCEEDED':
        succeededRuns++
        if (bucket) bucket.succeeded++
        break
      case 'FAILED':
        failedRuns++
        if (bucket) bucket.failed++
        break
      case 'CANCELLED':
      case 'CANCELED':
        canceledRuns++
        if (bucket) bucket.canceled++
        break
      case 'RUNNING':
      case 'HOLDING':
      case 'RECOVERING':
      case 'WAITING_FOR_AUTH':
        runningRuns++
        if (bucket) bucket.running++
        break
      case 'QUEUED':
      case 'PENDING':
        pendingRuns++
        break
    }
    if (bucket) bucket.total++

    // 耗时归集
    if (row.startedAt && row.finishedAt) {
      const dur = Math.max(0, new Date(row.finishedAt).getTime() - new Date(row.startedAt).getTime())
      allDurations.push(dur)
      if (bucket) bucket.durations.push(dur)
    }

    // 成果归集
    switch (row.outcomeStatus) {
      case 'PASS':
        outcomes.passed++
        break
      case 'WARN':
        outcomes.violation++
        break
      case 'FAIL':
        outcomes.failed++
        break
      default:
        outcomes.notEvaluated++
        break
    }

    // 触发渠道归集
    if (row.serviceCallerId) {
      triggers.serviceApi++
    } else if (row.executionOrigin === 'suite_member') {
      triggers.suiteMember++
    } else if (row.createdByConsoleAccountId) {
      triggers.manual++
    } else {
      triggers.schedule++
    }

    // 场景排行统计
    if (row.scenarioId) {
      const stat = scenarioStats.get(row.scenarioId) ?? {
        scenarioId: row.scenarioId,
        targetId: row.targetId,
        total: 0,
        failed: 0,
        succeeded: 0,
      }
      stat.total++
      if (st === 'SUCCEEDED') stat.succeeded++
      if (st === 'FAILED') stat.failed++
      scenarioStats.set(row.scenarioId, stat)
    }
  }

  // 5. 格式化时序点
  const timeline = Array.from(bucketMap.values()).map((b) => {
    const finishedCount = b.succeeded + b.failed + b.timedOut + b.canceled
    const rate = finishedCount > 0 ? b.succeeded / finishedCount : b.total > 0 ? b.succeeded / b.total : 1.0
    return {
      bucketAt: b.bucketAt,
      total: b.total,
      succeeded: b.succeeded,
      failed: b.failed,
      timedOut: b.timedOut,
      canceled: b.canceled,
      running: b.running,
      successRate: Math.round(rate * 1000) / 1000,
      p95DurationMs: b.durations.length ? percentile(b.durations, 95) : null,
    }
  })

  // 6. 计算环比
  const prevTotal = Number(prevTotals[0]?.total ?? 0)
  const prevSucceeded = Number(prevTotals[0]?.succeeded ?? 0)

  const finishedTotal = succeededRuns + failedRuns + timedOutRuns + canceledRuns
  const successRate =
    finishedTotal > 0 ? succeededRuns / finishedTotal : totalRuns > 0 ? succeededRuns / totalRuns : 1.0

  let runsDeltaPercentage: number | null = null
  let successRateDeltaPercentage: number | null = null

  if (prevTotal > 0) {
    runsDeltaPercentage = Math.round(((totalRuns - prevTotal) / prevTotal) * 1000) / 10
    const prevRate = prevTotal > 0 ? prevSucceeded / prevTotal : 1.0
    successRateDeltaPercentage = Math.round((successRate - prevRate) * 1000) / 10
  }

  const avgDurationMs = allDurations.length
    ? Math.round(allDurations.reduce((sum, d) => sum + d, 0) / allDurations.length)
    : null
  const p95DurationMs = allDurations.length ? percentile(allDurations, 95) : null

  // 7. 装配 Top 场景名称与目标系统名称
  const sortedByVolume = Array.from(scenarioStats.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)

  const sortedByTrouble = Array.from(scenarioStats.values())
    .filter((s) => s.failed > 0)
    .sort((a, b) => b.failed / b.total - a.failed / a.total || b.failed - a.failed)
    .slice(0, 5)

  const distinctScenarioIds = Array.from(
    new Set([...sortedByVolume.map((s) => s.scenarioId), ...sortedByTrouble.map((s) => s.scenarioId)]),
  )

  const scenarioMetaMap = new Map<string, { scenarioName: string; targetName: string; targetId: string }>()

  if (distinctScenarioIds.length > 0) {
    const metaRows = await db
      .select({
        scenarioId: scenarios.id,
        scenarioName: scenarios.name,
        targetId: targets.id,
        targetName: targets.name,
      })
      .from(scenarios)
      .leftJoin(targets, eq(scenarios.targetId, targets.id))
      .where(inArray(scenarios.id, distinctScenarioIds))

    for (const row of metaRows) {
      scenarioMetaMap.set(row.scenarioId, {
        scenarioName: row.scenarioName,
        targetName: row.targetName ?? '未知目标系统',
        targetId: row.targetId ?? '',
      })
    }
  }

  const mapToRankingItem = (stat: {
    scenarioId: string
    targetId: string
    total: number
    failed: number
    succeeded: number
  }): ScenarioRankingItem => {
    const meta = scenarioMetaMap.get(stat.scenarioId)
    const rate = stat.total > 0 ? stat.succeeded / stat.total : 1.0
    return {
      scenarioId: stat.scenarioId,
      scenarioName: meta?.scenarioName ?? stat.scenarioId,
      targetId: meta?.targetId ?? stat.targetId,
      targetName: meta?.targetName ?? '未知系统',
      runCount: stat.total,
      failCount: stat.failed,
      successRate: Math.round(rate * 1000) / 1000,
    }
  }

  return {
    asOf: asOf.toISOString(),
    range,
    summary: {
      totalRuns,
      succeededRuns,
      failedRuns,
      timedOutRuns,
      canceledRuns,
      runningRuns,
      pendingRuns,
      successRate: Math.round(successRate * 1000) / 1000,
      avgDurationMs,
      p95DurationMs,
      runsDeltaPercentage,
      successRateDeltaPercentage,
    },
    timeline,
    outcomes,
    triggers,
    topScenarios: sortedByVolume.map(mapToRankingItem),
    troubledScenarios: sortedByTrouble.map(mapToRankingItem),
  }
}
