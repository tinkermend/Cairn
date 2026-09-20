import { Inject, Injectable, Optional } from '@nestjs/common'
import type { ChangeHintBus, DbHandle } from '@cairn/db'
import { healthResponseSchema, type HealthResponse } from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import { CHANGE_HINT } from '../observe/change-hint.module'

export type HealthInspect = {
  status: HealthResponse['status']
  service: HealthResponse['service']
  uptimeSeconds: number
  database: 'up' | 'down'
  changeHint: 'up' | 'down' | 'unused'
  realtime: boolean
  pingLatencyMs: number | null
}

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now()

  constructor(
    @Inject(DB_HANDLE) private readonly dbHandle: DbHandle,
    @Optional() @Inject(CHANGE_HINT) private readonly changeHint?: ChangeHintBus,
  ) {}

  async inspect(): Promise<HealthInspect> {
    let database: 'up' | 'down' = 'down'
    let pingLatencyMs: number | null = null
    const pingStarted = Date.now()
    try {
      database = (await this.dbHandle.ping()) ? 'up' : 'down'
      pingLatencyMs = Date.now() - pingStarted
    } catch {
      database = 'down'
    }
    let changeHint: 'up' | 'down' | 'unused' = 'unused'
    const realtime = Boolean(this.changeHint?.realtime)
    if (this.changeHint) {
      try {
        changeHint = this.changeHint.realtime && (await this.changeHint.ping()) ? 'up' : this.changeHint.realtime ? 'down' : 'unused'
      } catch {
        changeHint = this.changeHint.realtime ? 'down' : 'unused'
      }
    }

    return {
      status: database === 'up' && changeHint !== 'down' ? 'ok' : 'degraded',
      service: 'cairn-api',
      uptimeSeconds: (Date.now() - this.startedAt) / 1000,
      database,
      changeHint,
      realtime,
      pingLatencyMs,
    }
  }

  async check(): Promise<HealthResponse> {
    const inspect = await this.inspect()
    return healthResponseSchema.parse({
      status: inspect.status,
      service: inspect.service,
      uptimeSeconds: inspect.uptimeSeconds,
      checks: { database: inspect.database, changeHint: inspect.changeHint },
    })
  }
}
