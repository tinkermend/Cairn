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
import { SuiteRunsController } from './suite-runs.controller'
import { SuiteRunsService } from './suite-runs.service'

const suiteRunId = '11111111-1111-4111-8111-111111111111'
const observation = {
  id: suiteRunId,
  suiteId: '22222222-2222-4222-8222-222222222222',
  suiteVersionId: '33333333-3333-4333-8333-333333333333',
  targetId: '44444444-4444-4444-8444-444444444444',
  status: 'RUNNING',
  verdict: null,
  counts: { planned: 1, succeeded: 0, failed: 0, cancelled: 0, skipped: 0, pending: 0, active: 1 },
  createdAt: '2026-09-19T00:00:00.000Z',
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
    list: vi.fn(async () => ({ items: [observation], nextCursor: undefined })),
    preview: vi.fn(async () => ({ members: [], issues: [] })),
    create: vi.fn(async () => ({ observation, created: true })),
    observation: vi.fn(async () => observation),
    cancel: vi.fn(async () => observation),
    stream: vi.fn(),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [SuiteRunsController],
    providers: [
      Reflector,
      { provide: SuiteRunsService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('SuiteRuns HTTP', () => {
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

  it('列表和观察只需 suite:read，启动需要 run:execute', async () => {
    await request(viewerApp.getHttpServer()).get('/suite-runs').expect(200)
    expect(service.list).toHaveBeenCalled()
    await request(viewerApp.getHttpServer()).get(`/suite-runs/${suiteRunId}/observation`).expect(200)
    await request(viewerApp.getHttpServer())
      .post('/suite-runs')
      .send({ suiteId: observation.suiteId, idempotencyKey: 'suite-run-01' })
      .expect(403)
    expect(service.create).not.toHaveBeenCalled()
    await request(adminApp.getHttpServer())
      .post('/suite-runs')
      .send({ suiteId: observation.suiteId, idempotencyKey: 'suite-run-01' })
      .expect(200)
    expect(service.create).toHaveBeenCalled()
  })
})
