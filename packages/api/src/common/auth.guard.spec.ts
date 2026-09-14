import { Controller, Get, NotFoundException, ServiceUnavailableException, type INestApplication } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { listenForSupertest } from '../__tests__/http-app'
import { AuthService } from '../auth/auth.service'
import { AllExceptionsFilter } from './all-exceptions.filter'
import { AuthGuard } from './auth.guard'

@Controller('protected')
class ProtectedController {
  @Get()
  get() {
    return { ok: true }
  }
}

describe('AuthGuard 会话与服务故障隔离', () => {
  let app: INestApplication
  let token: string
  const auth = { resolveAccount: vi.fn().mockResolvedValue({ id: 'acc-1', status: 'active' }) }

  async function createApp() {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'auth-guard-test-secret', signOptions: { expiresIn: '12h' } })],
      controllers: [ProtectedController],
      providers: [
        Reflector,
        { provide: AuthService, useValue: auth },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile()
    return listenForSupertest(moduleRef.createNestApplication({ logger: false }))
  }

  beforeAll(async () => {
    app = await createApp()
    token = await app.get(JwtService).signAsync({ sub: 'acc-1' })
  })

  afterAll(async () => {
    await app?.close()
  })

  it('同一 JWT 在 API 实例重建前后都有效', async () => {
    await request(app.getHttpServer()).get('/protected').auth(token, { type: 'bearer' }).expect(200)
    await app.close()
    app = await createApp()
    await request(app.getHttpServer()).get('/protected').auth(token, { type: 'bearer' }).expect(200)
  })

  it.each([
    [new Error('database connection unavailable'), 500, 'INTERNAL_ERROR'],
    [new ServiceUnavailableException(), 503, 'SERVICE_UNAVAILABLE'],
  ] as const)('账号查询失败 %s 返回 %i，恢复后同一凭证继续有效', async (error, status, code) => {
    auth.resolveAccount.mockRejectedValueOnce(error)
    const res = await request(app.getHttpServer()).get('/protected').auth(token, { type: 'bearer' }).expect(status)
    expect(res.body).toMatchObject({ code, message: '服务器内部错误' })
    await request(app.getHttpServer()).get('/protected').auth(token, { type: 'bearer' }).expect(200)
  })

  it('账号确实不存在才返回 401', async () => {
    auth.resolveAccount.mockRejectedValueOnce(new NotFoundException('账号不存在'))
    await request(app.getHttpServer()).get('/protected').auth(token, { type: 'bearer' }).expect(401)
  })

  it('缺失、无效和过期凭证仍拒绝，且不查询账号', async () => {
    auth.resolveAccount.mockClear()
    const expired = await app.get(JwtService).signAsync({ sub: 'acc-1' }, { expiresIn: -1 })
    await request(app.getHttpServer()).get('/protected').expect(401)
    await request(app.getHttpServer()).get('/protected').auth('invalid', { type: 'bearer' }).expect(401)
    await request(app.getHttpServer()).get('/protected').auth(expired, { type: 'bearer' }).expect(401)
    expect(auth.resolveAccount).not.toHaveBeenCalled()
  })
})
