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
import { CredentialsController } from './credentials.controller'
import { CredentialsService } from './credentials.service'

const credentialId = '11111111-1111-4111-8111-111111111111'
const credential = {
  id: credentialId,
  type: 'target_password',
  source: 'target_account',
  name: '演示账号',
  safeIdentifier: 'alice',
  subjectLabel: '演示目标',
  targetId: '22222222-2222-4222-8222-222222222222',
  targetAccountId: credentialId,
  revision: 1,
  managementStatus: 'active',
  maintenanceStatus: 'unknown',
  maintenanceDueAt: null,
  validityStartedAt: null,
  validityPolicy: { mode: 'unknown', amount: null, timeZone: null },
  issuerExpiresAt: null,
  issuerExpirySource: 'unknown',
  verificationStatus: 'pending',
  identityBindingStatus: 'confirmed',
  ownerConsoleAccountId: null,
  ownerDisplayName: null,
  ownerStatus: 'unclaimed',
  session: {
    browser: 'unprepared',
    auth: 'unknown',
    identityState: 'UNVERIFIED',
    occupancy: 'idle',
    sessionId: null,
    generation: null,
    observedAt: null,
    lastAuthCheckedAt: null,
    lastAuthSuccessAt: null,
    occupyingLabel: null,
  },
  capabilities: {
    canReplace: true,
    canSetMaintenance: true,
    canVerify: true,
    canDisable: true,
    externallyRenewed: false,
  },
  currentVersionId: null,
  updatedAt: '2026-09-19T00:00:00.000Z',
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
  permissions: ['target:read', 'credential:read'],
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
    list: vi.fn(async () => ({ items: [credential], stats: { visible: 1, approaching: 0, due: 0, unknown: 1, authAbnormal: 0, pendingVerification: 1, unclaimed: 1 }, asOf: credential.updatedAt, realtime: true })),
    get: vi.fn(async () => ({ ...credential, notes: null, purpose: null, tags: [], expiryReminderLeadDays: 14, policyRevision: 1, currentVersion: null, domainHref: '/targets/x', sessionHref: null })),
    usages: vi.fn(async () => ({ asOf: credential.updatedAt, items: [], withheld: false })),
    history: vi.fn(async () => ({ items: [] })),
    register: vi.fn(async () => credential),
    metadata: vi.fn(async () => ({ ...credential, revision: 2 })),
    replace: vi.fn(async () => ({ ...credential, revision: 2 })),
    disable: vi.fn(async () => ({ ...credential, managementStatus: 'disabled', revision: 2 })),
    enable: vi.fn(async () => ({ ...credential, revision: 3 })),
    revoke: vi.fn(async () => ({ ...credential, revision: 2 })),
    createBatch: vi.fn(async () => ({ batchId: credentialId, kind: 'password_replace', items: [], createdAt: credential.createdAt })),
    getBatch: vi.fn(async () => ({ batchId: credentialId, kind: 'password_replace', items: [], createdAt: credential.createdAt })),
    submitBatchItem: vi.fn(async () => ({ batchId: credentialId, kind: 'password_replace', items: [], createdAt: credential.createdAt })),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [CredentialsController],
    providers: [
      Reflector,
      { provide: CredentialsService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('Credentials HTTP', () => {
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

  it('凭据查看能力开放列表；只读用户不能写入或导入', async () => {
    await request(viewerApp.getHttpServer()).get('/credentials').expect(200)
    expect(service.list).toHaveBeenCalled()
    await request(viewerApp.getHttpServer()).post(`/credentials/${credentialId}/metadata`).send({ expectedRevision: 1, name: '越权' }).expect(403)
    await request(viewerApp.getHttpServer()).post('/credentials/import/resolve').send({ version: 1, rows: [{ row: 2, credentialId }] }).expect(403)
    expect(service.metadata).not.toHaveBeenCalled()
  })

  it('业务接口只用 GET 读取和 POST 变更', async () => {
    await request(adminApp.getHttpServer()).get(`/credentials/${credentialId}`).expect(200)
    await request(adminApp.getHttpServer())
      .post(`/credentials/${credentialId}/metadata`)
      .send({ expectedRevision: 1, name: '新名称' })
      .expect(200)
    expect(service.metadata).toHaveBeenCalled()
    await request(adminApp.getHttpServer()).put(`/credentials/${credentialId}`).expect(404)
  })

  it('替换必须带维护期限', async () => {
    await request(adminApp.getHttpServer())
      .post(`/credentials/${credentialId}/replace`)
      .send({ expectedRevision: 1, password: 'next-secret' })
      .expect(400)
    expect(service.replace).not.toHaveBeenCalled()
  })

  it('管理员可登记批次并逐项提交', async () => {
    await request(adminApp.getHttpServer())
      .post('/credentials/batches')
      .send({
        kind: 'metadata',
        idempotencyKey: 'batch-01',
        items: [{ itemId: credentialId, credentialId, expectedRevision: 1 }],
      })
      .expect(200)
    expect(service.createBatch).toHaveBeenCalled()
    await request(adminApp.getHttpServer()).get(`/credentials/batches/${credentialId}`).expect(200)
  })
})
