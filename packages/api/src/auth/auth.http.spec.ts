import { INestApplication } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PERMISSIONS, loginResponseSchema } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import { AuthGuard } from '../common/auth.guard'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { listenForSupertest } from '../__tests__/http-app'

const now = '2026-01-01T00:00:00.000Z'
const account = {
  id: 'acc-admin',
  displayName: 'Admin',
  email: 'admin',
  status: 'active' as const,
  roles: [{ id: 'admin', key: 'admin', name: 'Administrator', kind: 'system' as const }],
  permissions: [...PERMISSIONS],
  createdAt: now,
  updatedAt: now,
}

describe('POST /auth/login', () => {
  let app: INestApplication
  const auth = {
    login: vi.fn(),
    resolveAccount: vi.fn(),
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        Reflector,
        { provide: AuthService, useValue: auth },
        { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: account.id }) } },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    await listenForSupertest(app)
  })

  afterAll(async () => {
    await app?.close()
  })

  it('公开接口：合法 body 返回 token 与账号', async () => {
    auth.login.mockResolvedValueOnce({
      accessToken: 'jwt-token',
      tokenType: 'Bearer',
      expiresIn: 43200,
      account,
    })
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'admin', password: 'cairn-admin' })
      .expect(200)
    expect(() => loginResponseSchema.parse(res.body)).not.toThrow()
    expect(auth.login).toHaveBeenCalledWith(
      'admin',
      'cairn-admin',
      expect.objectContaining({ kind: 'web' }),
    )
  })

  it('缺字段 400', async () => {
    await request(app.getHttpServer()).post('/auth/login').send({ email: 'a@b.com' }).expect(400)
  })
})
