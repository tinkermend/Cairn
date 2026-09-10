import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apiErrorSchema, REQUEST_ID_HEADER } from '@cairn/shared'
import type { DbHandle } from '@cairn/db'
import { AppModule } from './app.module'
import { DB_HANDLE } from './db/db.module'

/**
 * 整应用装配测试。
 *
 * 与 health.spec / http-contract.spec 的区别：那两个用的是只含被测
 * 组件的隔离模块，因而漏掉了「未匹配路由落到 Express 默认处理器」
 * 与「pino 的 genReqId 早于 Nest 中间件执行」这两个缺陷——它们只在
 * 完整装配下才出现。
 */
describe('AppModule 完整装配', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DB_HANDLE)
      .useValue({
        ping: vi.fn(async () => true),
        close: vi.fn(async () => {}),
        db: {} as never,
        pool: {} as never,
      } satisfies DbHandle)
      .compile()

    app = moduleRef.createNestApplication({ logger: false })
    app.setGlobalPrefix('api', { exclude: ['health'] })
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  it('/health 不带 api 前缀，供负载均衡直接探活', async () => {
    await request(app.getHttpServer()).get('/health').expect(200)
    await request(app.getHttpServer()).get('/api/health').expect(404)
  })

  it('未匹配路径返回 JSON 错误契约而非 Express 的 HTML 页面', async () => {
    const res = await request(app.getHttpServer()).get('/api/does-not-exist').expect(404)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(() => apiErrorSchema.parse(res.body)).not.toThrow()
    expect(res.body.code).toBe('NOT_FOUND')
  })

  it('未带 token 的 RBAC 路由默认 401；登录是公开的', async () => {
    const res = await request(app.getHttpServer()).get('/api/rbac/roles').expect(401)
    expect(res.body.code).toBe('UNAUTHENTICATED')
    // 未认证与未匹配路由、校验失败、未处理异常同属必须过契约的四类
    expect(() => apiErrorSchema.parse(res.body)).not.toThrow()
    await request(app.getHttpServer()).get('/api/me').expect(401)
    await request(app.getHttpServer()).get('/api/console/accounts').expect(401)
    await request(app.getHttpServer()).get('/api/console/audit').expect(401)
    await request(app.getHttpServer()).get('/api/targets').expect(401)
    const login = await request(app.getHttpServer()).post('/api/auth/login').send({}).expect(400)
    expect(login.body.code).toBe('BAD_REQUEST')
    expect(() => apiErrorSchema.parse(login.body)).not.toThrow()
    // 校验失败必须逐字段给出原因，否则调用方只能看到「参数不对」
    expect(login.body.issues?.length).toBeGreaterThan(0)
  })

  it('未知路径返回 404 而非 401——路径不存在不该伪装成认证失败', async () => {
    const res = await request(app.getHttpServer()).post('/api/whatever').expect(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  it('每个响应都带 requestId，且与错误体内一致', async () => {
    const res = await request(app.getHttpServer()).get('/api/does-not-exist').expect(404)
    const header = res.headers[REQUEST_ID_HEADER]
    expect(header).toBeTruthy()
    expect(header).not.toBe('undefined')
    expect(res.body.requestId).toBe(header)
  })

  it('上游 requestId 被沿用', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/does-not-exist')
      .set(REQUEST_ID_HEADER, 'run-e2e-9')
      .expect(404)
    expect(res.headers[REQUEST_ID_HEADER]).toBe('run-e2e-9')
    expect(res.body.requestId).toBe('run-e2e-9')
  })

  it('对外头名就是 x-cairn-request-id', async () => {
    const res = await request(app.getHttpServer()).get('/api/does-not-exist').expect(404)
    expect(REQUEST_ID_HEADER).toBe('x-cairn-request-id')
    expect(res.headers['x-cairn-request-id']).toBe(res.body.requestId)
  })

  it('旧头 x-cairn-run-id 不被采纳', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/does-not-exist')
      .set('x-cairn-run-id', 'legacy-run-1')
      .expect(404)
    expect(res.body.requestId).not.toBe('legacy-run-1')
  })

  it('网关的 x-request-id 被采纳为 requestId', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/does-not-exist')
      .set('x-request-id', 'gw-7')
      .expect(404)
    expect(res.body.requestId).toBe('gw-7')
    expect(res.headers['x-cairn-request-id']).toBe('gw-7')
  })
})
