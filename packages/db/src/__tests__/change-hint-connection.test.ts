import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DbEnv } from '@cairn/shared'

const pgMock = vi.hoisted(() => ({
  clients: [] as Array<{ emit(event: string, ...args: unknown[]): boolean }>,
  failedConnects: 0,
}))

vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events')
  class Client extends EventEmitter {
    private ended = false

    constructor() {
      super()
      pgMock.clients.push(this)
    }

    async connect(): Promise<void> {
      if (pgMock.failedConnects > 0) {
        pgMock.failedConnects--
        throw new Error('connection refused')
      }
    }

    async query(): Promise<{ rows: [] }> {
      return { rows: [] }
    }

    async end(): Promise<void> {
      if (this.ended) return
      this.ended = true
      this.emit('end')
    }
  }
  return { Client }
})

import { createChangeHint } from '../observe/create-hint.js'

const dbEnv: DbEnv = {
  CAIRN_DB_DRIVER: 'postgres',
  CAIRN_DB_HOST: 'localhost',
  CAIRN_DB_PORT: 5432,
  CAIRN_DB_NAME: 'cairn',
  CAIRN_DB_USER: 'test',
  CAIRN_DB_PASSWORD: 'test',
  CAIRN_DB_SCHEMA: 'cairn',
}

afterEach(() => {
  vi.useRealTimers()
  pgMock.clients.length = 0
  pgMock.failedConnects = 0
})

describe('PostgreSQL change hint connection', () => {
  it('reports disconnect once, then reconnects and resumes delivery', async () => {
    vi.useFakeTimers()
    const bus = createChangeHint({ hint: 'postgres', namespace: 'test', dbEnv })
    const onHint = vi.fn()
    const onReconnect = vi.fn()
    const onDisconnect = vi.fn()
    try {
      await bus.subscribe(onHint, onReconnect, onDisconnect)
      const first = pgMock.clients[0]
      expect(first).toBeDefined()
      first!.emit('end')
      first!.emit('end')
      expect(onDisconnect).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(250)
      expect(pgMock.clients).toHaveLength(2)
      expect(onReconnect).toHaveBeenCalledTimes(1)
      pgMock.clients[1]!.emit('notification', {
        channel: 'cairn_run_observe',
        payload: JSON.stringify({
          namespace: 'test',
          eventSeq: 3,
          runId: '00000000-0000-4000-8000-000000000001',
          runControlChanged: true,
        }),
      })
      expect(onHint).toHaveBeenCalledWith(expect.objectContaining({ runControlChanged: true }))
    } finally {
      await bus.close()
    }
  })

  it('permits a fresh subscribe after initial LISTEN failure', async () => {
    const bus = createChangeHint({ hint: 'postgres', namespace: 'test', dbEnv })
    pgMock.failedConnects = 1
    try {
      await expect(bus.subscribe(vi.fn())).rejects.toThrow('connection refused')
      const onHint = vi.fn()
      await expect(bus.subscribe(onHint)).resolves.toBeTypeOf('function')
      expect(pgMock.clients).toHaveLength(2)
    } finally {
      await bus.close()
    }
  })
})
