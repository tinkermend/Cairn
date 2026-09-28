import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { RunObservation } from '@cairn/shared'
import { fetchRunObservation, subscribeRunEvents } from '@/lib/runs-api'
import { ApiRequestError } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'

import { useResetOnChange } from '@/hooks/use-reset-on-change'
export type ObservationConnection = 'live' | 'recovering' | 'unavailable' | 'forbidden' | 'idle'

type SharedStream = {
  controller: AbortController
  listeners: Set<(connection: ObservationConnection) => void>
  connection: ObservationConnection
  appliedSeq: number
  dirty: boolean
  pumping: boolean
  lastPumpAt: number
  timer: ReturnType<typeof setTimeout> | null
}

// A scenario page mounts several consumers of the same Run. Each consumer opening its
// own SSE connection can exhaust the browser's per-origin HTTP connection limit and
// leave ordinary save/debug requests queued behind long-lived streams.
const streams = new WeakMap<QueryClient, Map<string, SharedStream>>()

function acquireStream(
  queryClient: QueryClient,
  runId: string,
  initialSeq: number,
  onConnection: (connection: ObservationConnection) => void,
) {
  let byRun = streams.get(queryClient)
  if (!byRun) {
    byRun = new Map()
    streams.set(queryClient, byRun)
  }
  let stream = byRun.get(runId)
  if (!stream) {
    stream = {
      controller: new AbortController(),
      listeners: new Set(),
      connection: 'recovering',
      appliedSeq: initialSeq,
      dirty: false,
      pumping: false,
      lastPumpAt: 0,
      timer: null,
    }
    byRun.set(runId, stream)
    const active = stream
    const tokenAtStart = useAuthStore.getState().auth.accessToken
    let stopped = false
    let delay = 500
    const setConnection = (next: ObservationConnection) => {
      if (active.connection === next) return
      active.connection = next
      for (const listener of active.listeners) listener(next)
    }
    const pump = () => {
      if (active.pumping || active.controller.signal.aborted) return
      active.pumping = true
      active.lastPumpAt = Date.now()
      void (async () => {
        try {
          while (active.dirty && !active.controller.signal.aborted) {
            active.dirty = false
            try {
              const observation = await fetchRunObservation(runId)
              if (observation.eventSeq >= active.appliedSeq) {
                active.appliedSeq = observation.eventSeq
                queryClient.setQueryData(['runs', runId, 'observation'], observation)
              }
            } catch {
              // A later SSE event or an explicit refresh can retry the snapshot.
            }
          }
        } finally {
          active.pumping = false
          if (active.dirty && !active.controller.signal.aborted) scheduleRefresh(false)
        }
      })()
    }
    const scheduleRefresh = (immediate: boolean) => {
      active.dirty = true
      if (immediate && active.timer) {
        clearTimeout(active.timer)
        active.timer = null
      }
      if (active.pumping || active.timer) return
      const wait = immediate ? 0 : Math.max(0, 300 - (Date.now() - active.lastPumpAt))
      if (wait === 0) pump()
      else active.timer = setTimeout(() => {
        active.timer = null
        pump()
      }, wait)
    }
    void (async () => {
      while (!stopped && !active.controller.signal.aborted) {
        try {
          setConnection(active.connection === 'unavailable' ? 'unavailable' : 'recovering')
          await subscribeRunEvents(runId, {
            cursor: active.appliedSeq,
            signal: active.controller.signal,
            handlers: {
              onEvent: () => scheduleRefresh(false),
              onControl: (control) => {
                if (control.kind === 'ready') setConnection(control.realtime ? 'live' : 'unavailable')
                if (control.kind === 'reset') scheduleRefresh(true)
                if (control.kind === 'complete') {
                  stopped = true
                  setConnection('live')
                  scheduleRefresh(true)
                }
                if (control.kind === 'error') {
                  if (control.code === 'FORBIDDEN') {
                    stopped = true
                    setConnection('forbidden')
                  } else if (control.code === 'UNAUTHORIZED') {
                    stopped = true
                    if (tokenAtStart === useAuthStore.getState().auth.accessToken) {
                      useAuthStore.getState().auth.reset()
                    }
                  } else setConnection('recovering')
                }
              },
            },
          })
          if (stopped) return
          setConnection('recovering')
        } catch (error) {
          if (active.controller.signal.aborted || stopped) return
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
    })()
  }
  stream.appliedSeq = Math.max(stream.appliedSeq, initialSeq)
  stream.listeners.add(onConnection)
  onConnection(stream.connection)
  return () => {
    stream.listeners.delete(onConnection)
    if (stream.listeners.size > 0) return
    stream.controller.abort()
    if (stream.timer) clearTimeout(stream.timer)
    byRun.delete(runId)
  }
}

export function useRunObservation(runId: string, enabled = true) {
  const queryClient = useQueryClient()
  const appliedSeq = useRef(0)
  const [view, setView] = useState<RunObservation | null>(null)
  const [connection, setConnection] = useState<ObservationConnection>('idle')

  const observation = useQuery({
    queryKey: ['runs', runId, 'observation'],
    queryFn: () => fetchRunObservation(runId),
    enabled,
  })
  const apply = (next: RunObservation | undefined) => {
    if (!next || next.eventSeq < appliedSeq.current) return
    queryClient.setQueryData(['runs', runId], next.run)
    queryClient.setQueryData(['runs', runId, 'evidence'], next.evidence)
    appliedSeq.current = next.eventSeq
    setView(next)
  }

  // 切换运行时丢掉上一条运行的观察视图与连接状态；已应用序号在提交后清零。
  useResetOnChange(runId, () => {
    setView(null)
    setConnection('idle')
  })
  useEffect(() => {
    appliedSeq.current = 0
  }, [runId])

  useEffect(() => {
    apply(observation.data)
  }, [observation.data, runId])

  useEffect(() => {
    if (!enabled || !observation.isSuccess) return
    return acquireStream(queryClient, runId, observation.data?.eventSeq ?? 0, setConnection)
  }, [enabled, observation.isSuccess, runId])

  return {
    run: view?.run,
    evidence: view?.evidence,
    eventSeq: view?.eventSeq ?? 0,
    connection,
    query: observation,
    refresh: () => observation.refetch().then((result) => {
      apply(result.data)
      return result
    }),
  }
}

export function connectionLabel(connection: ObservationConnection): string {
  if (connection === 'live') return '连接正常'
  if (connection === 'recovering') return '恢复中'
  if (connection === 'unavailable') return '实时未配置'
  if (connection === 'forbidden') return '无权限'
  return '等待连接'
}

export function connectionTone(
  connection: ObservationConnection,
): 'neutral' | 'warning' | 'error' {
  if (connection === 'recovering') return 'warning'
  if (connection === 'forbidden') return 'error'
  return 'neutral'
}
