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
import { ArtifactsController, ReportsController } from './reports.controller'
import { ReportsService } from './reports.service'

const reportId = '11111111-1111-4111-8111-111111111111'
const report = {
  id: reportId,
  targetId: '22222222-2222-4222-8222-222222222222',
  subject: { kind: 'RUN', runId: '33333333-3333-4333-8333-333333333333' },
  currentRevision: null,
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
  permissions: ['report:read'],
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
    list: vi.fn(async () => ({ items: [report] })),
    get: vi.fn(async () => report),
    preview: vi.fn(async () => ({
      subject: report.subject,
      stage: 'final',
      scope: 'run',
      title: '报告',
      canGenerateFinal: true,
      evidencePending: false,
      issues: [],
    })),
    create: vi.fn(async () => report),
    revision: vi.fn(async () => ({ report, revision: {}, document: {} })),
    addRevision: vi.fn(async () => report),
    export: vi.fn(async () => ({ id: 'job', status: 'queued', artifactIds: [] })),
    deletePreview: vi.fn(async () => ({ previewToken: reportId, counts: {}, blockers: [] })),
    delete: vi.fn(async () => ({ id: reportId, deleted: true })),
    artifactStream: vi.fn(async () => ({
      chunks: (async function* () { yield Buffer.from([1, 2, 3]) })(),
      byteSize: 3,
      contentType: 'application/pdf',
      fileName: 'gin web脚手架 报告.pdf',
    })),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [ReportsController, ArtifactsController],
    providers: [
      Reflector,
      { provide: ReportsService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('Reports HTTP', () => {
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

  it('只读可看不能导出下载', async () => {
    await request(viewerApp.getHttpServer()).get('/reports').expect(200)
    await request(viewerApp.getHttpServer())
      .post('/reports')
      .send({
        subject: { kind: 'RUN', runId: '33333333-3333-4333-8333-333333333333' },
        idempotencyKey: 'report-01',
      })
      .expect(403)
    await request(viewerApp.getHttpServer()).get('/artifacts/44444444-4444-4444-8444-444444444444/content').expect(403)
    expect(service.artifactStream).not.toHaveBeenCalled()
  })

  it('有 export 权可创建并下载', async () => {
    await request(adminApp.getHttpServer())
      .post('/reports')
      .send({
        subject: { kind: 'RUN', runId: '33333333-3333-4333-8333-333333333333' },
        idempotencyKey: 'report-01',
      })
      .expect(200)
    const downloaded = await request(adminApp.getHttpServer())
      .get('/artifacts/44444444-4444-4444-8444-444444444444/content')
      .expect(200)
    expect(downloaded.headers['content-type']).toMatch(/pdf/)
    expect(downloaded.headers['content-disposition']).toMatch(/filename\*=UTF-8''/)
    expect(service.artifactStream).toHaveBeenCalled()
  })
})
