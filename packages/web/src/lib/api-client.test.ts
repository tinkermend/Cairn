import { z } from 'zod'
import { REQUEST_ID_HEADER } from '@cairn/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { ApiRequestError, apiFetch, apiFetchBlob } from './api-client'

function captureFetch(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
      })
    })
  )
  return calls
}

function sentHeaders(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>
}

afterEach(() => {
  vi.unstubAllGlobals()
  useAuthStore.getState().auth.reset()
})

describe('apiFetch', () => {
  it.each(['json', 'blob'] as const)(
    '%s 的旧请求返回 401 不得清除新登录的凭证',
    async (kind) => {
      let complete!: (response: Response) => void
      const pending = new Promise<Response>((resolve) => {
        complete = resolve
      })
      vi.stubGlobal(
        'fetch',
        vi.fn(() => pending)
      )
      useAuthStore.getState().auth.setAccessToken('expired-token')
      const request =
        kind === 'json'
          ? apiFetch('/api/probe', z.unknown())
          : apiFetchBlob('/api/probe')
      const rejected = expect(request).rejects.toBeInstanceOf(ApiRequestError)
      useAuthStore.getState().auth.setAccessToken('new-session-token')
      complete(
        new Response(
          JSON.stringify({
            code: 'UNAUTHENTICATED',
            message: '登录已过期',
            requestId: 'old-request',
          }),
          { status: 401 }
        )
      )

      await rejected
      expect(useAuthStore.getState().auth.accessToken).toBe('new-session-token')

      // 当前会话本身失效时，仍必须清除凭证。
      captureFetch(
        {
          code: 'UNAUTHENTICATED',
          message: '登录已过期',
          requestId: 'current-request',
        },
        401
      )
      const current =
        kind === 'json'
          ? apiFetch('/api/probe', z.unknown())
          : apiFetchBlob('/api/probe')
      await expect(current).rejects.toBeInstanceOf(ApiRequestError)
      expect(useAuthStore.getState().auth.accessToken).toBe('')
    }
  )

  it('每个请求都带 x-cairn-request-id，浏览器与服务端日志才能对上', async () => {
    const calls = captureFetch({ ok: true })

    await apiFetch('/api/probe', z.object({ ok: z.boolean() }))

    const id = sentHeaders(calls[0]?.init)[REQUEST_ID_HEADER]
    expect(REQUEST_ID_HEADER).toBe('x-cairn-request-id')
    expect(id).toBeTruthy()
  })

  it('调用方显式给出的 requestId 覆盖自动生成值', async () => {
    const calls = captureFetch({ ok: true })

    await apiFetch('/api/probe', z.object({ ok: z.boolean() }), {
      headers: { [REQUEST_ID_HEADER]: 'req-explicit' },
    })

    expect(sentHeaders(calls[0]?.init)[REQUEST_ID_HEADER]).toBe('req-explicit')
  })

  it('解析失败时抛出 ApiRequestError，并以错误体里的 requestId 为准', async () => {
    captureFetch(
      {
        code: 'SCENARIO_NOT_BOUND',
        message: '未绑定 Target',
        requestId: 'req-server',
      },
      409
    )

    const error = await apiFetch(
      '/api/probe',
      z.object({ ok: z.boolean() })
    ).catch((e) => e)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error.status).toBe(409)
    expect(error.payload.code).toBe('SCENARIO_NOT_BOUND')
    expect(error.requestId).toBe('req-server')
  })

  it('错误体不可解析时回落响应头，而不是 unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>502</html>', {
            status: 502,
            headers: { [REQUEST_ID_HEADER]: 'req-from-header' },
          })
      )
    )

    const error = await apiFetch(
      '/api/probe',
      z.object({ ok: z.boolean() })
    ).catch((e) => e)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error.requestId).toBe('req-from-header')
  })

  it('安全上下文缺失 randomUUID 时仍能发出请求（LAN 明文 HTTP 部署）', async () => {
    const calls = captureFetch({ ok: true })
    const original = crypto.randomUUID
    // 私有化交付里控制台常跑在非安全上下文，那里 randomUUID 整个不存在
    Object.defineProperty(crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
    })
    try {
      await apiFetch('/api/probe', z.object({ ok: z.boolean() }))
    } finally {
      Object.defineProperty(crypto, 'randomUUID', {
        value: original,
        configurable: true,
      })
    }

    const id = sentHeaders(calls[0]?.init)[REQUEST_ID_HEADER]
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })
})
