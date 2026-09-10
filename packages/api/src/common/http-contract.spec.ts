import {
  ConflictException,
  Controller,
  Get,
  INestApplication,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common'
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

  @Public()
  @Get('domain-code')
  domainCode(): never {
    throw new ConflictException({
      code: 'SCENARIO_NOT_BOUND',
      message: '工作流未绑定 Target',
    })
  }

  @Public()
  @Get('boom-with-code')
  boomWithCode(): never {
    throw new InternalServerErrorException({
      code: 'LEASE_CONFLICT',
      message: '内部细节：lease table cairn.session_lease 冲突',
    })
  }

  @Public()
  @Get('empty-code')
  emptyCode(): never {
    throw new ConflictException({ code: '', message: '空 code 应回落状态码映射' })
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

  it('handler 给出的领域 code 被透传', async () => {
    const res = await request(app.getHttpServer()).get('/probe/domain-code').expect(409)
    expect(() => apiErrorSchema.parse(res.body)).not.toThrow()
    expect(res.body).toMatchObject({ code: 'SCENARIO_NOT_BOUND', message: '工作流未绑定 Target' })
  })

  it('空 code 回落状态码映射，不产生非法错误体', async () => {
    const res = await request(app.getHttpServer()).get('/probe/empty-code').expect(409)
    expect(res.body.code).toBe('CONFLICT')
  })

  it('5xx 的领域 code 被强制覆盖为 INTERNAL_ERROR', async () => {
    const res = await request(app.getHttpServer()).get('/probe/boom-with-code').expect(500)
    expect(res.body.code).toBe('INTERNAL_ERROR')
    expect(JSON.stringify(res.body)).not.toContain('session_lease')
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

  it('响应头是平台私有头名本身，不是某个常量恰好拼出的字符串', async () => {
    const res = await request(app.getHttpServer()).get('/probe/missing').expect(404)
    expect(REQUEST_ID_HEADER).toBe('x-cairn-request-id')
    expect(res.headers['x-cairn-request-id']).toBeTruthy()
  })

  it('上游带了 requestId 则沿用，便于跨服务串联', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/missing')
      .set(REQUEST_ID_HEADER, 'run-abc-123')
      .expect(404)
    expect(res.body.requestId).toBe('run-abc-123')
    expect(res.headers[REQUEST_ID_HEADER]).toBe('run-abc-123')
  })

  it('网关的 x-request-id 同样被沿用', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/missing')
      .set('x-request-id', 'gw-9')
      .expect(404)
    expect(res.body.requestId).toBe('gw-9')
  })

  it('旧头 x-cairn-run-id 不再被采纳，服务端另发新 ID', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/missing')
      .set('x-cairn-run-id', 'legacy-run-1')
      .expect(404)
    expect(res.body.requestId).not.toBe('legacy-run-1')
    expect(res.body.requestId).toBe(res.headers[REQUEST_ID_HEADER])
  })
})
