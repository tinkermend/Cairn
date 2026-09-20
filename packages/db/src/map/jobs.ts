import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import {
  COMPILER_VERSION,
  FACTORY_EXPLORATION_POLICY,
  FACTORY_MAP_JOB_POLICY,
  MAP_EXPLORE_PROTOCOL,
  MAP_JOBS_PROTOCOL,
  canonicalJson,
  explorationPolicyDtoSchema,
  explorationPolicySchema,
  explorationPolicyUpdateBodySchema,
  frozenMapJobSchema,
  isMapJobRun,
  mapJobCreateBodySchema,
  mapJobCreateResponseSchema,
  mapJobDtoSchema,
  mapJobCommandKey,
  mapJobIdempotencyKey,
  mapJobPolicyDtoSchema,
  mapJobPolicySchema,
  mapJobPolicyUpdateBodySchema,
  mapSafeEntryCreateBodySchema,
  mapSafeEntryDtoSchema,
  mapSafeEntrySchema,
  scenarioDefinitionFromSteps,
  type ExecutionActor,
  type ExplorationPolicy,
  type ExplorationPolicyDto,
  type ExplorationPolicyUpdateBody,
  type MapJobCreateBody,
  type MapJobCreateResponse,
  type MapJobDto,
  type MapJobKind,
  type MapJobPolicy,
  type MapJobPolicyDto,
  type MapJobPolicyUpdateBody,
  type MapJobStopReason,
  type MapSafeEntryCreateBody,
  type MapSafeEntryDto,
  type Step,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit } from '../audit/record.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import { createRunWithSnapshot, requestRunCancel } from '../runs/runs.js'
import { isUniqueViolation } from '../runs/errors.js'
import { findLiveSession } from '../sessions/sessions.js'
import {
  mapActiveSliceExists,
  mapAuthPreparationRequired,
  mapCommandIdempotencyConflict,
  mapConsumerUnavailable,
  mapForbidden,
  mapNotFound,
  mapRevisionConflict,
} from './errors.js'
import { getPlatformConfig } from '../platform-config/store.js'
import { requireLiveTarget } from './view.js'
import { requireMapCapableAccount, requireTargetHasMapCapableAccount } from '../console/account-usage.js'

function jobPolicyFromRow(row: {
  policySchemaVersion: number
  policyVersion: number
  manualJobsEnabled: number
  maxProbePages: number
  maxProbeObjects: number
  maxProbeActions: number
  maxProbeSeconds: number
  maxRefreshPages: number
  maxRefreshObjects: number
  maxRefreshActions: number
  maxRefreshSeconds: number
  sliceWorkSeconds: number
  defaultDepth: string
  staticRefreshDays: number
}): MapJobPolicy {
  return mapJobPolicySchema.parse({
    schemaVersion: row.policySchemaVersion,
    policyVersion: row.policyVersion,
    manualJobsEnabled: row.manualJobsEnabled === 1,
    maxProbePages: row.maxProbePages,
    maxProbeObjects: row.maxProbeObjects,
    maxProbeActions: row.maxProbeActions,
    maxProbeSeconds: row.maxProbeSeconds,
    maxRefreshPages: row.maxRefreshPages,
    maxRefreshObjects: row.maxRefreshObjects,
    maxRefreshActions: row.maxRefreshActions,
    maxRefreshSeconds: row.maxRefreshSeconds,
    sliceWorkSeconds: row.sliceWorkSeconds,
    defaultDepth: row.defaultDepth,
    staticRefreshDays: row.staticRefreshDays,
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
    })
    const values = {
      policySchemaVersion: policy.schemaVersion,
      policyVersion: policy.policyVersion,
      manualJobsEnabled: policy.manualJobsEnabled ? 1 : 0,
      maxProbePages: policy.maxProbePages,
      maxProbeObjects: policy.maxProbeObjects,
      maxProbeActions: policy.maxProbeActions,
      maxProbeSeconds: policy.maxProbeSeconds,
      maxRefreshPages: policy.maxRefreshPages,
      maxRefreshObjects: policy.maxRefreshObjects,
      maxRefreshActions: policy.maxRefreshActions,
      maxRefreshSeconds: policy.maxRefreshSeconds,
      sliceWorkSeconds: policy.sliceWorkSeconds,
      defaultDepth: policy.defaultDepth,
      staticRefreshDays: policy.staticRefreshDays,
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

function explorationPolicyFromRow(row: {
  policySchemaVersion: number
  policyVersion: number
  exploreEnabled: number
  exploreMode: ExplorationPolicy['mode']
  modelEnabled: number
  maxHopDepth: number
  maxNewPages: number
  maxCandidates: number
  maxActions: number
  maxSeconds: number
  sliceWorkSeconds: number
  allowlistJson: ExplorationPolicy['allowlist']
  seedRefsJson: ExplorationPolicy['seedRefs']
}): ExplorationPolicy {
  return explorationPolicySchema.parse({
    schemaVersion: row.policySchemaVersion,
    policyVersion: row.policyVersion,
    exploreEnabled: row.exploreEnabled === 1,
    mode: row.exploreMode,
    modelEnabled: row.modelEnabled === 1,
    maxHopDepth: row.maxHopDepth,
    maxNewPages: row.maxNewPages,
    maxCandidates: row.maxCandidates,
    maxActions: row.maxActions,
    maxSeconds: row.maxSeconds,
    sliceWorkSeconds: row.sliceWorkSeconds,
    allowlist: row.allowlistJson,
    seedRefs: row.seedRefsJson,
  })
}

export async function getExplorationPolicy(db: Db, targetId: string): Promise<ExplorationPolicyDto> {
  await requireLiveTarget(db, targetId)
  const { mapExplorationPolicies } = schemaFor(db)
  const [row] = await db.select().from(mapExplorationPolicies).where(eq(mapExplorationPolicies.targetId, targetId)).limit(1)
  return explorationPolicyDtoSchema.parse({
    targetId,
    revision: row?.revision ?? 0,
    policy: row ? explorationPolicyFromRow(row) : FACTORY_EXPLORATION_POLICY,
    updatedAt: (row?.updatedAt ?? new Date(0)).toISOString(),
  })
}

export async function updateExplorationPolicy(
  db: Db,
  targetId: string,
  body: ExplorationPolicyUpdateBody,
  actor: ExecutionActor,
): Promise<ExplorationPolicyDto> {
  const parsed = explorationPolicyUpdateBodySchema.parse(body)
  await requireLiveTarget(db, targetId)
  return atomic(db, async (tx) => {
    const { mapExplorationPolicies, mapExplorationPolicyCommands } = schemaFor(tx)
    const [receipt] = await tx
      .select()
      .from(mapExplorationPolicyCommands)
      .where(
        and(
          eq(mapExplorationPolicyCommands.targetId, targetId),
          eq(mapExplorationPolicyCommands.commandKey, parsed.idempotencyKey),
        ),
      )
      .limit(1)
    const payload = { body: parsed }
    if (receipt) {
      if (canonicalJson(receipt.payload) !== canonicalJson(payload)) mapCommandIdempotencyConflict()
      return explorationPolicyDtoSchema.parse(receipt.result)
    }
    const [current] = await locked(tx, tx.select().from(mapExplorationPolicies).where(eq(mapExplorationPolicies.targetId, targetId)))
    const expected = current?.revision ?? 0
    if (expected !== parsed.expectedRevision) mapRevisionConflict('探索政策修订已变更')
    const now = await clockNow(tx)
    const nextRevision = expected + 1
    const policy = explorationPolicySchema.parse({
      ...(current ? explorationPolicyFromRow(current) : FACTORY_EXPLORATION_POLICY),
      policyVersion: nextRevision,
      exploreEnabled: parsed.exploreEnabled,
      mode: parsed.mode,
      modelEnabled: parsed.modelEnabled,
      allowlist: parsed.allowlist,
      seedRefs: parsed.seedRefs,
    })
    const values = {
      policySchemaVersion: policy.schemaVersion,
      policyVersion: policy.policyVersion,
      exploreEnabled: policy.exploreEnabled ? 1 : 0,
      exploreMode: policy.mode,
      modelEnabled: policy.modelEnabled ? 1 : 0,
      maxHopDepth: policy.maxHopDepth,
      maxNewPages: policy.maxNewPages,
      maxCandidates: policy.maxCandidates,
      maxActions: policy.maxActions,
      maxSeconds: policy.maxSeconds,
      sliceWorkSeconds: policy.sliceWorkSeconds,
      allowlistJson: policy.allowlist,
      seedRefsJson: policy.seedRefs,
      revision: nextRevision,
      updatedBy: actor.id,
      updatedAt: now,
    }
    if (current) await tx.update(mapExplorationPolicies).set(values).where(eq(mapExplorationPolicies.targetId, targetId))
    else await tx.insert(mapExplorationPolicies).values({ targetId, ...values })
    const result = await getExplorationPolicy(tx, targetId)
    await insertRows(tx, mapExplorationPolicyCommands, {
      id: newId(),
      targetId,
      commandKey: parsed.idempotencyKey,
      payload,
      result,
    })
    await recordAudit(tx, actor, 'map.exploration_policy.update', 'target', targetId, parsed.reason)
    return result
  })
}

export async function listMapSafeEntries(db: Db, targetId: string): Promise<{ items: MapSafeEntryDto[] }> {
  await requireLiveTarget(db, targetId)
  const { mapSafeEntries } = schemaFor(db)
  const rows = await db.select().from(mapSafeEntries).where(eq(mapSafeEntries.targetId, targetId)).orderBy(desc(mapSafeEntries.createdAt))
  return {
    items: rows.map((row) =>
      mapSafeEntryDtoSchema.parse({
        targetId,
        entryId: row.id,
        version: row.entryVersion,
        name: row.entryName,
        url: row.entryUrl,
        arrivalName: row.arrivalName,
        arrivalTarget: row.arrivalTarget,
        safetyBasis: row.safetyBasis,
        jobKinds: row.jobKinds,
        createdAt: row.createdAt.toISOString(),
      }),
    ),
  }
}

export async function createMapSafeEntry(
  db: Db,
  targetId: string,
  body: MapSafeEntryCreateBody,
  actor: ExecutionActor,
): Promise<MapSafeEntryDto> {
  const parsed = mapSafeEntryCreateBodySchema.parse(body)
  await requireLiveTarget(db, targetId)
  return atomic(db, async (tx) => {
    const { mapSafeEntries } = schemaFor(tx)
    const [receipt] = await tx
      .select()
      .from(mapSafeEntries)
      .where(and(eq(mapSafeEntries.targetId, targetId), eq(mapSafeEntries.commandKey, parsed.idempotencyKey)))
      .limit(1)
    if (receipt) {
      return mapSafeEntryDtoSchema.parse({
        targetId,
        entryId: receipt.id,
        version: receipt.entryVersion,
        name: receipt.entryName,
        url: receipt.entryUrl,
        arrivalName: receipt.arrivalName,
        arrivalTarget: receipt.arrivalTarget,
        safetyBasis: receipt.safetyBasis,
        jobKinds: receipt.jobKinds,
        createdAt: receipt.createdAt.toISOString(),
      })
    }
    const now = await clockNow(tx)
    const entry = mapSafeEntrySchema.parse({
      entryId: newId(),
      version: 1,
      name: parsed.name,
      url: parsed.url,
      arrivalName: parsed.arrivalName,
      arrivalTarget: parsed.arrivalTarget,
      safetyBasis: {
        kind: parsed.safetyBasisKind,
        summary: parsed.summary,
        confirmedBy: actor.id,
        confirmedAt: now.toISOString(),
      },
      jobKinds: parsed.jobKinds,
    })
    await insertRows(tx, mapSafeEntries, {
      id: entry.entryId,
      targetId,
      entryVersion: entry.version,
      entryName: entry.name,
      entryUrl: entry.url,
      arrivalName: entry.arrivalName,
      arrivalTarget: entry.arrivalTarget,
      safetyBasis: entry.safetyBasis,
      jobKinds: entry.jobKinds,
      commandKey: parsed.idempotencyKey,
      createdBy: actor.id,
      createdAt: now,
    })
    await recordAudit(tx, actor, 'map.safe_entry.create', 'target', targetId, parsed.summary)
    return mapSafeEntryDtoSchema.parse({ ...entry, targetId, createdAt: now.toISOString() })
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
    createdAt: Date
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
    firstRunId: slices[0]?.runId,
    slices: slices.map((slice) => ({
      sliceOrdinal: slice.sliceOrdinal,
      runId: slice.runId,
      reservedSeconds: slice.reservedSeconds,
      createdAt: slice.createdAt.toISOString(),
    })),
    createdAt: job.createdAt.toISOString(),
  })
}

export async function getMapJob(db: Db, jobId: string): Promise<MapJobDto> {
  const { mapJobs, mapJobSlices } = schemaFor(db)
  const [job] = await db.select().from(mapJobs).where(eq(mapJobs.id, jobId)).limit(1)
  if (!job) mapNotFound('地图作业不存在')
  const slices = await db.select().from(mapJobSlices).where(eq(mapJobSlices.jobId, jobId))
  return jobToDto(job, slices)
}

export async function hasReadyMapJobWorker(db: Db): Promise<boolean> {
  const { workers } = schemaFor(db)
  const rows = await db.select().from(workers)
  return rows.some((row) => row.status === 'READY' && (row.protocolCapabilities ?? []).includes(MAP_JOBS_PROTOCOL))
}

export async function hasReadyMapExploreWorker(db: Db): Promise<boolean> {
  const { workers } = schemaFor(db)
  const rows = await db.select().from(workers)
  return rows.some(
    (row) =>
      row.status === 'READY' &&
      (row.protocolCapabilities ?? []).includes(MAP_JOBS_PROTOCOL) &&
      (row.protocolCapabilities ?? []).includes(MAP_EXPLORE_PROTOCOL),
  )
}

export async function createMapJob(
  db: Db,
  targetId: string,
  body: MapJobCreateBody,
  actor: ExecutionActor,
  compiled: { steps: Step[]; releaseId?: string },
): Promise<MapJobCreateResponse> {
  const parsed = mapJobCreateBodySchema.parse(body)
  await requireLiveTarget(db, targetId)
  const commandKey = mapJobCommandKey({
    source: parsed.source,
    targetId,
    targetAccountId: parsed.targetAccountId,
    manualId: parsed.manualId,
    occurrenceId: parsed.occurrenceId,
  })
  return atomic(db, async (tx) => {
    const { mapJobCommands, mapJobs, mapJobSlices, mapSafeEntries, scenarios, scenarioVersions } = schemaFor(tx)
    const [receipt] = await tx
      .select()
      .from(mapJobCommands)
      .where(and(eq(mapJobCommands.targetId, targetId), eq(mapJobCommands.commandKey, commandKey)))
      .limit(1)
    const payload = { body: parsed, stepIds: compiled.steps.map((step) => step.id) }
    if (receipt) {
      if (canonicalJson({ body: parsed }) !== canonicalJson({ body: (receipt.payload as { body: unknown }).body })) {
        mapCommandIdempotencyConflict()
      }
      return mapJobCreateResponseSchema.parse({
        ...(receipt.result as MapJobCreateResponse),
        created: false,
      })
    }
    const policyDto = await getMapJobPolicy(tx, targetId)
    const exploreDto = parsed.jobKind === 'map_explore' ? await getExplorationPolicy(tx, targetId) : null
    if (parsed.jobKind === 'map_explore') {
      if (policyDto.revision !== parsed.expectedPolicyRevision) mapRevisionConflict('作业政策修订已变更')
      if (exploreDto!.revision !== parsed.expectedExplorationRevision) mapRevisionConflict('探索政策修订已变更')
      const factory = await getPlatformConfig(tx)
      if (factory?.document.mapExplorationEnabled !== true) mapForbidden('平台尚未开放地图探索')
      if (!exploreDto!.policy.exploreEnabled) mapForbidden('该目标尚未开放有界探索')
      if (exploreDto!.policy.modelEnabled) mapForbidden('本轮不开放模型提名')
      if (exploreDto!.policy.allowlist.length === 0) mapForbidden('没有可配置安全导航范围')
    } else {
      if (policyDto.revision !== parsed.expectedPolicyRevision) mapRevisionConflict('作业政策修订已变更')
      if (!policyDto.policy.manualJobsEnabled) {
        mapForbidden('手工地图作业尚未对该目标开放')
      }
    }
    const [entry] = await tx.select().from(mapSafeEntries).where(eq(mapSafeEntries.id, parsed.entryId)).limit(1)
    if (!entry || entry.targetId !== targetId) mapNotFound('安全进入路径不存在')
    if (!entry.jobKinds.includes(parsed.jobKind)) mapForbidden('该进入路径不适用于此作业类型')
    await requireMapCapableAccount(tx, targetId, parsed.targetAccountId)
    const session = await findLiveSession(tx, { targetId, targetAccountId: parsed.targetAccountId })
    if (!session || session.status !== 'OPEN' || session.authState !== 'AUTHENTICATED') {
      mapAuthPreparationRequired()
    }
    if (parsed.jobKind === 'map_explore') {
      if (!(await hasReadyMapExploreWorker(tx))) mapConsumerUnavailable('没有具备地图探索能力的 Worker')
    } else if (!(await hasReadyMapJobWorker(tx))) {
      mapConsumerUnavailable('没有具备地图作业能力的 Worker')
    }
    const now = await clockNow(tx)
    const jobId = newId()
    const budget =
      parsed.jobKind === 'map_probe'
        ? policyDto.policy.maxProbeSeconds
        : parsed.jobKind === 'map_explore'
          ? exploreDto!.policy.maxSeconds
          : policyDto.policy.maxRefreshSeconds
    const reserved = Math.min(
      parsed.jobKind === 'map_explore' ? exploreDto!.policy.sliceWorkSeconds : policyDto.policy.sliceWorkSeconds,
      budget,
    )
    try {
      await insertRows(tx, mapJobs, {
        id: jobId,
        targetId,
        targetAccountId: parsed.targetAccountId,
        jobKind: parsed.jobKind,
        jobStatus: 'queued',
        remainingBudgetSeconds: budget - reserved,
        policyRevision: policyDto.revision || 1,
        entryId: entry.id,
        releaseId: compiled.releaseId ?? null,
        requestJson: parsed,
        frozenPolicyJson: policyDto.policy,
        activeGuard: 'Y',
        revision: 1,
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
      })
    } catch (error) {
      if (isUniqueViolation(error)) mapActiveSliceExists()
      throw error
    }
    const scenarioId = newId()
    const versionId = newId()
    const steps = compiled.steps.map((step) => ({ ...step, id: newId() }))
    const definition = scenarioDefinitionFromSteps(steps)
    await tx.insert(scenarios).values({
      id: scenarioId,
      targetId,
      name: `[地图作业] ${jobId}`,
      status: 'active',
      purpose: 'map_job',
      createdByConsoleAccountId: actor.id,
      createdAt: now,
      updatedAt: now,
    })
    await tx.insert(scenarioVersions).values({
      id: versionId,
      scenarioId,
      versionNo: 1,
      kind: 'published',
      definition,
      compilerVersion: COMPILER_VERSION,
      sourceDigest: `${jobId}:0`,
      createdByConsoleAccountId: actor.id,
      createdAt: now,
    })
    const created = await createRunWithSnapshot(tx, {
      scenarioId,
      scenarioVersionId: versionId,
      targetAccountId: parsed.targetAccountId,
      actor,
      deadlineAt: new Date(now.getTime() + reserved * 1000),
      mapCapturePolicy: { enabled: true },
      mapConsumption: { mode: 'off' },
      mapJob: frozenMapJobSchema.parse({
        jobId,
        sliceOrdinal: 0,
        purpose: parsed.jobKind,
        releaseId: compiled.releaseId,
        entryId: entry.id,
        policyRevision: policyDto.revision || 1,
        remainingBudgetSeconds: budget - reserved,
        consumerVersion: MAP_JOBS_PROTOCOL,
        startBefore: parsed.startBefore,
        source: parsed.source,
        occurrenceId: parsed.occurrenceId,
      }),
    })
    await insertRows(tx, mapJobSlices, {
      id: newId(),
      jobId,
      targetId,
      sliceOrdinal: 0,
      runId: created.detail.id,
      reservedSeconds: reserved,
      createdAt: now,
    })
    const dto = await getMapJob(tx, jobId)
    const result = mapJobCreateResponseSchema.parse({ job: dto, created: true })
    await insertRows(tx, mapJobCommands, { id: newId(), targetId, commandKey, payload, result })
    await recordAudit(
      tx,
      actor,
      parsed.jobKind === 'map_explore' ? 'map.explore.create' : 'map.job.create',
      'target',
      targetId,
      `${parsed.jobKind} ${parsed.manualId ?? parsed.occurrenceId ?? ''}`,
    )
    return result
  })
}

export async function cancelMapJob(db: Db, jobId: string, actor: ExecutionActor): Promise<MapJobDto> {
  return atomic(db, async (tx) => {
    const { mapJobs, mapJobSlices } = schemaFor(tx)
    const [job] = await locked(tx, tx.select().from(mapJobs).where(eq(mapJobs.id, jobId)))
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
    return getMapJob(tx, jobId)
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
    const [job] = await locked(tx, tx.select().from(mapJobs).where(eq(mapJobs.id, slice.jobId)))
    if (!job || job.jobStatus === 'cancelled') return { continue: false, jobId: slice.jobId }
    const now = await clockNow(tx)
    const stop: MapJobStopReason =
      outcome === 'cancelled' ? 'cancelled' : outcome === 'failed' ? 'slice_failed' : 'completed'
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

export async function getMapSafeEntry(db: Db, targetId: string, entryId: string): Promise<MapSafeEntryDto> {
  await requireLiveTarget(db, targetId)
  const { mapSafeEntries } = schemaFor(db)
  const [row] = await db.select().from(mapSafeEntries).where(eq(mapSafeEntries.id, entryId)).limit(1)
  if (!row || row.targetId !== targetId) mapNotFound('安全进入路径不存在')
  return mapSafeEntryDtoSchema.parse({
    targetId,
    entryId: row.id,
    version: row.entryVersion,
    name: row.entryName,
    url: row.entryUrl,
    arrivalName: row.arrivalName,
    arrivalTarget: row.arrivalTarget,
    safetyBasis: row.safetyBasis,
    jobKinds: row.jobKinds,
    createdAt: row.createdAt.toISOString(),
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
