import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as db from '@cairn/db'
import { BrowserSessionsService } from './browser-sessions.service'
vi.mock('@cairn/db', async (load) => ({
  ...(await load<typeof import('@cairn/db')>()),
  getSessionOperation: vi.fn(),
  getRun: vi.fn(),
  getSessionById: vi.fn(),
  findAuthWaitLeaseForRun: vi.fn(),
  listSessionEventsAfter: vi.fn(),
}))
let service: BrowserSessionsService
let request: ReturnType<typeof vi.fn>
let account: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.clearAllMocks()
  request = vi.fn(async () => ({ ok: true }))
  account = vi.fn(async () => ({ id: 'actor', status: 'active', permissions: ['session:read'] }))
  service = new BrowserSessionsService(
    {} as never,
    { requestJson: request } as never,
    { decode: () => ({ exp: Date.now() / 1000 + 3600 }) } as never,
    { resolveAccount: account } as never,
  )
})
afterEach(() => vi.useRealTimers())
it('复用 Run 的完成认证保留令牌并解析真实 Run owner', async () => {
  vi.mocked(db.getSessionOperation).mockResolvedValue({
    id: 'op',
    kindParams: { reusedRunId: 'run' },
  } as never)
  vi.mocked(db.getRun).mockResolvedValue({ id: 'run', status: 'WAITING_FOR_AUTH', placement: {} } as never)
  vi.mocked(db.findAuthWaitLeaseForRun).mockResolvedValue({ sessionId: 's' } as never)
  vi.mocked(db.getSessionById).mockResolvedValue({ id: 's', generation: 3, ownerWorkerId: 'w' } as never)
  ;(service as any).withWorker = async (session: unknown, status: string, ownerId: string) => ({
    session,
    status,
    ownerId,
    worker: { instanceId: 'i' },
    endpoint: 'http://worker',
  })
  await service.completeAuth('op', { id: 'actor', permissions: ['run:execute'] } as never, { token: 'secret-control-token' })
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      runId: 'run',
      body: JSON.stringify({ token: 'secret-control-token' }),
      path: '/internal/managed-browser/resume-auth',
    }),
  )
})
it('总览 SSE 按账号保存补读水位，撤权立即结束连接', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  class Response extends EventEmitter {
    writableEnded = false
    write = vi.fn()
    status() {
      return this
    }
    setHeader() {}
    flushHeaders() {}
    end() {
      this.writableEnded = true
      this.emit('close')
    }
  }
  const response = new Response()
  // Do not re-emit close recursively in the mock.
  response.end = () => {
    response.writableEnded = true
  }
  vi.mocked(db.listSessionEventsAfter).mockResolvedValueOnce([
    { targetAccountId: 'a', seq: 50 },
    { targetAccountId: 'b', seq: 1 },
  ] as never)
  await service.streamObserve({
    query: {},
    account: { id: 'actor' } as never,
    authorization: 'Bearer test',
    response: response as never,
    signal: controller.signal,
  })
  const records = response.write.mock.calls
    .map((call) => String(call[0]))
    .filter((text) => text.startsWith('id: '))
  const cursor = records[1]!.split('\n')[0]!.slice(4)
  expect(JSON.parse(Buffer.from(cursor, 'base64url').toString())).toEqual({ a: 50, b: 1 })
  account.mockResolvedValueOnce({ id: 'actor', status: 'active', permissions: [] })
  await vi.advanceTimersByTimeAsync(1000)
  expect(response.writableEnded).toBe(true)
  expect(db.listSessionEventsAfter).toHaveBeenCalledTimes(1)
  controller.abort()
})
