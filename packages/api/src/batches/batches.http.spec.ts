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
import { BatchesController } from './batches.controller'
import { BatchesService } from './batches.service'

const batchId = '11111111-1111-4111-8111-111111111111'
const batch = {
  id: batchId,
  name: '测试批次',
  scenarioId: '22222222-2222-4222-8222-222222222222',
  scenarioVersionId: '33333333-3333-4333-8333-333333333333',
  datasetId: '44444444-4444-4444-8444-444444444444',
  status: 'QUEUED',
  failurePolicy: 'stop_on_threshold',
  failureThreshold: 5,
  pacingConfig: { minDelayMs: 1500, maxDelayMs: 3500 },
  totalItems: 10,
  successItems: 0,
  failedItems: 0,
  reviewItems: 0,
  pausedReason: null,
  createdByAccountId: 'acc-admin',
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
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
  permissions: ['batch:read'],
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
    list: vi.fn(async () => ({ items: [batch] })),
    get: vi.fn(async () => batch),
    getItems: vi.fn(async () => ({ items: [], total: 0 })),
    create: vi.fn(async () => batch),
    pause: vi.fn(async () => ({ ...batch, status: 'PAUSED' })),
    resume: vi.fn(async () => ({ ...batch, status: 'RUNNING' })),
    cancel: vi.fn(async () => ({ ...batch, status: 'CANCELLED' })),
    retryFailed: vi.fn(async () => ({ ...batch, id: '55555555-5555-4555-8555-555555555555' })),
    export: vi.fn(async () => ({ filename: 'batch-export.xlsx', base64: 'ZmFrZQ==', rowCount: 10 })),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [BatchesController],
    providers: [
      Reflector,
      { provide: BatchesService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('Batches HTTP', () => {
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

  it('读取只需 batch:read，创建需 batch:write，控制需 batch:execute', async () => {
    await request(viewerApp.getHttpServer()).get('/batches').expect(200)
    expect(service.list).toHaveBeenCalled()

    const body = {
      name: '测试批次',
      scenarioId: batch.scenarioId,
      scenarioVersionId: batch.scenarioVersionId,
      datasetId: batch.datasetId,
      binding: {},
    }

    await request(viewerApp.getHttpServer())
      .post('/batches')
      .send(body)
      .expect(403)
    expect(service.create).not.toHaveBeenCalled()

    await request(adminApp.getHttpServer())
      .post('/batches')
      .send(body)
      .expect(200)
    expect(service.create).toHaveBeenCalled()

    // pause requires batch:execute
    await request(viewerApp.getHttpServer())
      .post(`/batches/${batchId}/pause`)
      .send({ reason: '手工暂停' })
      .expect(403)
    expect(service.pause).not.toHaveBeenCalled()

    await request(adminApp.getHttpServer())
      .post(`/batches/${batchId}/pause`)
      .send({ reason: '手工暂停' })
      .expect(200)
    expect(service.pause).toHaveBeenCalled()
  })

  it('导出结果报表需 batch:read', async () => {
    await request(viewerApp.getHttpServer())
      .post(`/batches/${batchId}/export`)
      .send()
      .expect(200)
    expect(service.export).toHaveBeenCalled()
  })
})
