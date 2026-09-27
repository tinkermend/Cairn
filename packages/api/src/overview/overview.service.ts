import { Inject, Injectable } from '@nestjs/common'
import { readOverviewAnalytics, runReadScope, type DbHandle, type TargetScope } from '@cairn/db'
import type { OverviewAnalyticsQueryParsed, OverviewAnalyticsResponse } from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'

const CACHE_TTL_MS = 10_000

@Injectable()
export class OverviewService {
  private cache = new Map<string, { value: OverviewAnalyticsResponse; expiresAt: number }>()
  private inFlight = new Map<string, Promise<OverviewAnalyticsResponse>>()

  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async analytics(query: OverviewAnalyticsQueryParsed, actorId: string): Promise<OverviewAnalyticsResponse> {
    const scope = await runReadScope(this.handle, actorId)
    const key = overviewCacheKey(scope, query)
    const now = Date.now()

    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > now) {
      return cached.value
    }

    const pending = this.inFlight.get(key)
    if (pending) {
      return pending
    }

    const promise = (async () => {
      try {
        const result = await readOverviewAnalytics(this.handle, query, scope)
        this.cache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS })
        return result
      } catch (error) {
        rethrowDomain(error)
      } finally {
        this.inFlight.delete(key)
      }
    })()

    this.inFlight.set(key, promise)
    return promise
  }
}

/** 同一可见目标集合共用缓存；all 与空范围、不同 id 列表互不串号。 */
function overviewCacheKey(scope: TargetScope, query: OverviewAnalyticsQueryParsed): string {
  const targets = scope.all ? '*' : [...scope.ids].sort().join(',')
  return `${targets}:${query.range}:${query.targetId ?? ''}`
}
