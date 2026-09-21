import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import {
  ANALYSIS_LEASE_TTL_MS,
  ANALYSIS_MAX_ATTEMPTS,
  analysisJobDtoSchema,
  platformAiConnectionReady,
  type AnalysisBudget,
  type AnalysisJobDto,
  type AnalysisMode,
  type AnalysisSourceScope,
  type ExecutionActor,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit } from '../audit/record.js'
import { decodeAuditCursor, encodeAuditCursor } from '../audit/cursor.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, onCommit, schemaFor } from '../native.js'
import { publishChangeHint } from '../observe/hint.js'
import { DomainError, conflict, forbidden, notFound } from '../runs/errors.js'
import { analysisScopeDigest, backfillAnalysisSources } from './sources.js'
import { assertTargetPermission, lockConsoleAuthorization, scopedTargetFilter } from '../console/target-authorization.js'
import { requireLiveTarget } from '../map/view.js'
import { getOrCreatePlatformConfig } from '../platform-config/store.js'

export async function assertAnalysisAccess(db: Db, actorId: string, targetId: string, mode: string) {
  await assertTargetPermission(db, actorId, targetId, 'map:analyze')
  await assertTargetPermission(db, actorId, targetId, mode === 'run_incremental' ? 'run:read' : 'map:read')
}

async function assertAnalysisTargetEnabled(db: Db, targetId: string) {
  const target = await requireLiveTarget(db, targetId)
  if (target.status !== 'active') throw conflict('TARGET_DISABLED', '目标系统已停用')
}

function toDto(row: {
  id: string
  targetId: string
  scheduleId: string | null
  occurrenceId: string | null
  mode: string
  status: string
  sourceScope: AnalysisSourceScope
  strategyVersion: string
  budget: AnalysisBudget
  afterSeq: number
  throughSeq: number | null
  checkpointSeq: number
  result: Record<string, unknown> | null
  coverageGaps: string[]
  modelUsage: Record<string, unknown> | null
  attemptCount: number
  fencingToken: number
  cancelRequestedAt: Date | null
  createdAt: Date
  updatedAt: Date
}): AnalysisJobDto {
  return analysisJobDtoSchema.parse({
    analysisJobId: row.id,
    targetId: row.targetId,
    scheduleId: row.scheduleId,
    occurrenceId: row.occurrenceId,
    mode: row.mode,
    status: row.status,
    source: row.sourceScope,
    strategyVersion: row.strategyVersion,
    budget: row.budget,
    afterSeq: row.afterSeq,
    throughSeq: row.throughSeq,
    checkpointSeq: row.checkpointSeq,
    result: row.result,
    coverageGaps: row.coverageGaps,
    modelUsage: row.modelUsage,
    attemptCount: row.attemptCount,
    fencingToken: row.fencingToken,
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

export async function appendJobEvent(
  tx: Db,
  jobId: string,
  eventType: string,
  payload: Record<string, unknown>,
  now: Date,
) {
  const { analysisJobEvents } = schemaFor(tx)
  const [max] = await tx
    .select({ seq: sql<number>`COALESCE(MAX(${analysisJobEvents.seq}), 0)` })
    .from(analysisJobEvents)
    .where(eq(analysisJobEvents.jobId, jobId))
  const seq = Number(max?.seq ?? 0) + 1
  await insertRows(tx, analysisJobEvents, {
    id: newId(),
    jobId,
    seq,
    eventType,
    payload,
    createdAt: now,
  })
  onCommit(tx, () => publishChangeHint({ objectType: 'analysis_job', objectId: jobId, eventSeq: seq }))
}

export async function getAnalysisJob(db: Db, jobId: string, actorId?: string): Promise<AnalysisJobDto> {
  const { analysisJobs, analysisJobAttempts, analysisCandidates, mapAuthoringProposals } = schemaFor(db)
  const [row] = await db.select().from(analysisJobs).where(eq(analysisJobs.id, jobId)).limit(1)
  if (!row) throw notFound('ANALYSIS_JOB_NOT_FOUND', '分析作业不存在')
  if (actorId) await assertAnalysisAccess(db, actorId, row.targetId, row.mode)
  await requireLiveTarget(db, row.targetId)
  const attempts = await db
    .select()
    .from(analysisJobAttempts)
    .where(eq(analysisJobAttempts.jobId, jobId))
    .orderBy(analysisJobAttempts.attemptNo)
  const candidates = await db
    .select()
    .from(analysisCandidates)
    .where(eq(analysisCandidates.jobId, jobId))
    .orderBy(desc(analysisCandidates.createdAt))
  return analysisJobDtoSchema.parse({
    ...toDto(row),
    attempts: attempts.map((item) => ({
      attemptId: item.id,
      attemptNo: item.attemptNo,
      status: item.status,
      fencingToken: item.fencingToken,
      startedAt: item.startedAt?.toISOString() ?? null,
      finishedAt: item.finishedAt?.toISOString() ?? null,
      error: item.error,
      modelUsage: item.modelUsage,
    })),
    candidates: await Promise.all(candidates.map(async (item) => {
      const destination = item.review?.destination
      const proposal = destination?.kind === 'proposal' ? (await db.select({ status: mapAuthoringProposals.proposalStatus }).from(mapAuthoringProposals).where(eq(mapAuthoringProposals.id, destination.proposalId)).limit(1))[0] : undefined
      return ({
      candidateId: item.id,
      jobId: item.jobId,
      kind: item.kind,
      title: item.title,
      summary: item.summary,
      sources: item.sources,
      status: proposal?.status === 'accepted' ? 'accepted' : item.status,
      revision: item.revision,
      review: item.review,
      proposalStatus: proposal?.status,
      createdAt: item.createdAt.toISOString(),
    }) })),
  })
}

export async function listAnalysisJobEvents(db: Db, jobId: string, after = 0, actorId?: string) {
  await getAnalysisJob(db, jobId, actorId)
  const { analysisJobEvents } = schemaFor(db)
  return db
    .select()
    .from(analysisJobEvents)
    .where(and(eq(analysisJobEvents.jobId, jobId), sql`${analysisJobEvents.seq} > ${after}`))
    .orderBy(analysisJobEvents.seq)
    .limit(100)
}

export async function createAnalysisJob(
  db: Db,
  input: {
    targetId: string
    scheduleId?: string
    occurrenceId?: string
    mode: AnalysisMode
    source: AnalysisSourceScope
    strategyVersion: string
    budget: AnalysisBudget
    actor: ExecutionActor
  },
): Promise<AnalysisJobDto> {
  await assertAnalysisAccess(db, input.actor.id, input.targetId, input.mode)
  if (input.mode === 'run_incremental') await backfillAnalysisSources(db, input.targetId)
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, input.actor.id)
    await assertAnalysisAccess(tx, input.actor.id, input.targetId, input.mode)
    if (input.budget.useAi) await assertTargetPermission(tx, input.actor.id, input.targetId, 'ai:execute')
    await assertAnalysisTargetEnabled(tx, input.targetId)
    const { analysisJobs, analysisCheckpoints, targets, analysisCommitSeq } = schemaFor(tx)
    // Serialize first-checkpoint creation and same-scope admission, including
    // calls made without a schedule. Locking an absent checkpoint is not enough.
    await locked(tx, tx.select({ id: targets.id }).from(targets).where(eq(targets.id, input.targetId)))
    const now = await clockNow(tx)
    const config = await getOrCreatePlatformConfig(tx)
    if (
      input.budget.useAi &&
      (!config.document.analysisAi.enabled || !platformAiConnectionReady(config.document.platformAi))
    ) {
      throw conflict('ANALYSIS_CONFIG_INVALID', '知识分析模型尚未配置或启用')
    }
    const digest = analysisScopeDigest({
      targetId: input.targetId,
      mode: input.mode,
      source: input.source,
      strategyVersion: input.strategyVersion,
    })
    const [checkpoint] = await tx
      .select()
      .from(analysisCheckpoints)
      .where(
        and(
          eq(analysisCheckpoints.targetId, input.targetId),
          eq(analysisCheckpoints.scopeDigest, digest),
          eq(analysisCheckpoints.strategyGeneration, input.strategyVersion),
        ),
      )
      .limit(1)
    const active = await tx
      .select()
      .from(analysisJobs)
      .where(
        and(
          eq(analysisJobs.targetId, input.targetId),
          eq(analysisJobs.mode, input.mode),
          inArray(analysisJobs.status, ['QUEUED', 'RUNNING', 'RETRY_WAIT']),
        ),
      )
    if (active.some((row) => analysisScopeDigest({ targetId: row.targetId, mode: row.mode, source: row.sourceScope, strategyVersion: row.strategyVersion }) === digest)) {
      throw conflict('ANALYSIS_ACTIVE_EXISTS', '同范围已有执行中或待执行的分析作业')
    }
    const [watermark] = await tx.select().from(analysisCommitSeq).where(eq(analysisCommitSeq.targetId, input.targetId)).limit(1)
    const throughSeq = watermark?.seq ?? 0
    const id = newId()
    await insertRows(tx, analysisJobs, {
      id,
      targetId: input.targetId,
      scheduleId: input.scheduleId ?? null,
      occurrenceId: input.occurrenceId ?? null,
      mode: input.mode,
      status: 'QUEUED',
      sourceScope: input.source,
      strategyVersion: input.strategyVersion,
      budget: input.budget,
      afterSeq: checkpoint?.cursorSeq ?? 0,
      throughSeq,
      checkpointSeq: checkpoint?.cursorSeq ?? 0,
      result: null,
      coverageGaps: [],
      modelUsage: null,
      attemptCount: 0,
      fencingToken: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextRetryAt: null,
      cancelRequestedAt: null,
      authorizedActorId: input.actor.id,
      createdAt: now,
      updatedAt: now,
    })
    await appendJobEvent(tx, id, 'queued', { mode: input.mode, afterSeq: checkpoint?.cursorSeq ?? 0 }, now)
    return toDto({
      id,
      targetId: input.targetId,
      scheduleId: input.scheduleId ?? null,
      occurrenceId: input.occurrenceId ?? null,
      mode: input.mode,
      status: 'QUEUED',
      sourceScope: input.source,
      strategyVersion: input.strategyVersion,
      budget: input.budget,
      afterSeq: checkpoint?.cursorSeq ?? 0,
      throughSeq,
      checkpointSeq: checkpoint?.cursorSeq ?? 0,
      result: null,
      coverageGaps: [],
      modelUsage: null,
      attemptCount: 0,
      fencingToken: 0,
      cancelRequestedAt: null,
      createdAt: now,
      updatedAt: now,
    })
  })
}

export async function claimAnalysisJob(db: Db, owner: string, limit = 4) {
  return atomic(db, async (tx) => {
    const { platformConfig } = schemaFor(tx)
    await locked(tx, tx.select({ id: platformConfig.id }).from(platformConfig))
    const config = await getOrCreatePlatformConfig(tx)
    if (!config.document.knowledgeAnalysisEnabled) return []
    const { analysisJobs, analysisJobAttempts, analysisCommitSeq } = schemaFor(tx)
    const now = await clockNow(tx)
    const active = await tx.select({ id: analysisJobs.id }).from(analysisJobs).where(and(eq(analysisJobs.status, 'RUNNING'), sql`${analysisJobs.leaseExpiresAt} > ${now}`))
    const capacity = Math.max(0, config.document.analysisAi.maxConcurrentJobs - active.length)
    if (!capacity) return []
    const candidates = await tx
      .select()
      .from(analysisJobs)
      .where(
        or(
          and(eq(analysisJobs.status, 'QUEUED')),
          and(eq(analysisJobs.status, 'RETRY_WAIT'), lte(analysisJobs.nextRetryAt, now)),
          and(eq(analysisJobs.status, 'RUNNING'), lte(analysisJobs.leaseExpiresAt, now)),
        ),
      )
      .orderBy(analysisJobs.createdAt)
      .limit(Math.min(limit, capacity))
    const claimed: AnalysisJobDto[] = []
    for (const row of candidates) {
      const [lockedRow] = await locked(tx, tx.select().from(analysisJobs).where(eq(analysisJobs.id, row.id)))
      if (!lockedRow || lockedRow.cancelRequestedAt) {
        if (lockedRow?.cancelRequestedAt) {
          await tx
            .update(analysisJobs)
            .set({ status: 'CANCELLED', leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
            .where(eq(analysisJobs.id, row.id))
        }
        continue
      }
      if (!['QUEUED', 'RETRY_WAIT', 'RUNNING'].includes(lockedRow.status)) continue
      if (lockedRow.status === 'RETRY_WAIT' && lockedRow.nextRetryAt && lockedRow.nextRetryAt > now) continue
      if (lockedRow.status === 'RUNNING' && lockedRow.leaseExpiresAt && lockedRow.leaseExpiresAt.getTime() > now.getTime()) {
        continue
      }
      let failure: string | undefined
      if (lockedRow.status === 'RUNNING') {
        await tx.update(analysisJobAttempts).set({ status: 'FAILED', finishedAt: now, error: 'ANALYSIS_LEASE_EXPIRED' })
          .where(and(eq(analysisJobAttempts.jobId, row.id), eq(analysisJobAttempts.fencingToken, lockedRow.fencingToken)))
      }
      if (lockedRow.attemptCount >= ANALYSIS_MAX_ATTEMPTS) failure = 'ANALYSIS_ATTEMPTS_EXHAUSTED'
      try {
        await assertAnalysisAccess(tx, lockedRow.authorizedActorId, lockedRow.targetId, lockedRow.mode)
        if (lockedRow.budget.useAi) await assertTargetPermission(tx, lockedRow.authorizedActorId, lockedRow.targetId, 'ai:execute')
        await assertAnalysisTargetEnabled(tx, lockedRow.targetId)
      } catch (error) {
        if (!(error instanceof DomainError)) throw error
        failure = error.code
      }
      if (failure) {
        await tx.update(analysisJobs).set({ status: 'FAILED', leaseOwner: null, leaseExpiresAt: null, result: { error: failure }, updatedAt: now }).where(eq(analysisJobs.id, row.id))
        await appendJobEvent(tx, row.id, 'failed', { error: failure }, now)
        continue
      }
      const fencing = lockedRow.fencingToken + 1
      const attemptNo = lockedRow.attemptCount + 1
      // Legacy queued jobs did not freeze an upper bound at creation.
      const [watermark] = lockedRow.throughSeq === null
        ? await tx.select().from(analysisCommitSeq).where(eq(analysisCommitSeq.targetId, lockedRow.targetId)).limit(1)
        : []
      await tx
        .update(analysisJobs)
        .set({
          status: 'RUNNING',
          fencingToken: fencing,
          attemptCount: attemptNo,
          throughSeq: lockedRow.throughSeq ?? Math.max(lockedRow.afterSeq, watermark?.seq ?? 0),
          leaseOwner: owner,
          leaseExpiresAt: new Date(now.getTime() + ANALYSIS_LEASE_TTL_MS),
          nextRetryAt: null,
          updatedAt: now,
        })
        .where(eq(analysisJobs.id, lockedRow.id))
      await insertRows(tx, analysisJobAttempts, {
        id: newId(),
        jobId: lockedRow.id,
        attemptNo,
        status: 'RUNNING',
        fencingToken: fencing,
        startedAt: now,
        finishedAt: null,
        error: null,
      })
      await appendJobEvent(tx, lockedRow.id, 'claimed', { owner, fencingToken: fencing, attemptNo }, now)
      claimed.push(await getAnalysisJob(tx, lockedRow.id))
    }
    return claimed
  })
}

export async function heartbeatAnalysisJob(db: Db, jobId: string, owner: string, fencingToken: number) {
  return atomic(db, async (tx) => {
    const { analysisJobs } = schemaFor(tx)
    const now = await clockNow(tx)
    const [row] = await locked(tx, tx.select().from(analysisJobs).where(eq(analysisJobs.id, jobId)))
    if (!row || row.leaseOwner !== owner || row.fencingToken !== fencingToken || row.status !== 'RUNNING' || !row.leaseExpiresAt || row.leaseExpiresAt <= now) {
      throw conflict('ANALYSIS_LEASE_LOST', '分析作业租约已失效')
    }
    if (row.cancelRequestedAt) throw conflict('ANALYSIS_CANCELLED', '分析作业已请求取消')
    await assertAnalysisAccess(tx, row.authorizedActorId, row.targetId, row.mode)
    await assertAnalysisTargetEnabled(tx, row.targetId)
    if (row.budget.useAi) await assertTargetPermission(tx, row.authorizedActorId, row.targetId, 'ai:execute')
    await tx
      .update(analysisJobs)
      .set({ leaseExpiresAt: new Date(now.getTime() + ANALYSIS_LEASE_TTL_MS), updatedAt: now })
      .where(eq(analysisJobs.id, jobId))
  })
}

export async function submitAnalysisJob(
  db: Db,
  input: {
    jobId: string
    owner: string
    fencingToken: number
    expectedCursor: number
    throughSeq: number
    result: Record<string, unknown>
    coverageGaps: string[]
    modelUsage: Record<string, unknown>
    candidates?: Array<{
      kind: 'term' | 'experience' | 'failure_mode' | 'knowledge_revision' | 'map_refresh_suggestion'
      title: string
      summary: string
      sources: Record<string, unknown>[]
      payload?: Record<string, unknown>
    }>
    noNewData?: boolean
  },
) {
  return atomic(db, async (tx) => {
    const { analysisJobs, analysisJobAttempts, analysisCandidates, analysisCheckpoints } = schemaFor(tx)
    const now = await clockNow(tx)
    const [row] = await locked(tx, tx.select().from(analysisJobs).where(eq(analysisJobs.id, input.jobId)))
    if (!row) throw notFound('ANALYSIS_JOB_NOT_FOUND', '分析作业不存在')
    if (row.leaseOwner !== input.owner || row.fencingToken !== input.fencingToken || row.status !== 'RUNNING' || !row.leaseExpiresAt || row.leaseExpiresAt <= now) {
      throw conflict('ANALYSIS_LEASE_LOST', '迟到结果已被拒绝')
    }
    if (row.cancelRequestedAt) {
      throw conflict('ANALYSIS_CANCELLED', '取消后的结果不能生效')
    }
    await assertAnalysisAccess(tx, row.authorizedActorId, row.targetId, row.mode)
    await assertAnalysisTargetEnabled(tx, row.targetId)
    if (row.budget.useAi) await assertTargetPermission(tx, row.authorizedActorId, row.targetId, 'ai:execute')
    if (row.checkpointSeq !== input.expectedCursor) {
      throw conflict('ANALYSIS_CURSOR_CONFLICT', '检查点已前进，本次结果不能覆盖')
    }
    if (!Number.isSafeInteger(input.throughSeq) || input.throughSeq < input.expectedCursor || input.throughSeq > (row.throughSeq ?? row.afterSeq)) {
      throw conflict('ANALYSIS_CURSOR_CONFLICT', '结果超出本次冻结的数据范围')
    }
    const digest = analysisScopeDigest({
      targetId: row.targetId,
      mode: row.mode,
      source: row.sourceScope,
      strategyVersion: row.strategyVersion,
    })
    {
      const [checkpoint] = await locked(
        tx,
        tx
          .select()
          .from(analysisCheckpoints)
          .where(
            and(
              eq(analysisCheckpoints.targetId, row.targetId),
              eq(analysisCheckpoints.scopeDigest, digest),
              eq(analysisCheckpoints.strategyGeneration, row.strategyVersion),
            ),
          ),
      )
      if ((checkpoint?.cursorSeq ?? 0) !== input.expectedCursor) {
        throw conflict('ANALYSIS_CURSOR_CONFLICT', '持久化检查点已变化，不能覆盖其他批次结果')
      }
      if (checkpoint) {
        await tx
          .update(analysisCheckpoints)
          .set({ cursorSeq: input.throughSeq, updatedAt: now })
          .where(eq(analysisCheckpoints.id, checkpoint.id))
      } else {
        await insertRows(tx, analysisCheckpoints, {
          id: newId(),
          targetId: row.targetId,
          scopeDigest: digest,
          strategyGeneration: row.strategyVersion,
          cursorSeq: input.throughSeq,
          updatedAt: now,
        })
      }
    }
    for (const candidate of input.candidates ?? []) {
      await insertRows(tx, analysisCandidates, {
        id: newId(),
        jobId: row.id,
        targetId: row.targetId,
        kind: candidate.kind,
        title: candidate.title,
        summary: candidate.summary,
        payload: candidate.payload ?? {},
        sources: candidate.sources,
        status: 'pending',
        createdAt: now,
      })
    }
    await tx
      .update(analysisJobs)
      .set({
        status: 'SUCCEEDED',
        throughSeq: input.throughSeq,
        checkpointSeq: input.throughSeq,
        result: input.result,
        coverageGaps: input.coverageGaps,
        modelUsage: input.modelUsage,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(analysisJobs.id, row.id))
    await tx
      .update(analysisJobAttempts)
      .set({ status: 'SUCCEEDED', finishedAt: now, modelUsage: input.modelUsage })
      .where(and(eq(analysisJobAttempts.jobId, row.id), eq(analysisJobAttempts.fencingToken, input.fencingToken)))
    await appendJobEvent(tx, row.id, input.noNewData ? 'no_new_data' : 'succeeded', { throughSeq: input.throughSeq }, now)
    return getAnalysisJob(tx, row.id)
  })
}

export async function recordAnalysisModelUsage(db: Db, jobId: string, owner: string, fencingToken: number, modelUsage: Record<string, unknown>) {
  return atomic(db, async tx => {
    await heartbeatAnalysisJob(tx, jobId, owner, fencingToken)
    const { analysisJobAttempts, analysisJobs } = schemaFor(tx)
    await tx.update(analysisJobAttempts).set({ modelUsage }).where(and(eq(analysisJobAttempts.jobId, jobId), eq(analysisJobAttempts.fencingToken, fencingToken)))
    await tx.update(analysisJobs).set({ modelUsage }).where(eq(analysisJobs.id, jobId))
  })
}

export async function failAnalysisJob(
  db: Db,
  input: { jobId: string; owner: string; fencingToken: number; error: string; retryable: boolean; modelUsage?: Record<string, unknown> },
) {
  return atomic(db, async (tx) => {
    const { analysisJobs, analysisJobAttempts } = schemaFor(tx)
    const now = await clockNow(tx)
    const [row] = await locked(tx, tx.select().from(analysisJobs).where(eq(analysisJobs.id, input.jobId)))
    if (!row || row.leaseOwner !== input.owner || row.fencingToken !== input.fencingToken || row.status !== 'RUNNING' || !row.leaseExpiresAt || row.leaseExpiresAt <= now) {
      throw conflict('ANALYSIS_LEASE_LOST', '分析作业租约已失效')
    }
    const retry = input.retryable && row.attemptCount < ANALYSIS_MAX_ATTEMPTS
    await tx
      .update(analysisJobs)
      .set({
        status: retry ? 'RETRY_WAIT' : 'FAILED',
        nextRetryAt: retry ? new Date(now.getTime() + row.attemptCount * 15_000) : null,
        leaseOwner: null,
        leaseExpiresAt: null,
        result: { error: input.error },
        modelUsage: input.modelUsage ?? row.modelUsage,
        updatedAt: now,
      })
      .where(eq(analysisJobs.id, row.id))
    await tx
      .update(analysisJobAttempts)
      .set({ status: 'FAILED', finishedAt: now, error: input.error, modelUsage: input.modelUsage ?? null })
      .where(and(eq(analysisJobAttempts.jobId, row.id), eq(analysisJobAttempts.fencingToken, input.fencingToken)))
    await appendJobEvent(tx, row.id, retry ? 'retry_wait' : 'failed', { error: input.error }, now)
    return getAnalysisJob(tx, row.id)
  })
}

export async function cancelAnalysisJob(db: Db, jobId: string, actor: ExecutionActor, idempotencyKey: string) {
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actor.id)
    await getAnalysisJob(tx, jobId, actor.id)
    const { analysisCommands, analysisJobs, analysisJobAttempts } = schemaFor(tx)
    const payload = { jobId, actorId: actor.id }
    const [receipt] = await tx.select().from(analysisCommands).where(eq(analysisCommands.commandKey, idempotencyKey)).limit(1)
    if (receipt) {
      if (receipt.payload.jobId !== jobId || receipt.payload.actorId !== actor.id) throw conflict('ANALYSIS_IDEMPOTENCY_CONFLICT', '幂等键已被其他取消命令使用')
      return analysisJobDtoSchema.parse(receipt.result)
    }
    const [row] = await locked(tx, tx.select().from(analysisJobs).where(eq(analysisJobs.id, jobId)))
    if (!row) throw notFound('ANALYSIS_JOB_NOT_FOUND', '分析作业不存在')
    const now = await clockNow(tx)
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(row.status)) {
      const dto = toDto(row)
      await insertRows(tx, analysisCommands, {
        id: newId(),
        commandKey: idempotencyKey,
        payload,
        result: dto,
        createdAt: now,
      })
      return dto
    }
    await tx
      .update(analysisJobs)
      .set({
        cancelRequestedAt: now,
        status: 'CANCELLED',
        leaseOwner: null,
        leaseExpiresAt: null,
        fencingToken: row.fencingToken + 1,
        updatedAt: now,
      })
      .where(eq(analysisJobs.id, jobId))
    await tx.update(analysisJobAttempts).set({ status: 'CANCELLED', finishedAt: now })
      .where(and(eq(analysisJobAttempts.jobId, jobId), eq(analysisJobAttempts.status, 'RUNNING')))
    await appendJobEvent(tx, jobId, 'cancelled', { actorId: actor.id }, now)
    await recordAudit(tx, actor, 'analysis.cancel', 'target', row.targetId, `取消分析作业 ${jobId}`)
    const dto = await getAnalysisJob(tx, jobId)
    await insertRows(tx, analysisCommands, {
      id: newId(),
      commandKey: idempotencyKey,
      payload,
      result: dto,
      createdAt: now,
    })
    return dto
  })
}

export async function listAnalysisJobs(db: Db, query: { targetId?: string; status?: string; cursor?: string; limit: number }, actorId?: string) {
  const { analysisJobs } = schemaFor(db)
  const decoded = query.cursor ? decodeAuditCursor(query.cursor) : null
  const rows = await db
    .select()
    .from(analysisJobs)
    .where(
      and(
        await scopedTargetFilter(db, actorId, analysisJobs.targetId, 'map:analyze'),
        actorId ? or(
          and(eq(analysisJobs.mode, 'run_incremental'), await scopedTargetFilter(db, actorId, analysisJobs.targetId, 'run:read')),
          and(eq(analysisJobs.mode, 'map_quality'), await scopedTargetFilter(db, actorId, analysisJobs.targetId, 'map:read')),
        ) : undefined,
        query.targetId ? eq(analysisJobs.targetId, query.targetId) : undefined,
        query.status ? eq(analysisJobs.status, query.status as any) : undefined,
        decoded
          ? or(
              sql`${analysisJobs.createdAt} < ${decoded.createdAt}`,
              and(eq(analysisJobs.createdAt, decoded.createdAt), sql`${analysisJobs.id} < ${decoded.id}`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(analysisJobs.createdAt), desc(analysisJobs.id))
    .limit(query.limit + 1)
  const page = rows.slice(0, query.limit)
  return {
    items: page.map(toDto),
    nextCursor: rows.length > query.limit ? encodeAuditCursor(page.at(-1)!.createdAt, page.at(-1)!.id) : undefined,
  }
}

export { analysisScopeDigest }
