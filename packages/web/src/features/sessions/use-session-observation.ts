import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { subscribeSessionEvents } from '@/lib/sessions-api'

export function useSessionObservation(targetId?: string, accountId?: string) {
  const client = useQueryClient()
  const [connected, setConnected] = useState(false)
  const [eventSeq, setEventSeq] = useState(0)
  useEffect(() => {
    let stopped = false
    let cursor: string | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let refresh: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController
    const invalidate = () => {
      clearTimeout(refresh)
      refresh = setTimeout(() => {
        void client.invalidateQueries({ queryKey: ['sessions-overview'] })
        void client.invalidateQueries({ queryKey: ['sessions-systems'] })
        void client.invalidateQueries({
          queryKey: ['account-session', ...(targetId ? [targetId, accountId] : [])],
        })
        void client.invalidateQueries({ queryKey: ['session-operation'] })
        void client.invalidateQueries({ queryKey: ['account-session-events'] })
      }, 100)
    }
    const connect = async () => {
      controller = new AbortController()
      let ready = false
      try {
        await subscribeSessionEvents({
          targetId,
          accountId,
          cursor,
          signal: controller.signal,
          onReady: () => {
            if (!stopped && !ready) {
              ready = true
              setConnected(true)
              invalidate()
            }
          },
          onEvent: (_event, next) => {
            if (!stopped) {
              cursor = next
              setEventSeq((value) => value + 1)
              invalidate()
            }
          },
        })
      } catch {
        /* Retain the last durable state while reconnecting. */
      }
      if (!stopped) {
        setConnected(false)
        retry = setTimeout(() => void connect(), 2000)
      }
    }
    void connect()
    return () => {
      stopped = true
      controller?.abort()
      clearTimeout(retry)
      clearTimeout(refresh)
    }
  }, [targetId, accountId, client])
  return { connected, eventSeq }
}
