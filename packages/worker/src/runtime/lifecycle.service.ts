import { randomUUID } from 'node:crypto'
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common'
import {
  claimRun,
  expireRunDeadlines,
  expireStaleRunLeases,
  heartbeatWorker,
  markLostWorkers,
  markSessionsLostForWorkers,
  markWorkerDraining,
  markWorkerStopped,
  registerWorker,
  renewRunLease,
  settleRevokedRuns,
  sweepDriftedRuns,
  yieldUnfinishedRun,
  DomainError,
  WORKER_ID_CONFLICT,
  type DbHandle,
  type WorkerHeartbeatOutcome,
} from '@cairn/db'
import { resolveWorkerAdvertiseUrl, type RunGrant } from '@cairn/shared'
import { BrowserSessionManager } from '../browser/session-manager'
import { startManagedBrowserHttp, type ManagedBrowserHttp } from '../internal/http-server'
import { config } from '../config/env'
import { placementYieldExcludes } from './placement-backoff'
import { DB_HANDLE } from '../db/db.module'
import { ExecutionEngine } from '../engine/engine'
import { EvidenceSettleService } from '../evidence/settle.service'
import { ObjectService } from '../objects/object.service'

const TICK_INTERVAL_MS = 1_000

type InFlight = {
  grant: RunGrant
  controller: AbortController
  done: Promise<void>
}

/**
 * 执行面的进程生命周期。
 *
 * tick：容量未满则 claimRun，以 leaseId 去重后交给 Engine。
 * 心跳与 RunLease 续租共用 CAIRN_WORKER_HEARTBEAT_MS。
 * 恢复扫描挂在既有 session reaper tick 上。
 */
@Injectable()
export class LifecycleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(LifecycleService.name)
  private readonly startedAt = Date.now()
  /** 每次（重新）注册换一份：旧代的 grant 与心跳都必须随之作废。 */
  private instanceId = randomUUID()
  private readonly inFlight = new Map<string, InFlight>()
  private tick: NodeJS.Timeout | undefined
  private heartbeatTick: NodeJS.Timeout | undefined
  private cleanupTick: NodeJS.Timeout | undefined
  private reaperTick: NodeJS.Timeout | undefined
  private stopped = false
  private claiming = false
  private claimTask: Promise<void> | undefined
  private pendingClaim: AbortController | undefined
  private cleanupInFlight: Promise<{ purged: number }> | undefined
  private reaperInFlight:
    | Promise<{ leasesExpired: number; sessionsClosed: number; authTimeouts: number }>
    | undefined
  private healing: Promise<void> | undefined
  private internalHttp: ManagedBrowserHttp | undefined

  shutdownSignal: string | undefined
  shutdownCalled = false

  /**
   * 身份已被别的实例接管时如何结束进程。
   *
   * 这一步不能只是「不再领取」：那样进程活着却永远不干活，外部也看不出来。
   * 默认交给编排重启，测试里覆写成记录调用。
   */
  exitProcess: (code: number) => void = (code) => process.exit(code)

  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    private readonly engine: ExecutionEngine,
    private readonly objects: ObjectService,
    private readonly evidence: EvidenceSettleService,
    private readonly sessions: BrowserSessionManager,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.handle.ping()
    try {
      this.instanceId = randomUUID()
      await this.bindInternalHttp()
      await this.register()
    } catch (error) {
      await this.internalHttp?.close().catch(() => undefined)
      this.internalHttp = undefined
      // 本地最先踩到的错误路径：默认 ID 只够单进程，开第二个就撞。
      // 冒泡让 Nest 启动失败是对的，但得先说清楚是什么、怎么办；只带 ID 与秒数，不带凭证。
      if (error instanceof DomainError && error.code === WORKER_ID_CONFLICT) {
        this.logger.error(
          `CAIRN_WORKER_ID=${config.CAIRN_WORKER_ID} 已被另一个仍在心跳的实例占用，本进程不启动。` +
            `多实例部署必须每实例一个 ID；若上一个实例已经死了，等 ${config.CAIRN_WORKER_LOST_AFTER_SECONDS} 秒判失联后可重启。`,
        )
      }
      throw error
    }
    try {
      await this.sessions.reconcileOwn()
      this.sessions.startHeartbeat()
      this.startClaiming()
      this.claimTask = this.pump()
      this.heartbeatTick = setInterval(() => {
        void this.beat()
      }, config.CAIRN_WORKER_HEARTBEAT_MS)
      this.cleanupTick = setInterval(() => {
        void this.runCleanup()
      }, config.CAIRN_OBJECT_CLEANUP_INTERVAL_MS)
      this.reaperTick = setInterval(() => {
        void this.runReaper()
      }, config.CAIRN_SESSION_REAPER_INTERVAL_MS)
    } catch (error) {
      await markWorkerStopped(this.handle, config.CAIRN_WORKER_ID, this.instanceId).catch(() => undefined)
      throw error
    }
    this.logger.log(
      { workerId: config.CAIRN_WORKER_ID, instanceId: this.instanceId },
      '执行面已就绪，等待任务',
    )
  }

  isRunning(): boolean {
    return this.tick !== undefined
  }

  /**
   * 注册（或以新代重新注册）本实例：撤销自己名下残留的 ACTIVE 租约，
   * 对应 Run 交回恢复扫描。启动与失联自愈走同一条路径。
   */
  private async register(): Promise<void> {
    const registered = await registerWorker(this.handle, {
      workerId: config.CAIRN_WORKER_ID,
      instanceId: this.instanceId,
      capacity: config.CAIRN_WORKER_CAPACITY,
      maxSessions: config.CAIRN_BROWSER_MAX_SESSIONS,
      lostAfterSeconds: config.CAIRN_WORKER_LOST_AFTER_SECONDS,
      internalBaseUrl: this.advertiseUrl(),
    })
    await settleRevokedRuns(
      this.handle,
      registered.revokedRunIds,
      config.CAIRN_RUN_MAX_RECOVERIES,
    )
  }

  private startClaiming(): void {
    if (this.tick || this.shutdownCalled) return
    this.stopped = false
    this.tick = setInterval(() => {
      this.claimTask = this.pump()
    }, TICK_INTERVAL_MS)
  }

  uptimeSeconds(): number {
    return (Date.now() - this.startedAt) / 1000
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.shutdownSignal = signal
    this.shutdownCalled = true
    this.stopped = true
    await markWorkerDraining(this.handle, config.CAIRN_WORKER_ID, this.instanceId).catch(() => undefined)
    if (this.tick) {
      clearInterval(this.tick)
      this.tick = undefined
    }
    if (this.heartbeatTick) {
      clearInterval(this.heartbeatTick)
      this.heartbeatTick = undefined
    }
    if (this.cleanupTick) {
      clearInterval(this.cleanupTick)
      this.cleanupTick = undefined
    }
    if (this.reaperTick) {
      clearInterval(this.reaperTick)
      this.reaperTick = undefined
    }
    this.pendingClaim?.abort()
    for (const item of this.inFlight.values()) item.controller.abort()
    // 自愈可能正在重新注册：等它结束，别让停机与注册交错。
    await this.healing?.catch(() => undefined)
    const claiming = this.claimTask
    const cleanup = this.cleanupInFlight
    const reaper = this.reaperInFlight
    const owned = [...this.inFlight.values()]
    if (claiming) await claiming
    await Promise.all(owned.map((item) => item.done))
    if (cleanup) await cleanup
    if (reaper) await reaper
    for (const item of owned) {
      await yieldUnfinishedRun(this.handle, item.grant).catch(() => undefined)
    }
    await markWorkerStopped(this.handle, config.CAIRN_WORKER_ID, this.instanceId).catch(() => undefined)
    await this.internalHttp?.close().catch(() => undefined)
    this.internalHttp = undefined
    await this.sessions.shutdown()
    this.logger.log(`收到 ${signal ?? '停机'} 信号，已停止领取任务`)
  }

  async runCleanup(): Promise<{ purged: number }> {
    if (this.stopped) return { purged: 0 }
    if (this.cleanupInFlight) return this.cleanupInFlight
    this.cleanupInFlight = this.runCleanupTick()
      .catch((error) => {
        this.logger.error(error instanceof Error ? error.message : error, '对象清理失败')
        return { purged: 0 }
      })
      .finally(() => {
        this.cleanupInFlight = undefined
      })
    return this.cleanupInFlight
  }

  private async runCleanupTick(): Promise<{ purged: number }> {
    await this.evidence.settleExpired()
    return this.objects.purgeExpiredObjects({ limit: 100 })
  }

  async runReaper(): Promise<{
    leasesExpired: number
    sessionsClosed: number
    authTimeouts: number
  }> {
    if (this.stopped) return { leasesExpired: 0, sessionsClosed: 0, authTimeouts: 0 }
    if (this.reaperInFlight) return this.reaperInFlight
    this.reaperInFlight = this.reapAll()
      .catch((error) => {
        this.logger.error(error instanceof Error ? error.message : error, '回收失败')
        return { leasesExpired: 0, sessionsClosed: 0, authTimeouts: 0 }
      })
      .finally(() => {
        this.reaperInFlight = undefined
      })
    return this.reaperInFlight
  }

  private async reapAll(): Promise<{
    leasesExpired: number
    sessionsClosed: number
    authTimeouts: number
  }> {
    await expireRunDeadlines(this.handle)
    const session = await this.sessions.reap()
    await expireStaleRunLeases(this.handle, {
      limit: 50,
      maxRecoveries: config.CAIRN_RUN_MAX_RECOVERIES,
    })
    await sweepDriftedRuns(this.handle, {
      limit: 50,
      leaseTtlSeconds: config.CAIRN_RUN_LEASE_TTL_SECONDS,
      maxRecoveries: config.CAIRN_RUN_MAX_RECOVERIES,
    })
    const lostWorkerIds = await markLostWorkers(this.handle)
    if (lostWorkerIds.length > 0) {
      await markSessionsLostForWorkers(this.handle, lostWorkerIds)
    }
    return session
  }

  private async beat(): Promise<void> {
    if (this.stopped || this.healing) return
    try {
      const outcome = await heartbeatWorker(this.handle, config.CAIRN_WORKER_ID, this.instanceId, {
        internalBaseUrl: this.advertiseUrl(),
        liveHandleCount: this.sessions.liveHandleCount(),
      })
      if (outcome !== 'ok') {
        this.healing = this.healIdentity(outcome).finally(() => {
          this.healing = undefined
        })
        await this.healing
        return
      }
      for (const item of this.inFlight.values()) {
        const expiresAt = await renewRunLease(
          this.handle,
          item.grant,
          config.CAIRN_RUN_LEASE_TTL_SECONDS,
        )
        if (!expiresAt) {
          this.logger.warn({ runId: item.grant.runId, leaseId: item.grant.leaseId }, 'RunLease 续租失败，停手')
          item.controller.abort()
        }
      }
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : error, '心跳或续租失败')
    }
  }

  /** 本实例不再领取；已在途的 Run 中止，等租约过期后由同伴接管。 */
  private fenceSelf(): void {
    this.stopped = true
    this.pendingClaim?.abort()
    for (const item of this.inFlight.values()) item.controller.abort()
    if (this.tick) {
      clearInterval(this.tick)
      this.tick = undefined
    }
  }

  /**
   * 心跳写不进去之后的处置。
   *
   * 先无条件停手——本实例手上的每个 grant 都已不可信，续租必然 0 行。
   * 之后按原因分流，两条路都不允许留下「进程活着但永远不干活」的僵尸：
   *
   * - 被同伴判失联（抖动、长 GC、主机挂起超过 LOST_AFTER）：用新代重新注册，恢复领取。
   *   这条必须自愈，否则一次网络抖动就永久少掉一份集群容量。
   * - 身份被另一个活实例接管：按 D4 不得抢回，退出进程交给编排。
   */
  private async healIdentity(outcome: WorkerHeartbeatOutcome): Promise<void> {
    this.fenceSelf()
    if (this.shutdownCalled) return

    if (outcome === 'instance_taken') {
      this.logger.error(
        { workerId: config.CAIRN_WORKER_ID, instanceId: this.instanceId },
        'Worker 身份已被另一个实例接管，本进程退出；多实例部署必须每实例一个 CAIRN_WORKER_ID',
      )
      this.exitProcess(1)
      return
    }

    this.logger.warn(
      { workerId: config.CAIRN_WORKER_ID, instanceId: this.instanceId },
      'Worker 心跳未写入（已被判失联），停手并以新代重新注册',
    )
    await this.sessions.stopAllLocal().catch((error) => {
      this.logger.warn(
        { err: error instanceof Error ? error.message : error },
        '自愈停浏览器失败，继续重新注册',
      )
    })
    this.instanceId = randomUUID()
    try {
      await this.bindInternalHttp()
      await this.register()
    } catch (error) {
      // 重新注册被 WORKER_ID_CONFLICT 挡住 = 自愈期间别人拿走了这个 ID，等同身份被接管。
      this.logger.error(
        { workerId: config.CAIRN_WORKER_ID, err: error instanceof Error ? error.message : error },
        '重新注册失败，本进程退出',
      )
      this.exitProcess(1)
      return
    }
    try {
      await this.sessions.reconcileOwn()
    } catch (error) {
      this.logger.error(
        { workerId: config.CAIRN_WORKER_ID, err: error instanceof Error ? error.message : error },
        '自愈后会话核对失败，本进程退出',
      )
      this.exitProcess(1)
      return
    }
    this.startClaiming()
    this.logger.log(
      { workerId: config.CAIRN_WORKER_ID, instanceId: this.instanceId },
      'Worker 已以新代重新注册，恢复领取',
    )
  }

  private advertiseUrl(): string | null {
    return resolveWorkerAdvertiseUrl({
      networkMode: config.CAIRN_WORKER_NETWORK_MODE,
      advertiseUrl: config.CAIRN_WORKER_ADVERTISE_URL,
      internalPort: config.CAIRN_WORKER_INTERNAL_PORT,
    })
  }

  private async bindInternalHttp(): Promise<void> {
    this.sessions.setWorkerInstance(this.instanceId)
    if (config.CAIRN_WORKER_INTERNAL_PORT <= 0) return
    await this.internalHttp?.close().catch(() => undefined)
    this.internalHttp = await startManagedBrowserHttp({
      host: config.CAIRN_WORKER_INTERNAL_HOST,
      port: config.CAIRN_WORKER_INTERNAL_PORT,
      secret: config.CAIRN_INTERNAL_AUTH_SECRET,
      workerInstanceId: this.instanceId,
      sessions: this.sessions,
      engine: this.engine,
    })
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.claiming) return
    if (this.inFlight.size >= config.CAIRN_WORKER_CAPACITY) return
    this.claiming = true
    const controller = new AbortController()
    this.pendingClaim = controller
    try {
      const grant = await claimRun(this.handle, {
        workerId: config.CAIRN_WORKER_ID,
        instanceId: this.instanceId,
        leaseTtlSeconds: config.CAIRN_RUN_LEASE_TTL_SECONDS,
        excludeRunIds: placementYieldExcludes(),
      })
      if (!grant) return
      if (this.inFlight.has(grant.leaseId)) return
      this.logger.log({ runId: grant.runId, leaseId: grant.leaseId }, '领取到运行')
      const done = this.engine
        .execute(grant.runId, { grant, signal: controller.signal })
        .catch((error) => {
          this.logger.error(error instanceof Error ? error.message : error, '执行失败')
        })
        .finally(() => {
          this.inFlight.delete(grant.leaseId)
        })
      this.inFlight.set(grant.leaseId, { grant, controller, done })
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : error, '领取失败')
    } finally {
      if (this.pendingClaim === controller) this.pendingClaim = undefined
      this.claiming = false
    }
  }
}
