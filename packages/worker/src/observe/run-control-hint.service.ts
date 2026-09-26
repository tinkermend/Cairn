import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import type { ChangeHintBus } from '@cairn/db'
import type { ChangeHint } from '@cairn/shared'
import { CHANGE_HINT } from './change-hint.token'

const RETRY_MIN_MS = 250
const RETRY_MAX_MS = 8_000

@Injectable()
export class RunControlHintService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunControlHintService.name)
  private readonly callbacks = new Map<string, Set<() => void>>()
  private retryTimer: NodeJS.Timeout | undefined
  private retryDelayMs = RETRY_MIN_MS
  private unsubscribe: (() => void) | undefined
  private connecting = false
  private subscribed = false
  private stopped = false

  constructor(@Inject(CHANGE_HINT) private readonly bus: ChangeHintBus) {}

  get enabled(): boolean {
    return this.bus.realtime
  }

  get ready(): boolean {
    return this.enabled && this.subscribed
  }

  onModuleInit(): void {
    if (this.enabled) void this.connect()
  }

  onModuleDestroy(): void {
    this.stopped = true
    this.subscribed = false
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.callbacks.clear()
  }

  register(runId: string, callback: () => void): () => void {
    if (this.stopped) return () => undefined
    let listeners = this.callbacks.get(runId)
    if (!listeners) {
      listeners = new Set()
      this.callbacks.set(runId, listeners)
    }
    listeners.add(callback)
    return () => {
      listeners.delete(callback)
      if (listeners.size === 0) this.callbacks.delete(runId)
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.subscribed) return
    this.connecting = true
    let connectionAvailable = true
    try {
      const unsubscribe = await this.bus.subscribe(
        (hint) => this.onHint(hint),
        () => {
          connectionAvailable = true
          if (!this.connecting) this.setReady(true)
        },
        () => {
          connectionAvailable = false
          this.setReady(false)
        },
      )
      if (this.stopped) {
        unsubscribe?.()
        return
      }
      this.unsubscribe = unsubscribe || undefined
      this.retryDelayMs = RETRY_MIN_MS
      if (connectionAvailable) this.setReady(true)
    } catch (error) {
      if (this.stopped) return
      this.setReady(false)
      this.logger.warn(`运行控制提示订阅失败，稍后重试：${error instanceof Error ? error.message : String(error)}`)
      this.scheduleRetry()
    } finally {
      this.connecting = false
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return
    const delay = this.retryDelayMs
    this.retryDelayMs = Math.min(delay * 2, RETRY_MAX_MS)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.connect()
    }, delay)
    this.retryTimer.unref()
  }

  private onHint(hint: ChangeHint): void {
    if (this.stopped || hint.runControlChanged === false || (hint.objectType && hint.objectType !== 'run')) return
    const runId = hint.runId ?? hint.objectId
    if (runId) this.wake(this.callbacks.get(runId))
  }

  private setReady(ready: boolean): void {
    if (this.stopped || this.subscribed === ready) return
    this.subscribed = ready
    for (const listeners of this.callbacks.values()) this.wake(listeners)
  }

  private wake(listeners: Set<() => void> | undefined): void {
    if (!listeners) return
    for (const callback of [...listeners]) {
      try {
        callback()
      } catch (error) {
        this.logger.error(`运行控制提示回调失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
