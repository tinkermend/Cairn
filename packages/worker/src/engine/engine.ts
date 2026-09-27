import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import {
  conflict,
  expireRunDeadlines,
  failRunValidation,
  finishRunIfDrained,
  loadRunDetail,
  loadRunLoopState,
  loadRunRow,
  loadRunStepStates,
  markRunCancelled,
  reconcileOrphanAttempts,
  resolveMapRunSourceType,
  skipStepRuns,
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
  stepRunFor,
  stepUsesBrowser,
  type DebugAction,
  type DebugMode,
  type RunGrant,
  type RunSnapshot,
  type SessionGrant,
  type Step,
} from '@cairn/shared'
import type { LocalSecretProvider } from '@cairn/secret'
import { DB_HANDLE } from '../db/db.module'
import { RunControlHintService } from '../observe/run-control-hint.service.js'
import { SECRET_PROVIDER } from '../tokens.js'
import { systemClock } from './clock.js'
import { BROWSER_PORT, MAP_OBSERVATION_PORT, type BrowserPort, type PassiveMapObservationPort } from './ports.js'
import { BrowserStepExecutor } from './browser-executor.js'
import { MapIngestExecutor } from './map-ingest-executor.js'
import { FixtureStepExecutor } from './fixture-executor.js'
import { STEP_EXECUTOR_REGISTRY, StepExecutorRegistry } from './step-executor.js'
import { DebugHoldRegistry } from './debug-hold.js'
import { emitProcessLog } from '../process-log.js'
import type { ObjectService } from '../objects/object.service.js'
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
import { cleanupRunFileWorkspace } from './run-file-workspace.js'
import { snapshotForDebugStep } from './debug-step-plan.js'
import {
  type AttemptLogState,
  type AttemptOutcome,
  type ExecuteOptions,
  type ExecutorOutcome,
} from './engine-types.js'
import { runStepAt } from './engine-step-at.js'
import { findLoopBlock, isLoopBodyStep, runLoop } from './engine-loop.js'

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
    @Optional() readonly objects?: ObjectService,
    @Optional() readonly controlHints?: RunControlHintService,
  ) {
    this.mapObservation = mapObservation
    this.registry =
      registry ??
      new StepExecutorRegistry([
        new FixtureStepExecutor(),
        new BrowserStepExecutor(this.handle, this.browser, undefined, undefined, objects),
        new MapIngestExecutor(this.handle, this.browser),
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
    const needsBrowser = snapshot.steps.some((step) => !step.disabled && stepUsesBrowser(step.type))
    let sessionMustClose = false

    // P7 变化提示负责及时唤醒；数据库核验、低频补查和截止时间仍由 Engine 负责。
    const stop = this.watchCancellation(runId, external, clock, options.cancelPollMs, row.deadlineAt)
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
      await stop.ready
      if (stop.signal.aborted) {
        if (!yielding()) await markRunCancelled(db, runId, { grant })
        exit = yielding() ? 'yielded' : 'cancelled'
        return
      }
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

      const consumedPauseBeforeStepIds = new Set<string>()

      for (let index = 0; index < snapshot.steps.length; ) {
        const step = snapshot.steps[index]!

        // 循环体步骤不在根循环直接执行，跳过
        if (isLoopBodyStep(snapshot, step.id)) {
          index += 1
          continue
        }

        // 循环头委托给 runLoop
        if (step.type === 'loop') {
          const loopBlock = findLoopBlock(snapshot, step)
          if (!loopBlock) {
            this.logger.error({ stepId: step.id }, '循环头步骤未找到对应的控制流块定义')
            exit = 'failed'
            return
          }
          const loopResult = await this.runLoop({
            runId,
            headerStep: step,
            block: loopBlock,
            snapshot,
            grant,
            secrets,
            evidencePolicy,
            mapSourceType,
            mapBudget,
            sessionGrant,
            authGate,
            consumedPauseBeforeStepIds,
            clock,
            stop,
            yielding,
          })
          if (loopResult.sessionMustClose) sessionMustClose = true
          if (loopResult.exit !== 'next' && loopResult.exit !== 'completed') {
            exit = loopResult.exit
            return
          }
          if (loopResult.exit === 'completed') {
            exit = 'completed'
            return
          }
          index = loopResult.lastIndex + 1
          continue
        }

        const current = await loadRunLoopState(db, runId)
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

        const stepResult = await this.runStepAt({
          runId,
          step,
          stepIndex: index,
          scopePath: '',
          contextView: { ...current.context },
          snapshot,
          grant,
          secrets,
          evidencePolicy,
          mapSourceType,
          mapBudget,
          sessionGrant,
          authGate,
          consumedPauseBeforeStepIds,
          clock,
          stop,
          yielding,
        })
        if (stepResult.sessionMustClose) sessionMustClose = true
        if (stepResult.action === 'skipped' || stepResult.action === 'next') {
          index += 1
          continue
        }
        if (stepResult.action === 'retry') {
          continue
        }
        if (stepResult.action === 'await_hold') {
          const debugMode = (current.debugMode ?? 'runThrough') as DebugMode
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
        exit = stepResult.action
        return
      }

      // 步骤都终结但 Run 还停在 RUNNING（续跑、恢复）：补一次成功终态。
      // 正常的最后一步已在同一事务里写过 SUCCEEDED，这里只是兜底。
      await finishRunIfDrained(db, grant)
      exit = 'completed'

      if (
        sessionGrant &&
        this.browser?.captureFinalScreenshot &&
        snapshot.serviceDelivery?.finalScreenshot &&
        snapshot.evidencePolicy?.screenshot !== 'off'
      ) {
        await this.browser
          .captureFinalScreenshot(sessionGrant, {
            runId,
            sensitiveSelectors: snapshot.targetAuth?.sensitiveSelectors ?? [],
            screenshotViewport: snapshot.evidencePolicy?.screenshotViewport,
          })
          .catch((error: unknown) => {
            this.logger.warn(
              { runId, message: error instanceof Error ? error.message : String(error) },
              '捕获终态截图失败',
            )
          })
      }
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
      await cleanupRunFileWorkspace(runId).catch(() => undefined)
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
    pollMs: number | undefined,
    deadlineAt: Date | null,
  ) {
    return watchCancellation.call(this, runId, external, clock, pollMs, deadlineAt)
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
    if (action.action === 'retry_current' && (action.targetOverride || action.stepOverride)) {
      const detail = await loadRunDetail(this.handle, runId)
      const stepId = detail?.checkpoint?.stepId
      if (stepId) {
        const frozenStep = detail.snapshot.steps.find((step) => step.id === stepId)
        if (action.stepOverride && (!frozenStep || action.stepOverride.id !== stepId || action.stepOverride.type !== frozenStep.type || action.stepOverride.effectType !== frozenStep.effectType)) {
          throw conflict('DEBUG_STEP_OVERRIDE_MISMATCH', '重试修改的步骤与当前挂起步骤不一致，请重新选择当前步骤')
        }
        if (action.stepOverride) {
          try {
            snapshotForDebugStep(detail.snapshot, stepId, action.stepOverride)
          } catch (error) {
            throw conflict('DEBUG_LOCATOR_ROUTE_UNAVAILABLE', error instanceof Error ? error.message : '定位顺序不可用')
          }
        }
        const previous = detail.debugOverlay?.stepOverrides[stepId]
        await updateRunDebugOverlay(this.handle, runId, {
          revision: (detail.debugOverlay?.revision ?? 0) + 1,
          stepOverrides: {
            ...(detail.debugOverlay?.stepOverrides ?? {}),
            [stepId]: {
              ...previous,
              ...(action.stepOverride ? { step: action.stepOverride } : {}),
              ...(action.targetOverride ? { target: action.targetOverride } : {}),
            },
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

  async runStepAt(params: Parameters<typeof runStepAt>[0]): ReturnType<typeof runStepAt> {
    return runStepAt.call(this, params)
  }

  async runLoop(params: Parameters<typeof runLoop>[0]): ReturnType<typeof runLoop> {
    return runLoop.call(this, params)
  }
}
