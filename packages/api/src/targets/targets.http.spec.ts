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
import { PERMISSIONS, targetAccountSchema, targetListResponseSchema, targetSchema } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { TargetsController } from './targets.controller'
import { TargetsService } from './targets.service'
import { listenForSupertest } from '../__tests__/http-app'

const now = '2026-09-10T00:00:00.000Z'

const target = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'demo-sys',
  name: '演示系统',
  entryUrl: 'https://example.com/#/home',
  loginUrl: null,
  authMethod: 'password' as const,
  captchaMode: 'none' as const,
  status: 'active' as const,
  loginFields: null,
  accountCount: 0,
  createdAt: now,
  updatedAt: now,
}

const account = {
  id: '22222222-2222-4222-8222-222222222222',
  targetId: target.id,
  displayName: '运维',
  username: 'ops',
  hasPassword: true,
  status: 'active' as const,
  createdAt: now,
  updatedAt: now,
}

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
  permissions: ['target:read', 'audit:read'],
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
    listTargets: vi.fn(async () => ({ items: [target] })),
    getTarget: vi.fn(async () => target),
    createTarget: vi.fn(async () => target),
    updateTarget: vi.fn(async () => target),
    updateSessionPolicy: vi.fn(async () => target),
    previewDeleteTarget: vi.fn(async () => ({
      resourceId: target.id,
      resourceType: 'target' as const,
      activeRuns: 0,
      activeLeases: 0,
      cascadeSummary: {
        scenarios: 0,
        targetAccounts: 0,
        recordingDrafts: 0,
        runs: 0,
        storedObjects: 0,
      },
    })),
    deleteTarget: vi.fn(async () => ({
      resourceId: target.id,
      resourceType: 'target' as const,
      status: 'completed' as const,
      totalObjects: 0,
      purgedObjects: 0,
      failedObjects: 0,
      totalBytes: 0,
      purgedBytes: 0,
      lastError: null,
      completedAt: now,
    })),
    getTargetCleanupStatus: vi.fn(async () => ({
      resourceId: target.id,
      resourceType: 'target' as const,
      status: 'completed' as const,
      totalObjects: 0,
      purgedObjects: 0,
      failedObjects: 0,
      totalBytes: 0,
      purgedBytes: 0,
      lastError: null,
      completedAt: now,
    })),
    retryTargetCleanup: vi.fn(async () => ({
      resourceId: target.id,
      resourceType: 'target' as const,
      status: 'completed' as const,
      totalObjects: 0,
      purgedObjects: 0,
      failedObjects: 0,
      totalBytes: 0,
      purgedBytes: 0,
      lastError: null,
      completedAt: now,
    })),
    listAccounts: vi.fn(async () => ({ items: [account] })),
    createAccount: vi.fn(async () => account),
    updateAccount: vi.fn(async () => ({ ...account, hasPassword: false })),
    deleteAccount: vi.fn(async () => undefined),
    getAuthProfile: vi.fn(async () => ({ current: null, history: [], accounts: [] })),
    publishAuthProfile: vi.fn(async () => ({ current: null, history: [], accounts: [] })),
    updateAccountIdentity: vi.fn(async () => account),
    startAuthValidation: vi.fn(async () => ({ operation: { id: account.id }, created: true })),
    getAuthValidation: vi.fn(async () => ({ id: account.id })),
    observeAuthValidation: vi.fn(async () => ({ id: account.id })),
    validationBrowserMeta: vi.fn(async () => ({ framesAvailable: false })),
    getAccessPolicy: vi.fn(async () => ({
      targetId: target.id,
      revision: 0,
      policy: {
        schemaVersion: 1,
        policyVersion: 1,
        rules: [{ origin: 'https://example.com', purpose: 'business_surface', effect: 'allow' }],
      },
      seeded: true,
      resourceLoadsUnrestricted: true,
      updatedAt: now,
    })),
    updateAccessPolicy: vi.fn(async () => ({
      targetId: target.id,
      revision: 1,
      policy: {
        schemaVersion: 1,
        policyVersion: 1,
        rules: [{ origin: 'https://example.com', purpose: 'business_surface', effect: 'allow' }],
      },
      seeded: false,
      resourceLoadsUnrestricted: true,
      updatedAt: now,
    })),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [TargetsController],
    providers: [
      Reflector,
      { provide: TargetsService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('Targets HTTP', () => {
  const service = mockService()
  let adminApp: INestApplication
  let viewerApp: INestApplication
  let anonApp: INestApplication

  beforeAll(async () => {
    adminApp = await buildApp(adminPrincipal, service)
    viewerApp = await buildApp(viewerPrincipal, service)
    anonApp = await buildApp(null, service)
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterAll(async () => {
    await adminApp?.close()
    await viewerApp?.close()
    await anonApp?.close()
  })

  it('未认证 401', async () => {
    await request(anonApp.getHttpServer()).get('/targets').expect(401)
    expect(service.listTargets).not.toHaveBeenCalled()
  })

  it('GET /targets 符合契约', async () => {
    const res = await request(adminApp.getHttpServer()).get('/targets').expect(200)
    expect(() => targetListResponseSchema.parse(res.body)).not.toThrow()
    for (const item of res.body.items) {
      expect(item).not.toHaveProperty('password')
    }
  })

  it('只有 target:delete 不能删除目标系统', async () => {
    const onlyTargetDelete = await buildApp(
      {
        ...adminPrincipal,
        id: 'acc-target-delete',
        permissions: ['target:read', 'target:delete'],
      },
      service,
    )
    try {
      await request(onlyTargetDelete.getHttpServer()).post(`/targets/${target.id}/delete`).expect(403)
      expect(service.deleteTarget).not.toHaveBeenCalled()
    } finally {
      await onlyTargetDelete.close()
    }
  })

  it('viewer 可读不能写', async () => {
    await request(viewerApp.getHttpServer()).get('/targets').expect(200)
    await request(viewerApp.getHttpServer())
      .post('/targets')
      .send({ code: 'demo-sys', name: '演示', entryUrl: 'https://example.com' })
      .expect(403)
    expect(service.createTarget).not.toHaveBeenCalled()
  })

  it('创建合法目标系统 201', async () => {
    const res = await request(adminApp.getHttpServer())
      .post('/targets')
      .send({ code: 'demo-sys', name: '演示', entryUrl: 'https://example.com/#/home' })
      .expect(201)
    expect(() => targetSchema.parse(res.body)).not.toThrow()
  })

  it('code 只给 1 个字符 400', async () => {
    const res = await request(adminApp.getHttpServer())
      .post('/targets')
      .send({ code: 'a', name: '演示', entryUrl: 'https://example.com' })
      .expect(400)
    expect(res.body.code).toBe('BAD_REQUEST')
    expect(service.createTarget).not.toHaveBeenCalled()
  })

  it('无 scheme 或内嵌凭据 400', async () => {
    await request(adminApp.getHttpServer())
      .post('/targets')
      .send({ code: 'bad-url', name: 'x', entryUrl: 'example.com' })
      .expect(400)
    await request(adminApp.getHttpServer())
      .post('/targets')
      .send({ code: 'bad-cred', name: 'x', entryUrl: 'https://u:p@example.com' })
      .expect(400)
  })

  it('更新返回 200，删除返回 200', async () => {
    await request(adminApp.getHttpServer())
      .post(`/targets/${target.id}`)
      .send({ name: '新名称' })
      .expect(200)
    const res = await request(adminApp.getHttpServer()).post(`/targets/${target.id}/delete`).expect(200)
    expect(res.body).toMatchObject({ resourceId: target.id, resourceType: 'target' })
  })

  it('创建可带 loginFields 与首个账号，响应无 password 字段', async () => {
    const res = await request(adminApp.getHttpServer())
      .post('/targets')
      .send({
        code: 'demo-sys',
        name: '演示',
        entryUrl: 'https://example.com',
        loginFields: { username: { by: 'id', value: 'username' } },
        account: {
          displayName: '演示',
          username: 'demo',
          password: 'hunter2',
          validity: { mode: 'days', amount: 90, timeZone: 'Asia/Shanghai' },
        },
      })
      .expect(201)
    expect(() => targetSchema.parse(res.body)).not.toThrow()
    expect(res.body).not.toHaveProperty('password')
    expect(JSON.stringify(res.body)).not.toContain('hunter2')
    expect(service.createTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        loginFields: { username: { by: 'id', value: 'username' } },
        account: expect.objectContaining({ username: 'demo', password: 'hunter2' }),
      }),
      expect.anything(),
    )
  })

  it('非法 locator.by 400', async () => {
    await request(adminApp.getHttpServer())
      .post('/targets')
      .send({
        code: 'bad-by',
        name: 'x',
        entryUrl: 'https://example.com',
        loginFields: { username: { by: 'xpath', value: '//input' } },
      })
      .expect(400)
    expect(service.createTarget).not.toHaveBeenCalled()
  })

  it('更新体带 account 400', async () => {
    const res = await request(adminApp.getHttpServer())
      .post(`/targets/${target.id}`)
      .send({ name: '新名称', account: { displayName: '甲', username: 'a' } })
      .expect(400)
    expect(res.body.code).toBe('BAD_REQUEST')
    expect(service.updateTarget).not.toHaveBeenCalled()
  })

  it('更新体带 code 400', async () => {
    const res = await request(adminApp.getHttpServer())
      .post(`/targets/${target.id}`)
      .send({ code: 'new-code', name: 'x' })
      .expect(400)
    expect(res.body.code).toBe('BAD_REQUEST')
    expect(service.updateTarget).not.toHaveBeenCalled()
  })

  it('领域码 TARGET_CODE_CONFLICT 原样透传', async () => {
    service.createTarget.mockRejectedValueOnce(
      new ConflictException({ code: 'TARGET_CODE_CONFLICT', message: '目标系统编码已存在' }),
    )
    const res = await request(adminApp.getHttpServer())
      .post('/targets')
      .send({ code: 'demo-sys', name: '演示', entryUrl: 'https://example.com' })
      .expect(409)
    expect(res.body.code).toBe('TARGET_CODE_CONFLICT')
  })

  it('领域码 TARGET_HAS_ACCOUNTS 原样透传', async () => {
    service.deleteTarget.mockRejectedValueOnce(
      new ConflictException({ code: 'TARGET_HAS_ACCOUNTS', message: '请先删除该目标系统下的目标账号' }),
    )
    const res = await request(adminApp.getHttpServer()).post(`/targets/${target.id}/delete`).expect(409)
    expect(res.body.code).toBe('TARGET_HAS_ACCOUNTS')
  })

  it('领域码 TARGET_HAS_SCENARIOS / TARGET_ACCOUNT_HAS_RUNS 原样透传', async () => {
    service.deleteTarget.mockRejectedValueOnce(
      new ConflictException({ code: 'TARGET_HAS_SCENARIOS', message: '请先删除该目标系统下的场景' }),
    )
    const hasScenarios = await request(adminApp.getHttpServer())
      .post(`/targets/${target.id}/delete`)
      .expect(409)
    expect(hasScenarios.body.code).toBe('TARGET_HAS_SCENARIOS')

    service.deleteAccount.mockRejectedValueOnce(
      new ConflictException({ code: 'TARGET_ACCOUNT_HAS_RUNS', message: '请先处理引用该目标账号的运行' }),
    )
    const hasRuns = await request(adminApp.getHttpServer())
      .post(`/targets/${target.id}/accounts/${account.id}/delete`)
      .expect(409)
    expect(hasRuns.body.code).toBe('TARGET_ACCOUNT_HAS_RUNS')
  })

  it('目标不存在 404 TARGET_NOT_FOUND', async () => {
    service.getTarget.mockRejectedValueOnce(
      new NotFoundException({ code: 'TARGET_NOT_FOUND', message: '目标系统不存在' }),
    )
    const res = await request(adminApp.getHttpServer()).get('/targets/missing').expect(404)
    expect(res.body.code).toBe('TARGET_NOT_FOUND')
  })

  it('创建账号带密码但没有维护期限 400', async () => {
    await request(adminApp.getHttpServer())
      .post(`/targets/${target.id}/accounts`)
      .send({ displayName: '运维', username: 'ops', password: 'hunter2' })
      .expect(400)
  })

  it('创建账号响应无 password 字段', async () => {
    const res = await request(adminApp.getHttpServer())
      .post(`/targets/${target.id}/accounts`)
      .send({
        displayName: '运维',
        username: 'ops',
        password: 'hunter2',
        validity: { mode: 'days', amount: 90, timeZone: 'Asia/Shanghai' },
      })
      .expect(201)
    expect(() => targetAccountSchema.parse(res.body)).not.toThrow()
    expect(res.body).not.toHaveProperty('password')
    expect(JSON.stringify(res.body)).not.toContain('hunter2')
  })

  it('password 与 clearPassword 同时给出 400', async () => {
    await request(adminApp.getHttpServer())
      .post(`/targets/${target.id}/accounts/${account.id}`)
      .send({ password: 'x', clearPassword: true })
      .expect(400)
    expect(service.updateAccount).not.toHaveBeenCalled()
  })

  it('更新账号带 provider 400', async () => {
    await request(adminApp.getHttpServer())
      .post(`/targets/${target.id}/accounts/${account.id}`)
      .send({ provider: 'local', displayName: '甲' })
      .expect(400)
  })

  it('更新账号返回 200，删除账号返回 200', async () => {
    await request(adminApp.getHttpServer())
      .post(`/targets/${target.id}/accounts/${account.id}`)
      .send({ displayName: '值班' })
      .expect(200)
    await request(adminApp.getHttpServer())
      .post(`/targets/${target.id}/accounts/${account.id}/delete`)
      .expect(200)
  })

  it('GET 账号列表无 password 字段', async () => {
    const res = await request(adminApp.getHttpServer())
      .get(`/targets/${target.id}/accounts`)
      .expect(200)
    expect(res.body.items[0]).not.toHaveProperty('password')
    expect(res.body.items[0]).toHaveProperty('hasPassword')
  })

  it('认证规则读用 target:read，写与验收用 target:write', async () => {
    await request(viewerApp.getHttpServer()).get(`/targets/${target.id}/auth-profile`).expect(200)
    expect(service.getAuthProfile).toHaveBeenCalledWith(target.id)
    await request(viewerApp.getHttpServer())
      .post(`/targets/${target.id}/auth-profile`)
      .send({
        expectedRevision: 0,
        definition: {
          verify: { mode: 'http', success: { status: 200 }, failure: { status: 401 } },
          scope: { origins: ['https://example.com'], pathPrefixes: ['/'] },
        },
      })
      .expect(403)
    await request(adminApp.getHttpServer())
      .post(`/targets/${target.id}/accounts/${account.id}/identity`)
      .send({ expectedRevision: 1, expectedIdentity: 'alice' })
      .expect(200)
    expect(service.updateAccountIdentity).toHaveBeenCalled()
    await request(adminApp.getHttpServer())
      .post(`/targets/${target.id}/auth-profile/validations`)
      .send({
        targetAccountId: account.id,
        expectedRevision: 1,
        idempotencyKey: 'validate-profile-1',
      })
      .expect(202)
    expect(service.startAuthValidation).toHaveBeenCalled()
  })

  it('删除有待清理对象时返回 202', async () => {
    service.deleteTarget.mockResolvedValueOnce({
      resourceId: target.id,
      resourceType: 'target',
      status: 'pending',
      totalObjects: 3,
      purgedObjects: 0,
      failedObjects: 0,
      totalBytes: 512,
      purgedBytes: 0,
    })
    const res = await request(adminApp.getHttpServer()).post(`/targets/${target.id}/delete`).expect(202)
    expect(res.body.totalObjects).toBe(3)
  })

  it('读取授权需要 map:read，写入需要 target:write', async () => {
    await request(viewerApp.getHttpServer()).get(`/targets/${target.id}/access-policy`).expect(403)
    await request(adminApp.getHttpServer()).get(`/targets/${target.id}/access-policy`).expect(200)
    expect(service.getAccessPolicy).toHaveBeenCalledWith(target.id)
    await request(adminApp.getHttpServer())
      .post(`/targets/${target.id}/access-policy`)
      .send({
        expectedRevision: 0,
        idempotencyKey: 'access-policy-1',
        reason: '确认业务域',
        rules: [{ origin: 'https://example.com', purpose: 'business_surface', effect: 'allow' }],
      })
      .expect(200)
    expect(service.updateAccessPolicy).toHaveBeenCalled()
  })

  it('POST /targets/:id/session-policy 写入目标会话策略', async () => {
    await request(adminApp.getHttpServer())
      .post(`/targets/${target.id}/session-policy`)
      .send({ reclaim: 'AUTH_DRIVEN', keepAliveSeconds: 1800 })
      .expect(200)
    expect(service.updateSessionPolicy).toHaveBeenCalledWith(
      target.id,
      { reclaim: 'AUTH_DRIVEN', keepAliveSeconds: 1800 },
      expect.anything(),
    )
    await request(viewerApp.getHttpServer())
      .post(`/targets/${target.id}/session-policy`)
      .send({ reclaim: 'IDLE' })
      .expect(403)
  })
})
