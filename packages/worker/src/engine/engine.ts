import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import {
  conflict,
  appendRunEvents,
  continueRunDebug,
  enterRunHolding,
  expireRunDeadlines,
  failRunValidation,
  finishAttempt,
  finishRunIfDrained,
  getSessionById,
  loadRunDetail,
  loadRunRow,
  loadSecretCiphertext,
  markRunCancelled,
  reconcileOrphanAttempts,
  settleRunEvidence,
  startAttempt,
  stopRunDebug,
  updateRunDebugOverlay,
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
  pageIdentityChanged,
  resolveEvidencePolicy,
  resolveStepPolicy,
  retainUntilFor,
  runSnapshotSchema,
  type BrowserCommand,
  type DebugAction,
  type DebugCheckpointReason,
  type ExecutionError,
  type JsonValue,
  type PageRef,
  type ResolverDiagnostics,
  type RunDetailDto,
  type RunGrant,
  type RunSnapshot,
  type ScreenshotPointer,
  type DebugCheckpoint,
  type DebugMode,
  type DebugOverlay,
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
import { DebugHoldRegistry } from './debug-hold.js'

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
  readonly holds: DebugHoldRegistry

  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    /** 含浏览器步骤的 Run 经此端口 acquire / execute / release。 */
    @Optional() @Inject(BROWSER_PORT) private readonly browser?: BrowserPort,
    @Optional() @Inject(SECRET_PROVIDER) private readonly secrets?: LocalSecretProvider,
    @Optional() @Inject(STEP_EXECUTOR_REGISTRY) registry?: StepExecutorRegistry,
    @Optional() holds?: DebugHoldRegistry,
  ) {
    this.registry =
      registry ??
      new StepExecutorRegistry([
        new FixtureStepExecutor(),
        new BrowserStepExecutor(this.handle, this.browser),
      ])
    this.holds = holds ?? new DebugHoldRegistry()
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

      for (let index = 0; index < snapshot.steps.length; ) {
        const step = snapshot.steps[index]!
        const current = await loadRunRow(db, runId)
        if (!current) return
        if (current.cancelRequestedAt) {
          await markRunCancelled(db, runId, { grant })
          return
        }
        if (current.status !== 'RUNNING' && current.status !== 'HOLDING') return
        if (stop.signal.aborted) {
          if (!yielding()) await markRunCancelled(db, runId, { grant })
          return
        }

        const debugMode = (current.debugMode ?? 'runThrough') as DebugMode
        const detail = await loadRunDetail(db, runId)
        if (!detail) return
        const stepRun = detail.stepRuns.find((item) => item.stepId === step.id)
        // PENDING：尚未执行。RUNNING 且无在途 Attempt：接管后孤儿已收，或失败重试间隙——必须续跑，不得跳过。
        if (!stepRun || !isRunnableStepRun(stepRun)) {
          index += 1
          continue
        }

        if (this.holds.consumePause(runId) && debugMode !== 'runThrough') {
          const previous = [...detail.stepRuns].reverse().find((item) => item.status === 'SUCCEEDED')
          const heldStep = previous ?? stepRun
          const entered = await this.holdRun({
            runId,
            grant,
            debugMode,
            reason: 'author_pause',
            stepId: heldStep.stepId,
            stepOrdinal: heldStep.ordinal,
            contextKeys: Object.keys(detail.context),
            sessionGrant,
            overlay: detail.debugOverlay,
          })
          if (!entered) return
          const afterHold = await this.awaitHold({
            runId,
            grant,
            stop: stop.signal,
            yielding,
            sessionGrant,
          })
          if (afterHold === 'retry') continue
          if (afterHold === 'continue') {
            index = await this.indexAfterContinue(runId, index, snapshot)
            continue
          }
          return
        }

        const overlayTarget = detail.debugOverlay?.stepOverrides[step.id]?.target
        const resolved = resolveStepInput(step, detail.context, overlayTarget)
        const started = await startAttempt(db, {
          runId,
          stepRunId: stepRun.id,
          inputPayload: evidencePayloadForStep(step, resolved.input, Boolean(overlayTarget)),
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
            runStatus: debugMode === 'runThrough' ? 'FAILED' : 'HOLDING',
            skipRemaining: debugMode === 'runThrough',
            checkpoint:
              debugMode === 'runThrough'
                ? undefined
                : await this.buildCheckpoint({
                    runId,
                    debugMode,
                    reason: 'step_failed',
                    stepId: step.id,
                    stepOrdinal: stepRun.ordinal,
                    contextKeys: Object.keys(detail.context),
                    sessionGrant,
                    grant,
                    overlay: detail.debugOverlay,
                  }),
            grant,
            sessionLease: sessionLeaseFor({ step, sessionGrant, grant }),
            secrets,
          })
          if (debugMode === 'runThrough') return
          const afterHold = await this.awaitHold({
            runId,
            grant,
            stop: stop.signal,
            yielding,
            sessionGrant,
          })
          if (afterHold === 'retry') continue
          if (afterHold === 'continue') {
            index = await this.indexAfterContinue(runId, index, snapshot)
            continue
          }
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
          stepOrdinal: stepRun.ordinal,
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
          debugMode,
          overlay: detail.debugOverlay,
        })
        sessionMustClose = sessionMustClose || taint.hung
        if (finished === 'stop') return
        if (finished === 'held') {
          const afterHold = await this.awaitHold({
            runId,
            grant,
            stop: stop.signal,
            yielding,
            sessionGrant,
          })
          if (afterHold === 'retry') continue
          if (afterHold === 'continue') {
            index = await this.indexAfterContinue(runId, index, snapshot)
            continue
          }
          return
        }
        index += 1
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
    stepOrdinal: number
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
    debugMode: DebugMode
    overlay?: DebugOverlay | null
  }): Promise<'next' | 'stop' | 'held'> {
    const db = this.handle
    let attemptId = input.attemptId
    let attemptNo = input.attemptNo
    let context = input.context

    while (true) {
      // 重试之间也要看取消（D6 的「步骤间隙」），否则取消之后还会再开一次 Attempt。
      if (input.stop.aborted) {
        // 停机：这一轮的 Attempt 还没跑，原样留给接管方收孤儿，不替用户写取消。
        if (input.yielding()) return 'stop'
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
        return 'stop'
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
        const pause = this.holds.consumePause(input.runId)
        const hold = input.debugMode === 'holdAfterEach' || pause
        const closed = await this.close({
          runId: input.runId,
          attemptId,
          attemptStatus: 'SUCCEEDED',
          output: outcome.output,
          context,
          screenshot: outcome.screenshot,
          trace: outcome.trace,
          stepRunStatus: 'SUCCEEDED',
          runStatus: hold ? 'HOLDING' : input.last ? 'SUCCEEDED' : undefined,
          skipRemaining: false,
          checkpoint: hold
            ? await this.buildCheckpoint({
                runId: input.runId,
                debugMode: input.debugMode,
                reason: pause ? 'author_pause' : 'step_succeeded',
                stepId: input.step.id,
                stepOrdinal: input.stepOrdinal,
                contextKeys: Object.keys(context),
                sessionGrant: input.sessionGrant,
                grant: input.grant,
                overlay: input.overlay,
              })
            : undefined,
          grant: input.grant,
          sessionLease: sessionLeaseFor(input),
          secrets: input.secrets,
        })
        if (!closed) return 'stop'
        if (hold) return 'held'
        return input.last ? 'stop' : 'next'
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
        return 'stop'
      }

      // 停机中止。SIDE_EFFECT 已在上面的 needs_review 分支拿到结论，能走到这里的都可安全重跑。
      if (outcome.aborted && !outcome.timedOut && input.yielding()) return 'stop'

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
        return 'stop'
      }

      const retry = shouldRetry(input.step, error, attemptNo, input.policy.retryLimit)
      const hold =
        !retry && (input.debugMode === 'holdOnFailure' || input.debugMode === 'holdAfterEach')
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
        runStatus: retry ? undefined : hold ? 'HOLDING' : 'FAILED',
        skipRemaining: !retry && !hold,
        checkpoint: hold
          ? await this.buildCheckpoint({
              runId: input.runId,
              debugMode: input.debugMode,
              reason: 'step_failed',
              stepId: input.step.id,
              stepOrdinal: input.stepOrdinal,
              contextKeys: Object.keys(context),
              sessionGrant: input.sessionGrant,
              grant: input.grant,
              overlay: input.overlay,
            })
          : undefined,
        grant: input.grant,
        sessionLease: sessionLeaseFor(input),
        secrets: input.secrets,
      })
      if (!closed) return 'stop'
      if (hold) return 'held'
      if (!retry) return 'stop'

      const next = await startAttempt(db, {
        runId: input.runId,
        stepRunId: input.stepRunId,
        inputPayload: evidencePayloadForStep(input.step, input.input),
        grant: input.grant,
        secrets: input.secrets,
      })
      if (!next) {
        await this.finishAfterZeroRow(input.runId, input.grant, input.stop, input.yielding)
        return 'stop'
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
        if (!row || row.cancelRequestedAt) {
          controller.abort()
          return
        }
        if (row.status === 'RUNNING' || row.status === 'HOLDING') continue
        controller.abort()
        return
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

  async resumeDebug(runId: string, action: DebugAction, actorId: string): Promise<{ ok: true }> {
    if (action.action === 'pause') {
      if (!this.holds.resume(runId, { ...action, actorId })) {
        throw conflict('RUN_NOT_RUNNING', '只有运行中的调试会话可以请求暂停，且在途动作会先跑完')
      }
      return { ok: true }
    }
    if (action.action === 'stop') {
      if (this.holds.has(runId)) {
        this.holds.resume(runId, { ...action, actorId })
      } else {
        await stopRunDebug(this.handle, runId, { id: actorId })
      }
      return { ok: true }
    }
    if (!this.holds.has(runId)) {
      throw conflict('RUN_NOT_HOLDING', '没有等待中的调试挂起')
    }
    await this.assertCanResume(runId, action)
    if (action.action === 'retry_current' && action.targetOverride) {
      const detail = await loadRunDetail(this.handle, runId)
      const stepId = detail?.checkpoint?.stepId
      if (stepId) {
        await updateRunDebugOverlay(this.handle, runId, {
          revision: (detail.debugOverlay?.revision ?? 0) + 1,
          stepOverrides: {
            ...(detail.debugOverlay?.stepOverrides ?? {}),
            [stepId]: { target: action.targetOverride },
          },
        })
      }
    }
    this.holds.resume(runId, { ...action, actorId })
    return { ok: true }
  }

  private async holdRun(input: {
    runId: string
    grant: RunGrant
    debugMode: DebugMode
    reason: DebugCheckpointReason
    stepId: string
    stepOrdinal: number
    contextKeys: string[]
    sessionGrant?: SessionGrant
    overlay?: DebugOverlay | null
  }): Promise<boolean> {
    return enterRunHolding(this.handle, {
      runId: input.runId,
      grant: input.grant,
      checkpoint: await this.buildCheckpoint(input),
      debugOverlay: input.overlay,
    })
  }

  /** continue 只在检查点步已成功时前进；暂停在未跑步上则从当前步开跑。 */
  private async indexAfterContinue(runId: string, index: number, snapshot: RunSnapshot): Promise<number> {
    const after = await loadRunDetail(this.handle, runId)
    const currentId = snapshot.steps[index]?.id
    const current = after?.stepRuns.find((item) => item.stepId === currentId)
    return current?.status === 'SUCCEEDED' ? index + 1 : index
  }

  private async awaitHold(input: {
    runId: string
    grant: RunGrant
    stop: AbortSignal
    yielding: () => boolean
    sessionGrant?: SessionGrant
  }): Promise<'retry' | 'continue' | 'stop'> {
    const result = await this.holds.wait(input.runId, config.CAIRN_DEBUG_HOLD_TIMEOUT_MS, input.stop)
    if (result === 'timeout') {
      await failRunValidation(
        this.handle,
        input.runId,
        { grant: input.grant },
        {
          code: 'DEBUG_SESSION_TIMEOUT',
          category: 'TIMEOUT',
          retryable: false,
          safeMessage: '调试会话等待超时',
        },
        { skipRemaining: false },
      )
      return 'stop'
    }
    if (result === 'cancelled') {
      if (input.yielding()) return 'stop'
      const row = await loadRunRow(this.handle, input.runId)
      if (row?.cancelRequestedAt) {
        await markRunCancelled(this.handle, input.runId, { grant: input.grant })
      }
      return 'stop'
    }
    if (result.action === 'stop') {
      const row = await loadRunRow(this.handle, input.runId)
      if (row?.status === 'HOLDING') {
        await stopRunDebug(this.handle, input.runId, { id: result.actorId ?? input.grant.holderWorkerId })
      }
      return 'stop'
    }
    if (result.action === 'continue') {
      const resumed = await continueRunDebug(this.handle, {
        runId: input.runId,
        grant: input.grant,
      })
      return resumed ? 'continue' : 'stop'
    }
    if (result.action === 'retry_current') return 'retry'
    return this.awaitHold(input)
  }

  private async assertCanResume(runId: string, action: DebugAction): Promise<void> {
    const detail = await loadRunDetail(this.handle, runId)
    if (!detail || detail.status !== 'HOLDING' || !detail.checkpoint) {
      throw conflict('RUN_NOT_HOLDING', '仅 HOLDING 状态的运行允许调试操作')
    }
    const checkpoint = detail.checkpoint
    if (!action.fencingToken || action.fencingToken !== checkpoint.fencingToken) {
      throw conflict('DEBUG_FENCING_MISMATCH', '调试会话代次不匹配')
    }
    if (checkpoint.sessionGeneration > 0 && detail.placement.sessionId) {
      const session = await getSessionById(this.handle, detail.placement.sessionId)
      if (session && session.generation !== checkpoint.sessionGeneration) {
        throw conflict('DEBUG_FENCING_MISMATCH', '浏览器会话已变化，不能再试这一步')
      }
    }
    const current = detail.stepRuns.find((item) => item.stepId === checkpoint.stepId)
    if (action.action === 'continue') {
      if (checkpoint.reason === 'author_pause' && current?.status === 'PENDING') return
      if (current?.status !== 'SUCCEEDED') {
        throw conflict('STEP_CANNOT_RETRY', '只有当前步骤已成功时才能继续下一步')
      }
      return
    }
    if (
      current?.status !== 'FAILED' &&
      !(checkpoint.reason === 'author_pause' && current?.status === 'PENDING')
    ) {
      throw conflict('STEP_CANNOT_RETRY', '当前步骤不能再试')
    }
    const missing = checkpoint.contextKeys.filter((key) => !(key in detail.context))
    if (missing.length > 0) {
      throw conflict('CONTEXT_KEY_MISSING', `缺少上下文：${missing.join('、')}`)
    }
    const step = detail.snapshot.steps.find((item) => item.id === checkpoint.stepId)
    const sideEffect = step?.effectType === 'SIDE_EFFECT'
    if (sideEffect && !action.confirmSideEffect) {
      throw conflict('SIDE_EFFECT_CONFIRM_REQUIRED', '副作用步骤再试需要确认，可能对目标系统重复操作')
    }
    if (action.action === 'retry_current' && this.browser?.describeHold) {
      const current = await this.browser.describeHold(runId)
      if (pageIdentityChanged(checkpoint, current)) {
        if (action.pageChangedAck !== true) {
          throw conflict('PAGE_CHANGED_ACK_REQUIRED', '页面已变化，需确认后再试')
        }
        await appendRunEvents(this.handle, runId, [
          {
            type: 'run.debug_resumed',
            payload: { action: 'retry_current', pageChangedAck: true, url: current?.url ?? null },
          },
        ])
      }
    }
  }

  private async buildCheckpoint(input: {
    runId: string
    debugMode: DebugMode
    reason: DebugCheckpointReason
    stepId: string
    stepOrdinal: number
    contextKeys: string[]
    sessionGrant?: SessionGrant
    grant: RunGrant
    overlay?: DebugOverlay | null
  }): Promise<DebugCheckpoint> {
    const page = await this.browser?.describeHold?.(input.runId)
    return checkpointOf({ ...input, pageRef: page?.pageRef, url: page?.url })
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
  overlayTarget?: TargetDescriptor,
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
    const target = overlayTarget ?? step.input.target
    if (step.input.value !== undefined) {
      return { ok: true, input: { target, value: step.input.value } }
    }
    const from = step.input.from!
    const resolved = fillTextFromContext(context, from, step.input.fromField)
    if (!resolved.ok) {
      return {
        ok: false,
        input: {
          target,
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
    return { ok: true, input: { target, value: resolved.text } }
  }
  if (step.type === 'select') {
    const target = overlayTarget ?? step.input.target
    if (step.input.by === 'index' || step.input.value !== undefined) {
      return { ok: true, input: { ...step.input, target } }
    }
    const from = step.input.from!
    const resolved = fillTextFromContext(context, from, step.input.fromField)
    if (!resolved.ok) {
      return {
        ok: false,
        input: { ...step.input, target },
        error: {
          code: resolved.code,
          category: 'VALIDATION',
          retryable: false,
          safeMessage: resolved.message,
        },
      }
    }
    return { ok: true, input: { ...step.input, target, value: resolved.text } }
  }
  if (overlayTarget && step.input && typeof step.input === 'object' && 'target' in step.input) {
    return { ok: true, input: { ...step.input, target: overlayTarget } }
  }
  return { ok: true, input: step.input }
}

/** 可被 Engine 推进：未开始，或已在跑但没有未关闭的 Attempt（接管收孤儿后）。 */
function isRunnableStepRun(stepRun: RunDetailDto['stepRuns'][number]): boolean {
  if (stepRun.status === 'PENDING' || stepRun.status === 'FAILED') return true
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

function evidencePayloadForStep(step: Step, input: JsonValue, targetOverride = false): JsonValue {
  const withOverride = (value: { [key: string]: JsonValue }): JsonValue =>
    targetOverride ? { ...value, targetOverride: true } : value
  if (
    step.type === 'fill' &&
    step.input.sensitive &&
    input &&
    typeof input === 'object' &&
    !Array.isArray(input)
  ) {
    return withOverride({ ...input, value: REDACTED })
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return withOverride({ ...input })
  }
  return targetOverride ? { value: input, targetOverride: true } : input
}

function checkpointOf(input: {
  debugMode: DebugMode
  reason: DebugCheckpointReason
  stepId: string
  stepOrdinal: number
  contextKeys: string[]
  sessionGrant?: SessionGrant
  grant: RunGrant
  overlay?: DebugOverlay | null
  pageRef?: PageRef
  url?: string
}): DebugCheckpoint {
  return {
    mode: input.debugMode === 'holdAfterEach' ? 'holdAfterEach' : 'holdOnFailure',
    reason: input.reason,
    stepId: input.stepId,
    stepOrdinal: input.stepOrdinal,
    ...(input.pageRef ? { pageRef: input.pageRef } : {}),
    ...(input.url ? { url: input.url } : {}),
    contextKeys: input.contextKeys,
    sessionGeneration: input.sessionGrant?.generation ?? 0,
    fencingToken: String(input.grant.fencingToken),
    overlayRevision: input.overlay?.revision ?? 0,
  }
}

function shouldRetry(step: Step, error: ExecutionError, attemptNo: number, retryLimit: number): boolean {
  if (attemptNo >= retryLimit + 1) return false
  if (error.code === ASSERT_FAILED_CODE) return false
  // 同一次执行复用同一份会话授权，guard 撤销后不再刷新：丢租后重试注定失败。
  if (error.code === 'SESSION_LEASE_LOST') return false
  if (isAiStepType(step.type) && step.type === 'ai_action') return false
  if (step.effectType === 'SIDE_EFFECT' && (error.category === 'UNKNOWN' || error.category === 'TIMEOUT')) {
    return false
  }
  if (error.category === 'VALIDATION' || error.category === 'CANCELLED') return false
  return error.category === 'TIMEOUT' || error.category === 'EXECUTOR' || error.category === 'INFRASTRUCTURE'
}
