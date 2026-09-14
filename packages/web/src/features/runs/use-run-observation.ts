import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RunObservation } from '@cairn/shared'
import { fetchRunObservation, subscribeRunEvents } from '@/lib/runs-api'
import { ApiRequestError } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'

export type ObservationConnection = 'live' | 'recovering' | 'unavailable' | 'forbidden' | 'idle'

export function useRunObservation(runId: string, enabled = true) {
  const queryClient = useQueryClient()
  const appliedSeq = useRef(0)
  const dirty = useRef(false)
  const pumping = useRef(false)
  const refetchRef = useRef<() => Promise<unknown>>(async () => undefined)
  const applyRef = useRef<(next: RunObservation | undefined) => void>(() => undefined)
  const [view, setView] = useState<RunObservation | null>(null)
  const [connection, setConnection] = useState<ObservationConnection>('idle')

  const observation = useQuery({
    queryKey: ['runs', runId, 'observation'],
    queryFn: () => fetchRunObservation(runId),
    enabled,
  })
  refetchRef.current = () => observation.refetch()

  const apply = (next: RunObservation | undefined) => {
    if (!next || next.eventSeq < appliedSeq.current) return
    queryClient.setQueryData(['runs', runId], next.run)
    queryClient.setQueryData(['runs', runId, 'evidence'], next.evidence)
    appliedSeq.current = next.eventSeq
    setView(next)
  }
  applyRef.current = apply

  const pumpRefresh = () => {
    if (pumping.current) return
    pumping.current = true
    void (async () => {
      try {
        while (dirty.current) {
          dirty.current = false
          const result = await refetchRef.current()
          applyRef.current(
            result && typeof result === 'object' && 'data' in result
              ? (result.data as RunObservation | undefined)
              : undefined,
          )
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

  useEffect(() => {
    appliedSeq.current = 0
    setView(null)
    setConnection('idle')
  }, [runId])

  useEffect(() => {
    apply(observation.data)
  }, [observation.data, runId])

  useEffect(() => {
    if (!enabled || !observation.isSuccess) return
    const tokenAtStart = useAuthStore.getState().auth.accessToken
    const controller = new AbortController()
    let stopped = false
    let delay = 500
    const connect = async () => {
      while (!stopped && !controller.signal.aborted) {
        try {
          setConnection((current) => (current === 'unavailable' ? current : 'recovering'))
          await subscribeRunEvents(runId, {
            cursor: appliedSeq.current,
            signal: controller.signal,
            handlers: {
              onEvent: () => {
                scheduleRefresh()
              },
              onControl: (control) => {
                if (control.kind === 'ready') {
                  setConnection(control.realtime ? 'live' : 'unavailable')
                }
                if (control.kind === 'reset') {
                  scheduleRefresh()
                }
                if (control.kind === 'complete') {
                  stopped = true
                  setConnection('live')
                  scheduleRefresh()
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
                  }
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
