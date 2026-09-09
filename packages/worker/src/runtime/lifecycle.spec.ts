import { Test } from '@nestjs/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DbHandle } from '@cairn/db'
import { DB_HANDLE, DbModule } from '../db/db.module'
import { LifecycleService } from './lifecycle.service'

function stubDb(close = vi.fn(async () => {})): DbHandle {
  return { ping: async () => true, close, db: {} as never, pool: {} as never }
}

describe('LifecycleService', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined

  async function buildApp(handle: DbHandle) {
    const moduleRef = await Test.createTestingModule({
      providers: [LifecycleService, { provide: DB_HANDLE, useValue: handle }],
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
