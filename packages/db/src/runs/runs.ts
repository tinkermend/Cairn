import { and, asc, count, desc, eq, inArray, isNull, max, sql } from 'drizzle-orm'
import {
  CANCELLED_ATTEMPT_ERROR,
  DEFAULT_EXECUTOR_VERSIONS,
  RUNTIME_SCHEMA_VERSION,
  ScenarioValidationError,
  assertRunFromResolved,
  evidenceMetadataSchema,
  isFinishedRunStatus,
  isHaltedRunStatus,
  resolveSessionPolicy,
  runDetailSchema,
  runEvidenceListResponseSchema,
  runListResponseSchema,
  runSnapshotSchema,
  type CreateRunBody,
  type EvidenceType,
  type ExecutionError,
  type ExecutionPolicy,
  type JsonValue,
  type RunDetailDto,
  type RunGrant,
  type RunListResponse,
  type RunSnapshot,
  type RunStatus,
  type SessionGrant,
  type StepRunStatus,
} from '@cairn/shared'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { findActiveLeaseForRun, listActiveLeasesByRunIds, lockRunRow, releaseRunLeaseTx, verifyRunLeaseForWrite } from '../leases/leases.js'
import { verifySessionLeaseForCommit } from '../sessions/sessions.js'
import type { Db } from '../client.js'
import { cancelPendingStepRunsTx, skipRemainingStepRunsTx } from './step-status.js'
import { newId } from '../id.js'
import { attempts, evidences, runs, scenarios, stepRuns } from '../schema/execution.js'
import { targetAccounts, targets } from '../schema/targets.js'
import { computeIdempotencyDigest, computeSnapshotDigest } from './digest.js'
import { badRequest, conflict, mapPgRestriction, notFound } from './errors.js'
import { loadScenarioVersion } from './scenarios.js'

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

function rethrow(error: unknown): never {
  const mapped = mapPgRestriction(error)
  if (mapped) throw mapped
  throw error
}

export async function countRunsForAccount(db: Db, accountId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(runs).where(eq(runs.targetAccountId, accountId))
  return Number(row?.n ?? 0)
}

export async function getRun(db: Db, runId: string): Promise<RunDetailDto> {
  const detail = await loadRunDetail(db, runId)
  if (!detail) throw notFound('RUN_NOT_FOUND', '运行不存在')
  return detail
}

export async function listRuns(db: Db): Promise<RunListResponse> {
  // 带上场景名与目标系统名：两者都是 NOT NULL 外键，innerJoin 不会漏行。
  const rows = await db
    .select({
      run: runs,
      scenarioName: scenarios.name,
      targetName: targets.name,
      targetAccountName: targetAccounts.displayName,
    })
    .from(runs)
    .innerJoin(scenarios, eq(scenarios.id, runs.scenarioId))
    .innerJoin(targets, eq(targets.id, runs.targetId))
    .leftJoin(targetAccounts, eq(targetAccounts.id, runs.targetAccountId))
    .orderBy(desc(runs.createdAt), desc(runs.id))
  const leases = await listActiveLeasesByRunIds(
    db,
    rows.map((row) => row.run.id),
  )
  return runListResponseSchema.parse({
    items: rows.map(({ run: row, scenarioName, targetName, targetAccountName }) => ({
      id: row.id,
      status: row.status,
      cancelRequested: row.cancelRequestedAt !== null,
      targetId: row.targetId,
      targetName,
      targetAccountId: row.targetAccountId,
      targetAccountName,
      scenarioId: row.scenarioId,
      scenarioName,
      scenarioVersionId: row.scenarioVersionId,
      createdAt: row.createdAt.toISOString(),
      startedAt: iso(row.startedAt),
      finishedAt: iso(row.finishedAt),
      lease: leases.get(row.id) ? { holderWorkerId: leases.get(row.id)!.holderWorkerId } : null,
    })),
  })
}

export async function listRunEvidence(db: Db, runId: string) {
  await getRun(db, runId)
  const rows = await db
    .select()
    .from(evidences)
    .where(eq(evidences.runId, runId))
    .orderBy(asc(evidences.createdAt), asc(evidences.id))
  return runEvidenceListResponseSchema.parse({
    items: rows.map((row) =>
      evidenceMetadataSchema.parse({
        schemaVersion: row.schemaVersion,
        id: row.id,
        runId: row.runId,
        stepRunId: row.stepRunId ?? undefined,
        attemptId: row.attemptId ?? undefined,
        type: row.type,
        createdAt: row.createdAt.toISOString(),
        objectKey: row.objectKey ?? undefined,
        contentType: row.contentType ?? undefined,
        byteSize: row.byteSize ?? undefined,
        digest: row.digest ?? undefined,
        missingReason: row.missingReason ?? undefined,
        payload: row.payload ?? undefined,
      }),
    ),
  })
}

export async function loadRunDetail(db: Db, runId: string): Promise<RunDetailDto | null> {
  const [joined] = await db
    .select({
      run: runs,
      scenarioName: scenarios.name,
      targetName: targets.name,
      targetAccountName: targetAccounts.displayName,
    })
    .from(runs)
    .innerJoin(scenarios, eq(scenarios.id, runs.scenarioId))
    .innerJoin(targets, eq(targets.id, runs.targetId))
    .leftJoin(targetAccounts, eq(targetAccounts.id, runs.targetAccountId))
    .where(eq(runs.id, runId))
    .limit(1)
  if (!joined) return null
  const row = joined.run
  const stepRows = await db.select().from(stepRuns).where(eq(stepRuns.runId, runId)).orderBy(asc(stepRuns.ordinal))
  const attemptRows =
    stepRows.length === 0
      ? []
      : await db.select().from(attempts).where(inArray(attempts.stepRunId, stepRows.map((step) => step.id)))
  const snapshot = row.snapshot
  const stepsById = new Map(snapshot.steps.map((step) => [step.id, step]))
  const lease = await findActiveLeaseForRun(db, runId)
  return runDetailSchema.parse({
    id: row.id,
    status: row.status,
    cancelRequested: row.cancelRequestedAt !== null,
    targetId: row.targetId,
    targetName: joined.targetName,
    targetAccountId: row.targetAccountId,
    targetAccountName: joined.targetAccountName,
    scenarioId: row.scenarioId,
    scenarioName: joined.scenarioName,
    scenarioVersionId: row.scenarioVersionId,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    lease: lease
      ? {
          holderWorkerId: lease.holderWorkerId,
          fencingToken: lease.fencingToken,
          expiresAt: lease.expiresAt,
        }
      : null,
    snapshot,
    context: row.context,
    stepRuns: stepRows.map((step) => {
      const definition = stepsById.get(step.stepId)
      return {
        id: step.id,
        stepId: step.stepId,
        name: definition?.name ?? step.stepId,
        type: definition?.type ?? 'unknown',
        ordinal: step.ordinal,
        status: step.status,
        startedAt: iso(step.startedAt),
        finishedAt: iso(step.finishedAt),
        attempts: attemptRows
          .filter((attempt) => attempt.stepRunId === step.id)
          .sort((a, b) => a.attemptNo - b.attemptNo)
          .map((attempt) => ({
            id: attempt.id,
            attemptNo: attempt.attemptNo,
            status: attempt.status,
            startedAt: attempt.startedAt.toISOString(),
            finishedAt: iso(attempt.finishedAt),
            output: attempt.output ?? null,
            error: (attempt.error as ExecutionError | null) ?? null,
          })),
      }
    }),
  })
}

export async function createRunWithSnapshot(
  db: Db,
  input: CreateRunBody & { actor: AuditActor },
): Promise<{ detail: RunDetailDto; created: boolean }> {
  const { scenario, version } = await loadScenarioVersion(db, input.scenarioId, input.scenarioVersionId)
  if (scenario.status === 'disabled') throw conflict('SCENARIO_DISABLED', '场景已停用，不能创建新运行')

  const [target] = await db.select().from(targets).where(eq(targets.id, scenario.targetId)).limit(1)
  if (!target) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  if (target.status === 'disabled') throw conflict('TARGET_DISABLED', '目标系统已停用，不能创建新运行')

  const runInput = input.input ?? {}
  try {
    assertRunFromResolved(version.definition.steps, runInput)
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      throw badRequest(error.code, error.message)
    }
    throw error
  }

  let secretRef: RunSnapshot['secretRef']
  if (input.targetAccountId) {
    const [account] = await db
      .select()
      .from(targetAccounts)
      .where(eq(targetAccounts.id, input.targetAccountId))
      .limit(1)
    if (!account || account.targetId !== scenario.targetId) {
      throw badRequest('RUN_ACCOUNT_MISMATCH', '目标账号不属于该场景绑定的目标系统')
    }
    if (account.status === 'disabled') throw conflict('RUN_ACCOUNT_DISABLED', '目标账号已停用')
    if (account.secretId && account.secretProvider) {
      secretRef = { provider: account.secretProvider, secretId: account.secretId }
    }
  }

  const sessionPolicy = resolveSessionPolicy(input.sessionPolicy)

  const idempotencyDigest = input.idempotencyKey
    ? computeIdempotencyDigest({
        scenarioVersionId: version.id,
        input: runInput,
        targetAccountId: input.targetAccountId,
        policy: input.policy,
        sessionPolicy,
      })
    : null

  if (input.idempotencyKey) {
    const existing = await findIdempotent(db, input.actor.id, input.idempotencyKey)
    if (existing) {
      if (existing.idempotencyDigest !== idempotencyDigest) {
        throw conflict('RUN_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同的运行输入')
      }
      const detail = await getRun(db, existing.id)
      return { detail, created: false }
    }
  }

  const runId = newId()
  const now = new Date()
  const snapshotBase = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    runId,
    targetId: scenario.targetId,
    targetAccountId: input.targetAccountId,
    secretRef,
    scenarioId: scenario.id,
    scenarioVersionId: version.id,
    steps: version.definition.steps,
    input: runInput,
    createdAt: now.toISOString(),
    policy: input.policy,
    sessionPolicy,
    executorVersions: { ...DEFAULT_EXECUTOR_VERSIONS },
  }
  const parsed = runSnapshotSchema.parse(snapshotBase)
  const digest = computeSnapshotDigest(parsed)
  const snapshot = runSnapshotSchema.parse({ ...parsed, digest })

  try {
    await db.transaction(async (tx) => {
      await tx.insert(runs).values({
        id: runId,
        targetId: scenario.targetId,
        scenarioId: scenario.id,
        scenarioVersionId: version.id,
        targetAccountId: input.targetAccountId,
        createdByConsoleAccountId: input.actor.id,
        status: 'QUEUED',
        snapshot,
        snapshotDigest: digest,
        context: runInput,
        idempotencyKey: input.idempotencyKey,
        idempotencyDigest,
        createdAt: now,
        updatedAt: now,
      })
      if (snapshot.steps.length > 0) {
        await tx.insert(stepRuns).values(
          snapshot.steps.map((step, ordinal) => ({
            id: newId(),
            runId,
            stepId: step.id,
            ordinal,
            status: 'PENDING' as const,
          })),
        )
      }
      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'run.create',
        'run',
        runId,
        `创建运行（场景 ${scenario.name}）`,
      )
    })
  } catch (error) {
    if (input.idempotencyKey && mapPgRestriction(error)?.code === 'RUN_IDEMPOTENCY_CONFLICT') {
      const raced = await findIdempotent(db, input.actor.id, input.idempotencyKey)
      if (raced && raced.idempotencyDigest === idempotencyDigest) {
        return { detail: await getRun(db, raced.id), created: false }
      }
    }
    rethrow(error)
  }

  return { detail: await getRun(db, runId), created: true }
}

async function findIdempotent(db: Db, actorId: string, key: string) {
  const [row] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.createdByConsoleAccountId, actorId), eq(runs.idempotencyKey, key)))
    .limit(1)
  return row
}

export async function requestRunCancel(db: Db, runId: string, actor: AuditActor): Promise<RunDetailDto> {
  const now = new Date()
  await db.transaction(async (tx) => {
    const current = await lockRunRow(tx as unknown as Db, runId)
    if (!current) throw notFound('RUN_NOT_FOUND', '运行不存在')
    if (isFinishedRunStatus(current.status) || current.status === 'NEEDS_REVIEW') return

    const leaseless =
      current.status === 'QUEUED' ||
      current.status === 'RECOVERING' ||
      current.status === 'WAITING_FOR_AUTH'
    await tx
      .update(runs)
      .set({
        cancelRequestedAt: current.cancelRequestedAt ?? now,
        updatedAt: now,
        ...(leaseless ? { status: 'CANCELLED' as const, finishedAt: now } : {}),
      })
      .where(eq(runs.id, runId))
    if (leaseless) {
      await cancelPendingStepRunsTx(tx as unknown as Db, runId, now)
    }
    await recordAudit(tx as unknown as Db, actor, 'run.cancel', 'run', runId, '取消运行')
  })
  return getRun(db, runId)
}

export async function startAttempt(
  db: Db,
  input: { runId: string; stepRunId: string; inputPayload: JsonValue; grant: RunGrant },
): Promise<{ attemptId: string; attemptNo: number } | null> {
  return db.transaction(async (tx) => {
    const run = await lockRunRow(tx as unknown as Db, input.runId)
    if (!run || run.status !== 'RUNNING') return null
    if (!(await verifyRunLeaseForWrite(tx as unknown as Db, input.grant))) return null
    const [full] = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1)
    if (!full) return null
    const [step] = await tx.select().from(stepRuns).where(eq(stepRuns.id, input.stepRunId)).limit(1)
    if (!step || (step.status !== 'PENDING' && step.status !== 'RUNNING')) return null

    if (step.status === 'PENDING') {
      const moved = await tx
        .update(stepRuns)
        .set({ status: 'RUNNING', startedAt: new Date() })
        .where(and(eq(stepRuns.id, input.stepRunId), eq(stepRuns.status, 'PENDING')))
        .returning({ id: stepRuns.id })
      if (moved.length === 0) return null
    }

    const [agg] = await tx
      .select({ n: max(attempts.attemptNo) })
      .from(attempts)
      .where(eq(attempts.stepRunId, input.stepRunId))
    const attemptNo = Number(agg?.n ?? 0) + 1
    const attemptId = newId()
    const now = new Date()
    await tx.insert(attempts).values({
      id: attemptId,
      stepRunId: input.stepRunId,
      attemptNo,
      status: 'RUNNING',
      startedAt: now,
    })
    await tx.insert(evidences).values({
      id: newId(),
      runId: input.runId,
      stepRunId: input.stepRunId,
      attemptId,
      type: 'input',
      schemaVersion: 1,
      payload: input.inputPayload,
      createdAt: now,
    })
    return { attemptId, attemptNo }
  })
}

export type FinishAttemptInput = {
  runId: string
  attemptId: string
  attemptStatus: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  output?: JsonValue | null
  error?: ExecutionError | null
  context?: Record<string, JsonValue>
  stepRunStatus: StepRunStatus
  runStatus?: RunStatus
  skipRemaining?: boolean
  cancelPending?: boolean
  /**
   * 浏览器步骤提交边界：若提供，写 SUCCEEDED 前在事务内校验租约仍有效。
   * 丢租时 SIDE_EFFECT → NEEDS_REVIEW，其余 → FAILED，不写成功结果。
   */
  sessionLease?: SessionGrant & { holderWorkerId: string; effectType?: 'READ_ONLY' | 'IDEMPOTENT' | 'SIDE_EFFECT' }
  grant: RunGrant
  /** 仅测试：Evidence 写完后抛错，验证整单回滚 */
  injectFailure?: Error
  /**
   * 仅测试：Run 行已锁、租约已验、尚未写入任何事实时暂停。
   *
   * 这是 D5 的 TOCTOU 窗口。没有 `lockRunRow` 的话，回收与接管会正好挤进这里：
   * 谓词读到的「租约仍有效」在 COMMIT 前就已经过时，旧 owner 照样提交 SUCCEEDED。
   * 屏障必须留在生产代码里，否则这条不变量只能靠人看，没有任何检查卡得住。
   */
  barrierAfterVerify?: () => Promise<void>
}

/**
 * `updated: false` = Attempt 已不是 RUNNING（迟到回调），调用方必须停手。
 * `cancelled: true` = 写入被改写成取消，调用方同样必须停手。
 */
export type FinishAttemptResult = { updated: boolean; cancelled: boolean }

export async function finishAttempt(db: Db, input: FinishAttemptInput): Promise<FinishAttemptResult> {
  return db.transaction((tx) => finishAttemptTx(tx as unknown as Db, input))
}

export async function finishAttemptTx(tx: Db, input: FinishAttemptInput): Promise<FinishAttemptResult> {
  const now = new Date()
  const locked = await lockRunRow(tx, input.runId)
  if (!locked || isHaltedRunStatus(locked.status)) return { updated: false, cancelled: false }
  if (!(await verifyRunLeaseForWrite(tx, input.grant))) return { updated: false, cancelled: false }
  if (input.barrierAfterVerify) await input.barrierAfterVerify()
  const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1)
  if (!run) return { updated: false, cancelled: false }

  const [attempt] = await tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1)
  if (!attempt || attempt.status !== 'RUNNING') return { updated: false, cancelled: false }

  /**
   * 取消请求已到达：本次尝试的结论一律作废。
   *
   * 迟到的成功（Delay 跑完才看到取消请求）不得写成 SUCCEEDED，重试也不得再发起——
   * 这是「Running 中取消不出现迟到 SUCCEEDED」的唯一收口点，放在事务里与状态同生共死。
   * 例外是 NEEDS_REVIEW：副作用结果未知优先于取消，不能被取消洗成干净终态。
   */
  let cancelled = run.cancelRequestedAt !== null && input.runStatus !== 'NEEDS_REVIEW'

  let attemptStatus = input.attemptStatus
  let output = input.output
  let error = input.error
  let stepRunStatus = input.stepRunStatus
  let runStatus = input.runStatus
  let skipRemaining = input.skipRemaining
  let context = input.context

  /**
   * 浏览器步骤提交边界：丢租后的结果不可信。
   * SIDE_EFFECT → NEEDS_REVIEW；其余 → FAILED。不得写成 SUCCEEDED。
   */
  if (!cancelled && attemptStatus === 'SUCCEEDED' && input.sessionLease) {
    const held = await verifySessionLeaseForCommit(tx, input.sessionLease)
    if (!held) {
      const sideEffect = input.sessionLease.effectType === 'SIDE_EFFECT'
      attemptStatus = 'FAILED'
      output = null
      error = {
        code: 'SESSION_LEASE_LOST',
        category: sideEffect ? 'UNKNOWN' : 'INFRASTRUCTURE',
        retryable: false,
        safeMessage: '提交结果前会话租约已失效',
      }
      stepRunStatus = 'FAILED'
      runStatus = sideEffect ? 'NEEDS_REVIEW' : 'FAILED'
      skipRemaining = true
      context = undefined
    }
  }

  const closed = await tx
    .update(attempts)
    .set({
      status: cancelled ? 'CANCELLED' : attemptStatus,
      output: cancelled ? null : (output ?? null),
      error: cancelled ? CANCELLED_ATTEMPT_ERROR : (error ?? null),
      finishedAt: now,
    })
    .where(and(eq(attempts.id, input.attemptId), eq(attempts.status, 'RUNNING')))
    .returning({ id: attempts.id })
  if (closed.length === 0) return { updated: false, cancelled: false }

  const evidenceType: EvidenceType | undefined = cancelled
    ? 'error'
    : attemptStatus === 'SUCCEEDED'
      ? 'output'
      : error
        ? 'error'
        : undefined
  if (evidenceType) {
    await tx.insert(evidences).values({
      id: newId(),
      runId: input.runId,
      stepRunId: attempt.stepRunId,
      attemptId: input.attemptId,
      type: evidenceType,
      schemaVersion: 1,
      payload: cancelled
        ? CANCELLED_ATTEMPT_ERROR
        : evidenceType === 'output'
          ? (output ?? null)
          : (error ?? null),
      createdAt: now,
    })
  }

  // 取消时不采纳输出：context 保持取消前已提交的值。
  if (context && !cancelled) {
    await tx.update(runs).set({ context, updatedAt: now }).where(eq(runs.id, input.runId))
  }

  const finalStepStatus = cancelled ? 'CANCELLED' : stepRunStatus
  const stepTerminal = finalStepStatus !== 'RUNNING' && finalStepStatus !== 'PENDING'
  await tx
    .update(stepRuns)
    .set({
      status: finalStepStatus,
      ...(stepTerminal ? { finishedAt: now } : {}),
    })
    .where(eq(stepRuns.id, attempt.stepRunId))

  if (cancelled || input.cancelPending) await cancelPendingStepRunsTx(tx, input.runId, now)
  else if (skipRemaining) await skipRemainingStepRunsTx(tx, input.runId, now)

  const finalRunStatus = cancelled ? 'CANCELLED' : runStatus
  if (finalRunStatus) {
    await tx
      .update(runs)
      .set({
        status: finalRunStatus,
        updatedAt: now,
        // finished_at 表示「已有最终结论」，按 FINISHED 而不是 HALTED 判定：
        // NEEDS_REVIEW 只是停下来等人，结论要等 reviewRun 才写，否则耗时统计会把待核查
        // 算成已完成，同一条 Run 还会先后写两个不同的完成时间。
        ...(isFinishedRunStatus(finalRunStatus) ? { finishedAt: now } : {}),
      })
      .where(eq(runs.id, input.runId))
    if (isHaltedRunStatus(finalRunStatus) || finalRunStatus === 'WAITING_FOR_AUTH') {
      await releaseRunLeaseTx(
        tx,
        input.grant,
        finalRunStatus === 'WAITING_FOR_AUTH' ? 'waiting_for_auth' : 'run_halted',
      )
    }
  }

  if (input.injectFailure) throw input.injectFailure

  return { updated: true, cancelled }
}

/**
 * 步骤已全部成功但 Run 仍停在 `RUNNING` 时补写终态（§7 第 4 步「没有 PENDING 则成功」）。
 *
 * 最后一步成功已能在同一事务里直接写 SUCCEEDED；这条覆盖续跑与恢复路径。单条条件更新，
 * 只要还有非 SUCCEEDED 的 step_run（含 PENDING / RUNNING / FAILED / SKIPPED / CANCELLED）
 * 或有取消请求就 0 行，不会把没跑完的 Run 判成成功。
 */
export async function finishRunIfDrained(db: Db, grant: RunGrant): Promise<{ finished: boolean }> {
  const now = new Date()
  return db.transaction(async (tx) => {
    const locked = await lockRunRow(tx as unknown as Db, grant.runId)
    if (!locked || locked.status !== 'RUNNING') return { finished: false }
    if (!(await verifyRunLeaseForWrite(tx as unknown as Db, grant))) return { finished: false }
    const drained = await tx
      .update(runs)
      .set({ status: 'SUCCEEDED', finishedAt: now, updatedAt: now })
      .where(
        and(
          eq(runs.id, grant.runId),
          eq(runs.status, 'RUNNING'),
          isNull(runs.cancelRequestedAt),
          sql`EXISTS (SELECT 1 FROM ${stepRuns} WHERE run_id = ${grant.runId} AND status = 'SUCCEEDED')`,
          sql`NOT EXISTS (SELECT 1 FROM ${stepRuns} WHERE run_id = ${grant.runId} AND status <> 'SUCCEEDED')`,
        ),
      )
      .returning({ id: runs.id })
    if (drained.length === 0) return { finished: false }
    await releaseRunLeaseTx(tx as unknown as Db, grant, 'run_halted')
    return { finished: true }
  })
}

export async function skipRemainingStepRuns(db: Db, runId: string): Promise<void> {
  await skipRemainingStepRunsTx(db, runId, new Date())
}

export async function cancelPendingStepRuns(db: Db, runId: string): Promise<void> {
  await cancelPendingStepRunsTx(db, runId, new Date())
}

export type RunWriteAuthority = { grant: RunGrant } | { recover: true }

async function assertWriteAuthority(tx: Db, runId: string, authority: RunWriteAuthority): Promise<boolean> {
  const locked = await lockRunRow(tx, runId)
  if (!locked) return false
  if ('grant' in authority) return verifyRunLeaseForWrite(tx, authority.grant)
  const active = await findActiveLeaseForRun(tx, runId)
  return active === null
}

export async function markRunCancelled(db: Db, runId: string, authority: RunWriteAuthority): Promise<void> {
  const now = new Date()
  await db.transaction(async (tx) => {
    if (!(await assertWriteAuthority(tx as unknown as Db, runId, authority))) return
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1)
    if (!run || isHaltedRunStatus(run.status)) return
    await tx
      .update(runs)
      .set({ status: 'CANCELLED', finishedAt: now, updatedAt: now })
      .where(eq(runs.id, runId))
    await cancelPendingStepRunsTx(tx as unknown as Db, runId, now)
    if ('grant' in authority) {
      await releaseRunLeaseTx(tx as unknown as Db, authority.grant, 'run_halted')
    }
  })
}

export async function failRunValidation(db: Db, runId: string, authority: RunWriteAuthority): Promise<void> {
  const now = new Date()
  await db.transaction(async (tx) => {
    if (!(await assertWriteAuthority(tx as unknown as Db, runId, authority))) return
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1)
    if (!run || isHaltedRunStatus(run.status)) return
    await tx
      .update(runs)
      .set({ status: 'FAILED', finishedAt: now, updatedAt: now })
      .where(eq(runs.id, runId))
    await skipRemainingStepRunsTx(tx as unknown as Db, runId, now)
    if ('grant' in authority) {
      await releaseRunLeaseTx(tx as unknown as Db, authority.grant, 'run_halted')
    }
  })
}

/**
 * 需要人工认证：Run → WAITING_FOR_AUTH，同一事务释放 RunLease。
 * 仅从 RUNNING 迁入。
 */
export async function markRunWaitingForAuth(db: Db, grant: RunGrant): Promise<boolean> {
  const now = new Date()
  return db.transaction(async (tx) => {
    const locked = await lockRunRow(tx as unknown as Db, grant.runId)
    if (!locked || locked.status !== 'RUNNING') return false
    if (!(await verifyRunLeaseForWrite(tx as unknown as Db, grant))) return false
    const [row] = await tx
      .update(runs)
      .set({ status: 'WAITING_FOR_AUTH', updatedAt: now })
      .where(and(eq(runs.id, grant.runId), eq(runs.status, 'RUNNING')))
      .returning({ id: runs.id })
    if (!row) return false
    await releaseRunLeaseTx(tx as unknown as Db, grant, 'waiting_for_auth')
    return true
  })
}

/**
 * 认证等待超时：Run → FAILED，挂 SESSION_AUTH_TIMEOUT 错误证据，跳过剩余步骤。
 * recover 权威：行锁后确认无 ACTIVE 租约。
 */
export async function failRunAuthTimeout(db: Db, runId: string): Promise<boolean> {
  const now = new Date()
  return db.transaction(async (tx) => {
    const locked = await lockRunRow(tx as unknown as Db, runId)
    if (!locked || locked.status !== 'WAITING_FOR_AUTH') return false
    const active = await findActiveLeaseForRun(tx as unknown as Db, runId)
    if (active) return false
    const [run] = await tx
      .update(runs)
      .set({ status: 'FAILED', finishedAt: now, updatedAt: now })
      .where(and(eq(runs.id, runId), eq(runs.status, 'WAITING_FOR_AUTH')))
      .returning({ id: runs.id })
    if (!run) return false
    await tx.insert(evidences).values({
      id: newId(),
      runId,
      type: 'error',
      schemaVersion: 1,
      payload: {
        code: 'SESSION_AUTH_TIMEOUT',
        category: 'INFRASTRUCTURE',
        retryable: false,
        safeMessage: '等待人工认证超时',
      },
      createdAt: now,
    })
    await skipRemainingStepRunsTx(tx as unknown as Db, runId, now)
    return true
  })
}

/** 找出仍在 WAITING_FOR_AUTH 且绑定该 TargetAccount 的 Run。 */
export async function listRunsWaitingForAuthByAccount(
  db: Db,
  targetAccountId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.status, 'WAITING_FOR_AUTH'), eq(runs.targetAccountId, targetAccountId)))
  return rows.map((r) => r.id)
}

export async function loadRunRow(db: Db, runId: string) {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1)
  return row ?? null
}

export type { ExecutionPolicy }
