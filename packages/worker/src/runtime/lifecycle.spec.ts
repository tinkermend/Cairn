import { Test } from '@nestjs/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DbHandle } from '@cairn/db'
import { BrowserSessionManager } from '../browser/session-manager'
import { DB_HANDLE, DbModule } from '../db/db.module'
import { ExecutionEngine } from '../engine/engine'
import { ObjectService } from '../objects/object.service'
import { LifecycleService } from './lifecycle.service'

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
        { provide: BrowserSessionManager, useValue: stubSessions() },
      ],
    }).compile()
    const application = moduleRef.createNestApplication()
    await application.init()
    return application
  }

  afterEach(async () => {
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
