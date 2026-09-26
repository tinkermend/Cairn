import { ForbiddenException, INestApplication, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common'
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
import { ScenarioReportDefaultsController } from './report-settings.controller'
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

const developer: RequestAccount = {
  ...admin,
  id: 'acc-developer',
  permissions: ['workflow:read', 'workflow:write', 'report:read'],
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
    previewRevision: vi.fn(async () => ({ title: '修订预览' })),
    previewMember: vi.fn(async () => ({ title: '成员预览' })),
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
    saveDefaults: vi.fn(async (_scenarioId, body, account) => {
      if (body.outputPolicy?.autoGenerateReport && !account.permissions.includes('report:export')) {
        throw new ForbiddenException('开启自动生成报告需要具备报告导出权限 (report:export)')
      }
      return { profileId: null, revision: 1, outputPolicy: body.outputPolicy }
    }),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [ReportsController, ArtifactsController, ScenarioReportDefaultsController],
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
  let developerApp: INestApplication

  beforeAll(async () => {
    adminApp = await buildApp(admin, service)
    viewerApp = await buildApp(viewer, service)
    developerApp = await buildApp(developer, service)
  })

  beforeEach(() => vi.clearAllMocks())

  afterAll(async () => {
    await adminApp.close()
    await viewerApp.close()
    await developerApp.close()
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

  it('配置场景自动报告：无 report:export 权限开启时被 403 拒绝，有权限正常保存', async () => {
    const scenarioId = '55555555-5555-4555-8555-555555555555'
    await request(developerApp.getHttpServer())
      .post(`/scenarios/${scenarioId}/report-defaults`)
      .send({
        profileId: null,
        expectedRevision: 0,
        outputPolicy: { autoGenerateReport: true, memberReportPolicy: 'inherit' },
      })
      .expect(403)

    await request(adminApp.getHttpServer())
      .post(`/scenarios/${scenarioId}/report-defaults`)
      .send({
        profileId: null,
        expectedRevision: 0,
        outputPolicy: { autoGenerateReport: true, memberReportPolicy: 'inherit' },
      })
      .expect(200)
  })

  it('只读权限可预览修订与成员标题，客户端不能指定标题语法版本', async () => {
    const revisionId = '66666666-6666-4666-8666-666666666666'
    await request(viewerApp.getHttpServer()).post(`/reports/${reportId}/revision-preview`)
      .send({ reason: '预览标题', idempotencyKey: 'preview-01', config: { title: '{systemName}' } }).expect(200)
    await request(viewerApp.getHttpServer()).post(`/reports/${reportId}/revisions/${revisionId}/member-preview`)
      .send({ memberId: 'one', idempotencyKey: 'preview-02' }).expect(200)
    expect(service.previewRevision).toHaveBeenCalled()
    expect(service.previewMember).toHaveBeenCalled()
    await request(viewerApp.getHttpServer()).post(`/reports/${reportId}/revision-preview`)
      .send({ reason: '伪造版本', idempotencyKey: 'preview-03', config: { titleSyntaxVersion: 2 } }).expect(400)
  })
})
