import { Injectable } from '@nestjs/common'
import type { DebugAction } from '@cairn/shared'

export type DebugResumeRequest = DebugAction & { actorId?: string }

@Injectable()
export class DebugHoldRegistry {
  private readonly waits = new Map<
    string,
    {
      resolve: (value: DebugResumeRequest | 'timeout' | 'cancelled') => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private readonly pauseRequested = new Set<string>()

  wait(runId: string, timeoutMs: number, signal?: AbortSignal): Promise<DebugResumeRequest | 'timeout' | 'cancelled'> {
    this.cancel(runId)
    return new Promise((resolve) => {
      const finish = (value: DebugResumeRequest | 'timeout' | 'cancelled') => {
        signal?.removeEventListener('abort', onAbort)
        this.clearWait(runId)
        resolve(value)
      }
      const timer = setTimeout(() => finish('timeout'), timeoutMs)
      const onAbort = () => finish('cancelled')
      this.waits.set(runId, {
        resolve: finish,
        timer,
      })
      if (signal?.aborted) {
        finish('cancelled')
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  resume(runId: string, action: DebugResumeRequest): boolean {
    if (action.action === 'pause') {
      if (this.waits.has(runId)) return false
      this.pauseRequested.add(runId)
      return true
    }
    const wait = this.waits.get(runId)
    if (!wait) return false
    clearTimeout(wait.timer)
    this.waits.delete(runId)
    wait.resolve(action)
    return true
  }

  consumePause(runId: string): boolean {
    const had = this.pauseRequested.has(runId)
    this.pauseRequested.delete(runId)
    return had
  }

  has(runId: string): boolean {
    return this.waits.has(runId)
  }

  cancel(runId: string): void {
    const wait = this.waits.get(runId)
    if (!wait) return
    clearTimeout(wait.timer)
    this.waits.delete(runId)
    wait.resolve('cancelled')
  }

  private clearWait(runId: string): void {
    const wait = this.waits.get(runId)
    if (!wait) return
    clearTimeout(wait.timer)
    this.waits.delete(runId)
  }
}
