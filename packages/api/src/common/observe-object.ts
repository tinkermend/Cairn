import { BadRequestException } from '@nestjs/common'
import type { Request, Response } from 'express'
import type { ChangeHintBus } from '@cairn/db'
import type { ChangeHint } from '@cairn/shared'
import { abortWhenSseClientDrops } from './sse-abort.js'

/** Hints wake a bounded durable catch-up. One low-frequency reconciliation also
 * recovers lost hints and rechecks current account/target authorization. */
export async function observeObject<T, E extends { seq: number }>(input: {
  req: Request; res: Response; hints: ChangeHintBus; objectId: string; after: number
  event: string; matches: (hint: ChangeHint) => boolean
  snapshot: () => Promise<T>; events: (after: number) => Promise<E[]>
  finished?: (snapshot: T) => boolean
}) {
  const { req, res, objectId } = input
  let cursor = input.after
  const last = req.get('Last-Event-ID')
  if (last) {
    const prefix = `${objectId}:`
    if (!last.startsWith(prefix)) throw new BadRequestException('观察游标不属于当前对象')
    cursor = Number(last.slice(prefix.length))
  }
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new BadRequestException('观察游标无效')
  let expiresAt = Infinity
  const token = req.get('Authorization')?.replace(/^Bearer /, '')
  if (token) {
    try {
      const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString())
      if (typeof claims.exp === 'number') expiresAt = claims.exp * 1000
    } catch { throw new BadRequestException('认证信息无效') }
  }
  await input.snapshot() // fail with a normal HTTP error before opening SSE
  const signal = abortWhenSseClientDrops(req, res)
  let dirty = true
  let wake: (() => void) | undefined
  const notify = () => { dirty = true; wake?.() }
  const unsubscribe = await input.hints.subscribe(hint => { if (input.matches(hint)) notify() }, notify)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  const write = (event: string, data: unknown, seq?: number) => {
    if (signal.aborted || res.writableEnded) return
    const frame = `${seq === undefined ? '' : `id: ${objectId}:${seq}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    // A stalled client reconnects from its last durable event instead of growing
    // an unbounded per-client output buffer.
    if (!res.write(frame)) throw new Error('SSE client is not consuming data')
  }
  try {
    write('ready', { realtime: input.hints.realtime })
    while (!signal.aborted) {
      dirty = false
      if (Date.now() >= expiresAt) throw new Error('认证已过期')
      const snapshot = await input.snapshot()
      let events: E[]
      do {
        events = await input.events(cursor)
        for (const event of events) { write('event', event, event.seq); cursor = event.seq }
      } while (!signal.aborted && events.length === 100)
      write(input.event, snapshot)
      if (input.finished?.(snapshot)) break
      if (dirty) continue
      await new Promise<void>(resolve => {
        const finish = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', finish)
          wake = undefined
          resolve()
        }
        const timer = setTimeout(finish, Math.max(1, Math.min(30_000, expiresAt - Date.now())))
        wake = finish
        signal.addEventListener('abort', finish, { once: true })
        if (dirty || signal.aborted) finish()
      })
    }
  } catch {
    if (!signal.aborted && !res.writableEnded) res.write('event: error\ndata: {"message":"观察已中断，请重新连接并检查当前权限"}\n\n')
  } finally {
    unsubscribe?.()
    if (!res.writableEnded) res.end()
  }
}
