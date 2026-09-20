import { INestApplication, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERMISSIONS } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { listenForSupertest } from '../__tests__/http-app'
import { SuitesController } from './suites.controller'
import { SuitesService } from './suites.service'

const suiteId = '11111111-1111-4111-8111-111111111111'
const suite = {
  id: suiteId,
  targetId: '22222222-2222-4222-8222-222222222222',
  name: '日常巡检',
  description: null,
  status: 'active',
  draft: { revision: 1, document: { schemaVersion: 1, groups: [], members: [] }, updatedAt: '2026-09-19T00:00:00.000Z' },
  published: null,
  deletedAt: null,
  deletedBy: null,
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z',
}

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
  permissions: ['suite:read'],
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
    list: vi.fn(async () => ({ items: [suite] })),
    get: vi.fn(async () => suite),
    versions: vi.fn(async () => ({ items: [] })),
    create: vi.fn(async () => suite),
    saveDraft: vi.fn(async () => suite),
    validate: vi.fn(async () => ({ ok: true, issues: [] })),
    publish: vi.fn(async () => suite),
    enabled: vi.fn(async () => suite),
    deletePreview: vi.fn(async () => ({ previewToken: 't', counts: {}, blockers: [] })),
    delete: vi.fn(async () => ({ id: suiteId, deletedAt: '2026-09-19T00:00:00.000Z' })),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [SuitesController],
    providers: [
      Reflector,
      { provide: SuitesService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('Suites HTTP', () => {
  const service = mockService()
  let adminApp: INestApplication
  let viewerApp: INestApplication

  beforeAll(async () => {
    adminApp = await buildApp(admin, service)
    viewerApp = await buildApp(viewer, service)
  })

  beforeEach(() => vi.clearAllMocks())

  afterAll(async () => {
    await adminApp.close()
    await viewerApp.close()
  })

  it('读取只需 suite:read，编写需要 suite:write', async () => {
    await request(viewerApp.getHttpServer()).get('/suites').expect(200)
    expect(service.list).toHaveBeenCalled()
    await request(viewerApp.getHttpServer())
      .post('/suites')
      .send({ targetId: suite.targetId, name: '新集合' })
      .expect(403)
    expect(service.create).not.toHaveBeenCalled()
    await request(adminApp.getHttpServer())
      .post('/suites')
      .send({ targetId: suite.targetId, name: '新集合' })
      .expect(200)
    expect(service.create).toHaveBeenCalled()
  })
})
