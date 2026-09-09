import { Inject, Injectable } from '@nestjs/common'
import type { DbHandle } from '@cairn/db'
import { healthResponseSchema, type HealthResponse } from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now()

  constructor(@Inject(DB_HANDLE) private readonly dbHandle: DbHandle) {}

  async check(): Promise<HealthResponse> {
    let database: 'up' | 'down' = 'down'
    try {
      database = (await this.dbHandle.ping()) ? 'up' : 'down'
    } catch {
      database = 'down'
    }

    // 出站响应也过一遍 schema：契约由 @cairn/shared 单向拥有，
    // 这里若不匹配应当立刻暴露，而不是让 web 端解析失败。
    return healthResponseSchema.parse({
      status: database === 'up' ? 'ok' : 'degraded',
      service: 'cairn-api',
      uptimeSeconds: (Date.now() - this.startedAt) / 1000,
      checks: { database },
    })
  }
}
