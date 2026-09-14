import { Inject, Injectable, Optional } from '@nestjs/common'
import type { ChangeHintBus, DbHandle } from '@cairn/db'
import { healthResponseSchema, type HealthResponse } from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import { CHANGE_HINT } from '../observe/change-hint.module'

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now()

  constructor(
    @Inject(DB_HANDLE) private readonly dbHandle: DbHandle,
    @Optional() @Inject(CHANGE_HINT) private readonly changeHint?: ChangeHintBus,
  ) {}

  async check(): Promise<HealthResponse> {
    let database: 'up' | 'down' = 'down'
    try {
      database = (await this.dbHandle.ping()) ? 'up' : 'down'
    } catch {
      database = 'down'
    }
    let changeHint: 'up' | 'down' | 'unused' = 'unused'
    if (this.changeHint) {
      try {
        changeHint = this.changeHint.realtime && (await this.changeHint.ping()) ? 'up' : this.changeHint.realtime ? 'down' : 'unused'
      } catch {
        changeHint = this.changeHint.realtime ? 'down' : 'unused'
      }
    }

    // 出站响应也过一遍 schema：契约由 @cairn/shared 单向拥有，
    // 这里若不匹配应当立刻暴露，而不是让 web 端解析失败。
    return healthResponseSchema.parse({
      status: database === 'up' && changeHint !== 'down' ? 'ok' : 'degraded',
      service: 'cairn-api',
      uptimeSeconds: (Date.now() - this.startedAt) / 1000,
      checks: { database, changeHint },
    })
  }
}
