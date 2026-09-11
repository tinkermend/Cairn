import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import {
  failRunValidation,
  finishAttempt,
  finishRunIfDrained,
  loadRunDetail,
  loadRunRow,
  markRunCancelled,
  reconcileOrphanAttempts,
  startAttempt,
  type DbHandle,
  type FinishAttemptInput,
} from '@cairn/db'
import {
  CANCELLED_ATTEMPT_ERROR,
  DEFAULT_EXECUTOR_VERSIONS,
  jsonValueSchema,
  resolveStepPolicy,
  runSnapshotSchema,
  type ExecutionError,
  type JsonValue,
  type RunDetailDto,
  type RunGrant,
  type Step,
} from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import { isAbortError, systemClock, type EngineClock } from './clock.js'
import { executeDelay, executeEcho, executeFail } from './executors.js'
import { BROWSER_PORT, type BrowserPort } from './ports.js'

export type ExecuteOptions = {
  grant: RunGrant
  signal?: AbortSignal
  clock?: EngineClock
  /** 轮询取消请求的间隔。取消只能查库发现（NOTIFY 属 P7），测试用它把窗口压小。 */
  cancelPollMs?: number
}

/** 取消请求的轮询间隔：更密只增加查询，不会更早发现取消。 */
const DEFAULT_CANCEL_POLL_MS = 250

type ExecutorOutcome =
  | { kind: 'success'; output: JsonValue }
  | { kind: 'failed' | 'cancelled' | 'needs_review'; error: ExecutionError; timedOut: boolean; aborted: boolean }

@Injectable()
export class ExecutionEngine {
  private readonly logger = new Logger(ExecutionEngine.name)

  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    /** 本期 Echo/Delay/Fail 不消费；P5 浏览器步骤经此端口拿 SessionGrant。 */
    @Optional() @Inject(BROWSER_PORT) private readonly browser?: BrowserPort,
  ) {}

  async execute(runId: string, options: ExecuteOptions): Promise<void> {
    const grant = options.grant
    const clock = options.clock ?? systemClock
    const external = options.signal ?? new AbortController().signal
    const db = this.handle.db

    const orphan = await reconcileOrphanAttempts(db, { grant })
    if (orphan !== 'continue') return

    const row = await loadRunRow(db, runId)
    if (!row || row.status !== 'RUNNING') return

    const parsed = runSnapshotSchema.safeParse(row.snapshot)
    if (!parsed.success || !executorVersionsMatch(parsed.data.executorVersions)) {
      this.logger.warn({ runId }, '快照或 executorVersions 非法，Run 标为 FAILED')
      await failRunValidation(db, runId, { grant })
      return
    }
    const snapshot = parsed.data

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

    try {
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
          inputPayload: resolved.input,
          grant,
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
          })
          return
        }

        const policy = resolveStepPolicy(snapshot.policy, step.policy)
        const last = isLastOpenStep(detail, step.id)
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
          stop: stop.signal,
          yielding,
          clock,
        })
        if (!finished) return
      }

      // 步骤都终结但 Run 还停在 RUNNING（续跑、恢复）：补一次成功终态。
      // 正常的最后一步已在同一事务里写过 SUCCEEDED，这里只是兜底。
      await finishRunIfDrained(db, grant)
    } finally {
      stop.stop()
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
    stop: AbortSignal
    /** 见 execute 里的同名闭包：停机中止不写终态 */
    yielding: () => boolean
    clock: EngineClock
  }): Promise<boolean> {
    const db = this.handle.db
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
        })
        return false
      }

      const outcome = await this.runExecutor(input.step, input.input, input.policy.timeoutMs, input.stop, input.clock)

      // 成功也要看写入结果：取消请求抢先到达时 finishAttempt 会把它改写成取消，此时必须停手。
      if (outcome.kind === 'success') {
        if (input.step.outputKey) {
          context = { ...context, [input.step.outputKey]: jsonValueSchema.parse(outcome.output) }
        }
        return this.close({
          runId: input.runId,
          attemptId,
          attemptStatus: 'SUCCEEDED',
          output: outcome.output,
          context,
          stepRunStatus: 'SUCCEEDED',
          runStatus: input.last ? 'SUCCEEDED' : undefined,
          grant: input.grant,
        })
      }

      const error = outcome.error
      if (shouldNeedsReview(input.step, error, outcome.timedOut, outcome.aborted)) {
        await this.close({
          runId: input.runId,
          attemptId,
          attemptStatus: 'FAILED',
          error,
          stepRunStatus: 'FAILED',
          runStatus: 'NEEDS_REVIEW',
          grant: input.grant,
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
          stepRunStatus: 'CANCELLED',
          runStatus: 'CANCELLED',
          cancelPending: true,
          grant: input.grant,
        })
        return false
      }

      const retry = shouldRetry(input.step, error, attemptNo, input.policy.retryLimit)
      const closed = await this.close({
        runId: input.runId,
        attemptId,
        attemptStatus: 'FAILED',
        error,
        stepRunStatus: retry ? 'RUNNING' : 'FAILED',
        runStatus: retry ? undefined : 'FAILED',
        skipRemaining: !retry,
        grant: input.grant,
      })
      if (!closed || !retry) return false

      const next = await startAttempt(db, {
        runId: input.runId,
        stepRunId: input.stepRunId,
        inputPayload: input.input,
        grant: input.grant,
      })
      if (!next) {
        await this.finishAfterZeroRow(input.runId, input.grant, input.stop, input.yielding)
        return false
      }
      attemptId = next.attemptId
      attemptNo = next.attemptNo
    }
  }

  private async runExecutor(
    step: Step,
    input: JsonValue,
    timeoutMs: number,
    stop: AbortSignal,
    clock: EngineClock,
  ): Promise<ExecutorOutcome> {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), timeoutMs)
    const combined = AbortSignal.any([stop, timeout.signal])
    try {
      if (step.type === 'echo') return { kind: 'success', output: executeEcho(input) }
      if (step.type === 'delay') {
        return { kind: 'success', output: await executeDelay(step.input.durationMs, combined, clock) }
      }
      return { kind: 'failed', error: executeFail(step.input), timedOut: false, aborted: false }
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
    const row = await loadRunRow(this.handle.db, runId)
    if (!row || row.status !== 'RUNNING') return
    if (row.cancelRequestedAt) {
      await markRunCancelled(this.handle.db, runId, { grant })
      return
    }
    if (stop.aborted && !yielding()) {
      await markRunCancelled(this.handle.db, runId, { grant })
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
        const row = await loadRunRow(this.handle.db, runId)
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
    const result = await finishAttempt(this.handle.db, input)
    return result.updated && !result.cancelled
  }
}

function executorVersionsMatch(versions: Record<string, string> | undefined): boolean {
  if (!versions) return false
  return (['echo', 'delay', 'fail'] as const).every((key) => versions[key] === DEFAULT_EXECUTOR_VERSIONS[key])
}

function resolveStepInput(
  step: Step,
  context: Record<string, JsonValue>,
): { ok: true; input: JsonValue } | { ok: false; input: JsonValue; error: ExecutionError } {
  if (step.type === 'echo') {
    if (step.input.value !== undefined) return { ok: true, input: step.input.value }
    const from = step.input.from!
    if (!Object.hasOwn(context, from)) {
      return {
        ok: false,
        input: { from },
        error: {
          code: 'UNRESOLVED_REF',
          category: 'VALIDATION',
          retryable: false,
          safeMessage: `context 中不存在 ${from}`,
        },
      }
    }
    return { ok: true, input: jsonValueSchema.parse(context[from]) }
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

function shouldRetry(step: Step, error: ExecutionError, attemptNo: number, retryLimit: number): boolean {
  if (attemptNo >= retryLimit + 1) return false
  if (step.effectType === 'SIDE_EFFECT' && (error.category === 'UNKNOWN' || error.category === 'TIMEOUT')) {
    return false
  }
  if (error.category === 'VALIDATION' || error.category === 'CANCELLED') return false
  return error.category === 'TIMEOUT' || error.category === 'EXECUTOR' || error.category === 'INFRASTRUCTURE'
}
