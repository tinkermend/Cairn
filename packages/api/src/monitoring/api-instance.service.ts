import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { heartbeatApiInstance, latestLogicalVersion, markApiInstanceStopped, type DbHandle } from '@cairn/db'
import { deriveApiInstanceId, resolveBuildVersion } from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import { config } from '../config/env'
import { currentInternalForwards, currentSseConnections } from '../common/process-gauges'
import { sampleApiProcess } from './process-sample'

@Injectable()
export class ApiInstanceHeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApiInstanceHeartbeatService.name)
  private readonly instanceId = randomUUID()
  private timer: NodeJS.Timeout | undefined

  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  identity() {
    const configured = config.CAIRN_API_ID?.trim()
    if (configured) return { id: configured, idSource: 'configured' as const }
    return { id: deriveApiInstanceId(hostname(), config.CAIRN_API_PORT), idSource: 'derived' as const }
  }

  async onModuleInit(): Promise<void> {
    this.timer = setInterval(() => {
      void this.beat()
    }, config.CAIRN_API_HEARTBEAT_MS)
    this.timer.unref()
    void this.beat()
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    const { id } = this.identity()
    await markApiInstanceStopped(this.handle, id, this.instanceId).catch((error: unknown) => {
      this.logger.warn(error instanceof Error ? error.message : error, 'API 实例停止登记失败')
    })
  }

  private async beat(): Promise<void> {
    try {
      const { id, idSource } = this.identity()
      const process = sampleApiProcess()
      await heartbeatApiInstance(this.handle, {
        id,
        instanceId: this.instanceId,
        idSource,
        lostAfterSeconds: config.CAIRN_API_LOST_AFTER_SECONDS,
        version: resolveBuildVersion(config.CAIRN_BUILD_VERSION),
        schemaLogicalVersion: latestLogicalVersion(),
        rssBytes: process.rssBytes,
        eventLoopDelayMs: process.eventLoopDelayMs,
        sseConnections: currentSseConnections(),
        internalForwardInFlight: currentInternalForwards(),
      })
    } catch (error) {
      this.logger.warn(error instanceof Error ? error.message : error, 'API 实例登记失败')
    }
  }
}
