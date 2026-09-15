import { INestApplication, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PERMISSIONS } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { listenForSupertest } from '../__tests__/http-app'
import { AuthoringController } from './authoring.controller'
import { AuthoringService } from './authoring.service'

const admin: RequestAccount = {
  id: 'acc-admin',
  displayName: 'Admin',
  email: 'admin@example.com',
  status: 'active',
  roles: [{ id: 'admin', key: 'admin', name: 'Administrator', kind: 'system' }],
  permissions: [...PERMISSIONS],
}

const viewer: RequestAccount = {
  ...admin,
  id: 'acc-viewer',
  permissions: ['workflow:read', 'target:read'],
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
    normalizeObservation: vi.fn(async () => ({
      outcome: 'FOUND',
      target: { framePath: [], candidates: [{ by: 'label', value: '查询' }] },
      page: { url: 'https://shop.example.com/orders' },
      diagnostics: { outcome: 'FOUND', candidatesTried: [] },
      source: 'extension',
    })),
  }
}

async function buildApp(account: RequestAccount, service = mockService()) {
  const moduleRef = await Test.createTestingModule({
    controllers: [AuthoringController],
    providers: [
      Reflector,
      { provide: AuthoringService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  return listenForSupertest(moduleRef.createNestApplication({ logger: false }))
}

describe('编写观察 HTTP', () => {
  let adminApp: INestApplication
  let viewerApp: INestApplication
  const service = mockService()

  beforeAll(async () => {
    adminApp = await buildApp(admin, service)
    viewerApp = await buildApp(viewer, service)
  })

  afterAll(async () => {
    await adminApp.close()
    await viewerApp.close()
  })

  it('viewer 不能提交插件观察', async () => {
    await request(viewerApp.getHttpServer())
      .post('/authoring/observations')
      .send({
        targetId: '11111111-1111-4111-8111-111111111111',
        url: 'https://shop.example.com/orders',
      })
      .expect(403)
    expect(service.normalizeObservation).not.toHaveBeenCalled()
  })

  it('编写者可以提交并得到规范化观察', async () => {
    const res = await request(adminApp.getHttpServer())
      .post('/authoring/observations')
      .send({
        targetId: '11111111-1111-4111-8111-111111111111',
        url: 'https://shop.example.com/orders',
        target: { framePath: [], candidates: [{ by: 'label', value: '查询' }] },
      })
      .expect(200)
    expect(res.body.outcome).toBe('FOUND')
    expect(res.body.source).toBe('extension')
    expect(service.normalizeObservation).toHaveBeenCalled()
  })
})
