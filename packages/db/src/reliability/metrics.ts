import { and, desc, eq, sql } from 'drizzle-orm'
import {
  type AssetReliabilityItemDto,
  type AssetReliabilityListResponse,
  type AssetReliabilityQuery,
  type FeatureWindowDto,
  type IncidentSeverity,
  type IncidentStatus,
  type ReliabilityEvaluationDto,
  type WatermarkVector,
} from '@cairn/shared'
import type { Db } from '../client.js'
import {
  assertTargetPermission,
  intersectTargetScopes,
  loadAccountGrants,
  scopeFromGrants,
  targetScopeFilter,
} from '../console/target-authorization.js'
import { schemaFor } from '../native.js'

export interface ReliabilityOverview {
  targetId: string
  activeIncidentsCount: number
  incidentsByStatus: Record<string, number>
  incidentsBySeverity: Record<string, number>
  latestWindows: FeatureWindowDto[]
  watermarkVector: WatermarkVector | null
  latestEvaluation: ReliabilityEvaluationDto | null
}

export async function getReliabilityOverview(
  db: Db,
  targetId: string,
  actorId?: string,
): Promise<ReliabilityOverview> {
  if (actorId) await assertTargetPermission(db, actorId, targetId, 'reliability:read')
  const { reliabilityIncidents, featureWindows, reliabilityCheckpoints, reliabilityEvaluations } = schemaFor(db)

  // Incident counts
  const incidentRows = await db
    .select({
      status: reliabilityIncidents.status,
      severity: reliabilityIncidents.severity,
      count: sql<number>`count(*)`,
    })
    .from(reliabilityIncidents)
    .where(
      and(
        eq(reliabilityIncidents.targetId, targetId),
        sql`${reliabilityIncidents.status} NOT IN ('RESOLVED', 'DISMISSED')`,
      ),
    )
    .groupBy(reliabilityIncidents.status, reliabilityIncidents.severity)

  const incidentsByStatus: Record<string, number> = {}
  const incidentsBySeverity: Record<string, number> = {}
  let activeIncidentsCount = 0

  for (const r of incidentRows) {
    const c = Number(r.count)
    activeIncidentsCount += c
    incidentsByStatus[r.status] = (incidentsByStatus[r.status] ?? 0) + c
    incidentsBySeverity[r.severity] = (incidentsBySeverity[r.severity] ?? 0) + c
  }

  // Latest feature windows
  const windowRows = await db
    .select()
    .from(featureWindows)
    .where(eq(featureWindows.targetId, targetId))
    .orderBy(desc(featureWindows.windowEnd))
    .limit(10)

  const latestWindows: FeatureWindowDto[] = windowRows.map((w) => ({
    id: w.id,
    targetId: w.targetId,
    scopeDigest: w.scopeDigest,
    windowType: w.windowType as any,
    windowStart: w.windowStart.toISOString(),
    windowEnd: w.windowEnd.toISOString(),
    metricVersion: w.metricVersion,
    sampleCount: w.sampleCount,
    primaryHitCount: w.primaryHitCount,
    fallbackCount: w.fallbackCount,
    retryStepCount: w.retryStepCount,
    ewmaLatencyMs: w.ewmaLatencyMs,
    ewmaSuccessRate: w.ewmaSuccessRate,
    stats: w.stats as any,
    updatedAt: w.updatedAt.toISOString(),
  }))

  const [checkpoint] = await db
    .select({ watermarkVector: reliabilityCheckpoints.watermarkVector })
    .from(reliabilityCheckpoints)
    .where(eq(reliabilityCheckpoints.targetId, targetId))

  const [evalRow] = await db
    .select()
    .from(reliabilityEvaluations)
    .where(eq(reliabilityEvaluations.targetId, targetId))
    .orderBy(desc(reliabilityEvaluations.createdAt))
    .limit(1)

  const latestEvaluation: ReliabilityEvaluationDto | null = evalRow
    ? {
        id: evalRow.id,
        targetId: evalRow.targetId,
        scopeDigest: evalRow.scopeDigest,
        watermarkVector: evalRow.watermarkVector,
        generation: evalRow.generation,
        rulesEvaluated: evalRow.rulesEvaluated,
        breachesCount: evalRow.breachesCount,
        result: evalRow.result as any,
        coverageGaps: evalRow.coverageGaps as any,
        createdAt: evalRow.createdAt.toISOString(),
      }
    : null

  return {
    targetId,
    activeIncidentsCount,
    incidentsByStatus,
    incidentsBySeverity,
    latestWindows,
    watermarkVector: checkpoint?.watermarkVector ?? null,
    latestEvaluation,
  }
}

export async function listAssetReliabilityItems(
  db: Db,
  query: AssetReliabilityQuery,
  actorId?: string,
): Promise<AssetReliabilityListResponse> {
  const { scenarios, actionModules, targets, featureWindows, reliabilityIncidents } = schemaFor(db)
  const limit = Math.min(query.limit ?? 20, 100)
  const grants = actorId ? await loadAccountGrants(db, actorId) : undefined
  const scope = grants
    ? intersectTargetScopes(scopeFromGrants(grants, 'target:read'), scopeFromGrants(grants, 'reliability:read'))
    : undefined

  // 1. Target names lookup
  const targetRows = await db
    .select({ id: targets.id, name: targets.name })
    .from(targets)
    .where(and(query.targetId ? eq(targets.id, query.targetId) : undefined, scope && targetScopeFilter(targets.id, scope)))

  const targetMap = new Map<string, string>()
  for (const t of targetRows) {
    targetMap.set(t.id, t.name)
  }

  // 2. Fetch scenarios
  const scenarioItems: {
    assetId: string
    assetType: 'scenario'
    assetName: string
    targetId: string
    targetName: string
  }[] = []

  if (!query.assetType || query.assetType === 'scenario') {
    const sRows = await db
      .select({ id: scenarios.id, name: scenarios.name, targetId: scenarios.targetId })
      .from(scenarios)
      .where(
        and(
          sql`${scenarios.deletedAt} IS NULL`,
          query.targetId ? eq(scenarios.targetId, query.targetId) : undefined,
          scope && targetScopeFilter(scenarios.targetId, scope),
          query.search ? sql`${scenarios.name} LIKE ${'%' + query.search + '%'}` : sql`1=1`,
        ),
      )

    for (const s of sRows) {
      scenarioItems.push({
        assetId: s.id,
        assetType: 'scenario',
        assetName: s.name,
        targetId: s.targetId,
        targetName: targetMap.get(s.targetId) ?? '未知目标',
      })
    }
  }

  // 3. Fetch action modules
  const moduleItems: {
    assetId: string
    assetType: 'action_module'
    assetName: string
    targetId: string
    targetName: string
  }[] = []

  if (!query.assetType || query.assetType === 'action_module') {
    const mRows = await db
      .select({ id: actionModules.id, name: actionModules.name, key: actionModules.key, targetId: actionModules.targetId })
      .from(actionModules)
      .where(
        and(
          sql`${actionModules.deletedAt} IS NULL`,
          query.targetId ? eq(actionModules.targetId, query.targetId) : undefined,
          scope && targetScopeFilter(actionModules.targetId, scope),
          query.search
            ? sql`(${actionModules.name} LIKE ${'%' + query.search + '%'} OR ${actionModules.key} LIKE ${'%' + query.search + '%'})`
            : sql`1=1`,
        ),
      )

    for (const m of mRows) {
      moduleItems.push({
        assetId: m.id,
        assetType: 'action_module',
        assetName: m.name,
        targetId: m.targetId,
        targetName: targetMap.get(m.targetId) ?? '未知目标',
      })
    }
  }

  const allAssets = [...scenarioItems, ...moduleItems]
  if (allAssets.length === 0) {
    return { items: [], nextCursor: null, total: 0 }
  }

  // 4. Fetch active incidents
  const activeIncidents = await db
    .select({
      id: reliabilityIncidents.id,
      targetId: reliabilityIncidents.targetId,
      groupingKey: reliabilityIncidents.groupingKey,
      severity: reliabilityIncidents.severity,
      lineage: reliabilityIncidents.lineage,
    })
    .from(reliabilityIncidents)
    .where(
      and(
        query.targetId ? eq(reliabilityIncidents.targetId, query.targetId) : undefined,
        scope && targetScopeFilter(reliabilityIncidents.targetId, scope),
        sql`${reliabilityIncidents.status} NOT IN ('RESOLVED', 'DISMISSED')`,
      ),
    )

  // 5. Fetch recent feature windows
  const recentWindows = await db
    .select()
    .from(featureWindows)
    .where(and(query.targetId ? eq(featureWindows.targetId, query.targetId) : undefined, scope && targetScopeFilter(featureWindows.targetId, scope)))
    .orderBy(desc(featureWindows.windowEnd))
    .limit(200)

  const windowByTarget = new Map<string, typeof recentWindows[0]>()
  for (const w of recentWindows) {
    if (!windowByTarget.has(w.targetId)) {
      windowByTarget.set(w.targetId, w)
    }
  }

  const nowStr = new Date().toISOString()
  const severityRank: Record<string, number> = { P1: 4, P2: 3, P3: 2, P4: 1 }

  let combined: AssetReliabilityItemDto[] = allAssets.map((asset) => {
    const matchingIncidents = activeIncidents.filter((inc) => {
      if (inc.targetId !== asset.targetId) return false
      if (inc.groupingKey && inc.groupingKey.includes(asset.assetId)) return true
      return false
    })

    let highestSeverity: IncidentSeverity | null = null
    let maxRank = 0
    for (const inc of matchingIncidents) {
      const rank = severityRank[inc.severity] ?? 0
      if (rank > maxRank) {
        maxRank = rank
        highestSeverity = inc.severity as IncidentSeverity
      }
    }

    const targetWin = windowByTarget.get(asset.targetId)
    const sampleCount = targetWin?.sampleCount ?? 0
    const ewmaSuccessRate = targetWin && targetWin.sampleCount > 0 ? (targetWin.ewmaSuccessRate ?? null) : null
    const p95DurationMs = targetWin && targetWin.sampleCount > 0 ? (((targetWin.stats as any)?.p95LatencyMs as number | undefined) ?? (targetWin.ewmaLatencyMs || null)) : null
    const lastEvaluatedAt = targetWin?.windowEnd?.toISOString() ?? nowStr

    let status: 'healthy' | 'degraded' | 'insufficient_data' = 'healthy'
    if (matchingIncidents.length > 0 || (ewmaSuccessRate !== null && ewmaSuccessRate < 0.85)) {
      status = 'degraded'
    } else if (sampleCount < 5) {
      status = 'insufficient_data'
    }

    return {
      assetId: asset.assetId,
      assetType: asset.assetType,
      assetName: asset.assetName,
      targetId: asset.targetId,
      targetName: asset.targetName,
      sampleCount,
      ewmaSuccessRate,
      p95DurationMs,
      activeIncidentsCount: matchingIncidents.length,
      highestSeverity,
      lastEvaluatedAt,
      status,
    }
  })

  if (query.status) {
    combined = combined.filter((item) => item.status === query.status)
  }

  combined.sort((a, b) => {
    if (a.activeIncidentsCount !== b.activeIncidentsCount) {
      return b.activeIncidentsCount - a.activeIncidentsCount
    }
    if (a.status === 'degraded' && b.status !== 'degraded') return -1
    if (b.status === 'degraded' && a.status !== 'degraded') return 1
    return a.assetName.localeCompare(b.assetName)
  })

  const total = combined.length
  let startIndex = 0
  if (query.cursor) {
    const idx = combined.findIndex((c) => c.assetId === query.cursor)
    if (idx >= 0) {
      startIndex = idx + 1
    }
  }
  const sliced = combined.slice(startIndex, startIndex + limit)
  const lastSlice = sliced[sliced.length - 1]
  const nextCursor = startIndex + limit < combined.length && lastSlice ? lastSlice.assetId : null

  return {
    items: sliced,
    nextCursor,
    total,
  }
}

