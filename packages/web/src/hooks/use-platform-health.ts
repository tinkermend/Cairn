import { useEffect, useRef, useState, useCallback } from 'react'
import {
  healthResponseSchema,
  platformHealthResponseSchema,
  type PlatformHealthResponse,
} from '@cairn/shared'
import { apiFetch } from '@/lib/api-client'

export async function fetchPlatformHealth(): Promise<PlatformHealthResponse> {
  const fetchTime = new Date()
  try {
    return await apiFetch('/api/platform-health', platformHealthResponseSchema)
  } catch {
    // 聚合接口失败时回退至公开 /health
    try {
      const publicHealth = await apiFetch('/health', healthResponseSchema)
      const isDbDown = publicHealth.checks.database === 'down'
      const isHintDown = publicHealth.checks.changeHint === 'down'

      if (isDbDown) {
        return {
          overall: 'critical',
          asOf: fetchTime.toISOString(),
          validUntil: new Date(fetchTime.getTime() + 5000).toISOString(),
          freshForMs: 5000,
          checks: {
            api: { status: 'healthy', code: 'OK', message: 'API 可达' },
            database: { status: 'critical', code: 'DATABASE_DOWN', message: '数据库不可用' },
            worker: {
              status: 'unknown',
              code: 'DATABASE_UNAVAILABLE',
              message: '数据库故障；Worker 状态未知',
              healthyNodes: 0,
              affectedActiveRuns: 0,
              affectedActiveSessions: 0,
            },
            changeHint: {
              status: isHintDown ? 'degraded' : publicHealth.checks.changeHint === 'up' ? 'healthy' : 'unused',
              code: isHintDown ? 'DOWN' : 'OK',
              message: isHintDown ? '变更提示链路异常' : '变更提示链路未启用',
            },
          },
        }
      }

      // /health 正常但聚合不可用：总状态为 unknown（若提示故障则 degraded 且标明状态不完整）
      return {
        overall: isHintDown ? 'degraded' : 'unknown',
        asOf: fetchTime.toISOString(),
        validUntil: new Date(fetchTime.getTime() + 5000).toISOString(),
        freshForMs: 5000,
        checks: {
          api: { status: 'healthy', code: 'OK', message: 'API 自检正常' },
          database: { status: 'healthy', code: 'OK', message: '数据库自检正常' },
          worker: {
            status: 'unknown',
            code: 'AGGREGATE_UNAVAILABLE',
            message: 'Worker 聚合状态未确认',
            healthyNodes: 0,
            affectedActiveRuns: 0,
            affectedActiveSessions: 0,
          },
          changeHint: {
            status: isHintDown ? 'degraded' : publicHealth.checks.changeHint === 'up' ? 'healthy' : 'unused',
            code: isHintDown ? 'DOWN' : 'OK',
            message: isHintDown ? '变更提示链路异常' : '变更提示链路正常',
          },
        },
      }
    } catch {
      // 两者均不可达：本地断言网络连接失败
      return {
        overall: 'critical',
        asOf: fetchTime.toISOString(),
        validUntil: new Date(fetchTime.getTime() + 5000).toISOString(),
        freshForMs: 5000,
        checks: {
          api: { status: 'critical', code: 'CONNECTION_FAILED', message: '无法连接平台服务' },
          database: { status: 'unknown', code: 'UNKNOWN', message: '服务不可达' },
          worker: {
            status: 'unknown',
            code: 'UNKNOWN',
            message: '服务不可达',
            healthyNodes: 0,
            affectedActiveRuns: 0,
            affectedActiveSessions: 0,
          },
          changeHint: { status: 'unknown', code: 'UNKNOWN', message: '服务不可达' },
        },
      }
    }
  }
}

const STALE_MESSAGE = '状态已过期，等待重新检查'

/** 过期快照中的组件明细也不再代表当前事实。 */
export function markPlatformHealthStale(data: PlatformHealthResponse): PlatformHealthResponse {
  return {
    ...data,
    overall: 'unknown',
    checks: {
      api: { status: 'unknown', code: 'STALE', message: STALE_MESSAGE },
      database: { status: 'unknown', code: 'STALE', message: STALE_MESSAGE },
      worker: {
        status: 'unknown',
        code: 'STALE',
        message: STALE_MESSAGE,
        healthyNodes: 0,
        affectedActiveRuns: 0,
        affectedActiveSessions: 0,
      },
      changeHint: { status: 'unknown', code: 'STALE', message: STALE_MESSAGE },
    },
  }
}

export function usePlatformHealth() {
  const [data, setData] = useState<PlatformHealthResponse | null>(null)
  const [isChecking, setIsChecking] = useState(true)
  const [isStale, setIsStale] = useState(false)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestVersionRef = useRef(0)

  const performCheck = useCallback(async function checkPlatformHealth() {
    const requestVersion = ++requestVersionRef.current
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    setIsChecking(true)
    const startedAt = performance.now()
    const result = await fetchPlatformHealth()
    // 手动刷新、定时刷新可能重叠，旧响应不得覆盖后发起的新检查。
    if (requestVersion !== requestVersionRef.current) return
    const elapsedMs = Math.max(0, performance.now() - startedAt)
    const validForMs = Date.parse(result.validUntil) - Date.parse(result.asOf)
    // 不把最小轮询间隔当作有效期，且扣除请求途中已消耗的时间。
    const freshForMs = Math.max(0, Math.min(30_000, result.freshForMs, validForMs) - elapsedMs)
    setData(result)
    setIsChecking(false)
    setIsStale(freshForMs <= 0)

    if (staleTimerRef.current) clearTimeout(staleTimerRef.current)

    // 在到期前 500ms 刷新
    const refreshDelay = Math.max(1_000, freshForMs - 500)
    pollTimerRef.current = setTimeout(() => {
      void checkPlatformHealth()
    }, refreshDelay)

    // 到期且尚无新结果即改为未知，不把旧值当当前事实
    if (freshForMs > 0) {
      staleTimerRef.current = setTimeout(() => {
        setIsStale(true)
      }, freshForMs)
    }
  }, [])

  useEffect(() => {
    void performCheck()
    return () => {
      requestVersionRef.current += 1
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
    }
  }, [performCheck])

  // 过期后，总状态与所有组件明细都不再作为当前事实呈现。
  const effectiveData: PlatformHealthResponse | null = data
    ? isStale
      ? markPlatformHealthStale(data)
      : data
    : null

  return {
    data: effectiveData,
    isChecking,
    isStale,
    refresh: performCheck,
  }
}
