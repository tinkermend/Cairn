import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { subscribeRunEvents } from './runs-api'

const RUN_ID = '44444444-4444-4444-8444-444444444444'

describe('subscribeRunEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    useAuthStore.getState().auth.reset()
  })

  it('游标走 Last-Event-ID，凭证只在 Authorization', async () => {
    useAuthStore.getState().auth.setAccessToken('tok-1')
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      expect(url).toBe(`/api/runs/${RUN_ID}/events`)
      expect(url).not.toMatch(/token=|access_token=/)
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe('Bearer tok-1')
      expect(headers.get('Last-Event-ID')).toBe(`${RUN_ID}:3`)
      expect(headers.get('Accept')).toBe('text/event-stream')
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await subscribeRunEvents(RUN_ID, {
      cursor: 3,
      signal: new AbortController().signal,
      handlers: {},
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
