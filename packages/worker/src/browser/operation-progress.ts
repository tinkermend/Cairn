import type { SessionOperationProgressPhase } from '@cairn/shared'
import { appendSessionEvent, type DbHandle } from '@cairn/db'

type SessionKey = { targetId: string; targetAccountId: string }

type ProgressEvent = {
  phase: SessionOperationProgressPhase
  observedAt: string
  durationMs?: number
  summary?: string
  detail?: Record<string, unknown>
}

/** 进程内登记超过这么久仍未收尾的操作视为已被别处结束（取消、回收），丢弃避免泄漏。 */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000

/**
 * 一次会话维护操作的过程记录。用户发起的操作逐阶段落 operation.progress；
 * 后台操作先攒在内存，只在失败时由 finishMaintenance 一次性补写，避免保活巡检撑大事件表。
 */
export class OperationProgress {
  readonly claimedAt = Date.now()
  private readonly buffered: ProgressEvent[] = []

  constructor(
    private readonly db: DbHandle,
    readonly input: {
      key: SessionKey
      operationId: string
      kind: string
      background: boolean
      /** 入队时间；用来算排队耗时。 */
      createdAt?: Date | null
      sessionId?: string | null
      generation?: number | null
    },
  ) {}

  get queuedMs(): number | null {
    return this.input.createdAt ? Math.max(0, this.claimedAt - this.input.createdAt.getTime()) : null
  }

  elapsedMs(): number {
    return Date.now() - this.claimedAt
  }

  bindSession(session: { id: string; generation: number } | null | undefined): void {
    if (!session) return
    this.input.sessionId = session.id
    this.input.generation = session.generation
  }

  async mark(
    phase: SessionOperationProgressPhase,
    extra: { durationMs?: number; summary?: string; detail?: Record<string, unknown> } = {},
  ): Promise<void> {
    const event: ProgressEvent = { phase, observedAt: new Date().toISOString(), ...extra }
    if (this.input.background) {
      this.buffered.push(event)
      return
    }
    await this.write(event)
  }

  /** 后台操作失败时补写攒下的阶段；成功时丢弃。 */
  async flush(failed: boolean): Promise<void> {
    const pending = this.buffered.splice(0)
    if (!failed) return
    for (const event of pending) await this.write(event)
  }

  private async write(event: ProgressEvent): Promise<void> {
    // 过程事件只是观察面，写失败不能拖垮维护本身。
    await appendSessionEvent(this.db, {
      key: this.input.key,
      type: 'operation.progress',
      operationId: this.input.operationId,
      sessionId: this.input.sessionId ?? null,
      generation: this.input.generation ?? null,
      payload: { kind: this.input.kind, ...event },
    }).catch(() => undefined)
  }
}

const registry = new Map<string, OperationProgress>()

export function beginOperationProgress(
  db: DbHandle,
  input: ConstructorParameters<typeof OperationProgress>[1],
): OperationProgress {
  const now = Date.now()
  for (const [id, progress] of registry) {
    if (now - progress.claimedAt > STALE_AFTER_MS) registry.delete(id)
  }
  const progress = new OperationProgress(db, input)
  registry.set(input.operationId, progress)
  return progress
}

export function peekOperationProgress(operationId: string): OperationProgress | undefined {
  return registry.get(operationId)
}

export function takeOperationProgress(operationId: string): OperationProgress | undefined {
  const progress = registry.get(operationId)
  registry.delete(operationId)
  return progress
}

/** 测试隔离用：清空进程内登记。 */
export function clearOperationProgress(): void {
  registry.clear()
}
