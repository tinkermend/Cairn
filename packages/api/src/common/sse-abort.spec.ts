import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { abortWhenSseClientDrops } from './sse-abort'

describe('abortWhenSseClientDrops', () => {
  it('GET 读完请求体后的 req.close 不会中止仍在写的 SSE', () => {
    const req = new EventEmitter()
    const res = Object.assign(new EventEmitter(), { writableEnded: false })
    const signal = abortWhenSseClientDrops(req, res)
    req.emit('end')
    req.emit('close')
    expect(signal.aborted).toBe(false)
  })

  it('客户端在流未结束时断开才中止', () => {
    const req = new EventEmitter()
    const res = Object.assign(new EventEmitter(), { writableEnded: false })
    const signal = abortWhenSseClientDrops(req, res)
    res.emit('close')
    expect(signal.aborted).toBe(true)
  })

  it('正常写完后的 res.close 不再中止', () => {
    const req = new EventEmitter()
    const res = Object.assign(new EventEmitter(), { writableEnded: true })
    const signal = abortWhenSseClientDrops(req, res)
    res.emit('close')
    expect(signal.aborted).toBe(false)
  })
})
