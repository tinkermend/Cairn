import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INTERNAL_SIGNATURE_HEADERS,
  WORKER_FORWARD_AUTH_TIMEOUT_MS,
  WORKER_FORWARD_CONNECT_TIMEOUT_MS,
  WORKER_FORWARD_HEADER_TIMEOUT_MS,
  requireInternalSecret,
  verifyInternalHeaders,
} from '@cairn/shared'
import { currentInternalForwards } from '../common/process-gauges'
import { WorkerForwardError, WorkerInternalClient } from './worker-internal.client'

const call = {
  workerId: 'local-worker',
  workerInstanceId: '11111111-1111-4111-8111-111111111111',
  actorId: '22222222-2222-4222-8222-222222222222',
  runId: '33333333-3333-4333-8333-333333333333',
  sessionGeneration: 1,
  path: '/internal/managed-browser/meta',
  endpoint: 'http://127.0.0.1:8091',
}

describe('WorkerInternalClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('优先使用调用方已解析的库内入口，GET 失败不回退且不泄露 URL', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.8:8443')
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new WorkerInternalClient()
    await expect(
      client.requestJson({ ...call, method: 'GET', timeout: 'headers' }),
    ).rejects.toMatchObject({
      status: 503,
      code: 'WORKER_UNREACHABLE',
    })
    const err = await client.requestJson({ ...call, method: 'GET', timeout: 'headers' }).catch((error) => error)
    expect(String(err)).not.toMatch(/127\.0\.0\.1|8091|10\.0\.0\.8|8443|ECONNREFUSED/)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8091/internal/managed-browser/meta',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
      }),
    )
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect((init.signal as AbortSignal).aborted).toBe(false)
  })

  it('查询串走 query 且不参与签名，Worker 按 pathname 验签可通过', async () => {
    vi.stubEnv('CAIRN_INTERNAL_AUTH_SECRET', Buffer.alloc(32, 7).toString('base64'))
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new WorkerInternalClient()
    await client.requestJson({ ...call, method: 'GET', timeout: 'headers', query: { pageId: 'page-2' } })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const parsed = new URL(url)
    expect(parsed.searchParams.get('pageId')).toBe('page-2')
    const headers = init.headers as Record<string, string>
    const { config } = await import('../config/env')
    const ok = await verifyInternalHeaders(requireInternalSecret(config.CAIRN_INTERNAL_AUTH_SECRET), {
      method: 'GET',
      path: parsed.pathname,
      body: '',
      expiresUnix: Number(headers[INTERNAL_SIGNATURE_HEADERS.expires]),
      actorId: call.actorId,
      runId: call.runId,
      sessionGeneration: call.sessionGeneration,
      workerInstanceId: call.workerInstanceId,
      signature: headers[INTERNAL_SIGNATURE_HEADERS.signature]!,
    })
    expect(ok).toBe(true)
  })

  it('path 混入查询串直接拒绝，避免签名与 Worker 验签不一致', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const client = new WorkerInternalClient()
    await expect(
      client.requestJson({ ...call, method: 'GET', timeout: 'headers', path: `${call.path}?pageId=p` }),
    ).rejects.toThrow(/查询串/)
  })

  it('认证 POST 超时或断连返回结果未知，Web 可见文案不含地址', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('The operation was aborted')
      }),
    )
    const client = new WorkerInternalClient()
    const error = await client
      .requestJson({
        ...call,
        method: 'POST',
        timeout: 'auth',
        path: '/internal/managed-browser/auth/input',
        body: '{"type":"press"}',
      })
      .catch((err) => err)
    expect(error).toBeInstanceOf(WorkerForwardError)
    expect(error).toMatchObject({ status: 503, code: 'WORKER_RESULT_UNKNOWN' })
    expect(error.message).toBe('结果未知，请先查看状态')
    expect(String(error)).not.toMatch(/127\.0\.0\.1|8091|internal/)
  })

  // 「网络模式」已废除：非 loopback 的 http:// 现在是合法入口，由部署架构自行决定用不用 TLS。
  // 入口校验只剩基本合法性，所以这里用现在真正不合格的入口来守住「拒绝且不发请求」：
  // 请求带着 HMAC 签名头，发给不该发的地方比发不出去更糟。
  it.each([
    ['调试端口 9222', 'http://worker.example:9222'],
    ['地址里带凭据', 'http://user:pass@worker.example:8091'],
    ['通配主机', 'http://0.0.0.0:8091'],
  ])('不合格入口（%s）直接拒绝，不发请求', async (_label, endpoint) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = new WorkerInternalClient()
    await expect(
      client.requestJson({
        ...call,
        method: 'GET',
        timeout: 'headers',
        endpoint,
      }),
    ).rejects.toMatchObject({ code: 'WORKER_UNREACHABLE' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('上游错误信息若带地址则脱敏；超时预算按读/认证区分', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 'PAGE_STALE', message: 'see http://127.0.0.1:8091' }), {
          status: 409,
        }),
      ),
    )
    const client = new WorkerInternalClient()
    const error = await client.requestJson({ ...call, method: 'GET', timeout: 'headers' }).catch((err) => err)
    expect(error).toMatchObject({ code: 'PAGE_STALE', message: '执行面暂时不可达' })
    expect(WORKER_FORWARD_CONNECT_TIMEOUT_MS).toBe(3_000)
    expect(WORKER_FORWARD_HEADER_TIMEOUT_MS).toBe(10_000)
    expect(WORKER_FORWARD_AUTH_TIMEOUT_MS).toBe(30_000)
  })

  it('SSE 只把调用方信号交给 fetch，不把 10 秒头超时套在响应体上', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const client = new WorkerInternalClient()
    const caller = new AbortController()
    const streamed = await client.requestStream({ ...call, method: 'GET', timeout: 'stream', path: '/internal/managed-browser/frames' }, caller.signal)
    await streamed.text()
    const init = fetchMock.mock.calls[0]![1] as RequestInit & { headersTimeout?: number; bodyTimeout?: number }
    expect(init.signal).toBe(caller.signal)
    expect(init.redirect).toBe('error')
    expect(init.headersTimeout).toBe(10_000)
    expect(init.bodyTimeout).toBe(0)
  })

  it('转发计数持续到响应体读完', async () => {
    let resolveText!: (value: string) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        text: () => new Promise<string>((resolve) => {
          resolveText = resolve
        }),
      })),
    )
    const client = new WorkerInternalClient()
    const pending = client.requestJson({ ...call, method: 'GET', timeout: 'headers' })
    await vi.waitFor(() => {
      expect(typeof resolveText).toBe('function')
      expect(currentInternalForwards()).toBe(1)
    })
    resolveText('{}')
    await expect(pending).resolves.toEqual({})
    expect(currentInternalForwards()).toBe(0)
  })
})
