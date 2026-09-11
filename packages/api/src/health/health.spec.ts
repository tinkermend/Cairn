import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { healthResponseSchema } from '@cairn/shared'
import type { DbHandle } from '@cairn/db'
import { DB_HANDLE } from '../db/db.module'
import { HealthController } from './health.controller'
import { HealthService } from './health.service'
import { listenForSupertest } from '../__tests__/http-app'

function stubDb(ping: () => Promise<boolean>): DbHandle {
  return { ping, close: async () => {}, db: {} as never, pool: {} as never }
}

async function buildApp(handle: DbHandle): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [HealthService, { provide: DB_HANDLE, useValue: handle }],
  }).compile()
  const app = moduleRef.createNestApplication()
  await listenForSupertest(app)
  return app
}

describe('GET /health', () => {
  let healthy: INestApplication
  let broken: INestApplication

  beforeAll(async () => {
    healthy = await buildApp(stubDb(async () => true))
    broken = await buildApp(stubDb(async () => { throw new Error('connection refused') }))
  })

  afterAll(async () => {
    await healthy?.close()
    await broken?.close()
  })

  it('数据库可用时返回 ok', async () => {
    const res = await request(healthy.getHttpServer()).get('/health').expect(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.checks.database).toBe('up')
    expect(res.body.service).toBe('cairn-api')
  })

  it('响应符合 @cairn/shared 的契约', async () => {
    const res = await request(healthy.getHttpServer()).get('/health').expect(200)
    // 用与 web 端完全相同的 schema 对象解析——这是前后端契约的最小证明
    expect(() => healthResponseSchema.parse(res.body)).not.toThrow()
  })

  it('数据库不可用时降级为 degraded 而非 500', async () => {
    const res = await request(broken.getHttpServer()).get('/health').expect(200)
    expect(res.body.status).toBe('degraded')
    expect(res.body.checks.database).toBe('down')
    expect(() => healthResponseSchema.parse(res.body)).not.toThrow()
  })

  it('uptime 随时间单调不减', async () => {
    const a = await request(healthy.getHttpServer()).get('/health').expect(200)
    const b = await request(healthy.getHttpServer()).get('/health').expect(200)
    expect(b.body.uptimeSeconds).toBeGreaterThanOrEqual(a.body.uptimeSeconds)
  })
})
