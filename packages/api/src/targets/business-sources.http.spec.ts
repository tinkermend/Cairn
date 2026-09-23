import {
  ConflictException,
  INestApplication,
  NotFoundException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERMISSIONS, BUSINESS_SOURCE_CURSOR_EXPIRED } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter.js'
import type { RequestAccount } from '../common/request-account.js'
import { PermissionsGuard } from '../rbac/permissions.guard.js'
import { BusinessSourcesController } from './business-sources.controller.js'
import { BusinessSourcesService } from './business-sources.service.js'
import { listenForSupertest } from '../__tests__/http-app.js'

const now = '2026-09-23T10:00:00.000Z'
const targetId = '11111111-1111-4111-8111-111111111111'

const adminPrincipal: RequestAccount = {
  id: 'acc-admin',
  displayName: 'Admin',
  email: 'admin@example.com',
  status: 'active',
  roles: [{ id: 'admin', key: 'admin', name: 'Administrator', kind: 'system' }],
  permissions: [...PERMISSIONS],
}

const viewerPrincipal: RequestAccount = {
  ...adminPrincipal,
  id: 'acc-viewer',
  displayName: 'Viewer',
  roles: [{ id: 'viewer', key: 'viewer', name: 'Viewer', kind: 'system' }],
  permissions: ['target:read', 'dataset:read'],
}

const targetOnlyPrincipal: RequestAccount = {
  ...adminPrincipal,
  id: 'acc-target-only',
  displayName: 'Target Only',
  roles: [{ id: 'target_viewer', key: 'target_viewer', name: 'Target Viewer', kind: 'system' }],
  permissions: ['target:read'],
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
    getBusinessSource: vi.fn(async () => ({
      id: 'bs-1',
      targetId,
      entityType: 'manufacturer',
      sourceKind: 'dataset_snapshot',
      currentSnapshotId: 'snap-1',
      bindingRevision: 1,
      status: 'active',
      ownerAccountId: 'acc-admin',
      approverAccountId: 'acc-admin',
      approvedAt: now,
      declaredSourceAsOf: null,
      declaredByAccountId: null,
      declarationBasis: null,
      validUntil: null,
      completenessBasis: '快照全量扫描校验',
      completenessStatus: 'complete',
      createdAt: now,
      updatedAt: now,
    })),
    previewBusinessSource: vi.fn(async () => ({
      previewRows: [
        {
          rowIndex: 0,
          recordKey: 'MFG-1',
          displayName: 'Alpha Tech',
          recordStatus: 'active',
          payload: { code: 'MFG-1', name: 'Alpha Tech' },
          isValid: true,
        },
      ],
      validationDigest: {
        sampleCount: 1,
        sampleValidCount: 1,
        sampleRejectedCount: 0,
        potentialDuplicateKeys: [],
      },
    })),
    createCandidate: vi.fn(async () => ({
      id: 'cand-1',
      sourceBindingId: 'bs-1',
      targetId,
      entityType: 'manufacturer',
      datasetId: 'ds-1',
      buildStatus: 'building',
      rulesVersion: 1,
      mappingConfig: {
        keyColumn: 'code',
        displayNameColumn: 'name',
        fieldWhitelist: ['code', 'name'],
      },
      validationSummary: null,
      sourceObservedAt: null,
      createdAt: now,
      updatedAt: now,
    })),
    getCandidate: vi.fn(async () => ({
      id: 'cand-1',
      sourceBindingId: 'bs-1',
      targetId,
      entityType: 'manufacturer',
      datasetId: 'ds-1',
      buildStatus: 'ready',
      rulesVersion: 1,
      mappingConfig: {
        keyColumn: 'code',
        displayNameColumn: 'name',
        fieldWhitelist: ['code', 'name'],
      },
      validationSummary: {
        totalRows: 1,
        validCount: 1,
        rejectedCount: 0,
        issues: [],
      },
      sourceObservedAt: null,
      createdAt: now,
      updatedAt: now,
    })),
    approveCandidate: vi.fn(async () => ({
      bindingRevision: 2,
      snapshotId: 'cand-1',
    })),
    revokeSource: vi.fn(async () => ({
      bindingRevision: 3,
      revokedAt: now,
    })),
    listBusinessRecords: vi.fn(async () => ({
      items: [
        {
          id: 'rec-1',
          snapshotId: 'snap-1',
          targetId,
          entityType: 'manufacturer',
          recordKey: 'MFG-1',
          displayName: 'Alpha Tech',
          recordStatus: 'active',
          originalDatasetId: 'ds-1',
          datasetRowId: 'row-1',
          datasetRowIndex: 0,
          payload: { code: 'MFG-1', name: 'Alpha Tech' },
          createdAt: now,
        },
      ],
      snapshotId: 'snap-1',
      bindingRevision: 1,
      coverage: {
        status: 'complete',
        completenessBasis: '快照全量扫描校验',
        observedAt: null,
        importedAt: now,
      },
    })),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [BusinessSourcesController],
    providers: [
      Reflector,
      { provide: BusinessSourcesService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('BusinessSources HTTP', () => {
  const service = mockService()
  let adminApp: INestApplication
  let viewerApp: INestApplication
  let targetOnlyApp: INestApplication
  let anonApp: INestApplication

  beforeAll(async () => {
    adminApp = await buildApp(adminPrincipal, service)
    viewerApp = await buildApp(viewerPrincipal, service)
    targetOnlyApp = await buildApp(targetOnlyPrincipal, service)
    anonApp = await buildApp(null, service)
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterAll(async () => {
    await adminApp.close()
    await viewerApp.close()
    await targetOnlyApp.close()
    await anonApp.close()
  })

  describe('GET /targets/:targetId/business-sources', () => {
    it('未登录时返回 401', async () => {
      await request(anonApp.getHttpServer())
        .get(`/targets/${targetId}/business-sources`)
        .expect(401)
    })

    it('缺少 dataset:read 权限时返回 403', async () => {
      await request(targetOnlyApp.getHttpServer())
        .get(`/targets/${targetId}/business-sources`)
        .expect(403)
    })

    it('满足 target:read 和 dataset:read 权限时成功返回数据源', async () => {
      const res = await request(viewerApp.getHttpServer())
        .get(`/targets/${targetId}/business-sources?entityType=manufacturer`)
        .expect(200)

      expect(res.body.id).toBe('bs-1')
      expect(res.body.targetId).toBe(targetId)
      expect(service.getBusinessSource).toHaveBeenCalledWith(targetId, 'manufacturer', viewerPrincipal.id)
    })
  })

  describe('Preview business source', () => {
    it('GET preview 成功返回预览行与校验统计', async () => {
      const res = await request(viewerApp.getHttpServer())
        .get(
          `/targets/${targetId}/business-sources/preview?datasetId=ds-1&keyColumn=code&displayNameColumn=name&fieldWhitelist=code,name`,
        )
        .expect(200)

      expect(res.body.previewRows).toHaveLength(1)
      expect(res.body.validationDigest.sampleValidCount).toBe(1)
      expect(service.previewBusinessSource).toHaveBeenCalled()
    })

    it('POST preview 成功返回预览行', async () => {
      const res = await request(viewerApp.getHttpServer())
        .post(`/targets/${targetId}/business-sources/preview`)
        .send({
          datasetId: 'ds-1',
          entityType: 'manufacturer',
          mappingConfig: {
            keyColumn: 'code',
            displayNameColumn: 'name',
            fieldWhitelist: ['code', 'name'],
          },
        })
        .expect(201)

      expect(res.body.previewRows).toHaveLength(1)
      expect(service.previewBusinessSource).toHaveBeenCalled()
    })
  })

  describe('POST /targets/:targetId/business-sources/candidates', () => {
    it('Viewer 无 write 权限时返回 403', async () => {
      await request(viewerApp.getHttpServer())
        .post(`/targets/${targetId}/business-sources/candidates`)
        .send({
          datasetId: 'ds-1',
          mappingConfig: {
            keyColumn: 'code',
            displayNameColumn: 'name',
            fieldWhitelist: ['code', 'name'],
          },
        })
        .expect(403)
    })

    it('Admin 成功创建候选', async () => {
      const res = await request(adminApp.getHttpServer())
        .post(`/targets/${targetId}/business-sources/candidates`)
        .send({
          datasetId: 'ds-1',
          mappingConfig: {
            keyColumn: 'code',
            displayNameColumn: 'name',
            fieldWhitelist: ['code', 'name'],
          },
        })
        .expect(201)

      expect(res.body.id).toBe('cand-1')
      expect(service.createCandidate).toHaveBeenCalled()
    })
  })

  describe('GET /targets/:targetId/business-sources/candidates/:candidateId', () => {
    it('Viewer 成功查看候选状态', async () => {
      const res = await request(viewerApp.getHttpServer())
        .get(`/targets/${targetId}/business-sources/candidates/cand-1`)
        .expect(200)

      expect(res.body.buildStatus).toBe('ready')
      expect(service.getCandidate).toHaveBeenCalledWith(targetId, 'cand-1', viewerPrincipal.id)
    })
  })

  describe('POST /targets/:targetId/business-sources/candidates/:candidateId/approve', () => {
    it('Admin 成功审批候选', async () => {
      const res = await request(adminApp.getHttpServer())
        .post(`/targets/${targetId}/business-sources/candidates/cand-1/approve`)
        .send({
          expectedRevision: 1,
          approvalBasis: '人工复核源数据无误',
        })
        .expect(201)

      expect(res.body.bindingRevision).toBe(2)
      expect(service.approveCandidate).toHaveBeenCalled()
    })
  })

  describe('POST /targets/:targetId/business-sources/revoke', () => {
    it('Admin 成功撤回数据源', async () => {
      const res = await request(adminApp.getHttpServer())
        .post(`/targets/${targetId}/business-sources/revoke`)
        .send({
          expectedRevision: 2,
          revocationReason: '源数据已被废弃',
        })
        .expect(201)

      expect(res.body.bindingRevision).toBe(3)
      expect(service.revokeSource).toHaveBeenCalled()
    })
  })

  describe('GET /targets/:targetId/business-records', () => {
    it('TargetOnly 具有 target:read 权限即可读取已批准快照记录', async () => {
      const res = await request(targetOnlyApp.getHttpServer())
        .get(`/targets/${targetId}/business-records?entityType=manufacturer`)
        .expect(200)

      expect(res.body.items).toHaveLength(1)
      expect(res.body.items[0].recordKey).toBe('MFG-1')
      expect(service.listBusinessRecords).toHaveBeenCalled()
    })

    it('游标失效时严格返回 409 Conflict 与 BUSINESS_SOURCE_CURSOR_EXPIRED 错误码', async () => {
      service.listBusinessRecords.mockRejectedValueOnce(
        new ConflictException({
          code: BUSINESS_SOURCE_CURSOR_EXPIRED,
          message: '业务数据源快照已切换或失效，请重置游标重新获取',
          details: { currentSnapshotId: 'snap-2', bindingRevision: 2 },
        }),
      )

      const res = await request(targetOnlyApp.getHttpServer())
        .get(`/targets/${targetId}/business-records?cursor=expired_cursor`)
        .expect(409)

      expect(res.body.code).toBe(BUSINESS_SOURCE_CURSOR_EXPIRED)
      expect(res.body.message).toContain('快照已切换或失效')
      expect(res.body.details.bindingRevision).toBe(2)
    })
  })
})
