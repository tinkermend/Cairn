import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChangeHintBus } from '@cairn/db'
import { observeObject } from './observe-object.js'

function fixture(last?: string) {
  const req = Object.assign(new EventEmitter(), { get: (name: string) => name === 'Last-Event-ID' ? last : undefined })
  const res = Object.assign(new EventEmitter(), { writableEnded: false, setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn((_frame: string) => true), end: vi.fn(() => { res.writableEnded = true }) })
  let notify: Parameters<ChangeHintBus['subscribe']>[0] | undefined
  const unsubscribe = vi.fn()
  const hints = { driver: 'postgres', realtime: true, namespace: 'test', subscribe: vi.fn(async callback => { notify = callback; return unsubscribe }) } as unknown as ChangeHintBus
  return { req: req as unknown as Request, res: res as unknown as Response, raw: res, hints, unsubscribe, notify: () => notify?.({ namespace: 'test', objectType: 'schedule', objectId: 'object', eventSeq: 1 }) }
}

describe('durable object SSE', () => {
  afterEach(() => vi.useRealTimers())

  it('补读超过一页的事件，并遵守 Last-Event-ID', async () => {
    const records = Array.from({ length: 125 }, (_, i) => ({ seq: i + 1 }))
    for (const after of [0, 100]) {
      const f = fixture(after ? `object:${after}` : undefined)
      await observeObject({ ...f, objectId: 'object', after: 0, event: 'schedule', matches: () => true,
        snapshot: async () => ({ done: true }), events: async cursor => records.slice(cursor, cursor + 100), finished: snapshot => snapshot.done,
      })
      const frames = f.raw.write.mock.calls.map(call => call[0] as unknown as string)
      expect(frames.filter(frame => frame.startsWith('id:'))).toHaveLength(125 - after)
      expect(frames.some(frame => frame.startsWith('id: object:125\n'))).toBe(true)
      expect(f.unsubscribe).toHaveBeenCalledOnce()
    }
  })

  it('通知驱动读取，无每秒查库；撤权和客户端断开都会清理订阅', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let allowed = true
    const snapshot = vi.fn(async () => { if (!allowed) throw new Error('revoked'); return {} })
    const events = vi.fn(async () => [])
    const stream = observeObject({ ...f, objectId: 'object', after: 0, event: 'schedule', matches: () => true, snapshot, events })
    await vi.advanceTimersByTimeAsync(0)
    const reads = snapshot.mock.calls.length
    await vi.advanceTimersByTimeAsync(2500)
    expect(snapshot).toHaveBeenCalledTimes(reads)
    f.notify()
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshot).toHaveBeenCalledTimes(reads + 1)
    allowed = false
    await vi.advanceTimersByTimeAsync(30_000)
    await stream
    expect(f.raw.write.mock.calls.some(call => String(call[0]).startsWith('event: error'))).toBe(true)
    expect(f.unsubscribe).toHaveBeenCalledOnce()
  })
})
