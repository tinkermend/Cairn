import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { platformHealthResponseSchema } from '@cairn/shared'
import * as dbModule from '@cairn/db'
import type { DbHandle } from '@cairn/db'
import { DB_HANDLE } from '../db/db.module'
import { CHANGE_HINT } from '../observe/change-hint.module'
import { HealthService } from '../health/health.service'
import { PlatformHealthController } from './platform-health.controller'
import { PlatformHealthService } from './platform-health.service'
import { listenForSupertest, unusedChangeHint } from '../__tests__/http-app'

function stubDb(ping: () => Promise<boolean>): DbHandle {
  return { ping, close: async () => {}, driver: 'postgres', poolStats: () => null }
}

async function buildApp(
  handle: DbHandle,
  hint = unusedChangeHint,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [PlatformHealthController],
    providers: [
      PlatformHealthService,
      HealthService,
      { provide: DB_HANDLE, useValue: handle },
      { provide: CHANGE_HINT, useValue: hint },
    ],
  }).compile()
  const app = moduleRef.createNestApplication()
  await listenForSupertest(app)
  return app
}

describe('GET /platform-health', () => {
  let app: INestApplication

  beforeAll(async () => {
    app = await buildApp(stubDb(async () => true))
  })

  beforeEach(() => {
    vi.spyOn(dbModule, 'readMonitorClock').mockImplementation(async () => new Date())
    vi.spyOn(dbModule, 'readPlatformApiHealthSummary').mockResolvedValue({
      recentlyLostInstances: 0,
      earliestApiValidUntil: null,
    })
  })

  afterAll(async () => {
    await app?.close()
  })

  it('全绿：数据库可用且有健康执行 Worker 时返回 healthy', async () => {
    vi.spyOn(dbModule, 'readPlatformWorkerHealthSummary').mockResolvedValueOnce({
      asOf: new Date(),
      healthyNodes: 2,
      expiredInServiceNodes: 0,
      affectedActiveRuns: 0,
      affectedActiveSessions: 0,
      earliestWorkerValidUntil: new Date(Date.now() + 20_000),
    })

    const res = await request(app.getHttpServer()).get('/platform-health').expect(200)
    expect(() => platformHealthResponseSchema.parse(res.body)).not.toThrow()
    expect(res.body.overall).toBe('healthy')
    expect(res.body.checks.database.status).toBe('healthy')
    expect(res.body.checks.worker.status).toBe('healthy')
    expect(res.body.checks.worker.healthyNodes).toBe(2)
  })

  it('最近失联的 API 实例使平台降级；过期的 API 心跳缩短快照有效期', async () => {
    const apiValidUntil = new Date(Date.now() + 4_000)
    vi.spyOn(dbModule, 'readPlatformApiHealthSummary').mockResolvedValueOnce({
      recentlyLostInstances: 2,
      earliestApiValidUntil: apiValidUntil,
    })
    vi.spyOn(dbModule, 'readPlatformWorkerHealthSummary').mockResolvedValueOnce({
      asOf: new Date(),
      healthyNodes: 2,
      expiredInServiceNodes: 0,
      affectedActiveRuns: 0,
      affectedActiveSessions: 0,
      earliestWorkerValidUntil: new Date(Date.now() + 20_000),
    })

    const res = await request(app.getHttpServer()).get('/platform-health').expect(200)
    expect(res.body.overall).toBe('degraded')
    expect(res.body.checks.api).toMatchObject({
      status: 'degraded',
      code: 'PARTIAL_API_LOST',
    })
    expect(res.body.checks.api.message).toContain('2 个离线')
    expect(Date.parse(res.body.validUntil)).toBe(apiValidUntil.getTime())
  })

  it('用数据库时钟判定心跳并计算响应时间，避免 API 主机时钟偏移', async () => {
    const databaseAsOf = new Date(Date.now() + 120_000)
    vi.spyOn(dbModule, 'readMonitorClock').mockResolvedValueOnce(databaseAsOf)
    const apiSummary = vi.spyOn(dbModule, 'readPlatformApiHealthSummary').mockResolvedValueOnce({
      recentlyLostInstances: 0,
      earliestApiValidUntil: new Date(databaseAsOf.getTime() + 4_000),
    })
    const workerSummary = vi.spyOn(dbModule, 'readPlatformWorkerHealthSummary').mockResolvedValueOnce({
      asOf: databaseAsOf,
      healthyNodes: 1,
      expiredInServiceNodes: 0,
      affectedActiveRuns: 0,
      affectedActiveSessions: 0,
      earliestWorkerValidUntil: new Date(databaseAsOf.getTime() + 20_000),
    })

    const res = await request(app.getHttpServer()).get('/platform-health').expect(200)
    expect(res.body.asOf).toBe(databaseAsOf.toISOString())
    expect(res.body.validUntil).toBe(new Date(databaseAsOf.getTime() + 4_000).toISOString())
    expect(apiSummary).toHaveBeenCalledWith(expect.anything(), databaseAsOf)
    expect(workerSummary).toHaveBeenCalledWith(expect.anything(), databaseAsOf)
  })

  it('数据库 ping 成功但时钟查询失败时不继续用本机时间宣称全绿', async () => {
    vi.spyOn(dbModule, 'readMonitorClock').mockRejectedValueOnce(new Error('clock query failed'))
    const res = await request(app.getHttpServer()).get('/platform-health').expect(200)
    expect(res.body.overall).toBe('critical')
    expect(res.body.checks.database).toMatchObject({ status: 'critical', code: 'DATABASE_CHECK_FAILED' })
    expect(res.body.checks.worker.status).toBe('unknown')
  })

  it('状态即将到期时 freshForMs 不得长于 validUntil', async () => {
    vi.spyOn(dbModule, 'readPlatformApiHealthSummary').mockResolvedValueOnce({
      recentlyLostInstances: 0,
      earliestApiValidUntil: new Date(Date.now() + 350),
    })
    vi.spyOn(dbModule, 'readPlatformWorkerHealthSummary').mockResolvedValueOnce({
      asOf: new Date(),
      healthyNodes: 1,
      expiredInServiceNodes: 0,
      affectedActiveRuns: 0,
      affectedActiveSessions: 0,
      earliestWorkerValidUntil: new Date(Date.now() + 20_000),
    })

    const res = await request(app.getHttpServer()).get('/platform-health').expect(200)
    const validForMs = Date.parse(res.body.validUntil) - Date.parse(res.body.asOf)
    expect(validForMs).toBeGreaterThan(0)
    expect(res.body.freshForMs).toBeLessThanOrEqual(validForMs)
  })

  it('API 实例登记不可检查时返回未知，不报告全绿', async () => {
    vi.spyOn(dbModule, 'readPlatformApiHealthSummary').mockRejectedValueOnce(new Error('registry unavailable'))
    vi.spyOn(dbModule, 'readPlatformWorkerHealthSummary').mockResolvedValueOnce({
      asOf: new Date(),
      healthyNodes: 2,
      expiredInServiceNodes: 0,
      affectedActiveRuns: 0,
      affectedActiveSessions: 0,
      earliestWorkerValidUntil: new Date(Date.now() + 20_000),
    })

    const res = await request(app.getHttpServer()).get('/platform-health').expect(200)
    expect(res.body.overall).toBe('unknown')
    expect(res.body.checks.api).toMatchObject({
      status: 'unknown',
      code: 'API_INSTANCE_CHECK_FAILED',
    })
  })

  it('单项故障即红：数据库宕机时总体为 critical，Worker 状态未知且不被重复计为独立故障', async () => {
    const downApp = await buildApp(stubDb(async () => false))
    try {
      const res = await request(downApp.getHttpServer()).get('/platform-health').expect(200)
      expect(() => platformHealthResponseSchema.parse(res.body)).not.toThrow()
      expect(res.body.overall).toBe('critical')
      expect(res.body.checks.database.status).toBe('critical')
      expect(res.body.checks.database.code).toBe('DATABASE_DOWN')
      expect(res.body.checks.worker.status).toBe('unknown')
      expect(res.body.checks.worker.message).toContain('数据库故障；Worker 状态未知')
    } finally {
      await downApp.close()
    }
  })

  it('单项故障即红：没有健康执行 Worker 时总体为 critical', async () => {
    vi.spyOn(dbModule, 'readPlatformWorkerHealthSummary').mockResolvedValueOnce({
      asOf: new Date(),
      healthyNodes: 0,
      expiredInServiceNodes: 0,
      affectedActiveRuns: 0,
      affectedActiveSessions: 0,
      earliestWorkerValidUntil: null,
    })

    const res = await request(app.getHttpServer()).get('/platform-health').expect(200)
    expect(res.body.overall).toBe('critical')
    expect(res.body.checks.worker.status).toBe('critical')
    expect(res.body.checks.worker.code).toBe('NO_HEALTHY_WORKERS')
  })

  it('在服 Worker 心跳过期时为 degraded（黄）', async () => {
    vi.spyOn(dbModule, 'readPlatformWorkerHealthSummary').mockResolvedValueOnce({
      asOf: new Date(),
      healthyNodes: 1,
      expiredInServiceNodes: 1,
      affectedActiveRuns: 0,
      affectedActiveSessions: 0,
      earliestWorkerValidUntil: new Date(Date.now() + 20_000),
    })

    const res = await request(app.getHttpServer()).get('/platform-health').expect(200)
    expect(res.body.overall).toBe('degraded')
    expect(res.body.checks.worker.status).toBe('degraded')
    expect(res.body.checks.worker.code).toBe('WORKER_DEGRADED')
    expect(res.body.checks.worker.message).toContain('部分执行节点心跳过期')
  })

  it('失联节点影响活跃运行或会话时说明具体影响并报 degraded', async () => {
    vi.spyOn(dbModule, 'readPlatformWorkerHealthSummary').mockResolvedValueOnce({
      asOf: new Date(),
      healthyNodes: 1,
      expiredInServiceNodes: 0,
      affectedActiveRuns: 2,
      affectedActiveSessions: 1,
      earliestWorkerValidUntil: new Date(Date.now() + 20_000),
    })

    const res = await request(app.getHttpServer()).get('/platform-health').expect(200)
    expect(res.body.overall).toBe('degraded')
    expect(res.body.checks.worker.status).toBe('degraded')
    expect(res.body.checks.worker.message).toContain('失联节点影响 2 个活跃运行与 1 个活跃会话')
    expect(res.body.checks.worker.affectedActiveRuns).toBe(2)
    expect(res.body.checks.worker.affectedActiveSessions).toBe(1)
  })

  it('变更提示链路异常时单列并报 degraded', async () => {
    vi.spyOn(dbModule, 'readPlatformWorkerHealthSummary').mockResolvedValueOnce({
      asOf: new Date(),
      healthyNodes: 2,
      expiredInServiceNodes: 0,
      affectedActiveRuns: 0,
      affectedActiveSessions: 0,
      earliestWorkerValidUntil: new Date(Date.now() + 20_000),
    })

    const degradedHintApp = await buildApp(stubDb(async () => true), {
      realtime: true,
      ping: async () => false,
      publish: async () => {},
      subscribe: async () => () => {},
    })

    try {
      const res = await request(degradedHintApp.getHttpServer()).get('/platform-health').expect(200)
      expect(res.body.overall).toBe('degraded')
      expect(res.body.checks.changeHint.status).toBe('degraded')
    } finally {
      await degradedHintApp.close()
    }
  })
})
