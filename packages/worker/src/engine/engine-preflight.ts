import {
  expireRunDeadlines,
  failRunValidation,
  loadRunDetail,
  loadRunRow,
  loadSecretCiphertext,
  type DbHandle,
} from '@cairn/db'
import {
  isPlacementYieldCode,
  isSessionConfigErrorCode,
  LOCAL_SECRET_PROVIDER,
  type ExecutionError,
  type RunGrant,
  type RunSnapshot,
  type SessionGrant,
} from '@cairn/shared'
import { config } from '../config/env.js'
import { yieldPlacement } from '../runtime/placement-backoff.js'
import { acquireValidationError } from './engine-decisions.js'
import type { EngineClock } from './clock.js'
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
      stepRunId: current?.stepRuns.find(step => step.stepId === checkpoint.nextStepId)?.id,
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
 * 轮询取消请求并把在途执行打断。
 *
 * 与整个 `execute` 同长：跨步骤、跨重试都有效；一旦命中就一直保持 aborted，所以后续
 * 步骤与重试都不会再发起。Run 被别处收尾（离开 RUNNING）时同样停机。
 * 轮询是本期唯一手段：取消没有 NOTIFY 可依赖（P7）。
 */
export function watchCancellation(
  this: ExecutionEngine,
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
