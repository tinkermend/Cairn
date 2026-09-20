import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { subscribeMonitoringStream } from './monitoring-api'

describe('subscribeMonitoringStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    useAuthStore.getState().auth.reset()
  })

  it('游标走 Last-Event-ID，凭证只在 Authorization，间隔不能靠 URL 绕过鉴权', async () => {
    useAuthStore.getState().auth.setAccessToken('tok-mon')
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      expect(url).toBe('/api/monitoring/stream?intervalMs=5000')
      expect(url).not.toMatch(/token=|access_token=/)
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe('Bearer tok-mon')
      expect(headers.get('Last-Event-ID')).toBe('2026-09-18T03:00:00.000Z')
      expect(headers.get('Accept')).toBe('text/event-stream')
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await subscribeMonitoringStream({
      lastEventId: '2026-09-18T03:00:00.000Z',
      signal: new AbortController().signal,
      handlers: {},
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
