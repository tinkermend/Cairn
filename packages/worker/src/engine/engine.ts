import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import {
  conflict,
  expireRunDeadlines,
  failRunValidation,
  finishRunIfDrained,
  loadRunDetail,
  loadRunRow,
  markRunCancelled,
  reconcileOrphanAttempts,
  resolveMapRunSourceType,
  startAttempt,
  stopRunDebug,
  updateRunDebugOverlay,
  type DbHandle,
  type FinishAttemptInput,
} from '@cairn/db'
import {
  executorVersionsMatch,
  PROCESS_LOG_EVENTS,
  type ProcessLogExit,
  resolveEvidencePolicy,
  resolveStepPolicy,
  runSnapshotSchema,
  stepUsesBrowser,
  type DebugAction,
  type DebugMode,
  type RunGrant,
  type RunSnapshot,
  type SessionGrant,
} from '@cairn/shared'
import type { LocalSecretProvider } from '@cairn/secret'
import { DB_HANDLE } from '../db/db.module'
import { SECRET_PROVIDER } from '../tokens.js'
import { systemClock } from './clock.js'
import { BROWSER_PORT, MAP_OBSERVATION_PORT, type BrowserPort, type PassiveMapObservationPort } from './ports.js'
import { BrowserStepExecutor } from './browser-executor.js'
import { FixtureStepExecutor } from './fixture-executor.js'
import { MapExploreExecutor } from './explore-executor.js'
import { STEP_EXECUTOR_REGISTRY, StepExecutorRegistry } from './step-executor.js'
import { DebugHoldRegistry } from './debug-hold.js'
import { emitProcessLog } from '../process-log.js'
import { type CapturePhaseBudget } from '../map/passive-capture.js'
import {
  alreadyClosedContinues,
  close,
  collectAfterFacts,
  completeAttempt,
  finishAfterZeroRow,
  runExecutor,
  type CompleteAttemptInput,
} from './engine-attempt.js'
import { handleAuthGate } from './engine-auth-gate.js'
import {
  assertCanResume,
  awaitHold,
  buildCheckpoint,
  exitAfterHold,
  holdRun,
  indexAfterContinue,
} from './engine-debug.js'
import { acquireSession, resolveRedactionSecrets, watchCancellation } from './engine-preflight.js'
import { settleRun } from './engine-settle.js'
import { evidencePayloadForStep, isLastOpenStep, isRunnableStepRun, resolveStepInput, sessionLeaseFor } from './engine-step-plan.js'
import {
  DEFAULT_CANCEL_POLL_MS,
  type AttemptLogState,
  type AttemptOutcome,
  type ExecuteOptions,
  type ExecutorOutcome,
} from './engine-types.js'

export type { ExecuteOptions } from './engine-types.js'

@Injectable()
export class ExecutionEngine {
  readonly logger = new Logger(ExecutionEngine.name)
  readonly registry: StepExecutorRegistry
  private readonly attemptLog = new Map<string, AttemptLogState>()
  readonly holds: DebugHoldRegistry
  mapObservation?: PassiveMapObservationPort

  constructor(
    @Inject(DB_HANDLE) readonly handle: DbHandle,
    /** 含浏览器步骤的 Run 经此端口 acquire / execute / release。 */
    @Optional() @Inject(BROWSER_PORT) readonly browser?: BrowserPort,
    @Optional() @Inject(SECRET_PROVIDER) readonly secrets?: LocalSecretProvider,
    @Optional() @Inject(STEP_EXECUTOR_REGISTRY) registry?: StepExecutorRegistry,
    @Optional() holds?: DebugHoldRegistry,
    @Optional() @Inject(MAP_OBSERVATION_PORT) mapObservation?: PassiveMapObservationPort,
  ) {
    this.mapObservation = mapObservation
    this.registry =
      registry ??
      new StepExecutorRegistry([
        new FixtureStepExecutor(),
        new BrowserStepExecutor(this.handle, this.browser),
        new MapExploreExecutor(this.browser),
      ])
    this.holds = holds ?? new DebugHoldRegistry()
  }

  emitProcess(
    level: 'log' | 'warn' | 'error' | 'debug',
    event: string,
    fields: Record<string, unknown>,
  ): void {
    emitProcessLog(this.logger, level, event, fields)
  }

  rememberAttempt(attemptId: string, state: AttemptLogState): void {
    this.attemptLog.set(attemptId, state)
    this.emitProcess('log', PROCESS_LOG_EVENTS.attemptStarted, {
      runId: state.runId,
      stepRunId: state.stepRunId,
      attemptId,
      attemptNo: state.attemptNo,
      stepId: state.stepId,
      stepType: state.stepType,
      workerId: state.workerId,
      leaseId: state.leaseId,
    })
  }

  emitAttemptFinished(attemptId: string, attemptStatus: string, code?: string): void {
    const state = this.attemptLog.get(attemptId)
    this.attemptLog.delete(attemptId)
    if (!state) return
    this.emitProcess('log', PROCESS_LOG_EVENTS.attemptFinished, {
      runId: state.runId,
      stepRunId: state.stepRunId,
      attemptId,
      attemptNo: state.attemptNo,
      stepId: state.stepId,
      stepType: state.stepType,
      workerId: state.workerId,
      leaseId: state.leaseId,
      attemptStatus,
      durationMs: state.clock.now() - state.startedAt,
      code,
    })
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
      this.logger.warn(
        { runId, workerId: grant.holderWorkerId, leaseId: grant.leaseId },
        '快照或 executorVersions 非法，Run 标为 FAILED',
      )
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
    const mapSourceType = await resolveMapRunSourceType(db, snapshot.scenarioVersionId)
    const mapBudget: CapturePhaseBudget = { usedMs: 0 }
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
    const runStartedAt = clock.now()
    let exit: ProcessLogExit = 'stopped'
    this.emitProcess('log', PROCESS_LOG_EVENTS.runStarted, {
      runId,
      workerId: grant.holderWorkerId,
      leaseId: grant.leaseId,
    })

    let sessionGrant: SessionGrant | undefined
    try {
      if (needsBrowser) {
        const acquired = await this.acquireSession(snapshot, grant, stop.signal)
        if (acquired.kind !== 'held') {
          if (stop.fromDb.aborted) {
            await markRunCancelled(db, runId, { grant })
            exit = 'cancelled'
            return
          }
          if (yielding()) {
            exit = 'yielded'
            return
          }
          if (acquired.kind === 'waiting_for_auth') {
            this.emitProcess('log', PROCESS_LOG_EVENTS.runHolding, { runId, reason: 'waiting_for_auth' })
            exit = 'held'
            return
          }
          exit = acquired.kind === 'failed' ? 'failed' : 'stopped'
          return
        }
        sessionGrant = acquired.grant
      }
      const authGate = { restored: false }
      if (sessionGrant && this.browser?.restoreAuthGate) {
        authGate.restored = await this.browser.restoreAuthGate(runId, sessionGrant)
      }

      if (row.cancelRequestedAt) {
        await markRunCancelled(db, runId, { grant })
        exit = 'cancelled'
        return
      }
      if (stop.signal.aborted) {
        if (!yielding()) await markRunCancelled(db, runId, { grant })
        exit = yielding() ? 'yielded' : 'cancelled'
        return
      }

      for (let index = 0; index < snapshot.steps.length; ) {
        const step = snapshot.steps[index]!
        const current = await loadRunRow(db, runId)
        if (!current) {
          exit = 'stopped'
          return
        }
        if (current.cancelRequestedAt) {
          await markRunCancelled(db, runId, { grant })
          exit = 'cancelled'
          return
        }
        if (current.status !== 'RUNNING' && current.status !== 'HOLDING') {
          exit = 'stopped'
          return
        }
        if (stop.signal.aborted) {
          if (!yielding()) await markRunCancelled(db, runId, { grant })
          exit = yielding() ? 'yielded' : 'cancelled'
          return
        }

        const debugMode = (current.debugMode ?? 'runThrough') as DebugMode
        const detail = await loadRunDetail(db, runId)
        if (!detail) {
          exit = 'stopped'
          return
        }
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
          if (!entered) {
            exit = 'stopped'
            return
          }
          this.emitProcess('log', PROCESS_LOG_EVENTS.runHolding, {
            runId,
            reason: 'author_pause',
            stepId: heldStep.stepId,
          })
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
          exit = await this.exitAfterHold(db, runId, yielding)
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
          exit = stop.signal.aborted && !yielding() ? 'cancelled' : yielding() ? 'yielded' : 'stopped'
          return
        }
        this.rememberAttempt(started.attemptId, {
          startedAt: clock.now(),
          clock,
          stepId: step.id,
          stepType: step.type,
          attemptNo: started.attemptNo,
          runId,
          stepRunId: stepRun.id,
          workerId: grant.holderWorkerId,
          leaseId: grant.leaseId,
        })

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
          if (debugMode === 'runThrough') {
            exit = 'failed'
            return
          }
          this.emitProcess('log', PROCESS_LOG_EVENTS.runHolding, {
            runId,
            reason: 'step_failed',
            stepId: step.id,
          })
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
          exit = await this.exitAfterHold(db, runId, yielding)
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
          mapSourceType,
          mapBudget,
          authGate,
        })
        sessionMustClose = sessionMustClose || taint.hung
        if (finished === 'next') {
          index += 1
          continue
        }
        if (finished === 'await_hold') {
          this.emitProcess('log', PROCESS_LOG_EVENTS.runHolding, {
            runId,
            reason: debugMode === 'holdAfterEach' ? 'step_succeeded' : 'step_failed',
            stepId: step.id,
          })
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
          exit = await this.exitAfterHold(db, runId, yielding)
          return
        }
        exit = finished
        return
      }

      // 步骤都终结但 Run 还停在 RUNNING（续跑、恢复）：补一次成功终态。
      // 正常的最后一步已在同一事务里写过 SUCCEEDED，这里只是兜底。
      await finishRunIfDrained(db, grant)
      exit = 'completed'
    } finally {
      const latest = await loadRunRow(db, runId).catch(() => undefined)
      this.emitProcess('log', PROCESS_LOG_EVENTS.runFinished, {
        runId,
        workerId: grant.holderWorkerId,
        leaseId: grant.leaseId,
        exit,
        status: latest?.status,
        durationMs: clock.now() - runStartedAt,
      })
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
      await settleRun.call(this, db, runId, grant)
      stop.stop()
    }
  }

  async acquireSession(snapshot: RunSnapshot, grant: RunGrant, signal: AbortSignal) {
    return acquireSession.call(this, snapshot, grant, signal)
  }

  async completeAttempt(input: CompleteAttemptInput): Promise<AttemptOutcome> {
    return completeAttempt.call(this, input)
  }

  async runExecutor(input: Parameters<typeof runExecutor>[0]): Promise<ExecutorOutcome> {
    return runExecutor.call(this, input)
  }

  async finishAfterZeroRow(
    runId: string,
    grant: RunGrant,
    stop: AbortSignal,
    yielding: () => boolean,
  ): Promise<void> {
    return finishAfterZeroRow.call(this, runId, grant, stop, yielding)
  }

  watchCancellation(
    runId: string,
    external: AbortSignal,
    clock: Parameters<typeof watchCancellation>[2],
    pollMs: number,
  ) {
    return watchCancellation.call(this, runId, external, clock, pollMs)
  }

  async collectAfterFacts(input: Parameters<typeof collectAfterFacts>[0]) {
    return collectAfterFacts.call(this, input)
  }

  async handleAuthGate(input: Parameters<typeof handleAuthGate>[0]) {
    return handleAuthGate.call(this, input)
  }

  async close(input: FinishAttemptInput): Promise<boolean> {
    return close.call(this, input)
  }

  async alreadyClosedContinues(input: FinishAttemptInput): Promise<boolean> {
    return alreadyClosedContinues.call(this, input)
  }

  async resumeDebug(runId: string, action: DebugAction, actorId: string): Promise<{ ok: true }> {
    const current = await loadRunRow(this.handle, runId)
    if (current?.status === 'WAITING_FOR_AUTH') {
      throw conflict('RUN_WAITING_FOR_AUTH', '认证等待期间不能执行调试命令')
    }
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

  async holdRun(input: Parameters<typeof holdRun>[0]) {
    return holdRun.call(this, input)
  }

  async indexAfterContinue(runId: string, index: number, snapshot: RunSnapshot) {
    return indexAfterContinue.call(this, runId, index, snapshot)
  }

  async exitAfterHold(db: DbHandle, runId: string, yielding: () => boolean) {
    return exitAfterHold.call(this, db, runId, yielding)
  }

  async awaitHold(input: Parameters<typeof awaitHold>[0]) {
    return awaitHold.call(this, input)
  }

  async assertCanResume(runId: string, action: DebugAction) {
    return assertCanResume.call(this, runId, action)
  }

  async buildCheckpoint(input: Parameters<typeof buildCheckpoint>[0]) {
    return buildCheckpoint.call(this, input)
  }

  async resolveRedactionSecrets(snapshot: RunSnapshot) {
    return resolveRedactionSecrets.call(this, snapshot)
  }
}
