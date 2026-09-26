import { and, eq, inArray, isNull } from 'drizzle-orm'
import {
  FACTORY_MAP_JOB_POLICY,
  MAP_JOBS_PROTOCOL,
  canonicalJson,
  isMapJobRun,
  mapJobDtoSchema,
  mapJobPolicyDtoSchema,
  mapJobPolicySchema,
  mapJobPolicyUpdateBodySchema,
  type ExecutionActor,
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
import { mapCommandIdempotencyConflict, mapNotFound, mapRevisionConflict } from './errors.js'
import { requireLiveTarget } from './view.js'
import { requireTargetHasMapCapableAccount } from '../console/account-usage.js'

function jobPolicyFromRow(row: {
  policySchemaVersion: number
  policyVersion: number
  manualJobsEnabled: number
  sliceWorkSeconds: number
}): MapJobPolicy {
  return mapJobPolicySchema.parse({
    schemaVersion: row.policySchemaVersion,
    policyVersion: row.policyVersion,
    manualJobsEnabled: row.manualJobsEnabled === 1,
    sliceWorkSeconds: row.sliceWorkSeconds,
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
      sliceWorkSeconds: policy.sliceWorkSeconds,
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
