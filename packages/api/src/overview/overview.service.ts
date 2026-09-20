import { Inject, Injectable } from '@nestjs/common'
import { readOverviewAnalytics, type DbHandle } from '@cairn/db'
import type { OverviewAnalyticsQueryParsed, OverviewAnalyticsResponse } from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'

const CACHE_TTL_MS = 10_000

@Injectable()
export class OverviewService {
  private cache = new Map<string, { value: OverviewAnalyticsResponse; expiresAt: number }>()
  private inFlight = new Map<string, Promise<OverviewAnalyticsResponse>>()

  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async analytics(query: OverviewAnalyticsQueryParsed): Promise<OverviewAnalyticsResponse> {
    const key = `${query.range}:${query.targetId ?? ''}`
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
        const result = await readOverviewAnalytics(this.handle, query)
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
