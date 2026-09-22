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
import { DatasetsController } from './datasets.controller'
import { DatasetsService } from './datasets.service'

const datasetId = '11111111-1111-4111-8111-111111111111'
const dataset = {
  id: datasetId,
  name: '测试商品数据集',
  targetId: '22222222-2222-4222-8222-222222222222',
  sourceType: 'excel',
  sourceFilename: 'products.xlsx',
  rowCount: 10,
  columns: [{ name: '商品名', key: 'name', type: 'string', sampleValues: ['手机'] }],
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
  permissions: ['dataset:read'],
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
    list: vi.fn(async () => ({ items: [dataset] })),
    get: vi.fn(async () => dataset),
    getRows: vi.fn(async () => ({ items: [], total: 0 })),
    create: vi.fn(async () => dataset),
    autoMap: vi.fn(async () => ({ binding: {} })),
    preflight: vi.fn(async () => ({ totalRows: 0, validCount: 0, warningCount: 0, errorCount: 0, issues: [] })),
    delete: vi.fn(async () => undefined),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [DatasetsController],
    providers: [
      Reflector,
      { provide: DatasetsService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('Datasets HTTP', () => {
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

  it('读取只需 dataset:read，创建需 dataset:write', async () => {
    await request(viewerApp.getHttpServer()).get('/datasets').expect(200)
    expect(service.list).toHaveBeenCalled()

    const body = {
      name: '测试数据',
      targetId: '22222222-2222-4222-8222-222222222222',
      sourceType: 'excel',
      sourceFilename: 'data.xlsx',
      columns: [{ name: '商品名', key: 'title', type: 'string', sampleValues: [] }],
      rows: [{ title: '测试1' }],
    }

    await request(viewerApp.getHttpServer())
      .post('/datasets')
      .send(body)
      .expect(403)
    expect(service.create).not.toHaveBeenCalled()

    await request(adminApp.getHttpServer())
      .post('/datasets')
      .send({ ...body, targetId: undefined })
      .expect(400)
    expect(service.create).not.toHaveBeenCalled()

    await request(adminApp.getHttpServer())
      .post('/datasets')
      .send(body)
      .expect(200)
    expect(service.create).toHaveBeenCalled()
  })

  it('预检与自动映射接口正常响应', async () => {
    await request(viewerApp.getHttpServer())
      .post(`/datasets/${datasetId}/auto-map`)
      .send({ scenarioInputs: [] })
      .expect(200)
    expect(service.autoMap).toHaveBeenCalled()

    await request(viewerApp.getHttpServer())
      .post(`/datasets/${datasetId}/preflight`)
      .send({ scenarioInputs: [], binding: {} })
      .expect(200)
    expect(service.preflight).toHaveBeenCalled()
  })
})
