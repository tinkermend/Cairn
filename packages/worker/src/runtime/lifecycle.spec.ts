import { Logger } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DbHandle } from '@cairn/db'
import { BrowserSessionManager } from '../browser/session-manager'
import { DB_HANDLE, DbModule } from '../db/db.module'
import { clearPlacementYields, yieldPlacement } from './placement-backoff'
import { ExecutionEngine } from '../engine/engine'
import { EvidenceSettleService } from '../evidence/settle.service'
import { ObjectService } from '../objects/object.service'
import { config } from '../config/env'
import { LifecycleService } from './lifecycle.service'

vi.mock('@cairn/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cairn/db')>()
  return {
    ...actual,
    registerWorker: vi.fn(async () => ({ worker: { id: 'stub' }, revokedRunIds: [] })),
    settleRevokedRuns: vi.fn(async () => undefined),
    markWorkerDraining: vi.fn(async () => undefined),
    markWorkerStopped: vi.fn(async () => undefined),
    listActiveLeasesForWorker: vi.fn(async () => []),
    claimRun: vi.fn(async () => null),
    heartbeatWorker: vi.fn(async () => 'ok' as const),
    renewRunLease: vi.fn(async () => new Date()),
    expireStaleRunLeases: vi.fn(async () => ({ expired: 0, outcomes: [] })),
    sweepDriftedRuns: vi.fn(async () => 0),
    markLostWorkers: vi.fn(async () => []),
    markSessionsLostForWorkers: vi.fn(async () => 0),
    yieldUnfinishedRun: vi.fn(async () => undefined),
    yieldClaimedRun: vi.fn(async () => 'yielded' as const),
  }
})

function stubDb(close = vi.fn(async () => {})): DbHandle {
  return { ping: async () => true, close, db: {} as never, pool: {} as never }
}

function stubSessions() {
  return {
    reconcileOwn: vi.fn(async () => ({ leasesRevoked: 0, sessionsClosed: 0 })),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
    shutdown: vi.fn(async () => {}),
    reap: vi.fn(async () => ({ leasesExpired: 0, sessionsClosed: 0, authTimeouts: 0 })),
    stopAllLocal: vi.fn(async () => []),
  }
}

describe('LifecycleService', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined

  async function buildApp(handle: DbHandle) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: handle },
        { provide: ExecutionEngine, useValue: { execute: vi.fn(async () => {}) } },
        { provide: ObjectService, useValue: { purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })) } },
        { provide: EvidenceSettleService, useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) } },
        { provide: BrowserSessionManager, useValue: stubSessions() },
      ],
    }).compile()
    const application = moduleRef.createNestApplication()
    await application.init()
    return application
  }

  afterEach(async () => {
    clearPlacementYields()
    await app?.close().catch(() => {})
    app = undefined
  })

  it('启动时探活数据库并持有存活句柄', async () => {
    app = await buildApp(stubDb())
    expect(app.get(LifecycleService).isRunning()).toBe(true)
  })

  it('框架关闭应用时自动触发停机钩子并释放句柄', async () => {
    app = await buildApp(stubDb())
    const svc = app.get(LifecycleService)

    await app.close() // 不手工调用钩子，验证框架确实会触发
    app = undefined

    expect(svc.shutdownCalled).toBe(true)
    expect(svc.isRunning()).toBe(false)
  })

  it('停机钩子拿得到信号名', async () => {
    app = await buildApp(stubDb())
    const svc = app.get(LifecycleService)
    svc.onApplicationShutdown('SIGTERM')
    expect(svc.shutdownSignal).toBe('SIGTERM')
  })

  it('停机等待在途对象清理结束', async () => {
    let release!: () => void
    const purgeHold = new Promise<{ purged: number }>((resolve) => {
      release = () => resolve({ purged: 1 })
    })
    const sessions = stubSessions()
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: stubDb() },
        { provide: ExecutionEngine, useValue: { execute: vi.fn(async () => {}) } },
        { provide: ObjectService, useValue: { purgeExpiredObjects: vi.fn(() => purgeHold) } },
        { provide: EvidenceSettleService, useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) } },
        { provide: BrowserSessionManager, useValue: sessions },
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    const svc = app.get(LifecycleService)
    const running = svc.runCleanup()
    const closing = svc.onApplicationShutdown('SIGTERM')
    let closed = false
    void closing.then(() => {
      closed = true
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(closed).toBe(false)
    release()
    await running
    await closing
    expect(svc.shutdownCalled).toBe(true)
    expect(sessions.shutdown).toHaveBeenCalledOnce()
  })

  it('启动时 reconcileOwn 并启动心跳', async () => {
    const sessions = stubSessions()
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: stubDb() },
        { provide: ExecutionEngine, useValue: { execute: vi.fn(async () => {}) } },
        { provide: ObjectService, useValue: { purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })) } },
        { provide: EvidenceSettleService, useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) } },
        { provide: BrowserSessionManager, useValue: sessions },
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    expect(sessions.reconcileOwn).toHaveBeenCalledOnce()
    expect(sessions.startHeartbeat).toHaveBeenCalledOnce()
  })

  it('uptime 非负且随时间增长', async () => {
    app = await buildApp(stubDb())
    const svc = app.get(LifecycleService)
    const first = svc.uptimeSeconds()
    expect(first).toBeGreaterThanOrEqual(0)
    await new Promise((r) => setTimeout(r, 10))
    expect(svc.uptimeSeconds()).toBeGreaterThan(first)
  })

  it('被判失联：停手、以新代重新注册、恢复领取，不留僵尸进程', async () => {
    const { heartbeatWorker, registerWorker } = await import('@cairn/db')
    const svc = await buildLifecycle()
    // 启动注册已经发生过一次，计数从这里重新起算
    vi.mocked(registerWorker).mockClear()
    vi.mocked(heartbeatWorker).mockResolvedValueOnce('lost')
    const exit = vi.fn()
    svc.exitProcess = exit
    const abort = injectInFlight(svc)
    const instanceBefore = instanceIdOf(svc)

    await beat(svc)

    // 在途 grant 已随失联作废，必须中止；但领取能力要回来。
    expect(abort).toHaveBeenCalledOnce()
    expect(registerWorker).toHaveBeenCalledOnce()
    expect(instanceIdOf(svc)).not.toBe(instanceBefore)
    expect(svc.isRunning()).toBe(true)
    expect(exit).not.toHaveBeenCalled()
    const sessions = app!.get(BrowserSessionManager)
    expect(sessions.stopAllLocal).toHaveBeenCalled()
    expect(vi.mocked(registerWorker).mock.invocationCallOrder[0]!).toBeGreaterThan(
      vi.mocked(sessions.stopAllLocal).mock.invocationCallOrder[0]!,
    )
  })

  it('登记时写入 maxSessions；pump 把冷却中的 runId 传给 claimRun', async () => {
    const { claimRun, registerWorker } = await import('@cairn/db')
    const svc = await buildLifecycle()
    expect(registerWorker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxSessions: config.CAIRN_BROWSER_MAX_SESSIONS }),
    )
    await (svc as unknown as { claimTask?: Promise<void> }).claimTask
    vi.mocked(claimRun).mockClear()
    const { yieldClaimedRun } = await import('@cairn/db')
    vi.mocked(yieldClaimedRun).mockResolvedValueOnce('yielded')
    await yieldPlacement({} as never, {
      runId: 'run-yielded',
      leaseId: 'lease-yielded',
      fencingToken: 1,
      holderWorkerId: 'w',
      expiresAt: new Date().toISOString(),
    })
    await (svc as unknown as { pump: () => Promise<void> }).pump()
    expect(claimRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ excludeRunIds: expect.arrayContaining(['run-yielded']) }),
    )
  })

  it('身份被另一实例接管：不抢回，退出进程', async () => {
    const { heartbeatWorker, registerWorker } = await import('@cairn/db')
    const svc = await buildLifecycle()
    vi.mocked(registerWorker).mockClear()
    vi.mocked(heartbeatWorker).mockResolvedValueOnce('instance_taken')
    const exit = vi.fn()
    svc.exitProcess = exit
    const abort = injectInFlight(svc)

    await beat(svc)

    expect(abort).toHaveBeenCalledOnce()
    expect(svc.isRunning()).toBe(false)
    expect(registerWorker).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('自愈期间 ID 被别人拿走：重新注册失败也要退出，不静默停工', async () => {
    const { heartbeatWorker, registerWorker } = await import('@cairn/db')
    const svc = await buildLifecycle()
    // 只对自愈那次注册注入冲突：启动注册必须先正常走完
    vi.mocked(registerWorker).mockRejectedValueOnce(new Error('WORKER_ID_CONFLICT'))
    vi.mocked(heartbeatWorker).mockResolvedValueOnce('lost')
    const exit = vi.fn()
    svc.exitProcess = exit

    await beat(svc)

    expect(svc.isRunning()).toBe(false)
    expect(exit).toHaveBeenCalledWith(1)
  })

  /** 验收 21：容量满就不再领取，否则一个实例会把自己撑爆、租约全部续不上。 */
  it('容量已满时不再领取', async () => {
    const { claimRun } = await import('@cairn/db')
    const svc = await buildLifecycle()
    // 等启动那次领取跑完，否则 pump 会被 claiming 挡住，用例就测不到容量这一层
    await (svc as unknown as { claimTask?: Promise<void> }).claimTask
    vi.mocked(claimRun).mockClear()
    injectInFlight(svc)

    await (svc as unknown as { pump: () => Promise<void> }).pump()

    // 默认容量 1，已有一条在途
    expect(claimRun).not.toHaveBeenCalled()
  })

  /** S6：同 ID 双开是本地最先踩到的错误路径，必须给出可读原因且不带凭证。 */
  it('启动撞同 ID 冲突：给出可读原因后仍让启动失败', async () => {
    const { registerWorker, DomainError } = await import('@cairn/db')
    vi.mocked(registerWorker).mockRejectedValueOnce(
      new DomainError('conflict', 'WORKER_ID_CONFLICT', 'Worker local-worker 仍有新鲜心跳'),
    )
    const errors: string[] = []
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      errors.push(String(message))
    })

    try {
      await expect(
        Test.createTestingModule({
          providers: [
            LifecycleService,
            { provide: DB_HANDLE, useValue: stubDb() },
            { provide: ExecutionEngine, useValue: { execute: vi.fn(async () => {}) } },
            {
              provide: ObjectService,
              useValue: { purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })) },
            },
            { provide: EvidenceSettleService, useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) } },
            { provide: BrowserSessionManager, useValue: stubSessions() },
          ],
        })
          .compile()
          .then((moduleRef) => moduleRef.createNestApplication().init()),
      ).rejects.toThrow(/WORKER_ID_CONFLICT|仍有新鲜心跳/)
    } finally {
      spy.mockRestore()
    }

    const explained = errors.join('\n')
    expect(explained).toContain('CAIRN_WORKER_ID=local-worker')
    expect(explained).toContain('每实例一个 ID')
    expect(explained).not.toMatch(/password|CairnDB/i)
  })

  async function buildLifecycle(): Promise<LifecycleService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleService,
        { provide: DB_HANDLE, useValue: stubDb() },
        { provide: ExecutionEngine, useValue: { execute: vi.fn(async () => {}) } },
        { provide: ObjectService, useValue: { purgeExpiredObjects: vi.fn(async () => ({ purged: 0 })) } },
        { provide: EvidenceSettleService, useValue: { settleExpired: vi.fn(async () => ({ marked: 0 })) } },
        { provide: BrowserSessionManager, useValue: stubSessions() },
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    const svc = app.get(LifecycleService)
    expect(svc.isRunning()).toBe(true)
    return svc
  }

  /** 注入一条在途运行，返回它的 abort 探针。 */
  function injectInFlight(svc: LifecycleService): ReturnType<typeof vi.fn> {
    const abort = vi.fn()
    ;(
      svc as unknown as {
        inFlight: Map<string, { controller: { abort: () => void }; grant: unknown; done: Promise<void> }>
      }
    ).inFlight.set('lease-1', {
      grant: {
        runId: 'r1',
        leaseId: 'lease-1',
        fencingToken: 1,
        holderWorkerId: 'w',
        expiresAt: new Date().toISOString(),
      },
      controller: { abort },
      done: Promise.resolve(),
    })
    return abort
  }

  function beat(svc: LifecycleService): Promise<void> {
    return (svc as unknown as { beat: () => Promise<void> }).beat()
  }

  function instanceIdOf(svc: LifecycleService): string {
    return (svc as unknown as { instanceId: string }).instanceId
  }
})

describe('DbModule', () => {
  it('停机时关闭连接池（所有权在创建者）', async () => {
    const close = vi.fn(async () => {})
    const moduleRef = await Test.createTestingModule({ imports: [DbModule] })
      .overrideProvider(DB_HANDLE)
      .useValue(stubDb(close))
      .compile()
    const application = moduleRef.createNestApplication()
    await application.init()

    await application.close()

    expect(close).toHaveBeenCalledOnce()
  })
})
