import { INestApplication, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERMISSIONS, type ReliabilityIncidentDto } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { listenForSupertest } from '../__tests__/http-app'
import { TargetReliabilityController, ReliabilityAssetsController, ReliabilityIncidentsController, ReliabilityUpgradeJobsController } from './reliability.controller'
import { ReliabilityService } from './reliability.service'

const targetId = '11111111-1111-4111-8111-111111111111'
const incidentId = '22222222-2222-4222-8222-222222222222'

const mockIncident: ReliabilityIncidentDto = {
  id: incidentId,
  targetId,
  groupingKey: `g_test_key`,
  scopeDigest: `target:${targetId}`,
  severity: 'P3',
  status: 'DETECTED',
  memberCount: 2,
  firstSeenAt: '2026-09-23T00:00:00.000Z',
  lastSeenAt: '2026-09-23T01:00:00.000Z',
  title: '测试可靠性事件',
  summary: '检测到持续定位 Fallback',
  evidenceScores: { supportingScore: 60, counterScore: 10, supportingFactors: ['回退频发'], counterFactors: [] },
  revision: 1,
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T01:00:00.000Z',
}

const admin: RequestAccount = {
  id: 'acc-admin',
  displayName: 'Admin',
  email: 'admin@example.com',
  status: 'active',
  roles: [{ id: 'admin', key: 'admin', name: 'Administrator', kind: 'system' }],
  permissions: [...PERMISSIONS],
}

const triager: RequestAccount = {
  ...admin,
  id: 'acc-triager',
  permissions: ['reliability:read', 'reliability:triage'],
}

const viewer: RequestAccount = {
  ...admin,
  id: 'acc-viewer',
  permissions: ['reliability:read'],
}

let currentAccount: RequestAccount | null = admin

class StaticAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!currentAccount) throw new UnauthorizedException('未认证')
    context.switchToHttp().getRequest().account = currentAccount
    return true
  }
}

function mockService() {
  return {
    getOverview: vi.fn(async () => ({
      targetId,
      activeIncidentsCount: 1,
      incidentsByStatus: { DETECTED: 1 },
      incidentsBySeverity: { P3: 1 },
      latestWindows: [],
      watermarkVector: { runCompletedSeq: 50, mapCommittedSeq: 0, validationSeq: 0 },
      latestEvaluation: null,
    })),
    listIncidents: vi.fn(async () => ({
      items: [mockIncident],
      total: 1,
    })),
    listIncidentSignals: vi.fn(async () => ({
      items: [
        {
          id: 'sig-1',
          targetId,
          kind: 'resolution_fallback',
          severity: 'WARN',
          subjectRef: { kind: 'scenario_step', id: 'step-1' },
          sourceRef: { kind: 'attempt', id: 'att-1' },
          occurredAt: '2026-09-23T00:00:00.000Z',
          scopeDigest: `target:${targetId}`,
          availability: 'available',
          createdAt: '2026-09-23T00:00:00.000Z',
        },
      ],
      total: 1,
      nextCursor: null,
    })),
    listAssets: vi.fn(async () => ({
      items: [
        {
          assetId: 'sc-1',
          assetType: 'scenario',
          assetName: '测试场景',
          targetId,
          targetName: '测试目标',
          sampleCount: 20,
          ewmaSuccessRate: 0.95,
          p95DurationMs: 1200,
          activeIncidentsCount: 0,
          highestSeverity: null,
          lastEvaluatedAt: '2026-09-23T00:00:00.000Z',
          status: 'healthy',
        },
      ],
      total: 1,
      nextCursor: null,
    })),
    getIncidentDetail: vi.fn(async () => ({
      incident: mockIncident,
      members: [{ id: 'm-1', incidentId, memberRef: 'att-1', memberType: 'attempt', joinedAt: '2026-09-23T00:00:00.000Z' }],
    })),
    requestEvaluation: vi.fn(async () => ({
      targetId,
      requested: true,
    })),
    mergeIncidents: vi.fn(async () => ({
      ...mockIncident,
      memberCount: 4,
      revision: 2,
    })),
    splitIncidents: vi.fn(async () => ({
      sourceIncident: { ...mockIncident, memberCount: 1, revision: 2 },
      newIncident: { ...mockIncident, id: '33333333-3333-4333-8333-333333333333', memberCount: 1, revision: 1 },
    })),
    dismissIncident: vi.fn(async () => ({
      ...mockIncident,
      status: 'DISMISSED',
      dismissedReason: '预期变更',
      revision: 2,
    })),
    silenceIncident: vi.fn(async () => ({
      ...mockIncident,
      silencedUntil: '2026-09-24T00:00:00.000Z',
      revision: 2,
    })),
    resolveIncident: vi.fn(async () => ({
      ...mockIncident,
      status: 'RESOLVED',
      dismissedReason: '已采纳修复补丁',
      revision: 2,
    })),
    getIncidentImpact: vi.fn(async () => ({
      incidentId,
      targetId,
      impactedRuns: [],
      affectedAssets: [],
      summary: {
        totalScenarios: 0,
        upgradeableCount: 0,
        blockedCount: 0,
        alreadyLatestCount: 0,
        gapsCount: 0,
      },
      coverageGaps: [],
      generatedAt: '2026-09-23T00:00:00.000Z',
    })),
    batchUpgrade: vi.fn(async () => ({
      jobId: 'job-1',
      incidentId,
      targetId,
      moduleId: '11111111-2222-4111-8111-111111111111',
      toVersionId: '22221111-2222-4111-8111-111111111111',
      status: 'completed',
      results: [{ scenarioId: '33331111-2222-4111-8111-111111111111', scenarioName: '场景1', status: 'upgraded' }],
      createdAt: '2026-09-23T00:00:00.000Z',
      completedAt: '2026-09-23T00:00:01.000Z',
    })),
    getUpgradeJob: vi.fn(async () => ({
      jobId: 'job-1',
      incidentId,
      targetId,
      moduleId: '11111111-2222-4111-8111-111111111111',
      toVersionId: '22221111-2222-4111-8111-111111111111',
      status: 'completed',
      results: [{ scenarioId: '33331111-2222-4111-8111-111111111111', scenarioName: '场景1', status: 'upgraded' }],
      createdAt: '2026-09-23T00:00:00.000Z',
      completedAt: '2026-09-23T00:00:01.000Z',
    })),
  }
}

describe('Reliability HTTP Endpoints', () => {
  let app: INestApplication
  let service: ReturnType<typeof mockService>

  beforeAll(async () => {
    service = mockService()
    const moduleRef = await Test.createTestingModule({
      controllers: [
        TargetReliabilityController,
        ReliabilityAssetsController,
        ReliabilityIncidentsController,
        ReliabilityUpgradeJobsController,
      ],
      providers: [
        { provide: ReliabilityService, useValue: service },
        { provide: APP_GUARD, useClass: StaticAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        Reflector,
      ],
    }).compile()

    app = moduleRef.createNestApplication()
    app.useGlobalGuards(new StaticAuthGuard(), new PermissionsGuard(new Reflector()))
    app.useGlobalFilters(new AllExceptionsFilter())
    await listenForSupertest(app)
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    currentAccount = admin
    vi.clearAllMocks()
  })

  it('GET /targets/:targetId/reliability returns target overview', async () => {
    currentAccount = viewer
    const res = await request(app.getHttpServer()).get(`/targets/${targetId}/reliability`)
    expect(res.status).toBe(200)
    expect(res.body.targetId).toBe(targetId)
    expect(res.body.activeIncidentsCount).toBe(1)
  })

  it('GET /reliability/incidents lists incidents with query params', async () => {
    currentAccount = viewer
    const res = await request(app.getHttpServer())
      .get('/reliability/incidents')
      .query({ targetId, status: 'DETECTED' })
    expect(res.status).toBe(200)
    expect(res.body.items.length).toBe(1)
    expect(res.body.items[0].id).toBe(incidentId)
  })

  it('GET /reliability/incidents/:incidentId returns incident detail', async () => {
    currentAccount = viewer
    const res = await request(app.getHttpServer()).get(`/reliability/incidents/${incidentId}`)
    expect(res.status).toBe(200)
    expect(res.body.incident.id).toBe(incidentId)
    expect(res.body.members.length).toBe(1)
  })

  it('POST /targets/:targetId/reliability/evaluations permissions check', async () => {
    // Viewer lacks reliability:configure -> 403
    currentAccount = viewer
    const forbidden = await request(app.getHttpServer())
      .post(`/targets/${targetId}/reliability/evaluations`)
      .send({})
    expect(forbidden.status).toBe(403)

    // Admin has reliability:configure -> 200
    currentAccount = admin
    const ok = await request(app.getHttpServer())
      .post(`/targets/${targetId}/reliability/evaluations`)
      .send({})
    expect(ok.status).toBe(200)
    expect(ok.body.requested).toBe(true)
  })

  it('POST /reliability/incidents/:incidentId/merge permissions and triage execution', async () => {
    currentAccount = viewer
    const forbidden = await request(app.getHttpServer())
      .post(`/reliability/incidents/${incidentId}/merge`)
      .send({ targetIncidentId: '44444444-4444-4444-8444-444444444444' })
    expect(forbidden.status).toBe(403)

    currentAccount = triager
    const ok = await request(app.getHttpServer())
      .post(`/reliability/incidents/${incidentId}/merge`)
      .send({ targetIncidentId: '44444444-4444-4444-8444-444444444444' })
    expect(ok.status).toBe(200)
    expect(ok.body.memberCount).toBe(4)
  })

  it('POST /reliability/incidents/:incidentId/split partitions incident', async () => {
    currentAccount = triager
    const ok = await request(app.getHttpServer())
      .post(`/reliability/incidents/${incidentId}/split`)
      .send({ memberIds: ['att-1'], newTitle: '拆离子事件' })
    expect(ok.status).toBe(200)
    expect(ok.body.newIncident.id).toBeDefined()
  })

  it('POST /reliability/incidents/:incidentId/dismiss dismisses incident', async () => {
    currentAccount = triager
    const ok = await request(app.getHttpServer())
      .post(`/reliability/incidents/${incidentId}/dismiss`)
      .send({ reason: '预期变更' })
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('DISMISSED')
  })

  it('POST /reliability/incidents/:incidentId/silence silences incident', async () => {
    currentAccount = triager
    const ok = await request(app.getHttpServer())
      .post(`/reliability/incidents/${incidentId}/silence`)
      .send({ durationHours: 24, reason: '排期修复中' })
    expect(ok.status).toBe(200)
    expect(ok.body.silencedUntil).toBeDefined()
  })

  it('POST /reliability/incidents/:incidentId/resolve resolves incident with reason', async () => {
    currentAccount = viewer
    const forbidden = await request(app.getHttpServer())
      .post(`/reliability/incidents/${incidentId}/resolve`)
      .send({ reason: '已采纳修复补丁' })
    expect(forbidden.status).toBe(403)

    currentAccount = triager
    const ok = await request(app.getHttpServer())
      .post(`/reliability/incidents/${incidentId}/resolve`)
      .send({ reason: '已采纳修复补丁' })
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('RESOLVED')
    expect(ok.body.dismissedReason).toBe('已采纳修复补丁')
  })

  it('GET /reliability/assets returns asset items and checks permissions', async () => {
    currentAccount = {
      ...viewer,
      permissions: ['run:read'], // missing reliability:read
    }
    const forbidden = await request(app.getHttpServer()).get('/reliability/assets')
    expect(forbidden.status).toBe(403)

    currentAccount = viewer
    const ok = await request(app.getHttpServer()).get('/reliability/assets?assetType=scenario')
    expect(ok.status).toBe(200)
    expect(ok.body.items).toHaveLength(1)
    expect(ok.body.items[0].assetName).toBe('测试场景')
    expect(ok.body.items[0].status).toBe('healthy')
  })

  it('GET /reliability/incidents/:incidentId/signals returns paginated signals', async () => {
    currentAccount = viewer
    const ok = await request(app.getHttpServer()).get(`/reliability/incidents/${incidentId}/signals?limit=10`)
    expect(ok.status).toBe(200)
    expect(ok.body.items).toHaveLength(1)
    expect(ok.body.items[0].kind).toBe('resolution_fallback')
  })

  it('GET /reliability/incidents/:incidentId/impact returns impact snapshot', async () => {
    currentAccount = viewer
    const ok = await request(app.getHttpServer()).get(`/reliability/incidents/${incidentId}/impact`)
    expect(ok.status).toBe(200)
    expect(ok.body.incidentId).toBe(incidentId)
    expect(ok.body.targetId).toBe(targetId)
    expect(ok.body.summary).toBeDefined()
  })

  it('POST /reliability/incidents/:incidentId/batch-upgrade permissions check and execution', async () => {
    // Viewer lacks reliability:triage -> 403
    currentAccount = viewer
    const forbidden = await request(app.getHttpServer())
      .post(`/reliability/incidents/${incidentId}/batch-upgrade`)
      .send({
        moduleId: '11111111-2222-4111-8111-111111111111',
        toVersionId: '22221111-2222-4111-8111-111111111111',
        scenarioIds: ['33331111-2222-4111-8111-111111111111'],
        idempotencyKey: 'idem-1',
      })
    expect(forbidden.status).toBe(403)

    // Triager has reliability:triage -> 200
    currentAccount = triager
    const ok = await request(app.getHttpServer())
      .post(`/reliability/incidents/${incidentId}/batch-upgrade`)
      .send({
        moduleId: '11111111-2222-4111-8111-111111111111',
        toVersionId: '22221111-2222-4111-8111-111111111111',
        scenarioIds: ['33331111-2222-4111-8111-111111111111'],
        idempotencyKey: 'idem-1',
      })
    expect(ok.status).toBe(200)
    expect(ok.body.jobId).toBe('job-1')
    expect(ok.body.status).toBe('completed')
    expect(ok.body.results).toHaveLength(1)
  })

  it('GET /reliability/upgrade-jobs/:jobId returns upgrade job detail', async () => {
    currentAccount = viewer
    const ok = await request(app.getHttpServer()).get('/reliability/upgrade-jobs/job-1')
    expect(ok.status).toBe(200)
    expect(ok.body.jobId).toBe('job-1')
    expect(ok.body.status).toBe('completed')
  })
})

