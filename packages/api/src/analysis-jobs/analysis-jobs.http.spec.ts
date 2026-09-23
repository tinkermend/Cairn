import { INestApplication, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { listenForSupertest } from '../__tests__/http-app'
import { AnalysisJobsController } from './analysis-jobs.controller'
import { AnalysisJobsService } from './analysis-jobs.service'
import { KnowledgeCandidatesController } from './knowledge-candidates.controller'

const jobId = '11111111-1111-4111-8111-111111111111'

const job = {
  analysisJobId: jobId,
  targetId: '22222222-2222-4222-8222-222222222222',
  mode: 'map_quality',
  status: 'QUEUED',
}

const admin: RequestAccount = {
  id: 'acc-admin',
  displayName: 'Admin',
  email: 'admin@example.com',
  status: 'active',
  roles: [{ id: 'admin', key: 'admin', name: 'Administrator', kind: 'system' }],
  permissions: ['map:analyze', 'schedule:read', 'target:read', 'map:read'],
}

const viewer: RequestAccount = {
  ...admin,
  id: 'acc-viewer',
  permissions: ['schedule:read'],
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
    list: vi.fn(async () => ({ items: [job] })),
    get: vi.fn(async () => job),
    cancel: vi.fn(async () => ({ ...job, status: 'CANCELLED' })),
    review: vi.fn(async () => job),
    insights: vi.fn(async () => ({ jobId, insights: [], changeImpacts: [], coverageGaps: [] })),
    insight: vi.fn(async (_jobId, insightId) => ({ insightId, kind: 'failure_mode', title: '测试洞察' })),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [AnalysisJobsController, KnowledgeCandidatesController],
    providers: [
      Reflector,
      { provide: AnalysisJobsService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('AnalysisJobs HTTP', () => {
  const service = mockService()
  let adminApp: INestApplication
  let viewerApp: INestApplication

  beforeAll(async () => {
    adminApp = await buildApp(admin, service)
    viewerApp = await buildApp(viewer, service)
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterAll(async () => {
    await adminApp.close()
    await viewerApp.close()
  })

  it('候选审阅使用知识领域 POST 且严格校验修订和命令', async () => {
    const body = { kind: 'reject', idempotencyKey: 'review-01', expectedRevision: 1, reason: '证据不足' }
    await request(viewerApp.getHttpServer()).post(`/knowledge-candidates/${jobId}/review`).send(body).expect(403)
    await request(adminApp.getHttpServer()).post(`/knowledge-candidates/${jobId}/review`).send({ ...body, expectedRevision: 0 }).expect(400)
    await request(adminApp.getHttpServer()).post(`/knowledge-candidates/${jobId}/review`).send({ ...body, publish: true }).expect(400)
    await request(adminApp.getHttpServer()).post(`/knowledge-candidates/${jobId}/review`).send(body).expect(200)
    expect(service.review).toHaveBeenCalledWith(jobId, body, admin)
  })

  it('读取和取消都要求 map:analyze，取消走 POST', async () => {
    await request(viewerApp.getHttpServer()).get('/analysis-jobs').expect(403)
    await request(adminApp.getHttpServer()).get('/analysis-jobs').expect(200)
    expect(service.list).toHaveBeenCalled()

    await request(adminApp.getHttpServer()).get(`/analysis-jobs/${jobId}`).expect(200)
    expect(service.get).toHaveBeenCalledWith(jobId, admin.id)

    await request(viewerApp.getHttpServer())
      .post(`/analysis-jobs/${jobId}/cancel`)
      .send({ idempotencyKey: 'cancel-01' })
      .expect(403)
    await request(adminApp.getHttpServer())
      .post(`/analysis-jobs/${jobId}/cancel`)
      .send({ idempotencyKey: 'cancel-01' })
      .expect(200)
    expect(service.cancel).toHaveBeenCalledWith(jobId, expect.objectContaining({ idempotencyKey: 'cancel-01' }), admin)
  })

  it('读取分析作业洞察和单项洞察需要 map:analyze', async () => {
    const insightId = '00000000-0000-4000-8000-000000000001'
    await request(viewerApp.getHttpServer()).get(`/analysis-jobs/${jobId}/insights`).expect(403)
    await request(adminApp.getHttpServer()).get(`/analysis-jobs/${jobId}/insights`).expect(200)
    expect(service.insights).toHaveBeenCalledWith(jobId, admin.id)

    await request(viewerApp.getHttpServer()).get(`/analysis-jobs/${jobId}/insights/${insightId}`).expect(403)
    await request(adminApp.getHttpServer()).get(`/analysis-jobs/${jobId}/insights/${insightId}`).expect(200)
    expect(service.insight).toHaveBeenCalledWith(jobId, insightId, admin.id)
  })
})
