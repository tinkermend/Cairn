import { Inject, Injectable, Optional } from '@nestjs/common'
import type { DbHandle, ChangeHintBus } from '@cairn/db'
import { readMonitorClock, readPlatformApiHealthSummary, readPlatformWorkerHealthSummary } from '@cairn/db'
import {
  platformHealthResponseSchema,
  type PlatformHealthItem,
  type PlatformHealthResponse,
  type PlatformHealthStatus,
  type PlatformHealthWorkerItem,
  type PlatformHealthChangeHintItem,
} from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import { CHANGE_HINT } from '../observe/change-hint.module'
import { HealthService } from '../health/health.service'

@Injectable()
export class PlatformHealthService {
  constructor(
    @Inject(DB_HANDLE) private readonly dbHandle: DbHandle,
    private readonly healthService: HealthService,
    @Optional() @Inject(CHANGE_HINT) private readonly changeHint?: ChangeHintBus,
  ) {}

  async getPlatformHealth(): Promise<PlatformHealthResponse> {
    const healthInspect = await this.healthService.inspect()
    // 实例与 Worker 心跳期限由数据库时间写入；聚合时沿用同一时钟。
    let asOf = new Date()
    let databaseClockFailed = false
    if (healthInspect.database === 'up') {
      try {
        asOf = await readMonitorClock(this.dbHandle)
      } catch {
        databaseClockFailed = true
      }
    }

    let databaseItem: PlatformHealthItem
    let apiItem: PlatformHealthItem
    let changeHintItem: PlatformHealthChangeHintItem
    let workerItem: PlatformHealthWorkerItem
    let earliestApiValidUntil: Date | null = null
    let earliestWorkerValidUntil: Date | null = null

    // 1. 数据库状态检查
    if (healthInspect.database === 'down' || databaseClockFailed) {
      databaseItem = {
        status: 'critical',
        code: databaseClockFailed ? 'DATABASE_CHECK_FAILED' : 'DATABASE_DOWN',
        message: databaseClockFailed ? '数据库状态检查失败' : '数据库不可用',
      }
    } else {
      databaseItem = {
        status: 'healthy',
        code: 'OK',
        message: '数据库连接正常',
      }
    }

    // 2. 变更提示链路状态
    if (healthInspect.changeHint === 'unused') {
      changeHintItem = {
        status: 'unused',
        code: 'UNUSED',
        message: '变更提示链路未启用',
      }
    } else if (healthInspect.changeHint === 'up') {
      changeHintItem = {
        status: 'healthy',
        code: 'OK',
        message: '变更提示链路正常',
      }
    } else {
      changeHintItem = {
        status: 'degraded',
        code: 'DOWN',
        message: '变更提示链路异常',
      }
    }

    // 3. API 状态检查
    if (databaseItem.status === 'critical') {
      // 库断开时 API 进程自身仍可响应请求
      apiItem = {
        status: 'healthy',
        code: 'OK',
        message: 'API 服务正常',
      }
    } else {
      try {
        const instances = await readPlatformApiHealthSummary(this.dbHandle, asOf)
        const lost = instances.recentlyLostInstances
        earliestApiValidUntil = instances.earliestApiValidUntil
        if (lost > 0) {
          apiItem = {
            status: 'degraded',
            code: 'PARTIAL_API_LOST',
            message: `部分 API 实例失联 (${lost} 个离线)`,
          }
        } else {
          apiItem = {
            status: 'healthy',
            code: 'OK',
            message: 'API 服务正常',
          }
        }
      } catch {
        apiItem = {
          status: 'unknown',
          code: 'API_INSTANCE_CHECK_FAILED',
          message: 'API 实例状态检查失败',
        }
      }
    }

    // 4. 执行 Worker 状态检查
    if (databaseItem.status === 'critical') {
      // 数据库故障导致 Worker 登记不可读时显示「数据库故障；Worker 状态未知」，不得把它再计为独立 Worker 故障
      workerItem = {
        status: 'unknown',
        code: 'DATABASE_UNAVAILABLE',
        message: '数据库故障；Worker 状态未知',
        healthyNodes: 0,
        affectedActiveRuns: 0,
        affectedActiveSessions: 0,
      }
    } else {
      try {
        const workerSummary = await readPlatformWorkerHealthSummary(this.dbHandle, asOf)
        const { healthyNodes, expiredInServiceNodes, affectedActiveRuns, affectedActiveSessions } = workerSummary
        earliestWorkerValidUntil = workerSummary.earliestWorkerValidUntil

        if (healthyNodes === 0) {
          workerItem = {
            status: 'critical',
            code: 'NO_HEALTHY_WORKERS',
            message: '没有健康的执行节点，无法执行场景',
            healthyNodes: 0,
            affectedActiveRuns,
            affectedActiveSessions,
          }
        } else if (expiredInServiceNodes > 0 || affectedActiveRuns > 0 || affectedActiveSessions > 0) {
          const message =
            affectedActiveRuns > 0 || affectedActiveSessions > 0
              ? `失联节点影响 ${affectedActiveRuns} 个活跃运行与 ${affectedActiveSessions} 个活跃会话`
              : `部分执行节点心跳过期，当前有 ${healthyNodes} 个健康节点可用`
          workerItem = {
            status: 'degraded',
            code: 'WORKER_DEGRADED',
            message,
            healthyNodes,
            affectedActiveRuns,
            affectedActiveSessions,
          }
        } else {
          workerItem = {
            status: 'healthy',
            code: 'OK',
            message: `已有 ${healthyNodes} 个健康执行节点在服`,
            healthyNodes,
            affectedActiveRuns: 0,
            affectedActiveSessions: 0,
          }
        }
      } catch {
        workerItem = {
          status: 'unknown',
          code: 'WORKER_CHECK_FAILED',
          message: 'Worker 状态检查失败',
          healthyNodes: 0,
          affectedActiveRuns: 0,
          affectedActiveSessions: 0,
        }
      }
    }

    // 5. 计算总状态
    let overall: PlatformHealthStatus
    if (databaseItem.status === 'critical' || workerItem.status === 'critical') {
      overall = 'critical'
    } else if (
      workerItem.status === 'degraded' ||
      apiItem.status === 'degraded' ||
      changeHintItem.status === 'degraded'
    ) {
      overall = 'degraded'
    } else if (
      databaseItem.status === 'unknown' ||
      workerItem.status === 'unknown' ||
      apiItem.status === 'unknown'
    ) {
      overall = 'unknown'
    } else {
      overall = 'healthy'
    }

    // 6. 服务端有效期与新鲜度计算
    const maxWindowMs = 30_000
    let validUntilMs = asOf.getTime() + maxWindowMs
    if (earliestApiValidUntil && earliestApiValidUntil.getTime() > asOf.getTime()) {
      validUntilMs = Math.min(validUntilMs, earliestApiValidUntil.getTime())
    }
    if (earliestWorkerValidUntil && earliestWorkerValidUntil.getTime() > asOf.getTime()) {
      validUntilMs = Math.min(validUntilMs, earliestWorkerValidUntil.getTime())
    }
    const validUntil = new Date(validUntilMs)
    const freshForMs = Math.max(0, validUntilMs - asOf.getTime() - 500)

    return platformHealthResponseSchema.parse({
      overall,
      asOf: asOf.toISOString(),
      validUntil: validUntil.toISOString(),
      freshForMs,
      checks: {
        api: apiItem,
        database: databaseItem,
        worker: workerItem,
        changeHint: changeHintItem,
      },
    })
  }
}
