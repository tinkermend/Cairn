import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import {
  expireRunDeadlines,
  failRunValidation,
  finishAttempt,
  finishRunIfDrained,
  loadRunDetail,
  loadRunRow,
  loadSecretCiphertext,
  markRunCancelled,
  reconcileOrphanAttempts,
  settleRunEvidence,
  startAttempt,
  type DbHandle,
  type FinishAttemptInput,
} from '@cairn/db'
import {
  CANCELLED_ATTEMPT_ERROR,
  LOCAL_SECRET_PROVIDER,
  REDACTED,
  executorVersionsMatch,
  ASSERT_FAILED_CODE,
  fillTextFromContext,
  isAiStepType,
  readContextValue,
  stepUsesBrowser,
  isPlacementYieldCode,
  isSessionConfigErrorCode,
  jsonValueSchema,
  resolveEvidencePolicy,
  resolveStepPolicy,
  retainUntilFor,
  runSnapshotSchema,
  type BrowserCommand,
  type ExecutionError,
  type JsonValue,
  type ResolverDiagnostics,
  type RunDetailDto,
  type RunGrant,
  type RunSnapshot,
  type ScreenshotPointer,
  type SessionGrant,
  type Step,
  type TargetDescriptor,
} from '@cairn/shared'
import type { LocalSecretProvider } from '@cairn/secret'
import { config } from '../config/env.js'
import { DB_HANDLE } from '../db/db.module'
import { SECRET_PROVIDER } from '../tokens.js'
import { yieldPlacement } from '../runtime/placement-backoff.js'
import { isAbortError, systemClock, type EngineClock } from './clock.js'
import { BROWSER_PORT, type BrowserPort } from './ports.js'
import { BrowserStepExecutor } from './browser-executor.js'
import { FixtureStepExecutor } from './fixture-executor.js'
import {
  STEP_EXECUTOR_REGISTRY,
  StepExecutorRegistry,
  type StepExecutionOutcome,
} from './step-executor.js'

export type ExecuteOptions = {
  grant: RunGrant
  signal?: AbortSignal
  clock?: EngineClock
  /** 轮询取消请求的间隔。取消只能查库发现（NOTIFY 属 P7），测试用它把窗口压小。 */
  cancelPollMs?: number
}

/** 取消请求的轮询间隔：更密只增加查询，不会更早发现取消。 */
const DEFAULT_CANCEL_POLL_MS = 250

type ExecutorOutcome = StepExecutionOutcome & {
  timedOut: boolean
  aborted: boolean
}

@Injectable()
export class ExecutionEngine {
  private readonly logger = new Logger(ExecutionEngine.name)
  private readonly registry: StepExecutorRegistry

  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    /** 含浏览器步骤的 Run 经此端口 acquire / execute / release。 */
    @Optional() @Inject(BROWSER_PORT) private readonly browser?: BrowserPort,
    @Optional() @Inject(SECRET_PROVIDER) private readonly secrets?: LocalSecretProvider,
    @Optional() @Inject(STEP_EXECUTOR_REGISTRY) registry?: StepExecutorRegistry,
  ) {
    this.registry =
      registry ??
      new StepExecutorRegistry([
        new FixtureStepExecutor(),
        new BrowserStepExecutor(this.handle, this.browser),
      ])
  }

  async execute(runId: string, options: ExecuteOptions): Promise<void> {
    const grant = options.grant
    const clock = options.clock ?? systemClock
    const external = options.signal ?? new AbortController().signal
    const db = this.handle

    await expireRunDeadlines(db, runId)
    const orphan = await reconcileOrphanAttempts(db, { grant })
    if (orphan !== 'continue') return

    const row = await loadRunRow(db, runId)
    if (!row || row.status !== 'RUNNING') return

    const parsed = runSnapshotSchema.safeParse(row.snapshot)
    if (
      !parsed.success ||
      !executorVersionsMatch(
        parsed.data.executorVersions,
        parsed.data.steps.map((step) => step.type),
      )
    ) {
      this.logger.warn({ runId }, '快照或 executorVersions 非法，Run 标为 FAILED')
      await failRunValidation(db, runId, { grant }, {
        code: 'RUN_SNAPSHOT_INVALID',
        category: 'VALIDATION',
        retryable: false,
        safeMessage: '运行快照或执行器版本非法，无法开始步骤',
      })
      return
    }
    const snapshot = parsed.data
    const secrets = await this.resolveRedactionSecrets(snapshot)
    const evidencePolicy = resolveEvidencePolicy(snapshot.evidencePolicy)
    const needsBrowser = snapshot.steps.some((step) => stepUsesBrowser(step.type))
    let sessionMustClose = false

    // 取消没有通知机制可依赖（NOTIFY 属 P7），在途取消只能轮询 cancel_requested_at。
    const stop = this.watchCancellation(runId, external, clock, options.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS)
    /**
     * 停机／失联中止不是取消。
     *
     * 外部信号只说明「本实例要走了」，Run 的事实并没有结论：此时不写终态，直接返回，
     * 由停机路径把 Run 交回 `RECOVERING` 并释放租约，未关闭的 Attempt 留给接管方按
     * effectType 收敛（READ_ONLY / IDEMPOTENT 续跑，SIDE_EFFECT 进核查）。把它写成
     * CANCELLED 等于一次滚动发布就替用户取消了没取消的 Run，也让整套恢复能力在最常见的
     * 重启场景上永远用不到。库里说停（取消请求、Run 已离开 RUNNING）走另一条路。
     */
    const yielding = (): boolean => external.aborted && !stop.fromDb.aborted

    let sessionGrant: SessionGrant | undefined
    try {
      if (needsBrowser) {
        const acquired = await this.acquireSession(snapshot, grant, stop.signal)
        if (acquired.kind !== 'held') {
          if (stop.fromDb.aborted) await markRunCancelled(db, runId, { grant })
          return
        }
        sessionGrant = acquired.grant
      }

      if (row.cancelRequestedAt) {
        await markRunCancelled(db, runId, { grant })
        return
      }
      if (stop.signal.aborted) {
        if (!yielding()) await markRunCancelled(db, runId, { grant })
        return
      }

      for (const step of snapshot.steps) {
        const current = await loadRunRow(db, runId)
        if (!current || current.status !== 'RUNNING') return
        if (current.cancelRequestedAt) {
          await markRunCancelled(db, runId, { grant })
          return
        }
        if (stop.signal.aborted) {
          if (!yielding()) await markRunCancelled(db, runId, { grant })
          return
        }

        const detail = await loadRunDetail(db, runId)
        if (!detail) return
        const stepRun = detail.stepRuns.find((item) => item.stepId === step.id)
        // PENDING：尚未执行。RUNNING 且无在途 Attempt：接管后孤儿已收，或失败重试间隙——必须续跑，不得跳过。
        if (!stepRun || !isRunnableStepRun(stepRun)) continue

        const resolved = resolveStepInput(step, detail.context)
        const started = await startAttempt(db, {
          runId,
          stepRunId: stepRun.id,
          inputPayload: evidencePayloadForStep(step, resolved.input),
          grant,
          secrets,
        })
        if (!started) {
          await this.finishAfterZeroRow(runId, grant, stop.signal, yielding)
          return
        }

        if (!resolved.ok) {
          await this.close({
            runId,
            attemptId: started.attemptId,
            attemptStatus: 'FAILED',
            error: resolved.error,
            stepRunStatus: 'FAILED',
            runStatus: 'FAILED',
            skipRemaining: true,
            grant,
            sessionLease: sessionLeaseFor({ step, sessionGrant, grant }),
            secrets,
          })
          return
        }

        const policy = resolveStepPolicy(snapshot.policy, step.policy, step.type)
        const last = isLastOpenStep(detail, step.id)
        const taint = { hung: false }
        const finished = await this.completeAttempt({
          runId,
          grant,
          step,
          stepRunId: stepRun.id,
          attemptId: started.attemptId,
          attemptNo: started.attemptNo,
          input: resolved.input,
          policy,
          last,
          context: { ...detail.context },
          sessionGrant,
          targetId: snapshot.targetId,
          snapshot,
          stop: stop.signal,
          yielding,
          clock,
          secrets,
          evidencePolicy,
          taint,
        })
        sessionMustClose = sessionMustClose || taint.hung
        if (!finished) return
      }

      // 步骤都终结但 Run 还停在 RUNNING（续跑、恢复）：补一次成功终态。
      // 正常的最后一步已在同一事务里写过 SUCCEEDED，这里只是兜底。
      await finishRunIfDrained(db, grant)
    } finally {
      if (sessionGrant && this.browser) {
        if (sessionMustClose && this.browser.invalidate) {
          await this.browser.invalidate(sessionGrant, 'ai_hung').catch((error: unknown) => {
            this.logger.warn(
              { runId, message: error instanceof Error ? error.message : String(error) },
              '关闭未落定的 AI 会话失败',
            )
          })
        }
        await this.browser.release(sessionGrant, 'run_finished').catch((error: unknown) => {
          this.logger.warn(
            { runId, message: error instanceof Error ? error.message : String(error) },
            '释放会话租约失败',
          )
        })
      }
      await settleRunEvidence(db, runId, {
        pendingTtlSeconds: config.CAIRN_OBJECT_PENDING_TTL_SECONDS,
        maxUploadAttempts: config.CAIRN_EVIDENCE_UPLOAD_MAX_ATTEMPTS,
      }).catch((error: unknown) => {
        this.logger.warn(
          { runId, message: error instanceof Error ? error.message : String(error) },
          '证据收尾失败',
        )
      })
      stop.stop()
    }
  }

  private async acquireSession(
    snapshot: RunSnapshot,
    grant: RunGrant,
    signal: AbortSignal,
  ): Promise<{ kind: 'held'; grant: SessionGrant } | { kind: 'stop' }> {
    if (!this.browser) {
      await yieldPlacement(this.handle, grant)
      return { kind: 'stop' }
    }
    try {
      const outcome = await this.browser.acquire(snapshot, grant, signal)
      if (outcome.ok) return { kind: 'held', grant: outcome.grant }
      if (signal.aborted) return { kind: 'stop' }
      if (outcome.waitingForAuth) return { kind: 'stop' }
      if (isPlacementYieldCode(outcome.code)) {
        await yieldPlacement(this.handle, grant)
        return { kind: 'stop' }
      }
      if (isSessionConfigErrorCode(outcome.code)) {
        await failRunValidation(this.handle, grant.runId, { grant }, acquireValidationError(outcome))
        return { kind: 'stop' }
      }
      this.logger.warn({ runId: grant.runId, code: outcome.code }, 'acquire 未识别的失败，按配置错误收场')
      await failRunValidation(this.handle, grant.runId, { grant }, acquireValidationError(outcome))
      return { kind: 'stop' }
    } catch (error) {
      if (signal.aborted) return { kind: 'stop' }
      this.logger.warn(
        { runId: grant.runId, message: error instanceof Error ? error.message : String(error) },
        'acquire 抛出异常，按配置错误收场',
      )
      await failRunValidation(this.handle, grant.runId, { grant }, {
        code: 'SESSION_ACQUIRE_FAILED',
        category: 'INFRASTRUCTURE',
        retryable: false,
        safeMessage: '会话获取过程异常，运行在步骤开始前失败',
      })
      return { kind: 'stop' }
    }
  }

  private async completeAttempt(input: {
    runId: string
    grant: RunGrant
    step: Step
    stepRunId: string
    attemptId: string
    attemptNo: number
    input: JsonValue
    policy: { timeoutMs: number; retryLimit: number }
    last: boolean
    context: Record<string, JsonValue>
    sessionGrant?: SessionGrant
    targetId: string
    stop: AbortSignal
    /** 见 execute 里的同名闭包：停机中止不写终态 */
    yielding: () => boolean
    clock: EngineClock
    secrets: readonly string[]
    evidencePolicy: ReturnType<typeof resolveEvidencePolicy>
    snapshot: RunSnapshot
    taint: { hung: boolean }
  }): Promise<boolean> {
    const db = this.handle
    let attemptId = input.attemptId
    let attemptNo = input.attemptNo
    let context = input.context

    while (true) {
      // 重试之间也要看取消（D6 的「步骤间隙」），否则取消之后还会再开一次 Attempt。
      if (input.stop.aborted) {
        // 停机：这一轮的 Attempt 还没跑，原样留给接管方收孤儿，不替用户写取消。
        if (input.yielding()) return false
        await this.close({
          runId: input.runId,
          attemptId,
          attemptStatus: 'CANCELLED',
          error: CANCELLED_ATTEMPT_ERROR,
          stepRunStatus: 'CANCELLED',
          runStatus: 'CANCELLED',
          cancelPending: true,
          grant: input.grant,
          sessionLease: sessionLeaseFor(input),
          secrets: input.secrets,
        })
        return false
      }

      const outcome = await this.runExecutor({
        step: input.step,
        input: input.input,
        context,
        timeoutMs: input.policy.timeoutMs,
        stop: input.stop,
        clock: input.clock,
        sessionGrant: input.sessionGrant,
        runId: input.runId,
        stepRunId: input.stepRunId,
        attemptId,
        targetId: input.targetId,
        evidencePolicy: input.evidencePolicy,
        grant: input.grant,
        snapshot: input.snapshot,
      })
      if (outcome.hung) input.taint.hung = true

      // 成功也要看写入结果：取消请求抢先到达时 finishAttempt 会把它改写成取消，此时必须停手。
      if (outcome.kind === 'success') {
        if (input.step.outputKey) {
          context = {
            ...context,
            [input.step.outputKey]: jsonValueSchema.parse(contextValue(input.step, outcome.output)),
          }
        }
        return this.close({
          runId: input.runId,
          attemptId,
          attemptStatus: 'SUCCEEDED',
          output: outcome.output,
          context,
          screenshot: outcome.screenshot,
          trace: outcome.trace,
          stepRunStatus: 'SUCCEEDED',
          runStatus: input.last ? 'SUCCEEDED' : undefined,
          grant: input.grant,
          sessionLease: sessionLeaseFor(input),
          secrets: input.secrets,
        })
      }

      const error = outcome.error
      if (
        outcome.kind === 'needs_review' ||
        shouldNeedsReview(input.step, error, outcome.timedOut, outcome.aborted)
      ) {
        await this.close({
          runId: input.runId,
          attemptId,
          attemptStatus: 'FAILED',
          error,
          diagnostics: outcome.diagnostics,
          screenshot: outcome.screenshot,
          trace: outcome.trace,
          stepRunStatus: 'FAILED',
          runStatus: 'NEEDS_REVIEW',
          grant: input.grant,
          sessionLease: sessionLeaseFor(input),
          secrets: input.secrets,
        })
        return false
      }

      // 停机中止。SIDE_EFFECT 已在上面的 needs_review 分支拿到结论，能走到这里的都可安全重跑。
      if (outcome.aborted && !outcome.timedOut && input.yielding()) return false

      if (outcome.kind === 'cancelled' || (outcome.aborted && !outcome.timedOut)) {
        await this.close({
          runId: input.runId,
          attemptId,
          attemptStatus: 'CANCELLED',
          error,
          diagnostics: outcome.diagnostics,
          screenshot: outcome.screenshot,
          trace: outcome.trace,
          stepRunStatus: 'CANCELLED',
          runStatus: 'CANCELLED',
          cancelPending: true,
          grant: input.grant,
          sessionLease: sessionLeaseFor(input),
          secrets: input.secrets,
        })
        return false
      }

      const retry = shouldRetry(input.step, error, attemptNo, input.policy.retryLimit)
      const closed = await this.close({
        runId: input.runId,
        attemptId,
        attemptStatus: 'FAILED',
        error,
        output: outcome.output,
        diagnostics: outcome.diagnostics,
        screenshot: outcome.screenshot,
        trace: outcome.trace,
        stepRunStatus: retry ? 'RUNNING' : 'FAILED',
        runStatus: retry ? undefined : 'FAILED',
        skipRemaining: !retry,
        grant: input.grant,
        sessionLease: sessionLeaseFor(input),
        secrets: input.secrets,
      })
      if (!closed || !retry) return false

      const next = await startAttempt(db, {
        runId: input.runId,
        stepRunId: input.stepRunId,
        inputPayload: evidencePayloadForStep(input.step, input.input),
        grant: input.grant,
        secrets: input.secrets,
      })
      if (!next) {
        await this.finishAfterZeroRow(input.runId, input.grant, input.stop, input.yielding)
        return false
      }
      attemptId = next.attemptId
      attemptNo = next.attemptNo
    }
  }

  private async runExecutor(input: {
    step: Step
    input: JsonValue
    context: Record<string, JsonValue>
    timeoutMs: number
    stop: AbortSignal
    clock: EngineClock
    sessionGrant?: SessionGrant
    runId: string
    stepRunId: string
    attemptId: string
    targetId: string
    evidencePolicy: ReturnType<typeof resolveEvidencePolicy>
    grant: RunGrant
    snapshot: RunSnapshot
  }): Promise<ExecutorOutcome> {
    const { step, timeoutMs, stop, clock } = input
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), timeoutMs)
    const combined = AbortSignal.any([stop, timeout.signal])
    try {
      const executor = this.registry.get(step.type)
      if (!executor) {
        return {
          kind: 'failed',
          error: {
            code: 'EXECUTOR_NOT_FOUND',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: `未找到步骤类型 [${step.type}] 的执行器`,
          },
          timedOut: false,
          aborted: false,
        }
      }

      const outcome = await executor.execute({
        runId: input.runId,
        stepRunId: input.stepRunId,
        attemptId: input.attemptId,
        targetId: input.targetId,
        step,
        input: input.input,
        context: input.context,
        signal: combined,
        clock,
        sessionGrant: input.sessionGrant,
        evidencePolicy: input.evidencePolicy,
        grant: input.grant,
        snapshot: input.snapshot,
      })

      // 执行器可能把中止收成一个普通失败结果返回（AI SDK 会把 abort 包成自己的错误）。
      // 中止判定以引擎自己的信号为准，否则副作用步骤会丢掉 NEEDS_REVIEW 这条处置路径。
      if (outcome.kind === 'success') return { ...outcome, timedOut: false, aborted: false }
      return {
        ...outcome,
        timedOut: (outcome.timedOut ?? false) || (timeout.signal.aborted && !stop.aborted),
        aborted: (outcome.aborted ?? false) || timeout.signal.aborted || stop.aborted,
      }
    } catch (error) {
      const timedOut = timeout.signal.aborted && !stop.aborted
      const aborted = isAbortError(error) || stop.aborted || timeout.signal.aborted
      if (step.effectType === 'SIDE_EFFECT' && aborted) {
        return {
          kind: 'needs_review',
          error: {
            code: timedOut ? 'TIMEOUT' : 'UNKNOWN',
            category: timedOut ? 'TIMEOUT' : 'UNKNOWN',
            retryable: false,
            safeMessage: timedOut ? '副作用步骤超时，结果未确认' : '副作用步骤中止，结果未确认',
          },
          timedOut,
          aborted,
        }
      }
      if (aborted) {
        return {
          kind: timedOut ? 'failed' : 'cancelled',
          error: {
            code: timedOut ? 'TIMEOUT' : 'CANCELLED',
            category: timedOut ? 'TIMEOUT' : 'CANCELLED',
            retryable: timedOut,
            safeMessage: timedOut ? '步骤超时' : '步骤已取消',
          },
          timedOut,
          aborted,
        }
      }
      // 非中止的异常是执行器故障，不是取消：记 EXECUTOR，是否再试交给策略。
      this.logger.error(
        { message: error instanceof Error ? error.message : String(error) },
        '执行器抛出异常',
      )
      return {
        kind: 'failed',
        error: {
          code: 'EXECUTOR_ERROR',
          category: 'EXECUTOR',
          retryable: true,
          safeMessage: '执行器执行失败',
        },
        timedOut: false,
        aborted: false,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private async finishAfterZeroRow(
    runId: string,
    grant: RunGrant,
    stop: AbortSignal,
    yielding: () => boolean,
  ): Promise<void> {
    const row = await loadRunRow(this.handle, runId)
    if (!row || row.status !== 'RUNNING') return
    if (row.cancelRequestedAt) {
      await markRunCancelled(this.handle, runId, { grant })
      return
    }
    if (stop.aborted && !yielding()) {
      await markRunCancelled(this.handle, runId, { grant })
    }
  }

  /**
   * 轮询取消请求并把在途执行打断。
   *
   * 与整个 `execute` 同长：跨步骤、跨重试都有效；一旦命中就一直保持 aborted，所以后续
   * 步骤与重试都不会再发起。Run 被别处收尾（离开 RUNNING）时同样停机。
   * 轮询是本期唯一手段：取消没有 NOTIFY 可依赖（P7）。
   */
  private watchCancellation(
    runId: string,
    external: AbortSignal,
    clock: EngineClock,
    pollMs: number,
  ): { signal: AbortSignal; fromDb: AbortSignal; stop: () => void } {
    const controller = new AbortController()
    const signal = AbortSignal.any([external, controller.signal])

    const loop = async (): Promise<void> => {
      while (!signal.aborted) {
        try {
          await clock.sleep(pollMs, signal)
        } catch {
          return
        }
        if (signal.aborted) return
        await expireRunDeadlines(this.handle, runId)
        const row = await loadRunRow(this.handle, runId)
        if (!row || row.status !== 'RUNNING' || row.cancelRequestedAt) {
          controller.abort()
          return
        }
      }
    }
    void loop().catch((error: unknown) => {
      this.logger.warn({ runId, error }, '取消轮询中断')
    })

    // fromDb 只在「库里说停」时 abort：调用方靠它把停机中止与取消分开。
    return { signal, fromDb: controller.signal, stop: () => controller.abort() }
  }

  /**
   * 收尾一次 Attempt。
   *
   * 返回 true 表示这次收尾真的落库、且没有被取消请求改写成取消——只有此时才允许继续推进。
   * `updated: false`（Attempt 已被关闭，迟到回调）与 `cancelled: true` 都必须立刻停手。
   */
  private async close(input: FinishAttemptInput): Promise<boolean> {
    const result = await finishAttempt(this.handle, input)
    return result.updated && !result.cancelled
  }

  private async resolveRedactionSecrets(snapshot: RunSnapshot): Promise<string[]> {
    const secrets: string[] = []
    if (snapshot.secretRef?.provider === LOCAL_SECRET_PROVIDER && this.secrets) {
      const row = await loadSecretCiphertext(this.handle, snapshot.secretRef.secretId)
      if (row) {
        try {
          const password = this.secrets.decrypt(row.id, row.ciphertext)
          if (password) secrets.push(password)
        } catch {
          // 解密失败不阻断执行，只是这一份口令进不了脱敏集
        }
      }
    }
    const modelRef = snapshot.aiExecution?.secretRef
    if (modelRef?.provider === LOCAL_SECRET_PROVIDER && this.secrets) {
      const row = await loadSecretCiphertext(this.handle, modelRef.secretId)
      if (row) {
        try {
          const key = this.secrets.decrypt(row.id, row.ciphertext)
          if (key) secrets.push(key)
        } catch {
          // 同上
        }
      }
    }
    if (config.CAIRN_BROWSER_AI_API_KEY) secrets.push(config.CAIRN_BROWSER_AI_API_KEY)
    return secrets
  }
}

function resolveStepInput(
  step: Step,
  context: Record<string, JsonValue>,
): { ok: true; input: JsonValue } | { ok: false; input: JsonValue; error: ExecutionError } {
  if (step.type === 'echo') {
    if (step.input.value !== undefined) return { ok: true, input: step.input.value }
    const from = step.input.from!
    const resolved = readContextValue(context, from, step.input.fromField)
    if (!resolved.ok) {
      return {
        ok: false,
        input: {
          from,
          ...(step.input.fromField ? { fromField: step.input.fromField } : {}),
        },
        error: {
          code: resolved.code,
          category: 'VALIDATION',
          retryable: false,
          safeMessage: resolved.message,
        },
      }
    }
    return { ok: true, input: resolved.value }
  }
  if (step.type === 'fill') {
    if (step.input.value !== undefined) {
      return { ok: true, input: { target: step.input.target, value: step.input.value } }
    }
    const from = step.input.from!
    const resolved = fillTextFromContext(context, from, step.input.fromField)
    if (!resolved.ok) {
      return {
        ok: false,
        input: {
          target: step.input.target,
          from,
          ...(step.input.fromField ? { fromField: step.input.fromField } : {}),
        },
        error: {
          code: resolved.code,
          category: 'VALIDATION',
          retryable: false,
          safeMessage: resolved.message,
        },
      }
    }
    return { ok: true, input: { target: step.input.target, value: resolved.text } }
  }
  return { ok: true, input: step.input }
}

/** 可被 Engine 推进：未开始，或已在跑但没有未关闭的 Attempt（接管收孤儿后）。 */
function isRunnableStepRun(stepRun: RunDetailDto['stepRuns'][number]): boolean {
  if (stepRun.status === 'PENDING') return true
  if (stepRun.status !== 'RUNNING') return false
  return !stepRun.attempts.some((attempt) => attempt.status === 'RUNNING')
}

/**
 * 当前步骤是否为「最后一个未完成步骤」。
 * RUNNING 与 PENDING 都算未完成——接管后不得把后面的步骤当成最后一步写 SUCCEEDED。
 */
function isLastOpenStep(detail: RunDetailDto, stepId: string): boolean {
  const current = detail.stepRuns.find((item) => item.stepId === stepId)
  if (!current) return false
  return detail.stepRuns.every(
    (item) =>
      item.ordinal <= current.ordinal || (item.status !== 'PENDING' && item.status !== 'RUNNING'),
  )
}

function shouldNeedsReview(step: Step, error: ExecutionError, timedOut: boolean, aborted: boolean): boolean {
  if (step.effectType !== 'SIDE_EFFECT') return false
  if (error.category === 'UNKNOWN') return true
  if (error.category === 'TIMEOUT' || timedOut) return true
  return aborted
}

function sessionLeaseFor(input: {
  step: Step
  sessionGrant?: SessionGrant
  grant: RunGrant
}): FinishAttemptInput['sessionLease'] {
  if (!input.sessionGrant || !stepUsesBrowser(input.step.type)) return undefined
  return {
    ...input.sessionGrant,
    holderWorkerId: input.grant.holderWorkerId,
    effectType: input.step.effectType,
  }
}

function contextValue(step: Step, output: JsonValue): JsonValue {
  if (
    step.type === 'extract' &&
    output &&
    typeof output === 'object' &&
    !Array.isArray(output) &&
    'value' in output
  ) {
    return jsonValueSchema.parse(output.value)
  }
  return output
}

const ACQUIRE_FAIL_MESSAGES: Record<string, string> = {
  SESSION_ACCOUNT_REQUIRED: '浏览器步骤未指定目标账号，无法建立会话',
  SESSION_TARGET_MISSING: '目标系统不存在或已被删除',
  SESSION_POLICY_INVALID: '会话策略不合法',
}

function acquireValidationError(outcome: { code: string; message: string }): ExecutionError {
  return {
    code: outcome.code,
    category: isSessionConfigErrorCode(outcome.code) ? 'VALIDATION' : 'INFRASTRUCTURE',
    retryable: false,
    safeMessage: ACQUIRE_FAIL_MESSAGES[outcome.code] ?? outcome.message,
  }
}

function evidencePayloadForStep(step: Step, input: JsonValue): JsonValue {
  if (
    step.type === 'fill' &&
    step.input.sensitive &&
    input &&
    typeof input === 'object' &&
    !Array.isArray(input)
  ) {
    return { ...input, value: REDACTED }
  }
  return input
}

function shouldRetry(step: Step, error: ExecutionError, attemptNo: number, retryLimit: number): boolean {
  if (attemptNo >= retryLimit + 1) return false
  if (error.code === ASSERT_FAILED_CODE) return false
  if (isAiStepType(step.type) && step.type === 'ai_action') return false
  if (step.effectType === 'SIDE_EFFECT' && (error.category === 'UNKNOWN' || error.category === 'TIMEOUT')) {
    return false
  }
  if (error.category === 'VALIDATION' || error.category === 'CANCELLED') return false
  return error.category === 'TIMEOUT' || error.category === 'EXECUTOR' || error.category === 'INFRASTRUCTURE'
}
