import { schemaFor } from '../native.js'
import { updateRows } from '../native.js'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  CANCELLED_ATTEMPT_ERROR,
  isFinishedRunStatus,
  isHaltedRunStatus,
  type EffectType,
  type ExecutionError,
  type RunGrant,
  type RunLeaseErrorCode,
  type RunSnapshot,
  type RunStatus,
} from '@cairn/shared'
import { recordAudit, type AuditActor } from '../audit/record.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import {
  countFailedRecoveries,
  expireLeaseIfDue,
  findActiveLeaseForRun,
  listDriftedRunningIds,
  listExpiredActiveLeases,
  lockRunRow,
  releaseRunLeaseTx,
  verifyRunLeaseForWrite,
} from '../leases/leases.js'
import { attempts, evidences, runs, stepRuns } from '../schema/execution.js'
import { settleRunEvidence } from '../objects/evidence.js'
import { appendRunEvents } from '../observe/events.js'
import { conflict, notFound } from './errors.js'
import { cancelPendingStepRunsTx, skipRemainingStepRunsTx } from './step-status.js'

const RUN_RECOVERY_EXHAUSTED: RunLeaseErrorCode = 'RUN_RECOVERY_EXHAUSTED'

const RECOVERY_EXHAUSTED_ERROR: ExecutionError = {
  code: RUN_RECOVERY_EXHAUSTED,
  category: 'UNKNOWN',
  retryable: false,
  safeMessage: '同一运行恢复次数已耗尽',
}

export type SettleOutcome = 'skipped' | 'expired' | 'cancelled' | 'needs_review' | 'recovering'

export async function settleLeaselessRun(
  db: Db,
  input: {
    runId: string
    leaseId?: string
    maxRecoveries: number
    /**
     * 仅测试：租约已置 EXPIRED、Run 已迁移，提交前抛错。
     *
     * 租约过期与 Run 状态迁移必须同生共死：只落一半就会出现「租约没了但 Run 还挂在
     * RUNNING」或反之，恢复扫描从此看不见它。没有注入点这条就只能靠读码确认。
     */
    injectFailure?: Error
  },
): Promise<SettleOutcome> {
  const { evidences, runs } = schemaFor(db)
  return db.transaction(async (tx) => {
    const run = await lockRunRow(tx as unknown as Db, input.runId)
    if (!run) return 'skipped'

    if (input.leaseId) {
      const expired = await expireLeaseIfDue(tx as unknown as Db, input.leaseId)
      if (!expired) return 'skipped'
    }

    if (isFinishedRunStatus(run.status) || run.status === 'NEEDS_REVIEW') {
      return 'expired'
    }

    const now = new Date()
    if (run.cancelRequestedAt) {
      const outcome = await settleRunCancellationTx(tx as unknown as Db, input.runId, now)
      return outcome === 'pending' ? 'skipped' : outcome
    }

    const failed = await countFailedRecoveries(tx as unknown as Db, input.runId)
    if (failed >= input.maxRecoveries) {
      await closeRunningAttemptsTx(tx as unknown as Db, input.runId, now)
      // 不写 finished_at：NEEDS_REVIEW 只是停下来等人，结论由 reviewRun 给出（D11）。
      await tx
        .update(runs)
        .set({ status: 'NEEDS_REVIEW', updatedAt: now })
        .where(eq(runs.id, input.runId))
      await tx.insert(evidences).values({
        id: newId(),
        runId: input.runId,
        type: 'error',
        schemaVersion: 1,
        payload: RECOVERY_EXHAUSTED_ERROR,
        createdAt: now,
      })
      await appendRunEvents(tx as unknown as Db, input.runId, [
        { type: 'run.status_changed', payload: { status: 'NEEDS_REVIEW' } },
        { type: 'evidence.recorded', payload: { type: 'error', status: 'available' } },
      ])
      return 'needs_review'
    }

    if (run.status === 'RUNNING') {
      await tx
        .update(runs)
        .set({ status: 'RECOVERING', updatedAt: now })
        .where(eq(runs.id, input.runId))
      if (input.injectFailure) throw input.injectFailure
      await appendRunEvents(tx as unknown as Db, input.runId, [
        { type: 'run.status_changed', payload: { status: 'RECOVERING' } },
      ])
      return 'recovering'
    }

    return 'expired'
  })
}

export async function expireStaleRunLeases(
  db: Db,
  input: { limit: number; maxRecoveries: number },
): Promise<{ expired: number; outcomes: SettleOutcome[] }> {
  const candidates = await listExpiredActiveLeases(db, input.limit)
  const outcomes: SettleOutcome[] = []
  for (const item of candidates) {
    outcomes.push(
      await settleLeaselessRun(db, {
        runId: item.runId,
        leaseId: item.leaseId,
        maxRecoveries: input.maxRecoveries,
      }),
    )
  }
  return { expired: outcomes.filter((item) => item !== 'skipped').length, outcomes }
}

export async function sweepDriftedRuns(
  db: Db,
  input: { limit: number; leaseTtlSeconds: number; maxRecoveries: number },
): Promise<number> {
  const ids = await listDriftedRunningIds(db, input.leaseTtlSeconds, input.limit)
  let settled = 0
  for (const runId of ids) {
    const outcome = await settleLeaselessRun(db, { runId, maxRecoveries: input.maxRecoveries })
    if (outcome !== 'skipped') settled += 1
  }
  return settled
}

export async function settleRevokedRuns(
  db: Db,
  runIds: string[],
  maxRecoveries: number,
): Promise<void> {
  for (const runId of runIds) {
    await settleLeaselessRun(db, { runId, maxRecoveries })
  }
}

export type YieldClaimReason = 'worker_shutdown' | 'placement_yield'
export type YieldClaimResult = 'yielded' | 'has_attempts' | 'unknown'

/**
 * 交回已领取但尚未执行的 Run。
 * `placement_yield` 只允许在没有在途 Attempt 时；有 `RUNNING` Attempt 返回 `has_attempts`，不改现场。
 * 终态 Attempt 不挡回交——恢复重领的 Run 身上会有上一轮记录。
 * Worker 占不到会话时必须走 `yieldPlacement`（回交 + 进程内冷却），不要只调本函数。
 */
export async function yieldClaimedRun(
  db: Db,
  grant: RunGrant,
  reason: YieldClaimReason,
): Promise<YieldClaimResult> {
  const { attempts, runs, stepRuns } = schemaFor(db)
  const now = new Date()
  return db.transaction(async (tx) => {
    const run = await lockRunRow(tx as unknown as Db, grant.runId)
    if (!run) return 'unknown'
    if (!(await verifyRunLeaseForWrite(tx as unknown as Db, grant))) {
      await releaseRunLeaseTx(tx as unknown as Db, grant, reason)
      return 'unknown'
    }
    if (reason === 'placement_yield') {
      const [row] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(attempts)
        .innerJoin(stepRuns, eq(attempts.stepRunId, stepRuns.id))
        .where(and(eq(stepRuns.runId, grant.runId), eq(attempts.status, 'RUNNING')))
      if (Number(row?.n ?? 0) > 0) return 'has_attempts'
    }
    const yielded =
      !isHaltedRunStatus(run.status) && run.status !== 'WAITING_FOR_AUTH'
    if (yielded) {
      await tx
        .update(runs)
        .set({ status: 'RECOVERING', updatedAt: now })
        .where(eq(runs.id, grant.runId))
    }
    await releaseRunLeaseTx(tx as unknown as Db, grant, reason)
    if (run.cancelRequestedAt && !isHaltedRunStatus(run.status))
      await settleRunCancellationTx(tx as unknown as Db, grant.runId, now)
    else if (yielded) {
      await appendRunEvents(tx as unknown as Db, grant.runId, [
        { type: 'run.status_changed', payload: { status: 'RECOVERING', reason } },
      ])
    }
    return 'yielded'
  })
}

/** 停机时释放仍 ACTIVE 的租约；未终态的 Run 回到 RECOVERING，供其他 Worker 领取。 */
export async function yieldUnfinishedRun(db: Db, grant: RunGrant): Promise<void> {
  await yieldClaimedRun(db, grant, 'worker_shutdown')
}

export async function reconcileOrphanAttempts(
  db: Db,
  input: { grant: RunGrant } | { recoverRunId: string },
): Promise<'continue' | 'needs_review' | 'cancelled'> {
  const { attempts, runs, stepRuns } = schemaFor(db)
  return db.transaction(async (tx) => {
    const runId = 'grant' in input ? input.grant.runId : input.recoverRunId
    const run = await lockRunRow(tx as unknown as Db, runId)
    if (!run) return 'cancelled'
    if (isHaltedRunStatus(run.status))
      return run.status === 'NEEDS_REVIEW' ? 'needs_review' : 'cancelled'

    if ('grant' in input) {
      const held = await verifyRunLeaseForWrite(tx as unknown as Db, input.grant)
      if (!held) return 'cancelled'
    } else {
      const active = await findActiveLeaseForRun(tx as unknown as Db, runId)
      if (active) return 'continue'
    }

    const [row] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1)
    if (!row) return 'cancelled'
    const snapshot = row.snapshot as RunSnapshot
    if (!snapshot || !Array.isArray(snapshot.steps)) return 'continue'
    const stepRows = await tx.select().from(stepRuns).where(eq(stepRuns.runId, runId))
    const openAttempts =
      stepRows.length === 0
        ? []
        : await tx
            .select()
            .from(attempts)
            .where(
              and(
                inArray(
                  attempts.stepRunId,
                  stepRows.map((step) => step.id),
                ),
                eq(attempts.status, 'RUNNING'),
              ),
            )
    const stepsById = new Map(snapshot.steps.map((step) => [step.id, step]))
    const now = new Date()

    for (const stepRow of stepRows) {
      const open = openAttempts.filter((attempt) => attempt.stepRunId === stepRow.id)
      if (open.length === 0) continue
      const effect = (stepsById.get(stepRow.stepId)?.effectType ?? 'SIDE_EFFECT') as EffectType
      if (effect === 'SIDE_EFFECT') {
        for (const attempt of open) {
          await closeAttemptTx(tx as unknown as Db, {
            runId,
            attemptId: attempt.id,
            stepRunId: stepRow.id,
            now,
            status: 'FAILED',
            error: {
              code: 'UNKNOWN',
              category: 'UNKNOWN',
              retryable: false,
              safeMessage: '接管时副作用步骤结果未确认',
            },
          })
        }
        await tx
          .update(stepRuns)
          .set({ status: 'FAILED', finishedAt: now })
          .where(eq(stepRuns.id, stepRow.id))
        await tx
          .update(runs)
          .set({ status: 'NEEDS_REVIEW', updatedAt: now })
          .where(eq(runs.id, runId))
        if ('grant' in input) {
          await releaseRunLeaseTx(tx as unknown as Db, input.grant, 'run_halted')
        }
        await appendRunEvents(tx, runId, [
          { type: 'run.status_changed', payload: { status: 'NEEDS_REVIEW' } },
        ])
        return 'needs_review'
      }
      for (const attempt of open) {
        await closeAttemptTx(tx as unknown as Db, {
          runId,
          attemptId: attempt.id,
          stepRunId: stepRow.id,
          now,
          status: 'CANCELLED',
          error: CANCELLED_ATTEMPT_ERROR,
        })
      }
    }
    return 'continue'
  })
}

/** Caller holds the Run row lock and requests cancellation. Never conclude a live owner's work. */
export async function settleRunCancellationTx(
  tx: Db,
  runId: string,
  now: Date,
): Promise<'pending' | 'cancelled' | 'needs_review'> {
  if (await findActiveLeaseForRun(tx, runId)) return 'pending'
  const outcome = await reconcileOrphanAttempts(tx, { recoverRunId: runId })
  if (outcome !== 'continue') return outcome
  const { runs, stepRuns } = schemaFor(tx)
  await tx.update(runs).set({ status: 'CANCELLED', finishedAt: now, updatedAt: now })
    .where(eq(runs.id, runId))
  // Orphan attempts are now closed. A read-only orphan can still have a RUNNING StepRun.
  await tx.update(stepRuns).set({ status: 'CANCELLED', finishedAt: now })
    .where(and(eq(stepRuns.runId, runId), inArray(stepRuns.status, ['PENDING', 'RUNNING'])))
  await appendRunEvents(tx, runId, [
    { type: 'run.status_changed', payload: { status: 'CANCELLED' } },
  ])
  return 'cancelled'
}

export async function reviewRun(
  db: Db,
  input: { runId: string; actor: AuditActor; conclusion: 'fail' | 'cancel'; note?: string },
) {
  const { runs } = schemaFor(db)
  const now = new Date()
  await db.transaction(async (tx) => {
    const run = await lockRunRow(tx as unknown as Db, input.runId)
    if (!run) throw notFound('RUN_NOT_FOUND', '运行不存在')
    if (run.status !== 'NEEDS_REVIEW') {
      throw conflict('RUN_NOT_REVIEWABLE', '只有待核查的运行可以给出结论')
    }
    const status: RunStatus = input.conclusion === 'fail' ? 'FAILED' : 'CANCELLED'
    await tx
      .update(runs)
      .set({ status, finishedAt: now, updatedAt: now })
      .where(eq(runs.id, input.runId))
    if (input.conclusion === 'fail') {
      await skipRemainingStepRunsTx(tx as unknown as Db, input.runId, now)
    } else {
      await cancelPendingStepRunsTx(tx as unknown as Db, input.runId, now)
    }
    await recordAudit(
      tx as unknown as Db,
      input.actor,
      'run.review',
      'run',
      input.runId,
      `核查结论 ${input.conclusion}${input.note ? `：${input.note}` : ''}`,
    )
    await appendRunEvents(tx as unknown as Db, input.runId, [
      { type: 'run.status_changed', payload: { status } },
    ])
  })
  // 执行轴已落。收尾失败不回滚核查，留给 cleanup 扫描已终态 + 轴 PENDING。
  await settleRunEvidence(db, input.runId, { pendingTtlSeconds: 3600, maxUploadAttempts: 3 }).catch(
    () => undefined,
  )
}

export { resumeRunAfterAuth } from '../sessions/auth-control.js'

async function closeRunningAttemptsTx(
  tx: Db,
  runId: string,
  now: Date,
): Promise<void> {
  const { attempts, stepRuns } = schemaFor(tx)
  const stepRows = await tx.select().from(stepRuns).where(eq(stepRuns.runId, runId))
  for (const step of stepRows) {
    const open = await tx
      .select()
      .from(attempts)
      .where(and(eq(attempts.stepRunId, step.id), eq(attempts.status, 'RUNNING')))
    for (const attempt of open) {
      await closeAttemptTx(tx, {
        runId,
        attemptId: attempt.id,
        stepRunId: step.id,
        now,
        status: 'FAILED',
        error: RECOVERY_EXHAUSTED_ERROR,
      })
    }
    if (open.length > 0) {
      await tx
        .update(stepRuns)
        .set({ status: 'FAILED', finishedAt: now })
        .where(eq(stepRuns.id, step.id))
    }
  }
}

async function closeAttemptTx(
  tx: Db,
  input: {
    runId: string
    attemptId: string
    stepRunId: string
    now: Date
    status: 'FAILED' | 'CANCELLED'
    error: ExecutionError
  },
): Promise<void> {
  const { attempts, evidences } = schemaFor(tx)
  const closed = await updateRows(
    tx,
    attempts,
    {
      status: input.status,
      error: input.error,
      output: null,
      finishedAt: input.now,
    },
    and(eq(attempts.id, input.attemptId), eq(attempts.status, 'RUNNING')),
    { id: attempts.id },
  )
  if (closed.length === 0) return
  const evidenceId = newId()
  await tx.insert(evidences).values({
    id: evidenceId,
    runId: input.runId,
    stepRunId: input.stepRunId,
    attemptId: input.attemptId,
    type: 'error',
    schemaVersion: 1,
    payload: input.error,
    createdAt: input.now,
  })
  await appendRunEvents(tx, input.runId, [
    {
      type: 'attempt.finished',
      stepRunId: input.stepRunId,
      attemptId: input.attemptId,
      payload: { status: input.status },
    },
    {
      type: 'evidence.recorded',
      stepRunId: input.stepRunId,
      attemptId: input.attemptId,
      payload: { evidenceId, type: 'error', status: 'available' },
    },
  ])
}
