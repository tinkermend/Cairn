import {
  overviewAnalyticsResponseSchema,
  type OverviewAnalyticsQuery,
  type OverviewAnalyticsResponse,
} from '@cairn/shared'
import { apiFetch, toQueryString } from '@/lib/api-client'

export function fetchOverviewAnalytics(
  query: OverviewAnalyticsQuery = {}
): Promise<OverviewAnalyticsResponse> {
  return apiFetch(
    `/api/overview/analytics${toQueryString(query)}`,
    overviewAnalyticsResponseSchema
  )
}
