import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PostgresDbEnv } from '@cairn/shared'
import { createChangeHint } from '../observe/create-hint.js'
import { publishChangeHint, resetChangeHintPublisher } from '../observe/hint.js'

const pg = vi.hoisted(() => {
  class FakeClient {
    static instances: FakeClient[] = []
    static connectGate: Promise<void> | null = null
    static connectErrors: Array<Error | null> = []
    connectCalls = 0
    ended = false
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

    constructor() {
      FakeClient.instances.push(this)
    }

    on(event: string, fn: (...args: unknown[]) => void) {
      const list = this.listeners.get(event) ?? []
      list.push(fn)
      this.listeners.set(event, list)
      return this
    }

    emit(event: string, ...args: unknown[]) {
      for (const fn of this.listeners.get(event) ?? []) fn(...args)
    }

    async connect() {
      this.connectCalls += 1
      if (FakeClient.connectGate) await FakeClient.connectGate
      const error = FakeClient.connectErrors.shift()
      if (error) throw error
    }

    async query() {
      return { rows: [] }
    }

    async end() {
      this.ended = true
      this.emit('end')
    }

    static reset() {
      FakeClient.instances = []
      FakeClient.connectGate = null
      FakeClient.connectErrors = []
    }
  }
  return { FakeClient }
})

const redis = vi.hoisted(() => {
  class FakeRedis {
    static gate: Promise<void> | null = null
    static connectErrors: Array<Error | null> = []
    static instances: FakeRedis[] = []
    isOpen = false
    connectCalls = 0
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

    constructor() {
      FakeRedis.instances.push(this)
    }

    on(event: string, fn: (...args: unknown[]) => void) {
      const list = this.listeners.get(event) ?? []
      list.push(fn)
      this.listeners.set(event, list)
      return this
    }

    async connect() {
      this.connectCalls += 1
      if (FakeRedis.gate) await FakeRedis.gate
      const error = FakeRedis.connectErrors.shift()
      if (error) throw error
      this.isOpen = true
    }

    async publish() {
      return 1
    }

    async ping() {
      return 'PONG'
    }

    async subscribe() {
      return
    }

    async quit() {
      this.isOpen = false
    }

    async disconnect() {
      this.isOpen = false
    }

    static reset() {
      FakeRedis.instances = []
      FakeRedis.gate = null
      FakeRedis.connectErrors = []
    }
  }
  return {
    FakeRedis,
    createClient: () => new FakeRedis(),
  }
})

vi.mock('pg', () => ({ Client: pg.FakeClient }))
vi.mock('redis', () => ({ createClient: redis.createClient }))

const pgEnv: PostgresDbEnv = {
  CAIRN_DB_DRIVER: 'postgres',
  CAIRN_DB_HOST: '127.0.0.1',
  CAIRN_DB_PORT: 5432,
  CAIRN_DB_NAME: 'cairn',
  CAIRN_DB_USER: 'cairn',
  CAIRN_DB_PASSWORD: 'cairn',
  CAIRN_DB_SCHEMA: 'cairn',
}

const runId = '66666666-6666-4666-8666-666666666666'

describe('变化提示发布与重连', () => {
  beforeEach(() => {
    pg.FakeClient.reset()
    redis.FakeRedis.reset()
    resetChangeHintPublisher()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    resetChangeHintPublisher()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('首次并发发布只 connect 一次', async () => {
    let release!: () => void
    pg.FakeClient.connectGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const bus = createChangeHint({ hint: 'postgres', namespace: 'race', dbEnv: pgEnv })
    const first = bus.publish({ namespace: 'race', runId, eventSeq: 1 })
    const second = bus.publish({ namespace: 'race', runId, eventSeq: 2 })
    await Promise.resolve()
    expect(pg.FakeClient.instances).toHaveLength(1)
    expect(pg.FakeClient.instances[0]?.connectCalls).toBe(1)
    release()
    await Promise.all([first, second])
    await bus.close()
  })

  it('连接失败后可以换新 Client 再发布', async () => {
    const bus = createChangeHint({ hint: 'postgres', namespace: 'retry', dbEnv: pgEnv })
    pg.FakeClient.connectErrors = [new Error('ECONNREFUSED')]
    await expect(bus.publish({ namespace: 'retry', runId, eventSeq: 1 })).rejects.toThrow('ECONNREFUSED')
    await bus.publish({ namespace: 'retry', runId, eventSeq: 2 })
    expect(pg.FakeClient.instances).toHaveLength(2)
    await bus.close()
  })

  it('提交后提示失败不会变成未处理拒绝', async () => {
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    const bus = createChangeHint({ hint: 'postgres', namespace: 'void', dbEnv: pgEnv })
    pg.FakeClient.connectErrors = [new Error('ECONNREFUSED')]
    try {
      publishChangeHint({ runId, eventSeq: 1 })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(rejections).toEqual([])
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
      await bus.close()
    }
  })

  it('LISTEN 断开后会多次重连并在恢复后补读', async () => {
    vi.useFakeTimers()
    const bus = createChangeHint({ hint: 'postgres', namespace: 'listen', dbEnv: pgEnv })
    const onReconnect = vi.fn()
    await bus.subscribe(() => undefined, onReconnect)
    expect(pg.FakeClient.instances).toHaveLength(1)
    pg.FakeClient.connectErrors = [new Error('reconnect-1'), new Error('reconnect-2')]
    pg.FakeClient.instances[0]?.emit('end')
    await vi.advanceTimersByTimeAsync(250)
    expect(onReconnect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(onReconnect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onReconnect).toHaveBeenCalledTimes(1)
    expect(pg.FakeClient.instances.length).toBeGreaterThanOrEqual(4)
    await bus.close()
  })

  it('Redis 首次并发发布只 connect 一次，失败后可重试', async () => {
    let release!: () => void
    redis.FakeRedis.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const bus = createChangeHint({
      hint: 'redis',
      redisUrl: 'redis://127.0.0.1:6379',
      namespace: 'redis-race',
      dbEnv: { CAIRN_DB_DRIVER: 'sqlite', CAIRN_DB_FILE: ':memory:' },
    })
    const first = bus.publish({ namespace: 'redis-race', runId, eventSeq: 1 })
    const second = bus.publish({ namespace: 'redis-race', runId, eventSeq: 2 })
    await Promise.resolve()
    const publisher = redis.FakeRedis.instances[0]
    expect(publisher?.connectCalls).toBe(1)
    release()
    await Promise.all([first, second])
    await bus.close()

    const retry = createChangeHint({
      hint: 'redis',
      redisUrl: 'redis://127.0.0.1:6379',
      namespace: 'redis-retry',
      dbEnv: { CAIRN_DB_DRIVER: 'mysql', CAIRN_DB_HOST: '127.0.0.1', CAIRN_DB_PORT: 3306, CAIRN_DB_NAME: 'cairn', CAIRN_DB_USER: 'u', CAIRN_DB_PASSWORD: 'p' },
    })
    redis.FakeRedis.connectErrors = [new Error('ECONNREFUSED')]
    await expect(retry.publish({ namespace: 'redis-retry', runId, eventSeq: 1 })).rejects.toThrow('ECONNREFUSED')
    await retry.publish({ namespace: 'redis-retry', runId, eventSeq: 2 })
    expect(redis.FakeRedis.instances.at(-2)?.connectCalls).toBe(2)
    await retry.close()
  })
})
