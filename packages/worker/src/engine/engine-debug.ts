import {
  appendRunEvents,
  conflict,
  continueRunDebug,
  enterRunHolding,
  failRunValidation,
  getSessionById,
  loadRunDetail,
  loadRunRow,
  markRunCancelled,
  stopRunDebug,
  type DbHandle,
} from '@cairn/db'
import {
  pageIdentityChanged,
  type DebugAction,
  type DebugCheckpoint,
  type DebugCheckpointReason,
  type DebugMode,
  type DebugOverlay,
  type ProcessLogExit,
  type RunGrant,
  type RunSnapshot,
  type SessionGrant,
} from '@cairn/shared'
import { config } from '../config/env.js'
import { checkpointOf } from './engine-decisions.js'
import type { ExecutionEngine } from './engine.js'

export async function holdRun(
  this: ExecutionEngine,
  input: {
    runId: string
    grant: RunGrant
    debugMode: DebugMode
    reason: DebugCheckpointReason
    stepId: string
    stepOrdinal: number
    contextKeys: string[]
    sessionGrant?: SessionGrant
    overlay?: DebugOverlay | null
  },
): Promise<boolean> {
  return enterRunHolding(this.handle, {
    runId: input.runId,
    grant: input.grant,
    checkpoint: await this.buildCheckpoint(input),
    debugOverlay: input.overlay,
  })
}

/** continue 只在检查点步已成功时前进；暂停在未跑步上则从当前步开跑。 */
export async function indexAfterContinue(
  this: ExecutionEngine,
  runId: string,
  index: number,
  snapshot: RunSnapshot,
): Promise<number> {
  const after = await loadRunDetail(this.handle, runId)
  const currentId = snapshot.steps[index]?.id
  const current = after?.stepRuns.find((item) => item.stepId === currentId)
  return current?.status === 'SUCCEEDED' ? index + 1 : index
}

export async function exitAfterHold(
  this: ExecutionEngine,
  db: DbHandle,
  runId: string,
  yielding: () => boolean,
): Promise<ProcessLogExit> {
  if (yielding()) return 'yielded'
  const left = await loadRunRow(db, runId)
  if (left?.status === 'FAILED') return 'failed'
  if (left?.status === 'CANCELLED' || left?.cancelRequestedAt) return 'cancelled'
  if (left?.status === 'HOLDING' || left?.status === 'WAITING_FOR_AUTH') return 'held'
  return 'stopped'
}

export async function awaitHold(
  this: ExecutionEngine,
  input: {
    runId: string
    grant: RunGrant
    stop: AbortSignal
    yielding: () => boolean
    sessionGrant?: SessionGrant
  },
): Promise<'retry' | 'continue' | 'stop'> {
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

export async function assertCanResume(this: ExecutionEngine, runId: string, action: DebugAction): Promise<void> {
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

export async function buildCheckpoint(
  this: ExecutionEngine,
  input: {
    runId: string
    debugMode: DebugMode
    reason: DebugCheckpointReason
    stepId: string
    stepOrdinal: number
    contextKeys: string[]
    sessionGrant?: SessionGrant
    grant: RunGrant
    overlay?: DebugOverlay | null
  },
): Promise<DebugCheckpoint> {
  const page = await this.browser?.describeHold?.(input.runId)
  return checkpointOf({ ...input, pageRef: page?.pageRef, url: page?.url })
}
