import { and, asc, count, desc, eq, inArray, isNull, max, sql } from 'drizzle-orm'
import {
  CANCELLED_ATTEMPT_ERROR,
  DEFAULT_EXECUTOR_VERSIONS,
  RUNTIME_SCHEMA_VERSION,
  ScenarioValidationError,
  assertRunFromResolved,
  evidenceMetadataSchema,
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
  type RunListResponse,
  type RunSnapshot,
  type RunStatus,
  type SessionGrant,
  type StepRunStatus,
} from '@cairn/shared'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { verifySessionLeaseForCommit } from '../sessions/sessions.js'
import type { Db, DbHandle } from '../client.js'
import { newId } from '../id.js'
import { attempts, evidences, runs, stepRuns } from '../schema/execution.js'
import { targetAccounts, targets } from '../schema/targets.js'
import { computeIdempotencyDigest, computeSnapshotDigest } from './digest.js'
import { badRequest, conflict, mapPgRestriction, notFound } from './errors.js'
import { loadScenarioVersion } from './scenarios.js'

const TERMINAL_RUN = new Set<RunStatus>(['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'])

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
  const rows = await db.select().from(runs).orderBy(desc(runs.createdAt), desc(runs.id))
  return runListResponseSchema.parse({
    items: rows.map((row) => ({
      id: row.id,
      status: row.status,
      cancelRequested: row.cancelRequestedAt !== null,
      targetId: row.targetId,
      targetAccountId: row.targetAccountId,
      scenarioId: row.scenarioId,
      scenarioVersionId: row.scenarioVersionId,
      createdAt: row.createdAt.toISOString(),
      startedAt: iso(row.startedAt),
      finishedAt: iso(row.finishedAt),
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
  const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1)
  if (!row) return null
  const stepRows = await db.select().from(stepRuns).where(eq(stepRuns.runId, runId)).orderBy(asc(stepRuns.ordinal))
  const attemptRows =
    stepRows.length === 0
      ? []
      : await db.select().from(attempts).where(inArray(attempts.stepRunId, stepRows.map((step) => step.id)))
  const snapshot = row.snapshot
  const stepsById = new Map(snapshot.steps.map((step) => [step.id, step]))
  return runDetailSchema.parse({
    id: row.id,
    status: row.status,
    cancelRequested: row.cancelRequestedAt !== null,
    targetId: row.targetId,
    targetAccountId: row.targetAccountId,
    scenarioId: row.scenarioId,
    scenarioVersionId: row.scenarioVersionId,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
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
  const [current] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1)
  if (!current) throw notFound('RUN_NOT_FOUND', '运行不存在')
  if (TERMINAL_RUN.has(current.status)) return getRun(db, runId)

  const now = new Date()
  await db.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({
        cancelRequestedAt: current.cancelRequestedAt ?? now,
        updatedAt: now,
        ...(current.status === 'QUEUED' ? { status: 'CANCELLED' as const, finishedAt: now } : {}),
      })
      .where(eq(runs.id, runId))
    if (current.status === 'QUEUED') {
      await tx
        .update(stepRuns)
        .set({ status: 'CANCELLED', finishedAt: now })
        .where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, 'PENDING')))
    }
    await recordAudit(tx as unknown as Db, actor, 'run.cancel', 'run', runId, '取消运行')
  })
  return getRun(db, runId)
}

export async function claimQueuedRun(handle: DbHandle): Promise<{ id: string } | null> {
  const result = await handle.pool.query<{ id: string }>(
    `UPDATE runs
     SET status = 'RUNNING', started_at = now(), updated_at = now()
     WHERE id = (
       SELECT id FROM runs
       WHERE status = 'QUEUED' AND cancel_requested_at IS NULL
       ORDER BY created_at, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id`,
  )
  const id = result.rows[0]?.id
  return id ? { id } : null
}

export async function startAttempt(
  db: Db,
  input: { runId: string; stepRunId: string; inputPayload: JsonValue },
): Promise<{ attemptId: string; attemptNo: number } | null> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1)
    if (!run || run.status !== 'RUNNING') return null
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
  /** 仅测试：Evidence 写完后抛错，验证整单回滚 */
  injectFailure?: Error
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
  const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1)
  if (!run || TERMINAL_RUN.has(run.status)) return { updated: false, cancelled: false }

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
        ...(TERMINAL_RUN.has(finalRunStatus) ? { finishedAt: now } : {}),
      })
      .where(eq(runs.id, input.runId))
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
export async function finishRunIfDrained(db: Db, runId: string): Promise<{ finished: boolean }> {
  const now = new Date()
  const drained = await db
    .update(runs)
    .set({ status: 'SUCCEEDED', finishedAt: now, updatedAt: now })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.status, 'RUNNING'),
        isNull(runs.cancelRequestedAt),
        sql`EXISTS (SELECT 1 FROM ${stepRuns} WHERE run_id = ${runId} AND status = 'SUCCEEDED')`,
        sql`NOT EXISTS (SELECT 1 FROM ${stepRuns} WHERE run_id = ${runId} AND status <> 'SUCCEEDED')`,
      ),
    )
    .returning({ id: runs.id })
  return { finished: drained.length > 0 }
}

export async function skipRemainingStepRuns(db: Db, runId: string): Promise<void> {
  await skipRemainingStepRunsTx(db, runId, new Date())
}

export async function cancelPendingStepRuns(db: Db, runId: string): Promise<void> {
  await cancelPendingStepRunsTx(db, runId, new Date())
}

async function skipRemainingStepRunsTx(tx: Db, runId: string, now: Date): Promise<void> {
  await tx
    .update(stepRuns)
    .set({ status: 'SKIPPED', finishedAt: now })
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, 'PENDING')))
}

async function cancelPendingStepRunsTx(tx: Db, runId: string, now: Date): Promise<void> {
  await tx
    .update(stepRuns)
    .set({ status: 'CANCELLED', finishedAt: now })
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, 'PENDING')))
}

export async function markRunCancelled(db: Db, runId: string): Promise<void> {
  const now = new Date()
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1)
    if (!run || TERMINAL_RUN.has(run.status)) return
    await tx
      .update(runs)
      .set({ status: 'CANCELLED', finishedAt: now, updatedAt: now })
      .where(eq(runs.id, runId))
    await cancelPendingStepRunsTx(tx as unknown as Db, runId, now)
  })
}

export async function failRunValidation(db: Db, runId: string): Promise<void> {
  const now = new Date()
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1)
    if (!run || TERMINAL_RUN.has(run.status)) return
    await tx
      .update(runs)
      .set({ status: 'FAILED', finishedAt: now, updatedAt: now })
      .where(eq(runs.id, runId))
    await skipRemainingStepRunsTx(tx as unknown as Db, runId, now)
  })
}

/**
 * 需要人工认证：Run → WAITING_FOR_AUTH（非终态，P3 恢复扫描后再领取）。
 * 仅从 RUNNING 迁入。
 */
export async function markRunWaitingForAuth(db: Db, runId: string): Promise<boolean> {
  const now = new Date()
  const [row] = await db
    .update(runs)
    .set({ status: 'WAITING_FOR_AUTH', updatedAt: now })
    .where(and(eq(runs.id, runId), eq(runs.status, 'RUNNING')))
    .returning({ id: runs.id })
  return row !== undefined
}

/**
 * 认证等待超时：Run → FAILED，挂 SESSION_AUTH_TIMEOUT 错误证据，跳过剩余步骤。
 * 仅从 WAITING_FOR_AUTH 迁入。
 */
export async function failRunAuthTimeout(db: Db, runId: string): Promise<boolean> {
  const now = new Date()
  return db.transaction(async (tx) => {
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
