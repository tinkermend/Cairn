import {
  ConflictException,
  INestApplication,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FACTORY_PLATFORM_CONFIG, PERMISSIONS } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { listenForSupertest } from '../__tests__/http-app'
import { PlatformConfigController } from './platform-config.controller'
import { PlatformConfigService } from './platform-config.service'

const now = '2026-09-13T00:00:00.000Z'
const current = {
  revision: 1,
  document: FACTORY_PLATFORM_CONFIG,
  updatedAt: now,
  updatedByAccountId: 'acc-admin',
  reason: '初始化',
  source: 'bootstrap' as const,
}

const admin: RequestAccount = {
  id: 'acc-admin',
  displayName: 'Admin',
  email: 'admin@example.com',
  status: 'active',
  roles: [{ id: 'admin', key: 'admin', name: '管理员', kind: 'system' }],
  permissions: [...PERMISSIONS],
}

const settingsReader: RequestAccount = {
  ...admin,
  id: 'acc-settings',
  permissions: ['settings:read', 'settings:write'],
}

class StaticAuthGuard implements CanActivate {
  constructor(private readonly account: RequestAccount | null) {}
  canActivate(context: ExecutionContext): boolean {
    if (!this.account) throw new UnauthorizedException('未认证')
    context.switchToHttp().getRequest().account = this.account
    return true
  }
}

function mockService() {
  return {
    get: vi.fn(async () => current),
    validate: vi.fn((document) => ({ document })),
    update: vi.fn(async () => ({ ...current, revision: 2 })),
    restore: vi.fn(async () => ({ ...current, revision: 3, source: 'restore' })),
    revisions: vi.fn(async () => ({ items: [], nextCursor: undefined })),
    registerSecret: vi.fn(async () => ({
      secretRef: { provider: 'local', secretId: '00000000-0000-4000-8000-000000000099' },
    })),
    testConnection: vi.fn(async () => ({ ok: true, message: '已连通模型服务' })),
  }
}

async function buildApp(account: RequestAccount, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [PlatformConfigController],
    providers: [
      Reflector,
      { provide: PlatformConfigService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('PlatformConfig HTTP', () => {
  const service = mockService()
  let adminApp: INestApplication
  let settingsApp: INestApplication

  beforeAll(async () => {
    adminApp = await buildApp(admin, service)
    settingsApp = await buildApp(settingsReader, service)
  })

  beforeEach(() => vi.clearAllMocks())

  afterAll(async () => {
    await adminApp.close()
    await settingsApp.close()
  })

  it('管理员能读取完整配置', async () => {
    const res = await request(adminApp.getHttpServer()).get('/platform-config').expect(200)
    expect(res.body.revision).toBe(1)
    expect(res.body.document.browserAi).toBeDefined()
    expect(JSON.stringify(res.body)).not.toMatch(/sk-|apiKey/)
  })

  it('仅有 settings:read 不能读完整平台配置', async () => {
    await request(settingsApp.getHttpServer()).get('/platform-config').expect(403)
    await request(settingsApp.getHttpServer())
      .post('/platform-config/update')
      .send({ expectedRevision: 1, reason: '改', document: FACTORY_PLATFORM_CONFIG })
      .expect(403)
    expect(service.get).not.toHaveBeenCalled()
    expect(service.update).not.toHaveBeenCalled()
  })

  it('写接口需要 platform-config:write', async () => {
    await request(adminApp.getHttpServer())
      .post('/platform-config/update')
      .send({ expectedRevision: 1, reason: '调整超时', document: FACTORY_PLATFORM_CONFIG })
      .expect(200)
    expect(service.update).toHaveBeenCalled()
  })

  it('保存冲突返回 409 且带上当前修订', async () => {
    service.update.mockRejectedValueOnce(
      new ConflictException({
        code: 'PLATFORM_CONFIG_CONFLICT',
        message: '平台配置已被他人更新',
        details: { ...current, revision: 2 },
      }),
    )
    const res = await request(adminApp.getHttpServer())
      .post('/platform-config/update')
      .send({ expectedRevision: 1, reason: '过期修订', document: FACTORY_PLATFORM_CONFIG })
      .expect(409)
    expect(res.body.code).toBe('PLATFORM_CONFIG_CONFLICT')
    expect(res.body.details).toMatchObject({ revision: 2 })
    expect(JSON.stringify(res.body)).not.toMatch(/sk-|apiKey/)
  })
})
