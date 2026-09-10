import { useQuery } from '@tanstack/react-query'
import { healthResponseSchema, type HealthResponse } from '@cairn/shared'
import { apiFetch } from '@/lib/api-client'

export const healthQueryKey = ['health'] as const

/** 轮询后端健康状态。开发期用来确认前后端确实接通。 */
export function useHealth() {
  return useQuery<HealthResponse>({
    queryKey: healthQueryKey,
    queryFn: ({ signal }) => apiFetch('/health', healthResponseSchema, { signal }),
    refetchInterval: 30_000,
    retry: false,
  })
}
