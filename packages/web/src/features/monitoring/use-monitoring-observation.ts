import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_MONITOR_SSE_INTERVAL_MS } from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import { fetchMonitoringOverview, subscribeMonitoringStream } from '@/lib/monitoring-api'
import { useAuthStore } from '@/stores/auth-store'
import {
  readAutoRefreshEnabled,
  readAutoRefreshInterval,
  writeAutoRefreshEnabled,
  writeAutoRefreshInterval,
  type RefreshIntervalSeconds,
} from './labels'

export type MonitoringConnection = 'live' | 'recovering' | 'forbidden' | 'idle'

export function useMonitoringObservation() {
  const queryClient = useQueryClient()
  const [autoRefresh, setAutoRefreshState] = useState(readAutoRefreshEnabled)
  const [refreshInterval, setRefreshIntervalState] = useState<RefreshIntervalSeconds>(readAutoRefreshInterval)
  const [connection, setConnection] = useState<MonitoringConnection>('idle')
  const [intervalMs, setPushInterval] = useState(DEFAULT_MONITOR_SSE_INTERVAL_MS)
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  )
  const lastEventId = useRef<string | undefined>(undefined)
  const dirty = useRef(false)
  const pumping = useRef(false)
  const wasHidden = useRef(false)
  const lastSnapshotAt = useRef(0)

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
          await queryClient.invalidateQueries({ queryKey: ['monitoring', 'series'] })
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

  const setRefreshInterval = (sec: RefreshIntervalSeconds) => {
    setRefreshIntervalState(sec)
    writeAutoRefreshInterval(sec)
    lastSnapshotAt.current = 0
  }

  useEffect(() => {
    const onVisibility = () => {
      setVisible(document.visibilityState !== 'hidden')
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // 未开自动刷新、页面不可见或首屏未成功时不订阅推送；此时对外展示为 idle（无权限状态保持不变）。
  const streaming = autoRefresh && visible && overview.isSuccess
  useEffect(() => {
    if (!streaming) return
    const tokenAtStart = useAuthStore.getState().auth.accessToken
    const controller = new AbortController()
    let stopped = false
    let delay = 500
    const connect = async () => {
      while (!stopped && !controller.signal.aborted) {
        try {
          setConnection((current) => (current === 'forbidden' ? current : 'recovering'))
          await subscribeMonitoringStream({
            intervalMs: Math.min(refreshInterval * 1000, 60_000),
            lastEventId: lastEventId.current,
            signal: controller.signal,
            handlers: {
              onSnapshot: () => {
                const now = Date.now()
                if (lastSnapshotAt.current === 0 || now - lastSnapshotAt.current >= refreshInterval * 1000 - 1500) {
                  lastSnapshotAt.current = now
                  scheduleRefresh()
                }
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
  }, [streaming, refreshInterval])

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
    connection: !streaming && connection !== 'forbidden' ? 'idle' : connection,
    autoRefresh,
    setAutoRefresh,
    refreshInterval,
    setRefreshInterval,
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
