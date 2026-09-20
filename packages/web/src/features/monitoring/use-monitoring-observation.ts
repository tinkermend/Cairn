import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_MONITOR_SSE_INTERVAL_MS } from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import { fetchMonitoringOverview, subscribeMonitoringStream } from '@/lib/monitoring-api'
import { useAuthStore } from '@/stores/auth-store'
import { readAutoRefreshEnabled, writeAutoRefreshEnabled } from './labels'

export type MonitoringConnection = 'live' | 'recovering' | 'forbidden' | 'idle'

export function useMonitoringObservation() {
  const queryClient = useQueryClient()
  const [autoRefresh, setAutoRefreshState] = useState(readAutoRefreshEnabled)
  const [connection, setConnection] = useState<MonitoringConnection>('idle')
  const [intervalMs, setPushInterval] = useState(DEFAULT_MONITOR_SSE_INTERVAL_MS)
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  )
  const lastEventId = useRef<string | undefined>(undefined)
  const dirty = useRef(false)
  const pumping = useRef(false)
  const wasHidden = useRef(false)

  const overview = useQuery({
    queryKey: ['monitoring', 'overview'],
    queryFn: fetchMonitoringOverview,
  })

  useEffect(() => {
    if (overview.data?.asOf) lastEventId.current = overview.data.asOf
  }, [overview.data?.asOf])

  const pumpRefresh = () => {
    if (pumping.current) return
    pumping.current = true
    void (async () => {
      try {
        while (dirty.current) {
          dirty.current = false
          await queryClient.invalidateQueries({ queryKey: ['monitoring', 'overview'] })
          await queryClient.invalidateQueries({ queryKey: ['monitoring', 'alerts'] })
        }
      } finally {
        pumping.current = false
        if (dirty.current) pumpRefresh()
      }
    })()
  }

  const scheduleRefresh = () => {
    dirty.current = true
    pumpRefresh()
  }

  const setAutoRefresh = (enabled: boolean) => {
    setAutoRefreshState(enabled)
    writeAutoRefreshEnabled(enabled)
  }

  useEffect(() => {
    const onVisibility = () => {
      setVisible(document.visibilityState !== 'hidden')
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    if (!autoRefresh || !visible || !overview.isSuccess) {
      setConnection((current) => (current === 'forbidden' ? current : 'idle'))
      return
    }
    const tokenAtStart = useAuthStore.getState().auth.accessToken
    const controller = new AbortController()
    let stopped = false
    let delay = 500
    const connect = async () => {
      while (!stopped && !controller.signal.aborted) {
        try {
          setConnection((current) => (current === 'forbidden' ? current : 'recovering'))
          await subscribeMonitoringStream({
            intervalMs: DEFAULT_MONITOR_SSE_INTERVAL_MS,
            lastEventId: lastEventId.current,
            signal: controller.signal,
            handlers: {
              onSnapshot: () => {
                scheduleRefresh()
              },
              onControl: (control) => {
                if (control.kind === 'ready') {
                  setPushInterval(control.intervalMs)
                  setConnection('live')
                }
                if (control.kind === 'error') {
                  if (control.code === 'FORBIDDEN') {
                    stopped = true
                    setConnection('forbidden')
                    return
                  }
                  if (control.code === 'UNAUTHORIZED') {
                    stopped = true
                    if (tokenAtStart === useAuthStore.getState().auth.accessToken) {
                      useAuthStore.getState().auth.reset()
                    }
                    return
                  }
                  setConnection('recovering')
                }
              },
            },
          })
          if (stopped) return
          setConnection('recovering')
        } catch (error) {
          if (controller.signal.aborted || stopped) return
          if (error instanceof ApiRequestError && error.status === 403) {
            setConnection('forbidden')
            return
          }
          if (error instanceof ApiRequestError && error.status === 401) {
            if (tokenAtStart === useAuthStore.getState().auth.accessToken) {
              useAuthStore.getState().auth.reset()
            }
            return
          }
          setConnection('recovering')
          await new Promise((resolve) => setTimeout(resolve, delay))
          delay = Math.min(delay * 2, 8_000)
        }
      }
    }
    void connect()
    return () => {
      stopped = true
      controller.abort()
    }
  }, [autoRefresh, visible, overview.isSuccess])

  useEffect(() => {
    if (!visible) {
      wasHidden.current = true
      return
    }
    if (wasHidden.current && autoRefresh && overview.isSuccess) {
      wasHidden.current = false
      scheduleRefresh()
    }
  }, [autoRefresh, overview.isSuccess, visible])

  return {
    overview,
    connection,
    autoRefresh,
    setAutoRefresh,
    intervalMs,
    visible,
    refresh: () => {
      lastEventId.current = undefined
      return queryClient.invalidateQueries({ queryKey: ['monitoring'] })
    },
  }
}

export function connectionLabel(connection: MonitoringConnection): string {
  if (connection === 'live') return '推送已连接'
  if (connection === 'recovering') return '推送恢复中'
  if (connection === 'forbidden') return '无权限'
  return '推送未订阅'
}
