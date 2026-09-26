import {
  expireRunDeadlines,
  failRunValidation,
  loadRunControlState,
  loadRunDetail,
  loadSecretCiphertext,
  type DbHandle,
} from '@cairn/db'
import {
  isPlacementYieldCode,
  isSessionConfigErrorCode,
  LOCAL_SECRET_PROVIDER,
  stepRunFor,
  type ExecutionError,
  type RunGrant,
  type RunSnapshot,
  type SessionGrant,
} from '@cairn/shared'
import { config } from '../config/env.js'
import { yieldPlacement } from '../runtime/placement-backoff.js'
import { acquireValidationError } from './engine-decisions.js'
import { systemClock, type EngineClock } from './clock.js'
import { DEFAULT_CANCEL_POLL_MS, DEFAULT_CANCEL_RECONCILE_MS } from './engine-types.js'
import type { ExecutionEngine } from './engine.js'

export async function acquireSession(
  this: ExecutionEngine,
  snapshot: RunSnapshot,
  grant: RunGrant,
  signal: AbortSignal,
): Promise<
  | { kind: 'held'; grant: SessionGrant }
  | { kind: 'waiting_for_auth' }
  | { kind: 'failed' }
  | { kind: 'stopped' }
> {
  if (!this.browser) {
    await yieldPlacement(this.handle, grant)
    return { kind: 'stopped' }
  }
  const failAcquisition = async (error: ExecutionError) => {
    const current = await loadRunDetail(this.handle, grant.runId)
    const checkpoint = current?.authCheckpoint
    await failRunValidation(this.handle, grant.runId, { grant }, error, checkpoint ? {
      authCheckpoint: { ...checkpoint, status: 'unrecoverable', unrecoverableCode: error.code },
      stepRunId: current && checkpoint ? stepRunFor(current.stepRuns, checkpoint.nextStepId)?.id : undefined,
    } : undefined)
  }
  try {
    const outcome = await this.browser.acquire(snapshot, grant, signal)
    if (outcome.ok) return { kind: 'held', grant: outcome.grant }
    if (signal.aborted) return { kind: 'stopped' }
    if (outcome.waitingForAuth) return { kind: 'waiting_for_auth' }
    if (isPlacementYieldCode(outcome.code)) {
      await yieldPlacement(this.handle, grant)
      return { kind: 'stopped' }
    }
    if (isSessionConfigErrorCode(outcome.code)) {
      await failAcquisition(acquireValidationError(outcome))
      return { kind: 'failed' }
    }
    this.logger.warn(
      { runId: grant.runId, workerId: grant.holderWorkerId, leaseId: grant.leaseId, code: outcome.code },
      'acquire 未识别的失败，按配置错误收场',
    )
    await failAcquisition(acquireValidationError(outcome))
    return { kind: 'failed' }
  } catch (error) {
    if (signal.aborted) return { kind: 'stopped' }
    this.logger.warn(
      {
        runId: grant.runId,
        workerId: grant.holderWorkerId,
        leaseId: grant.leaseId,
        message: error instanceof Error ? error.message : String(error),
      },
      'acquire 抛出异常，按配置错误收场',
    )
    await failAcquisition({
      code: 'SESSION_ACQUIRE_FAILED',
      category: 'INFRASTRUCTURE',
      retryable: false,
      safeMessage: '会话获取过程异常，运行在步骤开始前失败',
    })
    return { kind: 'failed' }
  }
}

/**
 * 接收运行变更提示并核验取消事实，必要时把在途执行打断。
 *
 * 与整个 `execute` 同长：跨步骤、跨重试都有效；一旦命中就一直保持 aborted，所以后续
 * 步骤与重试都不会再发起。Run 被别处收尾（离开 RUNNING）时同样停机。
 * 提示可能丢失，所以还要低频补查；通知断开时临时恢复快速轻量查询。
 */
export function watchCancellation(
  this: ExecutionEngine,
  runId: string,
  external: AbortSignal,
  clock: EngineClock,
  pollMs: number | undefined,
  deadlineAt: Date | null,
): { signal: AbortSignal; fromDb: AbortSignal; ready: Promise<void>; stop: () => void } {
  const controller = new AbortController()
  const signal = AbortSignal.any([external, controller.signal])
  let dirty = false
  let sleeper: AbortController | undefined
  let checking: Promise<void> | undefined

  const wake = () => {
    dirty = true
    sleeper?.abort()
  }
  const unregister = this.controlHints?.register(runId, wake)

  const check = (): Promise<void> => {
    if (checking) return checking
    checking = (async () => {
      if (signal.aborted) return
      try {
        const row = await loadRunControlState(this.handle, runId)
        if (signal.aborted) return
        if (!row || row.cancelRequestedAt || (row.status !== 'RUNNING' && row.status !== 'HOLDING')) {
          controller.abort()
        }
      } catch (error) {
        this.logger.warn({ runId, error }, '取消状态核验失败，稍后重试')
      }
    })().finally(() => { checking = undefined })
    return checking
  }

  // 先登记提示，再补读一次，封住初始读取与订阅之间的取消竞态。
  const ready = check()

  const loop = async (): Promise<void> => {
    await ready
    while (!signal.aborted) {
      if (!dirty) {
        const delay = Math.max(1, pollMs ?? (this.controlHints?.ready ? DEFAULT_CANCEL_RECONCILE_MS : DEFAULT_CANCEL_POLL_MS))
        const waiting = new AbortController()
        sleeper = waiting
        try {
          await clock.sleep(delay, AbortSignal.any([signal, waiting.signal]))
        } catch (error) {
          if (!signal.aborted && !waiting.signal.aborted) {
            this.logger.warn({ runId, error }, '取消状态等待失败')
            return
          }
        } finally {
          if (sleeper === waiting) sleeper = undefined
        }
      }
      dirty = false
      if (signal.aborted) return
      await check()
    }
  }
  void loop().catch((error: unknown) => this.logger.warn({ runId, error }, '取消状态监视中断'))

  if (deadlineAt) {
    const dueAt = deadlineAt.getTime()
    const deadlineLoop = async (): Promise<void> => {
      await ready
      while (!signal.aborted) {
        const remaining = dueAt - Date.now()
        if (remaining > 0) {
          try {
            await systemClock.sleep(Math.min(remaining, 2_147_483_647), signal)
          } catch {
            return
          }
          continue
        }
        try {
          await expireRunDeadlines(this.handle, runId)
          await check()
        } catch (error) {
          this.logger.warn({ runId, error }, '运行截止时间核验失败，稍后重试')
        }
        if (signal.aborted) return
        // 数据库时钟稍慢或临时故障时复核，不把本机时钟直接当作取消事实。
        try {
          await systemClock.sleep(1_000, signal)
        } catch {
          return
        }
      }
    }
    void deadlineLoop().catch((error: unknown) => this.logger.warn({ runId, error }, '运行截止时间监视中断'))
  }

  // fromDb 只在「库里说停」时 abort：调用方靠它把停机中止与取消分开。
  return {
    signal,
    fromDb: controller.signal,
    ready,
    stop: () => {
      unregister?.()
      controller.abort()
      sleeper?.abort()
    },
  }
}

export async function resolveRedactionSecrets(this: ExecutionEngine, snapshot: RunSnapshot): Promise<string[]> {
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
