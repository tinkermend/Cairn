import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import {
  COMPILER_VERSION,
  FACTORY_MAP_JOB_POLICY,
  MAP_JOBS_PROTOCOL,
  canonicalJson,
  frozenMapJobSchema,
  isMapJobRun,
  mapIngestCreateBodySchema,
  mapIngestJobListQuerySchema,
  mapIngestJobListResponseSchema,
  mapJobCreateResponseSchema,
  mapJobDtoSchema,
  mapJobPolicyDtoSchema,
  mapJobPolicySchema,
  mapJobPolicyUpdateBodySchema,
  scenarioDefinitionFromSteps,
  targetStateRuleSchema,
  type ExecutionActor,
  type MapIngestCreateBody,
  type MapIngestJobListQuery,
  type MapJobCreateResponse,
  type MapMenuEntry,
  type MapJobDto,
  type MapJobKind,
  type MapJobPolicy,
  type MapJobPolicyDto,
  type MapJobPolicyUpdateBody,
  type MapJobStopReason,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit } from '../audit/record.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import { requestRunCancel } from '../runs/runs.js'
import { createRunWithSnapshot } from '../runs/runs.js'
import { findLiveSessions } from '../sessions/sessions.js'
import { isUniqueViolation } from '../runs/errors.js'
import { mapActiveSliceExists, mapAuthPreparationRequired, mapCommandIdempotencyConflict, mapConsumerUnavailable, mapForbidden, mapNotFound, mapRevisionConflict } from './errors.js'
import { requireLiveTarget } from './view.js'
import { requireMapCapableAccount, requireTargetHasMapCapableAccount } from '../console/account-usage.js'
import { lockConsoleAuthorization, scopedTargetFilter } from '../console/target-authorization.js'
import { ensureFrozenAccessPolicyTx } from './access.js'

function jobPolicyFromRow(row: {
  policySchemaVersion: number
  policyVersion: number
  manualJobsEnabled: number
  sliceWorkSeconds: number
  ingestMaxDepth: number
  ingestMaxPagesPerEntry: number
  ingestMaxPagesPerJob: number
  ingestMaxJobSeconds: number
  ingestNavTimeoutSeconds: number
  ingestSettleTimeoutSeconds: number
  ingestPageBudgetSeconds: number
  ingestMaxViewsPerPage: number
  ingestMaxOptionReadsPerPage: number
}): MapJobPolicy {
  return mapJobPolicySchema.parse({
    schemaVersion: row.policySchemaVersion,
    policyVersion: row.policyVersion,
    manualJobsEnabled: row.manualJobsEnabled === 1,
    sliceWorkSeconds: row.sliceWorkSeconds,
    ingestMaxDepth: row.ingestMaxDepth,
    ingestMaxPagesPerEntry: row.ingestMaxPagesPerEntry,
    ingestMaxPagesPerJob: row.ingestMaxPagesPerJob,
    ingestMaxJobSeconds: row.ingestMaxJobSeconds,
    ingestNavTimeoutSeconds: row.ingestNavTimeoutSeconds,
    ingestSettleTimeoutSeconds: row.ingestSettleTimeoutSeconds,
    ingestPageBudgetSeconds: row.ingestPageBudgetSeconds,
    ingestMaxViewsPerPage: row.ingestMaxViewsPerPage,
    ingestMaxOptionReadsPerPage: row.ingestMaxOptionReadsPerPage,
  })
}

export async function getMapJobPolicy(db: Db, targetId: string): Promise<MapJobPolicyDto> {
  await requireLiveTarget(db, targetId)
  const { mapJobPolicies } = schemaFor(db)
  const [row] = await db.select().from(mapJobPolicies).where(eq(mapJobPolicies.targetId, targetId)).limit(1)
  return mapJobPolicyDtoSchema.parse({
    targetId,
    revision: row?.revision ?? 0,
    policy: row ? jobPolicyFromRow(row) : FACTORY_MAP_JOB_POLICY,
    updatedAt: (row?.updatedAt ?? new Date(0)).toISOString(),
  })
}

export async function updateMapJobPolicy(
  db: Db,
  targetId: string,
  body: MapJobPolicyUpdateBody,
  actor: ExecutionActor,
): Promise<MapJobPolicyDto> {
  const parsed = mapJobPolicyUpdateBodySchema.parse(body)
  await requireLiveTarget(db, targetId)
  return atomic(db, async (tx) => {
    const { mapJobPolicies, mapJobPolicyCommands } = schemaFor(tx)
    const [receipt] = await tx
      .select()
      .from(mapJobPolicyCommands)
      .where(and(eq(mapJobPolicyCommands.targetId, targetId), eq(mapJobPolicyCommands.commandKey, parsed.idempotencyKey)))
      .limit(1)
    const payload = { body: parsed }
    if (receipt) {
      if (canonicalJson(receipt.payload) !== canonicalJson(payload)) mapCommandIdempotencyConflict()
      return mapJobPolicyDtoSchema.parse(receipt.result)
    }
    const [current] = await locked(tx, tx.select().from(mapJobPolicies).where(eq(mapJobPolicies.targetId, targetId)))
    const expected = current?.revision ?? 0
    if (expected !== parsed.expectedRevision) mapRevisionConflict('作业政策修订已变更')
    if (parsed.manualJobsEnabled) await requireTargetHasMapCapableAccount(tx, targetId)
    const now = await clockNow(tx)
    const nextRevision = expected + 1
    const policy = mapJobPolicySchema.parse({
      ...(current ? jobPolicyFromRow(current) : FACTORY_MAP_JOB_POLICY),
      policyVersion: nextRevision,
      manualJobsEnabled: parsed.manualJobsEnabled,
      ingestMaxDepth: parsed.ingestMaxDepth ?? current?.ingestMaxDepth,
      ingestMaxPagesPerEntry: parsed.ingestMaxPagesPerEntry ?? current?.ingestMaxPagesPerEntry,
      ingestMaxPagesPerJob: parsed.ingestMaxPagesPerJob ?? current?.ingestMaxPagesPerJob,
      ingestMaxJobSeconds: parsed.ingestMaxJobSeconds ?? current?.ingestMaxJobSeconds,
      ingestNavTimeoutSeconds: parsed.ingestNavTimeoutSeconds ?? current?.ingestNavTimeoutSeconds,
      ingestSettleTimeoutSeconds: parsed.ingestSettleTimeoutSeconds ?? current?.ingestSettleTimeoutSeconds,
      ingestPageBudgetSeconds: parsed.ingestPageBudgetSeconds ?? current?.ingestPageBudgetSeconds,
      ingestMaxViewsPerPage: parsed.ingestMaxViewsPerPage ?? current?.ingestMaxViewsPerPage,
      ingestMaxOptionReadsPerPage: parsed.ingestMaxOptionReadsPerPage ?? current?.ingestMaxOptionReadsPerPage,
    })
    const values = {
      policySchemaVersion: policy.schemaVersion,
      policyVersion: policy.policyVersion,
      manualJobsEnabled: policy.manualJobsEnabled ? 1 : 0,
      sliceWorkSeconds: policy.sliceWorkSeconds,
      ingestMaxDepth: policy.ingestMaxDepth,
      ingestMaxPagesPerEntry: policy.ingestMaxPagesPerEntry,
      ingestMaxPagesPerJob: policy.ingestMaxPagesPerJob,
      ingestMaxJobSeconds: policy.ingestMaxJobSeconds,
      ingestNavTimeoutSeconds: policy.ingestNavTimeoutSeconds,
      ingestSettleTimeoutSeconds: policy.ingestSettleTimeoutSeconds,
      ingestPageBudgetSeconds: policy.ingestPageBudgetSeconds,
      ingestMaxViewsPerPage: policy.ingestMaxViewsPerPage,
      ingestMaxOptionReadsPerPage: policy.ingestMaxOptionReadsPerPage,
      revision: nextRevision,
      updatedBy: actor.id,
      updatedAt: now,
    }
    if (current) await tx.update(mapJobPolicies).set(values).where(eq(mapJobPolicies.targetId, targetId))
    else await tx.insert(mapJobPolicies).values({ targetId, ...values })
    const result = await getMapJobPolicy(tx, targetId)
    await insertRows(tx, mapJobPolicyCommands, { id: newId(), targetId, commandKey: parsed.idempotencyKey, payload, result })
    await recordAudit(tx, actor, 'map.job_policy.update', 'target', targetId, parsed.reason)
    return result
  })
}

function jobToDto(
  job: {
    id: string
    targetId: string
    targetAccountId: string
    jobKind: MapJobKind
    jobStatus: MapJobDto['jobStatus']
    stopReason: MapJobStopReason | null
    revision: number
    remainingBudgetSeconds: number
    scope: MapJobDto['scope']
    ingestCursor: import('@cairn/shared').MapIngestCursor | null
    ingestSummary: import('@cairn/shared').MapIngestSummary | null
    releaseId: string | null
    frozenEntriesJson: MapMenuEntry[]
    createdAt: Date
    updatedAt: Date
  },
  slices: Array<{ sliceOrdinal: number; runId: string; reservedSeconds: number; createdAt: Date }>,
): MapJobDto {
  return mapJobDtoSchema.parse({
    jobId: job.id,
    targetId: job.targetId,
    targetAccountId: job.targetAccountId,
    jobKind: job.jobKind,
    jobStatus: job.jobStatus,
    stopReason: job.stopReason,
    revision: job.revision,
    remainingBudgetSeconds: job.remainingBudgetSeconds,
    scope: job.scope,
    ingestProgress: {
      totalEntries: job.frozenEntriesJson.length,
      completedEntries: job.ingestCursor?.completedEntries.length ?? 0,
      pagesCollected: job.ingestCursor?.visitedPageKeys.length ?? 0,
      currentEntryName: job.frozenEntriesJson[job.ingestCursor?.entryIndex ?? 0]?.name ?? null,
    },
    ingestSummary: job.ingestSummary,
    releaseId: job.releaseId,
    firstRunId: slices[0]?.runId,
    slices: slices.map((slice) => ({
      sliceOrdinal: slice.sliceOrdinal,
      runId: slice.runId,
      reservedSeconds: slice.reservedSeconds,
      createdAt: slice.createdAt.toISOString(),
    })),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  })
}

export async function getMapJob(db: Db, jobId: string, actorId?: string): Promise<MapJobDto> {
  if (actorId === '') mapNotFound('地图作业不存在')
  const { mapJobs, mapJobSlices } = schemaFor(db)
  const [job] = await db.select().from(mapJobs).where(and(
    eq(mapJobs.id, jobId),
    await scopedTargetFilter(db, actorId, mapJobs.targetId, 'map:read'),
  )).limit(1)
  if (!job) mapNotFound('地图作业不存在')
  const slices = await db.select().from(mapJobSlices).where(eq(mapJobSlices.jobId, jobId))
  return jobToDto(job, slices)
}

export async function listMapIngestJobs(db: Db, targetId: string, query: MapIngestJobListQuery) {
  await requireLiveTarget(db, targetId)
  const parsed = mapIngestJobListQuerySchema.parse(query)
  const { mapJobs } = schemaFor(db)
  let before: { createdAt: Date; id: string } | undefined
  if (parsed.cursor) {
    const [row] = await db.select({ id: mapJobs.id, createdAt: mapJobs.createdAt }).from(mapJobs)
      .where(and(eq(mapJobs.id, parsed.cursor), eq(mapJobs.targetId, targetId))).limit(1)
    if (!row) mapNotFound('采集作业游标不存在')
    before = row
  }
  const rows = await db.select({ id: mapJobs.id, createdAt: mapJobs.createdAt }).from(mapJobs)
    .where(and(eq(mapJobs.targetId, targetId), eq(mapJobs.jobKind, 'map_ingest'),
      before ? or(lt(mapJobs.createdAt, before.createdAt),
        and(eq(mapJobs.createdAt, before.createdAt), lt(mapJobs.id, before.id))) : undefined))
    .orderBy(desc(mapJobs.createdAt), desc(mapJobs.id)).limit(parsed.limit + 1)
  return mapIngestJobListResponseSchema.parse({
    items: await Promise.all(rows.slice(0, parsed.limit).map(row => getMapJob(db, row.id))),
    ...(rows.length > parsed.limit ? { nextCursor: rows[parsed.limit - 1]!.id } : {}),
  })
}

export async function hasReadyMapJobWorker(db: Db): Promise<boolean> {
  const { workers } = schemaFor(db)
  const rows = await db.select().from(workers)
  return rows.some((row) => row.status === 'READY' && (row.protocolCapabilities ?? []).includes(MAP_JOBS_PROTOCOL))
}

async function selectIngestAccount(db: Db, targetId: string, requested?: string): Promise<string> {
  if (requested) {
    await requireMapCapableAccount(db, targetId, requested)
    const sessions = await findLiveSessions(db, { targetId, targetAccountId: requested })
    if (!sessions.some(session => session.status === 'OPEN' && session.authState === 'AUTHENTICATED'
      && session.health !== 'UNHEALTHY')) mapAuthPreparationRequired()
    return requested
  }
  const { targetAccounts, browserSessions } = schemaFor(db)
  const accounts = await db.select({ id: targetAccounts.id }).from(targetAccounts)
    .where(and(eq(targetAccounts.targetId, targetId), eq(targetAccounts.status, 'active'),
      inArray(targetAccounts.usage, ['map', 'both']), isNull(targetAccounts.deletedAt)))
  const sessions = await db.select().from(browserSessions)
    .where(and(eq(browserSessions.targetId, targetId), eq(browserSessions.status, 'OPEN'),
      eq(browserSessions.authState, 'AUTHENTICATED')))
    .orderBy(desc(browserSessions.lastAuthSuccessAt))
  const eligible = new Set(accounts.map(account => account.id))
  const chosen = sessions.find(session => eligible.has(session.targetAccountId)
    && session.health !== 'UNHEALTHY' && (!session.authValidUntil || session.authValidUntil > new Date()))
  if (!chosen) mapAuthPreparationRequired()
  return chosen.targetAccountId
}

export async function createMapIngestJob(
  db: Db,
  targetId: string,
  body: MapIngestCreateBody,
  actor: ExecutionActor,
  source: { kind: 'manual' } | { kind: 'scheduled'; occurrenceId: string; startBefore?: string } = { kind: 'manual' },
): Promise<MapJobCreateResponse> {
  const parsed = mapIngestCreateBodySchema.parse(body)
  const target = await requireLiveTarget(db, targetId)
  const commandKey = source.kind === 'scheduled'
    ? 'map:scheduled:' + source.occurrenceId
    : 'map:manual:' + targetId + ':' + parsed.manualId
  return atomic(db, async tx => {
    const { mapJobCommands, mapJobs, mapJobSlices, mapMenuEntries, targetStateRules, scenarios, scenarioVersions } = schemaFor(tx)
    const payload = { body: parsed, source }
    const [receipt] = await tx.select().from(mapJobCommands)
      .where(and(eq(mapJobCommands.targetId, targetId), eq(mapJobCommands.commandKey, commandKey))).limit(1)
    if (receipt) {
      if (canonicalJson(receipt.payload) !== canonicalJson(payload)) mapCommandIdempotencyConflict()
      return mapJobCreateResponseSchema.parse({ ...(receipt.result as MapJobCreateResponse), created: false })
    }
    const policyDto = await getMapJobPolicy(tx, targetId)
    if (policyDto.revision !== parsed.expectedPolicyRevision) mapRevisionConflict('作业政策修订已变更')
    if (!policyDto.policy.manualJobsEnabled) mapForbidden('该目标尚未启用地图采集')
    const all = await tx.select().from(mapMenuEntries)
      .where(and(eq(mapMenuEntries.targetId, targetId), isNull(mapMenuEntries.archivedAt), eq(mapMenuEntries.enabled, 1)))
      .orderBy(mapMenuEntries.orderIndex, mapMenuEntries.createdAt)
    const chosen = parsed.scope === 'entries'
      ? all.filter(row => parsed.entryIds!.includes(row.id))
      : parsed.scope === 'detect_top_menus' ? [] : all
    if (parsed.scope === 'entries' && chosen.length !== parsed.entryIds!.length)
      mapNotFound('指定的一级菜单不存在或已停用')
    if (parsed.scope !== 'detect_top_menus' && !chosen.length) mapNotFound('没有已启用的一级菜单')
    const entries: MapMenuEntry[] = chosen.map(row => ({
      entryId: row.id, version: row.entryVersion, name: row.entryName,
      ...(row.entryUrl ? { url: row.entryUrl } : {}),
      ...(row.menuAnchor ? { menuAnchor: row.menuAnchor } : {}),
      enabled: true, orderIndex: row.orderIndex,
      arrivalName: row.arrivalName, arrivalTarget: row.arrivalTarget,
    }))
    const [stateRuleRow] = await tx.select({ rulesJson: targetStateRules.rulesJson }).from(targetStateRules)
      .where(eq(targetStateRules.targetId, targetId)).limit(1)
    const stateRule = stateRuleRow ? targetStateRuleSchema.parse(stateRuleRow.rulesJson) : undefined
    const allowedSpaHashPrefixes = stateRule?.allowedSpaHashPrefixes ?? ['#/']
    const ignoreQueryParams = stateRule?.ignoreQueryParams ?? []
    const accountId = await selectIngestAccount(tx, targetId, parsed.targetAccountId)
    if (!(await hasReadyMapJobWorker(tx))) mapConsumerUnavailable('没有具备地图采集能力的 Worker')
    const access = await ensureFrozenAccessPolicyTx(tx, { targetId, actorId: actor.id, mapJob: true })
    const now = await clockNow(tx)
    const jobId = newId()
    const budget = policyDto.policy.ingestMaxJobSeconds
    const reserved = Math.min(policyDto.policy.sliceWorkSeconds, budget)
    try {
      await insertRows(tx, mapJobs, {
        id: jobId, targetId, targetAccountId: accountId, jobKind: 'map_ingest', jobStatus: 'queued',
        remainingBudgetSeconds: budget - reserved, scope: parsed.scope, ingestCursor: null, ingestSummary: null,
        frozenEntriesJson: entries, frozenAccessRevision: access.frozen.revision,
        policyRevision: policyDto.revision || 1, releaseId: null, requestJson: payload,
        frozenPolicyJson: policyDto.policy, activeGuard: 'Y', revision: 1,
        createdBy: actor.id, createdAt: now, updatedAt: now,
      })
    } catch (error) {
      if (isUniqueViolation(error)) mapActiveSliceExists()
      throw error
    }
    const step = {
      id: newId(), name: '只读采集目标菜单', type: 'map_ingest' as const, effectType: 'READ_ONLY' as const,
      policy: { timeoutMs: (reserved + policyDto.policy.ingestPageBudgetSeconds + 10) * 1000, retryLimit: 0 },
      input: {
        jobId, startUrl: target.entryUrl, scope: parsed.scope, entries, cursor: null,
        policy: policyDto.policy, allowedSpaHashPrefixes, ignoreQueryParams, sliceWorkSeconds: reserved,
      },
    }
    const scenarioId = newId()
    const versionId = newId()
    const definition = scenarioDefinitionFromSteps([step])
    await tx.insert(scenarios).values({
      id: scenarioId, targetId, name: '[地图采集] ' + jobId, status: 'active', purpose: 'map_job',
      createdByConsoleAccountId: actor.id, createdAt: now, updatedAt: now,
    })
    await tx.insert(scenarioVersions).values({
      id: versionId, scenarioId, versionNo: 1, kind: 'published', definition,
      compilerVersion: COMPILER_VERSION, sourceDigest: jobId + ':0',
      createdByConsoleAccountId: actor.id, createdAt: now,
    })
    const created = await createRunWithSnapshot(tx, {
      scenarioId, scenarioVersionId: versionId, targetAccountId: accountId, actor,
      deadlineAt: new Date(now.getTime() + policyDto.policy.ingestMaxJobSeconds * 2_000),
      mapCapturePolicy: { enabled: true }, mapConsumption: { mode: 'off' },
      mapJob: frozenMapJobSchema.parse({
        jobId, sliceOrdinal: 0, purpose: 'map_ingest', policyRevision: policyDto.revision || 1,
        remainingBudgetSeconds: budget - reserved, consumerVersion: MAP_JOBS_PROTOCOL,
        source: source.kind, ...(source.kind === 'scheduled' ? { occurrenceId: source.occurrenceId, startBefore: source.startBefore } : {}),
        ingest: { scope: parsed.scope, entries, accessPolicyRevision: access.frozen.revision },
      }),
    })
    await insertRows(tx, mapJobSlices, {
      id: newId(), jobId, targetId, sliceOrdinal: 0, runId: created.detail.id,
      reservedSeconds: reserved, createdAt: now,
    })
    const result = mapJobCreateResponseSchema.parse({ job: await getMapJob(tx, jobId), created: true })
    await insertRows(tx, mapJobCommands, { id: newId(), targetId, commandKey, payload, result })
    await recordAudit(tx, actor, 'map.job.create', 'target', targetId, '创建地图采集作业')
    return result
  })
}

export async function cancelMapJob(db: Db, jobId: string, actor: ExecutionActor, actorId?: string): Promise<MapJobDto> {
  if (actorId === '') mapNotFound('地图作业不存在')
  return atomic(db, async (tx) => {
    const { mapJobs, mapJobSlices } = schemaFor(tx)
    if (actorId !== undefined) await lockConsoleAuthorization(tx, actorId)
    const [job] = await locked(tx, tx.select().from(mapJobs).where(and(
      eq(mapJobs.id, jobId),
      await scopedTargetFilter(tx, actorId, mapJobs.targetId, 'map:maintain'),
      await scopedTargetFilter(tx, actorId, mapJobs.targetId, 'map:read'),
    )))
    if (!job) mapNotFound('地图作业不存在')
    const now = await clockNow(tx)
    await tx
      .update(mapJobs)
      .set({ jobStatus: 'cancelled', stopReason: 'cancelled', activeGuard: null, updatedAt: now })
      .where(eq(mapJobs.id, jobId))
    const slices = await tx.select().from(mapJobSlices).where(eq(mapJobSlices.jobId, jobId))
    for (const slice of slices) {
      await requestRunCancel(tx, slice.runId, actor).catch(() => undefined)
    }
    await recordAudit(tx, actor, 'map.job.cancel', 'target', job.targetId, `取消作业 ${jobId}`)
    return getMapJob(tx, jobId, actorId)
  })
}

export async function completeMapJobSlice(
  db: Db,
  runId: string,
  outcome: 'completed' | 'failed' | 'cancelled',
): Promise<{ continue: boolean; jobId: string }> {
  const { mapJobSlices, mapJobs } = schemaFor(db)
  const [slice] = await db.select().from(mapJobSlices).where(eq(mapJobSlices.runId, runId)).limit(1)
  if (!slice) return { continue: false, jobId: '' }
  return atomic(db, async (tx) => {
    const { runs, scenarioVersions, mapJobSlices } = schemaFor(tx)
    const [job] = await locked(tx, tx.select().from(mapJobs).where(eq(mapJobs.id, slice.jobId)))
    if (!job || ['cancelled', 'completed', 'failed'].includes(job.jobStatus)) return { continue: false, jobId: slice.jobId }
    const [following] = await tx.select({ id: mapJobSlices.id }).from(mapJobSlices)
      .where(and(eq(mapJobSlices.jobId, slice.jobId), eq(mapJobSlices.sliceOrdinal, slice.sliceOrdinal + 1))).limit(1)
    if (following) return { continue: true, jobId: job.id }
    const now = await clockNow(tx)
    const finished = job.scope === 'detect_top_menus'
      || (job.ingestCursor !== null && job.ingestCursor.entryIndex >= job.frozenEntriesJson.length
        && job.ingestCursor.queue.length === 0)
    if (outcome === 'completed' && !finished
      && job.remainingBudgetSeconds > 0
      && (job.ingestCursor?.elapsedSeconds ?? 0) < job.frozenPolicyJson.ingestMaxJobSeconds) {
      if (now.getTime() - job.createdAt.getTime() >= job.frozenPolicyJson.ingestMaxJobSeconds * 2_000) {
        await tx.update(mapJobs).set({
          jobStatus: 'failed', stopReason: 'window_closed', activeGuard: null, updatedAt: now,
        }).where(eq(mapJobs.id, job.id))
        return { continue: false, jobId: job.id }
      }
      const [priorRun] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1)
      if (!priorRun?.snapshot.mapJob || !job.ingestCursor) mapNotFound('地图采集分片快照缺失')
      const priorStep = priorRun.snapshot.steps.find(step => step.type === 'map_ingest')
      if (!priorStep || priorStep.type !== 'map_ingest') mapNotFound('地图采集步骤缺失')
      const access = await ensureFrozenAccessPolicyTx(tx, { targetId: job.targetId, actorId: job.createdBy, mapJob: true })
      if (access.frozen.revision !== job.frozenAccessRevision) {
        await tx.update(mapJobs).set({
          jobStatus: 'failed', stopReason: 'compile_rejected', activeGuard: null, updatedAt: now,
        }).where(eq(mapJobs.id, job.id))
        return { continue: false, jobId: job.id }
      }
      const reserved = Math.min(job.frozenPolicyJson.sliceWorkSeconds, job.remainingBudgetSeconds)
      const nextOrdinal = slice.sliceOrdinal + 1
      const step = {
        ...priorStep, id: newId(), input: {
          ...priorStep.input, cursor: job.ingestCursor, sliceWorkSeconds: reserved,
        },
      }
      const versionId = newId()
      await tx.insert(scenarioVersions).values({
        id: versionId, scenarioId: priorRun.scenarioId, versionNo: nextOrdinal + 1,
        kind: 'published', definition: scenarioDefinitionFromSteps([step]),
        compilerVersion: COMPILER_VERSION, sourceDigest: job.id + ':' + nextOrdinal,
        createdByConsoleAccountId: job.createdBy, createdAt: now,
      })
      const created = await createRunWithSnapshot(tx, {
        scenarioId: priorRun.scenarioId, scenarioVersionId: versionId,
        targetAccountId: job.targetAccountId, actor: { kind: 'console', id: job.createdBy },
        deadlineAt: new Date(job.createdAt.getTime() + job.frozenPolicyJson.ingestMaxJobSeconds * 2_000),
        mapCapturePolicy: { enabled: true }, mapConsumption: { mode: 'off' },
        mapJob: frozenMapJobSchema.parse({
          ...priorRun.snapshot.mapJob, sliceOrdinal: nextOrdinal,
          remainingBudgetSeconds: job.remainingBudgetSeconds - reserved,
        }),
      })
      await insertRows(tx, mapJobSlices, {
        id: newId(), jobId: job.id, targetId: job.targetId, sliceOrdinal: nextOrdinal,
        runId: created.detail.id, reservedSeconds: reserved, createdAt: now,
      })
      const userWaiting = await hasClaimableUserRun(tx, { targetId: job.targetId, targetAccountId: job.targetAccountId })
      await tx.update(mapJobs).set({
        jobStatus: 'queued', stopReason: userWaiting ? 'user_run_waiting' : null, revision: job.revision + 1,
        remainingBudgetSeconds: job.remainingBudgetSeconds - reserved, updatedAt: now,
      }).where(eq(mapJobs.id, job.id))
      return { continue: true, jobId: job.id }
    }
    const stop: MapJobStopReason =
      outcome === 'cancelled' ? 'cancelled' : outcome === 'failed' ? 'slice_failed'
        : finished ? 'completed' : 'budget_exhausted'
    await tx
      .update(mapJobs)
      .set({
        jobStatus: outcome === 'completed' ? 'completed' : outcome,
        stopReason: stop,
        activeGuard: null,
        updatedAt: now,
      })
      .where(eq(mapJobs.id, job.id))
    return { continue: false, jobId: job.id }
  })
}

export async function hasClaimableUserRun(
  db: Db,
  input: { targetId: string; targetAccountId: string | null },
): Promise<boolean> {
  if (!input.targetAccountId) return false
  const { runs, runLeases } = schemaFor(db)
  const rows = await db
    .select({ id: runs.id, snapshot: runs.snapshot })
    .from(runs)
    .where(
      and(
        eq(runs.targetId, input.targetId),
        eq(runs.targetAccountId, input.targetAccountId),
        inArray(runs.status, ['QUEUED', 'RECOVERING']),
        isNull(runs.deletedAt),
        isNull(runs.cancelRequestedAt),
      ),
    )
  for (const row of rows) {
        if (isMapJobRun(row.snapshot)) continue
        if (row.snapshot.suiteAdmission) {
          const { suiteRunItems } = schemaFor(db)
          const [admitted] = await db
            .select({ id: suiteRunItems.id })
            .from(suiteRunItems)
            .where(and(eq(suiteRunItems.childRunId, row.id), eq(suiteRunItems.admissionStatus, 'ACTIVE')))
            .limit(1)
          if (!admitted) continue
        }
        const [lease] = await db
      .select({ id: runLeases.id })
      .from(runLeases)
      .where(and(eq(runLeases.runId, row.id), eq(runLeases.status, 'ACTIVE')))
      .limit(1)
    if (!lease) return true
  }
  return false
}
