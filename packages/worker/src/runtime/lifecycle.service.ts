import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common'
import { claimQueuedRun, type DbHandle } from '@cairn/db'
import { config } from '../config/env'
import { DB_HANDLE } from '../db/db.module'
import { ExecutionEngine } from '../engine/engine'
import { ObjectService } from '../objects/object.service'

const TICK_INTERVAL_MS = 1_000

/**
 * 执行面的进程生命周期。
 *
 * tick 领取一条 QUEUED Run 并交给 Engine。同时只跑一个 Run。
 * 停机：停止领取 → abort 在途 → 等收尾。副作用未确认的 Attempt 由 Engine 标 NEEDS_REVIEW。
 *
 * 领取是异步的，停机信号可能正好落在 claim 与 execute 之间：那时 controller 已存在、
 * pumpTask 也已登记，所以 shutdown 能 abort 到它并等到收尾——否则会留下一条
 * 被领取但没人执行的 RUNNING。
 */
@Injectable()
export class LifecycleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(LifecycleService.name)
  private readonly startedAt = Date.now()
  private tick: NodeJS.Timeout | undefined
  private cleanupTick: NodeJS.Timeout | undefined
  private stopped = false
  private busy = false
  private inFlight: Promise<void> | undefined
  private cleanupInFlight: Promise<{ purged: number }> | undefined
  private controller: AbortController | undefined

  shutdownSignal: string | undefined
  shutdownCalled = false

  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    private readonly engine: ExecutionEngine,
    private readonly objects: ObjectService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.handle.ping()
    this.tick = setInterval(() => {
      this.inFlight = this.pump()
    }, TICK_INTERVAL_MS)
    this.cleanupTick = setInterval(() => {
      void this.runCleanup()
    }, config.CAIRN_OBJECT_CLEANUP_INTERVAL_MS)
    this.logger.log('执行面已就绪，等待任务')
  }

  isRunning(): boolean {
    return this.tick !== undefined
  }

  uptimeSeconds(): number {
    return (Date.now() - this.startedAt) / 1000
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.shutdownSignal = signal
    this.shutdownCalled = true
    this.stopped = true
    if (this.tick) {
      clearInterval(this.tick)
      this.tick = undefined
    }
    if (this.cleanupTick) {
      clearInterval(this.cleanupTick)
      this.cleanupTick = undefined
    }
    this.controller?.abort()
    // 等 pump 自己退出：此刻它可能正卡在 claim 上，abort 只能打断它之后才创建的 signal。
    const inFlight = this.inFlight
    const cleanup = this.cleanupInFlight
    if (inFlight) await inFlight
    if (cleanup) await cleanup
    this.logger.log(`收到 ${signal ?? '停机'} 信号，已停止领取任务`)
  }

  async runCleanup(): Promise<{ purged: number }> {
    if (this.stopped) return { purged: 0 }
    if (this.cleanupInFlight) return this.cleanupInFlight
    this.cleanupInFlight = this.objects
      .purgeExpiredObjects({ limit: 100 })
      .catch((error) => {
        this.logger.error(error instanceof Error ? error.message : error, '对象清理失败')
        return { purged: 0 }
      })
      .finally(() => {
        this.cleanupInFlight = undefined
      })
    return this.cleanupInFlight
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.busy) return
    this.busy = true
    // controller 必须在 claim 之前就位：停机若落在 claim 期间，abort 才不会打空。
    const controller = new AbortController()
    this.controller = controller
    try {
      const claimed = await claimQueuedRun(this.handle)
      if (!claimed) return
      this.logger.log({ runId: claimed.id }, '领取到运行')
      await this.engine.execute(claimed.id, { signal: controller.signal })
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : error, '领取或执行失败')
    } finally {
      if (this.controller === controller) this.controller = undefined
      this.busy = false
    }
  }
}
