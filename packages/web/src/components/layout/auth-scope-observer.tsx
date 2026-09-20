import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { meResponseSchema } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { toAuthUser } from '@/lib/auth'
import { readSseStream } from '@/lib/sse'

export function AuthScopeObserver() {
  const token = useAuthStore((s) => s.auth.accessToken)
  const client = useQueryClient()
  useEffect(() => {
    if (!token) return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const connect = async () => {
      try {
        const response = await fetch('/api/me/events', {
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${token}`,
          },
          signal: abort.signal,
        })
        if (response.status === 401 || response.status === 403) {
          client.clear()
          useAuthStore.getState().auth.reset()
          return
        }
        if (!response.ok || !response.body)
          throw new Error('Authorization stream unavailable')
        await readSseStream(
          response.body,
          (frame) => {
            if (frame.event !== 'authorization' || abort.signal.aborted) return
            const parsed = meResponseSchema.safeParse(JSON.parse(frame.data))
            if (!parsed.success) return
            const next = toAuthUser(parsed.data.account)
            const current = useAuthStore.getState().auth.user
            if (JSON.stringify(next) !== JSON.stringify(current)) {
              void client.cancelQueries()
              client.removeQueries()
              useAuthStore.getState().auth.setUser(next)
            }
            client.setQueryData(['me'], parsed.data)
          },
          abort.signal
        )
      } catch {
        /* Retry transport loss; server always rechecks writes. */
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void connect(), 3000)
    }
    void connect()
    return () => {
      abort.abort()
      clearTimeout(timer)
    }
  }, [token, client])
  return null
}
