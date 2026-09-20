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
import { MapController } from './map.controller'
import { MapJobsController } from './map-jobs.controller'
import { MapService } from './map.service'

const targetId = '11111111-1111-4111-8111-111111111111'
const otherTargetId = '22222222-2222-4222-8222-222222222222'
const objectId = '33333333-3333-4333-8333-333333333333'

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
  displayName: 'Viewer',
  roles: [{ id: 'viewer', key: 'viewer', name: 'Viewer', kind: 'system' }],
  permissions: ['target:read', 'map:read'],
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
    summary: vi.fn(async () => ({
      view: {
        viewRef: { kind: 'projection', projectionId: objectId, cursor: 0, revision: 0 },
        identityRevision: 0,
        governanceRevision: 0,
        publicationRevision: 0,
        computedAt: '2026-09-16T00:00:00.000Z',
      },
      projectionStatus: 'missing',
      pageCount: 0,
      objectCount: 0,
      conflictCount: 0,
      unknownConditionCount: 0,
      changeCount: 0,
    })),
    listPages: vi.fn(async () => ({ items: [], view: { viewRef: { kind: 'projection', projectionId: objectId, cursor: 0, revision: 0 }, identityRevision: 0, governanceRevision: 0, publicationRevision: 0, computedAt: '2026-09-16T00:00:00.000Z' } })),
    listObjects: vi.fn(async (_target: string) => ({
      items:
        _target === targetId
          ? [
              {
                assetRef: { targetId, objectId },
                assetRefKey: 'p:x:o:33333333-3333-4333-8333-333333333333:i:x:d:0',
                lifecycle: 'OBSERVED',
                dimensions: [],
                unknownFields: [],
                changeCount: 0,
                evidenceAvailability: 'available',
              },
            ]
          : [],
      view: { viewRef: { kind: 'projection', projectionId: objectId, cursor: 0, revision: 0 }, identityRevision: 0, governanceRevision: 0, publicationRevision: 0, computedAt: '2026-09-16T00:00:00.000Z' },
    })),
    getObject: vi.fn(),
    match: vi.fn(),
    getFact: vi.fn(),
    listChanges: vi.fn(),
    getCommand: vi.fn(),
    preview: vi.fn(),
    command: vi.fn(),
    rebuild: vi.fn(),
    listReleases: vi.fn(),
    getRelease: vi.fn(),
    sealAndPublish: vi.fn(),
    publish: vi.fn(),
    withdraw: vi.fn(),
    listReferences: vi.fn(async (_target: string, _query: unknown, account: RequestAccount) => ({
      items: account.permissions.includes('workflow:read')
        ? [{ grade: 'confirmed_reference', scenarioId: objectId, reasons: ['explicit-binding'] }]
        : [],
      restricted: !account.permissions.includes('workflow:read'),
      scanStatus: 'idle',
      scanCompleteness: 'unknown',
    })),
    listImpacts: vi.fn(async (_target: string, _query: unknown, account: RequestAccount) => ({
      items: [],
      restricted: !account.permissions.includes('workflow:read'),
      notes: account.permissions.includes('workflow:read') ? [] : ['结果受权限限制'],
    })),
    bind: vi.fn(),
    unbind: vi.fn(),
    startScan: vi.fn(),
    runClues: vi.fn(),
    consumptionPolicy: vi.fn(async () => ({
      targetId,
      revision: 0,
      policy: {
        schemaVersion: 1,
        policyVersion: 1,
        mode: 'off',
        allowedStepTypes: ['extract', 'assert'],
        allowedAssetRefs: [],
        maxCandidateCount: 2,
        maxResolveMs: 1000,
        maxExtraAiCalls: 0,
        onUnavailable: 'baseline',
      },
      eligibility: null,
      updatedAt: '1970-01-01T00:00:00.000Z',
    })),
    updateConsumptionPolicy: vi.fn(),
    grantConsumptionEligibility: vi.fn(),
    jobPolicy: vi.fn(async () => ({
      targetId,
      revision: 0,
      policy: {
        schemaVersion: 1,
        policyVersion: 1,
        manualJobsEnabled: false,
        maxProbePages: 1,
        maxProbeObjects: 8,
        maxProbeActions: 8,
        maxProbeSeconds: 300,
        maxRefreshPages: 5,
        maxRefreshObjects: 20,
        maxRefreshActions: 20,
        maxRefreshSeconds: 900,
        sliceWorkSeconds: 20,
        defaultDepth: 'structure',
        staticRefreshDays: 7,
      },
      updatedAt: '1970-01-01T00:00:00.000Z',
    })),
    updateJobPolicy: vi.fn(),
    explorationPolicy: vi.fn(async () => ({
      targetId,
      revision: 0,
      policy: {
        schemaVersion: 1,
        policyVersion: 1,
        exploreEnabled: false,
        mode: 'allowlist',
        modelEnabled: false,
        maxHopDepth: 1,
        maxNewPages: 1,
        maxCandidates: 8,
        maxActions: 1,
        maxSeconds: 300,
        sliceWorkSeconds: 20,
        allowlist: [],
        seedRefs: [],
      },
      updatedAt: '1970-01-01T00:00:00.000Z',
    })),
    updateExplorationPolicy: vi.fn(),
    previewExploration: vi.fn(async () => ({
      jobKind: 'map_explore',
      entryId: objectId,
      items: [],
      estimatedActions: 6,
      estimatedSeconds: 20,
    })),
    createExploration: vi.fn(async () => ({
      created: true,
      job: {
        jobId: objectId,
        targetId,
        targetAccountId: objectId,
        jobKind: 'map_explore',
        jobStatus: 'queued',
        stopReason: null,
        revision: 1,
        remainingBudgetSeconds: 280,
        firstRunId: objectId,
        slices: [],
        createdAt: '2026-09-16T00:00:00.000Z',
      },
    })),
    listSafeEntries: vi.fn(async () => ({ items: [] })),
    createSafeEntry: vi.fn(),
    previewJob: vi.fn(async () => ({
      jobKind: 'map_probe',
      entryId: objectId,
      items: [],
      estimatedActions: 2,
      estimatedSeconds: 20,
    })),
    createJob: vi.fn(async () => ({
      created: true,
      job: {
        jobId: objectId,
        targetId,
        targetAccountId: objectId,
        jobKind: 'map_probe',
        jobStatus: 'queued',
        stopReason: null,
        revision: 1,
        remainingBudgetSeconds: 280,
        firstRunId: objectId,
        slices: [],
        createdAt: '2026-09-16T00:00:00.000Z',
      },
    })),
    getJob: vi.fn(),
    cancelJob: vi.fn(),
    listTerms: vi.fn(async () => ({ items: [] })),
    matchTerms: vi.fn(),
    getTerm: vi.fn(),
    createTerm: vi.fn(),
    updateTerm: vi.fn(),
    retireTerm: vi.fn(),
  }
}

describe('地图查询 HTTP', () => {
  let app: INestApplication
  const maps = mockService()

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MapController],
      providers: [
        { provide: MapService, useValue: maps },
        { provide: APP_GUARD, useValue: new StaticAuthGuard(admin) },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        Reflector,
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    listenForSupertest(app)
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(maps, mockService())
  })

  it('OMD01 无 map:read 不能枚举对象', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MapController],
      providers: [
        { provide: MapService, useValue: maps },
        { provide: APP_GUARD, useValue: new StaticAuthGuard({ ...viewer, permissions: ['target:read'] }) },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        Reflector,
      ],
    }).compile()
    const denied = moduleRef.createNestApplication()
    await denied.init()
    listenForSupertest(denied)
    await request(denied.getHttpServer()).get(`/targets/${targetId}/map/objects`).expect(403)
    await denied.close()
  })

  it('OMD01 两个 Target 各自查询，不串对象', async () => {
    const first = await request(app.getHttpServer()).get(`/targets/${targetId}/map/objects`).expect(200)
    const second = await request(app.getHttpServer()).get(`/targets/${otherTargetId}/map/objects`).expect(200)
    expect(first.body.items).toHaveLength(1)
    expect(second.body.items).toHaveLength(0)
    expect(maps.listObjects).toHaveBeenCalledWith(targetId, expect.any(Object))
    expect(maps.listObjects).toHaveBeenCalledWith(otherTargetId, expect.any(Object))
  })

  it('OMD11 无 workflow:read 时引用与影响不泄漏场景', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MapController],
      providers: [
        { provide: MapService, useValue: maps },
        { provide: APP_GUARD, useValue: new StaticAuthGuard(viewer) },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        Reflector,
      ],
    }).compile()
    const limited = moduleRef.createNestApplication()
    await limited.init()
    listenForSupertest(limited)
    const refs = await request(limited.getHttpServer()).get(`/targets/${targetId}/map/references`).expect(200)
    const impacts = await request(limited.getHttpServer()).get(`/targets/${targetId}/map/impacts`).expect(200)
    expect(refs.body.restricted).toBe(true)
    expect(refs.body.items).toEqual([])
    expect(impacts.body.restricted).toBe(true)
    expect(impacts.body.notes).toContain('结果受权限限制')
    await limited.close()
  })

  it('治理 overlay 缺少 assetRef 时拒绝', async () => {
    await request(app.getHttpServer())
      .post(`/targets/${targetId}/map/governance/preview`)
      .send({
        kind: 'retire',
        reason: '下线',
        expectedGovernanceRevision: 0,
      })
      .expect(400)
  })

  it('viewer 不能发布或提交治理命令', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MapController],
      providers: [
        { provide: MapService, useValue: maps },
        { provide: APP_GUARD, useValue: new StaticAuthGuard(viewer) },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        Reflector,
      ],
    }).compile()
    const limited = moduleRef.createNestApplication()
    await limited.init()
    listenForSupertest(limited)
    await request(limited.getHttpServer()).post(`/targets/${targetId}/map/governance/preview`).send({
      kind: 'retire',
      reason: '下线',
      expectedGovernanceRevision: 0,
    }).expect(403)
    await request(limited.getHttpServer()).post(`/targets/${targetId}/map/releases`).send({
      projectionId: objectId,
      expectedProjectionRevision: 0,
      expectedPublicationRevision: 0,
      idempotencyKey: 'cmd:seal-1',
      reason: '发布',
    }).expect(403)
    await request(limited.getHttpServer()).post(`/targets/${targetId}/map/terms`).send({
      idempotencyKey: 'term-create-1',
      canonicalName: '订单',
      meaning: '销售订单',
    }).expect(403)
    await request(limited.getHttpServer()).post(`/targets/${targetId}/map/consumption-policy`).send({
      expectedRevision: 0,
      idempotencyKey: 'policy-shadow-1',
      mode: 'shadow',
      reason: '仅比较',
    }).expect(403)
    await request(limited.getHttpServer()).post(`/targets/${targetId}/map/consumption-eligibility`).send({
      reportId: 'omt-grant-01',
      reason: '独立对照',
    }).expect(403)
    await limited.close()
  })

  it('可读取消费政策，更新需要 map:publish', async () => {
    await request(app.getHttpServer()).get(`/targets/${targetId}/map/consumption-policy`).expect(200)
    expect(maps.consumptionPolicy).toHaveBeenCalledWith(targetId)
    await request(app.getHttpServer()).post(`/targets/${targetId}/map/consumption-policy`).send({
      expectedRevision: 0,
      idempotencyKey: 'policy-shadow-1',
      mode: 'shadow',
      reason: '仅比较',
    }).expect(200)
    expect(maps.updateConsumptionPolicy).toHaveBeenCalled()
    await request(app.getHttpServer()).post(`/targets/${targetId}/map/consumption-eligibility`).send({
      reportId: 'omt-grant-01',
      reason: '独立对照',
    }).expect(200)
    expect(maps.grantConsumptionEligibility).toHaveBeenCalled()
  })

  it('可读作业政策，写政策与建作业需要 map:maintain', async () => {
    await request(app.getHttpServer()).get(`/targets/${targetId}/map/job-policy`).expect(200)
    await request(app.getHttpServer()).get(`/targets/${targetId}/map/safe-entries`).expect(200)
    await request(app.getHttpServer()).post(`/targets/${targetId}/map/jobs/preview`).send({
      jobKind: 'map_probe',
      targetAccountId: objectId,
      entryId: objectId,
    }).expect(200)
    await request(app.getHttpServer()).post(`/targets/${targetId}/map/jobs`).send({
      manualId: 'manual-job-1',
      expectedPolicyRevision: 0,
      jobKind: 'map_probe',
      targetAccountId: objectId,
      entryId: objectId,
    }).expect(202)
    const moduleRef = await Test.createTestingModule({
      controllers: [MapController],
      providers: [
        { provide: MapService, useValue: maps },
        { provide: APP_GUARD, useValue: new StaticAuthGuard(viewer) },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        Reflector,
      ],
    }).compile()
    const limited = moduleRef.createNestApplication()
    await limited.init()
    listenForSupertest(limited)
    await request(limited.getHttpServer()).post(`/targets/${targetId}/map/job-policy`).send({
      expectedRevision: 0,
      idempotencyKey: 'job-policy-1',
      manualJobsEnabled: true,
      reason: '开放',
    }).expect(403)
    await limited.close()
  })

  it('OMI01 读探索政策无需 explore；写政策与触发需要 map:explore', async () => {
    await request(app.getHttpServer()).get(`/targets/${targetId}/map/exploration-policy`).expect(200)
    await request(app.getHttpServer()).post(`/targets/${targetId}/map/explorations/preview`).send({
      targetAccountId: objectId,
      entryId: objectId,
    }).expect(200)
    await request(app.getHttpServer()).post(`/targets/${targetId}/map/explorations`).send({
      manualId: 'manual-explore-1',
      expectedExplorationRevision: 0,
      targetAccountId: objectId,
      entryId: objectId,
    }).expect(202)
    const moduleRef = await Test.createTestingModule({
      controllers: [MapController],
      providers: [
        { provide: MapService, useValue: maps },
        { provide: APP_GUARD, useValue: new StaticAuthGuard({ ...admin, permissions: ['map:maintain'] }) },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        Reflector,
      ],
    }).compile()
    const limited = moduleRef.createNestApplication()
    await limited.init()
    listenForSupertest(limited)
    await request(limited.getHttpServer()).post(`/targets/${targetId}/map/exploration-policy`).send({
      expectedRevision: 0,
      idempotencyKey: 'explore-policy-1',
      exploreEnabled: true,
      mode: 'allowlist',
      reason: '开放',
    }).expect(403)
    await request(limited.getHttpServer()).post(`/targets/${targetId}/map/explorations`).send({
      manualId: 'manual-explore-1',
      expectedExplorationRevision: 0,
      targetAccountId: objectId,
      entryId: objectId,
    }).expect(403)
    await limited.close()
  })
  it('术语复核角色不需要工作流写权限或地图读权限即可创建术语', async () => {
    const account = { ...viewer, permissions: ['target:read', 'map:review'] as RequestAccount['permissions'] }
    const moduleRef = await Test.createTestingModule({ controllers: [MapController], providers: [
      { provide: MapService, useValue: maps }, { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard }, { provide: APP_FILTER, useClass: AllExceptionsFilter }, Reflector,
    ] }).compile()
    const limited = moduleRef.createNestApplication()
    await limited.init(); listenForSupertest(limited)
    try {
      await request(limited.getHttpServer()).post(`/targets/${targetId}/map/terms`).send({ idempotencyKey: 'term-review-only', canonicalName: '订单', meaning: '销售订单' }).expect(201)
      expect(maps.createTerm).toHaveBeenCalledWith(targetId, expect.any(Object), expect.objectContaining({ id: account.id }))
    } finally { await limited.close() }
  })

})

describe('地图作业 HTTP', () => {
  let app: INestApplication
  const maps = mockService()

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MapJobsController],
      providers: [
        { provide: MapService, useValue: maps },
        { provide: APP_GUARD, useValue: new StaticAuthGuard(admin) },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        Reflector,
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    listenForSupertest(app)
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(maps, mockService())
  })

  it('可读取作业并取消', async () => {
    maps.getJob.mockResolvedValueOnce({ jobId: objectId, jobStatus: 'queued' })
    maps.cancelJob.mockResolvedValueOnce({ jobId: objectId, jobStatus: 'cancelled' })
    await request(app.getHttpServer()).get(`/map-jobs/${objectId}`).expect(200)
    await request(app.getHttpServer()).post(`/map-jobs/${objectId}/cancel`).expect(200)
    expect(maps.cancelJob).toHaveBeenCalledWith(objectId, expect.objectContaining({ id: admin.id }))
  })
})
