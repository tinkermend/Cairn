import {
  MODULE_INVOCATION_PROJECTOR_VERSION,
  classifyModuleRunKind,
  deriveInvocationResults,
  evaluateModuleHealth,
  isExcludedFromFormalStats,
  isFormalModuleRunKind,
  isHaltedRunStatus,
  moduleInvocationListQuerySchema,
  moduleInvocationListResponseSchema,
  moduleQualityQuerySchema,
  moduleQualityResponseSchema,
  moduleQualityStatsSchema,
  passRateBucket,
  percentile,
  runHrefForInvocation,
  type ActionModuleSummary,
  type ModuleContent,
  type ModuleHealthSummary,
  type ModuleInvocationListQuery,
  type ModuleInvocationListResponse,
  type ModuleInvocationResult,
  type ModuleQualityQuery,
  type ModuleQualityResponse,
  type ModuleQualityStats,
  type PlatformModuleQuality,
  type RunSnapshot,
} from '@cairn/shared'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, schemaFor } from '../native.js'
import { getOrCreatePlatformConfig } from '../platform-config/store.js'
import { notFound, unavailable } from '../runs/errors.js'

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function countManual(content: ModuleContent | null | undefined): number {
  return (content?.contract.postconditions ?? []).filter((item) => item.verification.kind === 'manual_requirement').length
}

function asResult(row: {
  runId: string
  invocationId: string
  projectorVersion: number
  moduleId: string
  moduleVersionId: string | null
  moduleDraftRevision: number | null
  runKind: ModuleInvocationResult['runKind']
  targetId: string
  targetAccountId: string | null
  outcome: ModuleInvocationResult['outcome']
  attribution: ModuleInvocationResult['attribution']
  failedExpandedStepId: string | null
  errorCategory: string | null
  errorCode: string | null
  manualRequirementsUnverified: number
  verificationStrength: ModuleInvocationResult['verificationStrength']
  retriedSuccess: number
  startedAt: Date | null
  finishedAt: Date | null
  durationMs: number | null
  aiCalls: number
  aiCost: string | number | null
  sourceRunEventSeq: number
}): ModuleInvocationResult {
  return {
    runId: row.runId,
    invocationId: row.invocationId,
    projectorVersion: row.projectorVersion,
    moduleId: row.moduleId,
    ...(row.moduleVersionId ? { moduleVersionId: row.moduleVersionId } : {}),
    ...(row.moduleDraftRevision !== null && row.moduleDraftRevision !== undefined
      ? { moduleDraftRevision: row.moduleDraftRevision }
      : {}),
    runKind: row.runKind,
    targetId: row.targetId,
    ...(row.targetAccountId ? { targetAccountId: row.targetAccountId } : {}),
    outcome: row.outcome,
    attribution: row.attribution,
    ...(row.failedExpandedStepId ? { failedExpandedStepId: row.failedExpandedStepId } : {}),
    ...(row.errorCategory ? { errorCategory: row.errorCategory } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    manualRequirementsUnverified: row.manualRequirementsUnverified,
    verificationStrength: row.verificationStrength,
    retriedSuccess: row.retriedSuccess === 1,
    ...(iso(row.startedAt) ? { startedAt: iso(row.startedAt) } : {}),
    ...(iso(row.finishedAt) ? { finishedAt: iso(row.finishedAt) } : {}),
    ...(row.durationMs !== null && row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
    aiCalls: row.aiCalls,
    ...(row.aiCost !== null && row.aiCost !== undefined && row.aiCost !== ''
      ? { aiCost: typeof row.aiCost === 'number' ? row.aiCost : Number(row.aiCost) }
      : {}),
    sourceRunEventSeq: row.sourceRunEventSeq,
  }
}

function withSnapshotMeta(result: ModuleInvocationResult, snapshot: RunSnapshot | null | undefined): ModuleInvocationResult {
  const entry = snapshot?.moduleManifest?.entries.find((item) => item.invocationId === result.invocationId)
  return {
    ...result,
    ...(entry?.implementationKey ? { implementationKey: entry.implementationKey } : {}),
  }
}

function valuesFromResult(result: ModuleInvocationResult, now: Date) {
  return {
    runId: result.runId,
    invocationId: result.invocationId,
    projectorVersion: result.projectorVersion,
    moduleId: result.moduleId,
    moduleVersionId: result.moduleVersionId ?? null,
    moduleDraftRevision: result.moduleDraftRevision ?? null,
    runKind: result.runKind,
    targetId: result.targetId,
    targetAccountId: result.targetAccountId ?? null,
    outcome: result.outcome,
    attribution: result.attribution,
    failedExpandedStepId: result.failedExpandedStepId ?? null,
    errorCategory: result.errorCategory ?? null,
    errorCode: result.errorCode ?? null,
    manualRequirementsUnverified: result.manualRequirementsUnverified,
    verificationStrength: result.verificationStrength,
    retriedSuccess: result.retriedSuccess ? 1 : 0,
    startedAt: result.startedAt ? new Date(result.startedAt) : null,
    finishedAt: result.finishedAt ? new Date(result.finishedAt) : null,
    durationMs: result.durationMs ?? null,
    aiCalls: result.aiCalls,
    aiCost: result.aiCost === undefined || result.aiCost === null ? null : String(result.aiCost),
    sourceRunEventSeq: result.sourceRunEventSeq,
    updatedAt: now,
  }
}

export async function requireModuleQualityConfig(db: Db): Promise<{
  config: PlatformModuleQuality
  revision: number
}> {
  const current = await getOrCreatePlatformConfig(db)
  if (!current?.document) throw unavailable('PLATFORM_CONFIG_UNAVAILABLE', '平台配置不可用')
  return { config: current.document.moduleQuality, revision: current.revision }
}

export async function projectModuleInvocationResults(
  db: Db,
  runId: string,
): Promise<{ projected: number; skipped: boolean }> {
  const { runs, scenarios, scenarioVersions, stepRuns, attempts, evidences, actionModules, actionModuleVersions } =
    schemaFor(db)
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1)
  if (!run) return { projected: 0, skipped: true }
  if (run.deletedAt || !isHaltedRunStatus(run.status)) return { projected: 0, skipped: true }
  const entries = run.snapshot.moduleManifest?.entries ?? []
  if (entries.length === 0) return { projected: 0, skipped: true }

  const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, run.scenarioId)).limit(1)
  const [version] = await db.select().from(scenarioVersions).where(eq(scenarioVersions.id, run.scenarioVersionId)).limit(1)
  const runKind = classifyModuleRunKind({
    scenarioPurpose: scenario?.purpose,
    versionKind: version?.kind,
    serviceCallerId: run.serviceCallerId,
  })

  const stepRows = await db.select().from(stepRuns).where(eq(stepRuns.runId, runId))
  const attemptRows = stepRows.length === 0
    ? []
    : await db.select().from(attempts).where(inArray(attempts.stepRunId, stepRows.map((item) => item.id)))
  const evidenceRows = await db.select().from(evidences).where(eq(evidences.runId, runId))
  const stepIdByRun = new Map(stepRows.map((item) => [item.id, item.stepId]))

  const versionIds = [...new Set(entries.map((item) => item.moduleVersionId).filter((item): item is string => Boolean(item)))]
  const moduleIds = [...new Set(entries.map((item) => item.moduleId))]
  const versionRows = versionIds.length === 0
    ? []
    : await db.select().from(actionModuleVersions).where(inArray(actionModuleVersions.id, versionIds))
  const moduleRows = await db.select().from(actionModules).where(inArray(actionModules.id, moduleIds))
  const contentByVersion = new Map(versionRows.map((item) => [item.id, item.content]))
  const draftByModule = new Map(moduleRows.map((item) => [item.id, item.draftContent]))
  const manualRequirementCounts: Record<string, number> = {}
  for (const entry of entries) {
    const content = entry.moduleVersionId
      ? contentByVersion.get(entry.moduleVersionId)
      : draftByModule.get(entry.moduleId)
    manualRequirementCounts[entry.invocationId] = countManual(content)
  }

  const derived = deriveInvocationResults({
    snapshot: run.snapshot,
    run: {
      status: run.status,
      eventSeq: run.eventSeq,
      runKind,
      context: run.context,
      authHint: {
        hadAuthWaitOrRecovery: Boolean(run.authCheckpoint),
        authStateExpired: run.authCheckpoint?.status === 'unrecoverable',
      },
    },
    stepRuns: stepRows.map((item) => ({
      stepId: item.stepId,
      status: item.status,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
    })),
    attempts: attemptRows.map((item) => ({
      stepId: stepIdByRun.get(item.stepRunId) ?? item.stepRunId,
      attemptNo: item.attemptNo,
      status: item.status,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      output: item.output,
      error: item.error && typeof item.error === 'object' ? item.error as { code?: string; category?: string } : null,
    })),
    evidences: evidenceRows.map((item) => ({
      stepId: item.stepRunId ? stepIdByRun.get(item.stepRunId) ?? null : null,
      type: item.type,
      payload: item.payload,
    })),
    manualRequirementCounts,
  })

  const { moduleInvocationResults } = schemaFor(db)
  const now = new Date()
  await atomic(db, async (tx) => {
    const { moduleInvocationResults: table } = schemaFor(tx)
    for (const result of derived) {
      const [existing] = await tx
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.runId, result.runId), eq(table.invocationId, result.invocationId)))
        .limit(1)
      const values = valuesFromResult(result, now)
      if (existing) {
        await tx.update(table).set(values).where(eq(table.id, existing.id))
      } else {
        await tx.insert(table).values({ id: newId(), ...values, createdAt: now })
      }
    }
  })
  void moduleInvocationResults
  return { projected: derived.length, skipped: false }
}

export async function backfillModuleInvocationResults(
  db: Db,
  input: { limit?: number } = {},
): Promise<{ scanned: number; projected: number }> {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100))
  const { runs, moduleInvocationResults } = schemaFor(db)
  const candidates = await db
    .select({
      id: runs.id,
      snapshot: runs.snapshot,
      eventSeq: runs.eventSeq,
      status: runs.status,
    })
    .from(runs)
    .where(and(
      isNull(runs.deletedAt),
      inArray(runs.status, ['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW']),
    ))
    .orderBy(asc(runs.updatedAt), asc(runs.id))
    .limit(limit * 5)

  let projected = 0
  let scanned = 0
  for (const row of candidates) {
    const entries = row.snapshot.moduleManifest?.entries ?? []
    if (entries.length === 0) continue
    scanned += 1
    const existing = await db
      .select({
        invocationId: moduleInvocationResults.invocationId,
        sourceRunEventSeq: moduleInvocationResults.sourceRunEventSeq,
        projectorVersion: moduleInvocationResults.projectorVersion,
      })
      .from(moduleInvocationResults)
      .where(eq(moduleInvocationResults.runId, row.id))
    const stale =
      existing.length !== entries.length ||
      existing.some((item) => item.sourceRunEventSeq < row.eventSeq || item.projectorVersion !== MODULE_INVOCATION_PROJECTOR_VERSION)
    if (!stale) continue
    const result = await projectModuleInvocationResults(db, row.id)
    if (result.projected > 0) projected += result.projected
    if (projected >= limit) break
  }
  return { scanned, projected }
}

function emptyStats(accountId?: string | null): ModuleQualityStats {
  return moduleQualityStatsSchema.parse({
    ...(accountId ? { targetAccountId: accountId } : {}),
    calls: 0,
    verified: 0,
    failedImplementation: 0,
    failedVerification: 0,
    externalInfra: 0,
    needsReview: 0,
    notReached: 0,
    cancelled: 0,
    unknown: 0,
    insufficient: 0,
    retriedSuccess: 0,
    sampleCount: 0,
    verifiedRate: null,
    durationMsP50: null,
    durationMsP95: null,
    aiCalls: 0,
    aiCost: null,
    lastVerifiedAt: null,
  })
}

function aggregateStats(
  rows: ModuleInvocationResult[],
  accountId?: string | null,
): ModuleQualityStats {
  const stats = emptyStats(accountId)
  const durations: number[] = []
  let cost: number | null = null
  let lastVerified: string | null = null
  let numerator = 0
  let denominator = 0
  for (const row of rows) {
    stats.calls += 1
    stats.aiCalls += row.aiCalls
    if (typeof row.aiCost === 'number') cost = (cost ?? 0) + row.aiCost
    if (typeof row.durationMs === 'number') durations.push(row.durationMs)
    if (row.retriedSuccess) stats.retriedSuccess += 1
    if (row.verificationStrength === 'insufficient') stats.insufficient += 1
    if (row.outcome === 'VERIFIED') {
      stats.verified += 1
      if (row.finishedAt && (!lastVerified || row.finishedAt > lastVerified)) lastVerified = row.finishedAt
    }
    if (row.outcome === 'FAILED_IMPLEMENTATION') stats.failedImplementation += 1
    if (row.outcome === 'FAILED_VERIFICATION') stats.failedVerification += 1
    if (row.attribution === 'EXTERNAL_INFRA') stats.externalInfra += 1
    if (row.outcome === 'NEEDS_REVIEW') stats.needsReview += 1
    if (row.outcome === 'NOT_REACHED') stats.notReached += 1
    if (row.outcome === 'CANCELLED') stats.cancelled += 1
    if (row.outcome === 'UNKNOWN') stats.unknown += 1
    const bucket = passRateBucket(row)
    if (bucket === 'numerator') {
      numerator += 1
      denominator += 1
    } else if (bucket === 'denominator') {
      denominator += 1
    }
  }
  stats.sampleCount = denominator
  stats.verifiedRate = denominator === 0 ? null : numerator / denominator
  stats.durationMsP50 = percentile(durations, 50)
  stats.durationMsP95 = percentile(durations, 95)
  stats.aiCost = cost
  stats.lastVerifiedAt = lastVerified
  return moduleQualityStatsSchema.parse(stats)
}

function inWindow(row: { finishedAt: Date | null }, since: Date): boolean {
  if (!row.finishedAt) return true
  return row.finishedAt.getTime() >= since.getTime()
}

function recentFailureStreak(rows: ModuleInvocationResult[]): number {
  const ordered = [...rows].sort((a, b) => String(b.finishedAt ?? '').localeCompare(String(a.finishedAt ?? '')))
  let streak = 0
  for (const row of ordered) {
    if (passRateBucket(row) === 'denominator') streak += 1
    else if (passRateBucket(row) === 'numerator') break
  }
  return streak
}

async function loadModuleOrThrow(db: Db, moduleId: string) {
  const { actionModules } = schemaFor(db)
  const [module] = await db
    .select({ id: actionModules.id })
    .from(actionModules)
    .where(and(eq(actionModules.id, moduleId), isNull(actionModules.deletedAt)))
    .limit(1)
  if (!module) throw notFound('MODULE_NOT_FOUND', '动作模块不存在')
}

async function loadQualityRows(
  db: Db,
  moduleId: string,
  versionId: string | undefined,
  since: Date,
): Promise<ModuleInvocationResult[]> {
  const { moduleInvocationResults, runs } = schemaFor(db)
  const conditions = [
    eq(moduleInvocationResults.moduleId, moduleId),
    eq(moduleInvocationResults.projectorVersion, MODULE_INVOCATION_PROJECTOR_VERSION),
    isNull(runs.deletedAt),
  ]
  if (versionId) conditions.push(eq(moduleInvocationResults.moduleVersionId, versionId))
  const rows = await db
    .select({ result: moduleInvocationResults, deletedAt: runs.deletedAt, runFinishedAt: runs.finishedAt, snapshot: runs.snapshot })
    .from(moduleInvocationResults)
    .innerJoin(runs, eq(runs.id, moduleInvocationResults.runId))
    .where(and(...conditions))
    .orderBy(desc(moduleInvocationResults.finishedAt), desc(moduleInvocationResults.id))
  return rows
    .filter((item) => inWindow(item.result, since) && !isExcludedFromFormalStats(item.result.runKind))
    .map((item) => withSnapshotMeta(asResult(item.result), item.snapshot))
}

export async function getActionModuleQuality(
  db: Db,
  moduleId: string,
  query: ModuleQualityQuery = {},
): Promise<ModuleQualityResponse> {
  await loadModuleOrThrow(db, moduleId)
  const parsed = moduleQualityQuerySchema.parse(query)
  const { config, revision } = await requireModuleQualityConfig(db)
  const windowDays = parsed.window ?? config.windowDays
  const since = new Date(Date.now() - windowDays * 86_400_000)
  const asOf = new Date().toISOString()
  const rows = await loadQualityRows(db, moduleId, parsed.versionId, since)
  const official = rows.filter((item) => isFormalModuleRunKind(item.runKind))
  const trial = aggregateStats(rows.filter((item) => item.runKind === 'trial'))
  const overall = aggregateStats(official)
  const health = evaluateModuleHealth({
    sampleCount: overall.sampleCount,
    verifiedRate: overall.verifiedRate,
    recentFailureStreak: recentFailureStreak(official),
    verificationInsufficient: official.length > 0 && official.every((item) => item.verificationStrength === 'insufficient'),
    windowDays,
    configRevision: revision,
    config,
    asOf,
  })
  const pending = await backfillPendingCount(db)
  const response: ModuleQualityResponse = {
    moduleId,
    versionId: parsed.versionId ?? null,
    windowDays,
    groupBy: parsed.groupBy ?? 'none',
    asOf,
    configRevision: revision,
    health,
    overall,
    trial,
    pendingBackfill: pending,
  }
  const byImpl = new Map<string, ModuleInvocationResult[]>()
  let fallbackOccurred = 0
  let fallbackSucceeded = 0
  for (const row of official) {
    if (row.implementationKey) {
      const list = byImpl.get(row.implementationKey) ?? []
      list.push(row)
      byImpl.set(row.implementationKey, list)
    }
    if (row.fallbackUsed) {
      fallbackOccurred += 1
      if (row.outcome === 'VERIFIED') fallbackSucceeded += 1
    }
  }
  if (byImpl.size > 1) {
    response.implementations = [...byImpl.entries()].map(([implementationKey, items]) => ({
      ...aggregateStats(items),
      implementationKey,
    }))
  }
  if (fallbackOccurred > 0) {
    response.fallback = { occurred: fallbackOccurred, succeeded: fallbackSucceeded }
  }
  if (parsed.groupBy === 'account') {
    const byAccount = new Map<string, ModuleInvocationResult[]>()
    for (const row of official) {
      const key = row.targetAccountId ?? 'none'
      const list = byAccount.get(key) ?? []
      list.push(row)
      byAccount.set(key, list)
    }
    response.accounts = [...byAccount.entries()].map(([key, items]) =>
      aggregateStats(items, key === 'none' ? null : key),
    )
  }
  return moduleQualityResponseSchema.parse(response)
}

async function backfillPendingCount(db: Db): Promise<number> {
  const { runs, moduleInvocationResults } = schemaFor(db)
  const halted = await db
    .select({ id: runs.id, snapshot: runs.snapshot, eventSeq: runs.eventSeq })
    .from(runs)
    .where(and(
      isNull(runs.deletedAt),
      inArray(runs.status, ['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW']),
    ))
    .limit(200)
  let pending = 0
  for (const row of halted) {
    const entries = row.snapshot.moduleManifest?.entries ?? []
    if (entries.length === 0) continue
    const existing = await db
      .select({
        invocationId: moduleInvocationResults.invocationId,
        sourceRunEventSeq: moduleInvocationResults.sourceRunEventSeq,
      })
      .from(moduleInvocationResults)
      .where(eq(moduleInvocationResults.runId, row.id))
    if (existing.length !== entries.length || existing.some((item) => item.sourceRunEventSeq < row.eventSeq)) {
      pending += 1
    }
  }
  return pending
}

export async function listModuleInvocations(
  db: Db,
  moduleId: string,
  query: ModuleInvocationListQuery = {},
): Promise<ModuleInvocationListResponse> {
  await loadModuleOrThrow(db, moduleId)
  const parsed = moduleInvocationListQuerySchema.parse(query)
  const { moduleInvocationResults, runs } = schemaFor(db)
  const conditions = [
    eq(moduleInvocationResults.moduleId, moduleId),
    eq(moduleInvocationResults.projectorVersion, MODULE_INVOCATION_PROJECTOR_VERSION),
    isNull(runs.deletedAt),
  ]
  if (parsed.versionId) conditions.push(eq(moduleInvocationResults.moduleVersionId, parsed.versionId))
  if (parsed.outcome) conditions.push(eq(moduleInvocationResults.outcome, parsed.outcome))
  if (parsed.attribution) conditions.push(eq(moduleInvocationResults.attribution, parsed.attribution))
  if (parsed.accountId) conditions.push(eq(moduleInvocationResults.targetAccountId, parsed.accountId))
  const asOf = new Date().toISOString()
  const [totalRow] = await db
    .select({ total: sql<number>`count(*)` })
    .from(moduleInvocationResults)
    .innerJoin(runs, eq(runs.id, moduleInvocationResults.runId))
    .where(and(...conditions))
  const rows = await db
    .select({ result: moduleInvocationResults })
    .from(moduleInvocationResults)
    .innerJoin(runs, eq(runs.id, moduleInvocationResults.runId))
    .where(and(...conditions))
    .orderBy(desc(moduleInvocationResults.finishedAt), desc(moduleInvocationResults.id))
    .limit(parsed.pageSize)
    .offset((parsed.page - 1) * parsed.pageSize)
  return moduleInvocationListResponseSchema.parse({
    items: rows.map((row) => {
      const result = asResult(row.result)
      return { ...result, runHref: runHrefForInvocation(result.runId, result.invocationId) }
    }),
    total: Number(totalRow?.total ?? 0),
    page: parsed.page,
    pageSize: parsed.pageSize,
    asOf,
  })
}

export async function attachModuleListHealth(
  db: Db,
  items: ActionModuleSummary[],
): Promise<ActionModuleSummary[]> {
  if (items.length === 0) return items
  let config: { config: PlatformModuleQuality; revision: number }
  try {
    config = await requireModuleQualityConfig(db)
  } catch {
    return items
  }
  return Promise.all(items.map(async (item) => {
    try {
      const quality = await getActionModuleQuality(db, item.id, { window: config.config.windowDays, groupBy: 'none' })
      const health: ModuleHealthSummary = quality.health
      return { ...item, health }
    } catch {
      return item
    }
  }))
}
