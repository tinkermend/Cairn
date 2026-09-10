import { Controller, Get, INestApplication, NotFoundException } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apiErrorSchema, REQUEST_ID_HEADER } from '@cairn/shared'
import { AuthService } from '../auth/auth.service'
import { AllExceptionsFilter } from './all-exceptions.filter'
import { AuthGuard } from './auth.guard'
import { Public } from './public.decorator'
import { RequestIdMiddleware } from './request-id.middleware'

@Controller('probe')
class ProbeController {
  @Public()
  @Get('open')
  open(): { ok: boolean } {
    return { ok: true }
  }

  @Get('guarded')
  guarded(): { ok: boolean } {
    return { ok: true }
  }

  @Public()
  @Get('missing')
  missing(): never {
    throw new NotFoundException('工作流不存在')
  }

  @Public()
  @Get('boom')
  boom(): never {
    throw new Error('内部细节：connection string postgres://user:pass@host')
  }
}

describe('HTTP 契约（Guard / 异常过滤器 / requestId）', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        Reflector,
        { provide: JwtService, useValue: { verifyAsync: async () => ({}) } },
        { provide: AuthService, useValue: { resolveAccount: async () => null } },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile()

    app = moduleRef.createNestApplication({ logger: false })
    app.use(new RequestIdMiddleware().use.bind(new RequestIdMiddleware()))
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  it('未标记 @Public 的路由默认拒绝', async () => {
    const res = await request(app.getHttpServer()).get('/probe/guarded').expect(401)
    expect(res.body.code).toBe('UNAUTHENTICATED')
  })

  it('标记 @Public 的路由放行', async () => {
    await request(app.getHttpServer()).get('/probe/open').expect(200, { ok: true })
  })

  it('错误响应符合 @cairn/shared 的契约', async () => {
    const res = await request(app.getHttpServer()).get('/probe/missing').expect(404)
    expect(() => apiErrorSchema.parse(res.body)).not.toThrow()
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', message: '工作流不存在' })
  })

  it('5xx 不泄露内部细节', async () => {
    const res = await request(app.getHttpServer()).get('/probe/boom').expect(500)
    expect(res.body.message).toBe('服务器内部错误')
    expect(JSON.stringify(res.body)).not.toContain('postgres://')
    expect(JSON.stringify(res.body)).not.toContain('connection string')
  })

  it('未带 requestId 时自动生成，并回写响应头', async () => {
    const res = await request(app.getHttpServer()).get('/probe/missing').expect(404)
    expect(res.headers[REQUEST_ID_HEADER]).toBeTruthy()
    expect(res.body.requestId).toBe(res.headers[REQUEST_ID_HEADER])
  })

  it('上游带了 requestId 则沿用，便于跨服务串联', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/missing')
      .set(REQUEST_ID_HEADER, 'run-abc-123')
      .expect(404)
    expect(res.body.requestId).toBe('run-abc-123')
    expect(res.headers[REQUEST_ID_HEADER]).toBe('run-abc-123')
  })
})
