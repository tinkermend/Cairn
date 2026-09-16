import {
  type CanActivate,
  type ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RbacStore, TargetsStore, type DbHandle } from '@cairn/db'
import { openIsolatedDb, expose, newId } from '@cairn/db/testing'
import { PERMISSIONS, type ModuleContent } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter.js'
import type { RequestAccount } from '../common/request-account.js'
import { PermissionsGuard } from '../rbac/permissions.guard.js'
import { ActionModulesController } from './action-modules.controller.js'
import { ActionModulesService } from './action-modules.service.js'
import { listenForSupertest } from '../__tests__/http-app.js'

const now = '2026-09-16T00:00:00.000Z'
const dummyModule = {
  id: '33333333-3333-4333-8333-333333333333',
  targetId: '11111111-1111-4111-8111-111111111111',
  key: 'order.query',
  name: '查询订单',
  description: '查询详情',
  capabilityKey: 'order',
  tags: ['order'],
  aliases: ['查单'],
  intentExamples: ['查一下订单'],
  draftRevision: 0,
  draftContent: null,
  createdAt: now,
  updatedAt: now,
}

const admin: RequestAccount = {
  id: 'acc-admin',
  displayName: 'Admin',
  email: 'admin@example.com',
  status: 'active',
  roles: [{ id: 'admin', key: 'admin', name: 'Administrator', kind: 'system' }],
  permissions: [...PERMISSIONS],
}

const reader: RequestAccount = {
  ...admin,
  id: 'acc-reader',
  permissions: ['module:read', 'target:read'],
}

const writerNoPublish: RequestAccount = {
  ...admin,
  id: 'acc-writer-no-pub',
  permissions: ['module:read', 'module:write', 'target:read'],
}

const anonymous: RequestAccount = {
  ...admin,
  id: 'acc-anon',
  permissions: [],
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
    list: vi.fn(async () => ({ items: [dummyModule], total: 1, page: 1, pageSize: 20 })),
    get: vi.fn(async () => dummyModule),
    create: vi.fn(async () => dummyModule),
    updateMeta: vi.fn(async () => dummyModule),
    saveDraft: vi.fn(async () => dummyModule),
    publish: vi.fn(async () => dummyModule),
    listVersions: vi.fn(async () => ({ items: [] })),
    getVersion: vi.fn(async () => ({ id: 'v1', versionNo: 1 })),
    delete: vi.fn(async () => ({ ok: true })),
    trial: vi.fn(async () => ({ id: 'run-trial-1', status: 'QUEUED' })),
    listReferences: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })),
    batchUpgrade: vi.fn(async () => ({ toVersionId: 'v2', results: [] })),
    updatePublication: vi.fn(async () => ({ id: 'v1', publicationStatus: 'deprecated' })),
    disableAffected: vi.fn(async () => ({ results: [] })),
    previewDelete: vi.fn(async () => ({ draftReferences: [], publishedReferences: [], verificationScenarioId: null, blockers: [] })),
    resolve: vi.fn(async () => ({ requestId: 'req-1', status: 'no_match', candidates: [], inputSuggestions: {}, unknowns: [], outcome: 'pending' })),
    getResolution: vi.fn(async () => ({ requestId: 'req-1', status: 'no_match', candidates: [], inputSuggestions: {}, unknowns: [], outcome: 'pending' })),
    closeResolution: vi.fn(async () => ({ requestId: 'req-1', status: 'no_match', candidates: [], inputSuggestions: {}, unknowns: [], outcome: 'abandoned' })),
    quality: vi.fn(async () => ({
      moduleId: dummyModule.id,
      windowDays: 7,
      groupBy: 'none',
      asOf: now,
      configRevision: 2,
      health: { signal: 'unknown', sampleCount: 0, verifiedRate: null, windowDays: 7, configRevision: 2, asOf: now },
      overall: { calls: 0, verified: 0, failedImplementation: 0, failedVerification: 0, externalInfra: 0, needsReview: 0, notReached: 0, cancelled: 0, unknown: 0, insufficient: 0, retriedSuccess: 0, sampleCount: 0, verifiedRate: null, durationMsP50: null, durationMsP95: null, aiCalls: 0, aiCost: null, lastVerifiedAt: null },
      trial: { calls: 0, verified: 0, failedImplementation: 0, failedVerification: 0, externalInfra: 0, needsReview: 0, notReached: 0, cancelled: 0, unknown: 0, insufficient: 0, retriedSuccess: 0, sampleCount: 0, verifiedRate: null, durationMsP50: null, durationMsP95: null, aiCalls: 0, aiCost: null, lastVerifiedAt: null },
      pendingBackfill: 0,
    })),
    invocations: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20, asOf: now })),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService> | ActionModulesService) {
  const moduleRef = await Test.createTestingModule({
    controllers: [ActionModulesController],
    providers: [
      Reflector,
      { provide: ActionModulesService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('ActionModules HTTP API', () => {
  const service = mockService()
  let adminApp: INestApplication
  let readerApp: INestApplication
  let writerNoPublishApp: INestApplication
  let noPermApp: INestApplication
  let noTargetApp: INestApplication

  beforeAll(async () => {
    adminApp = await buildApp(admin, service)
    readerApp = await buildApp(reader, service)
    writerNoPublishApp = await buildApp(writerNoPublish, service)
    noTargetApp = await buildApp({ ...admin, permissions: ['module:read', 'module:write', 'module:publish', 'workflow:write'] }, service)
    noPermApp = await buildApp(anonymous, service)
  })

  afterAll(async () => {
    await adminApp.close()
    await readerApp.close()
    await writerNoPublishApp.close()
    await noPermApp.close()
    await noTargetApp.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['get', '/action-modules'], ['get', `/action-modules/${dummyModule.id}`],
    ['get', `/action-modules/${dummyModule.id}/versions`], ['get', `/action-modules/${dummyModule.id}/versions/v1`],
    ['post', '/action-modules'], ['post', `/action-modules/${dummyModule.id}`],
    ['post', `/action-modules/${dummyModule.id}/draft`], ['post', `/action-modules/${dummyModule.id}/publish`],
    ['post', `/action-modules/${dummyModule.id}/delete`], ['post', `/action-modules/${dummyModule.id}/trial`],
    ['get', `/action-modules/${dummyModule.id}/references`],
    ['get', `/action-modules/${dummyModule.id}/delete-preview`],
    ['post', `/action-modules/${dummyModule.id}/batch-upgrade-drafts`],
    ['post', `/action-modules/${dummyModule.id}/disable-affected-scenarios`],
    ['post', `/action-modules/${dummyModule.id}/versions/v1/publication`],
    ['post', '/action-modules/resolve'],
    ['get', `/action-modules/resolutions/${dummyModule.id}`],
    ['post', `/action-modules/resolutions/${dummyModule.id}/close`],
  ] as const)('没有 Target 可见权限时 %s %s 返回 403', async (method, path) => {
    const res = await request(noTargetApp.getHttpServer())[method](path).send({})
    expect(res.status).toBe(403)
    expect(Object.values(service).every((fn) => fn.mock.calls.length === 0)).toBe(true)
  })

  describe('GET /action-modules', () => {
    it('无权限返回 403', async () => {
      const res = await request(noPermApp.getHttpServer()).get('/action-modules')
      expect(res.status).toBe(403)
    })

    it('有 module:read 返回 200', async () => {
      const res = await request(readerApp.getHttpServer()).get('/action-modules')
      expect(res.status).toBe(200)
      expect(service.list).toHaveBeenCalled()
    })
  })

  describe('POST /action-modules', () => {
    it('只读用户返回 403', async () => {
      const res = await request(readerApp.getHttpServer())
        .post('/action-modules')
        .send({
          idempotencyKey: 'http-request',
          targetId: dummyModule.targetId,
          key: 'test.create',
          name: '测试',
        })
      expect(res.status).toBe(403)
    })

    it('非法 key 格式返回 400', async () => {
      const res = await request(adminApp.getHttpServer())
        .post('/action-modules')
        .send({
          idempotencyKey: 'http-request',
          targetId: dummyModule.targetId,
          key: 'Invalid_Key!',
          name: '测试',
        })
      expect(res.status).toBe(400)
    })

    it('合法参数创建成功返回 201', async () => {
      const res = await request(adminApp.getHttpServer())
        .post('/action-modules')
        .send({
          idempotencyKey: 'http-request',
          targetId: dummyModule.targetId,
          key: 'valid.key',
          name: '测试模块',
        })
      expect(res.status).toBe(201)
      expect(service.create).toHaveBeenCalled()
    })
  })

  describe('POST /action-modules/:id/publish', () => {
    it('只有 write 无 publish 权限的用户发布返回 403', async () => {
      const res = await request(writerNoPublishApp.getHttpServer())
        .post(`/action-modules/${dummyModule.id}/publish`)
        .send({
          idempotencyKey: 'http-request',
          expectedRevision: 1,
        })
      expect(res.status).toBe(403)
    })

    it('有 publish 权限的用户发布返回 200', async () => {
      const res = await request(adminApp.getHttpServer())
        .post(`/action-modules/${dummyModule.id}/publish`)
        .send({
          idempotencyKey: 'http-request',
          expectedRevision: 1,
        })
      expect(res.status).toBe(200)
      expect(service.publish).toHaveBeenCalled()
    })
  })

  describe('POST /action-modules/:id/delete', () => {
    it('只读用户删除返回 403', async () => {
      const res = await request(readerApp.getHttpServer())
        .post(`/action-modules/${dummyModule.id}/delete`)
      expect(res.status).toBe(403)
    })

    it('有 write 权限的用户删除返回 200', async () => {
      const res = await request(writerNoPublishApp.getHttpServer())
        .post(`/action-modules/${dummyModule.id}/delete`)
      expect(res.status).toBe(200)
      expect(service.delete).toHaveBeenCalled()
    })
  })

  describe('GET /action-modules/:id/quality', () => {
    it('只读用户可以读取质量摘要', async () => {
      const res = await request(readerApp.getHttpServer()).get(`/action-modules/${dummyModule.id}/quality`)
      expect(res.status).toBe(200)
      expect(res.body.configRevision).toBe(2)
      expect(service.quality).toHaveBeenCalled()
    })

    it('缺少 target:read 时质量接口 403', async () => {
      const res = await request(noTargetApp.getHttpServer()).get(`/action-modules/${dummyModule.id}/quality`)
      expect(res.status).toBe(403)
    })

    it('配置读取失败时返回错误，不回落默认值', async () => {
      const { ServiceUnavailableException } = await import('@nestjs/common')
      service.quality.mockRejectedValueOnce(new ServiceUnavailableException({ code: 'PLATFORM_CONFIG_UNAVAILABLE', message: '平台配置不可用' }))
      const res = await request(adminApp.getHttpServer()).get(`/action-modules/${dummyModule.id}/quality`)
      expect(res.status).toBe(503)
      expect(res.body.health).toBeUndefined()
      expect(res.body.overall).toBeUndefined()
    })
  })

  describe('GET /action-modules/:id/invocations', () => {
    it('只有 module:read 没有 run:read 时 403', async () => {
      const res = await request(readerApp.getHttpServer()).get(`/action-modules/${dummyModule.id}/invocations`)
      expect(res.status).toBe(403)
      expect(service.invocations).not.toHaveBeenCalled()
    })

    it('具备 run:read 时返回调用列表', async () => {
      const res = await request(adminApp.getHttpServer()).get(`/action-modules/${dummyModule.id}/invocations`)
      expect(res.status).toBe(200)
      expect(service.invocations).toHaveBeenCalled()
    })
  })

  describe('POST /action-modules/:id/trial', () => {
    it('只读用户试跑返回 403', async () => {
      const res = await request(readerApp.getHttpServer())
        .post(`/action-modules/${dummyModule.id}/trial`)
        .send({})
      expect(res.status).toBe(403)
    })

    it('缺少 run:execute 的编写者试跑返回 403', async () => {
      const res = await request(writerNoPublishApp.getHttpServer())
        .post(`/action-modules/${dummyModule.id}/trial`)
        .send({})
      expect(res.status).toBe(403)
      expect(service.trial).not.toHaveBeenCalled()
    })

    it('有 module:write 与 run:execute 的用户试跑返回 200 并启动隔离试跑', async () => {
      const res = await request(adminApp.getHttpServer())
        .post(`/action-modules/${dummyModule.id}/trial`)
        .send({ inputs: { customParam: '123' } })
      expect(res.status).toBe(200)
      expect(service.trial).toHaveBeenCalledWith(
        dummyModule.id,
        { inputs: { customParam: '123' } },
        expect.anything(),
      )
    })
  })

  describe('AM-C 引用与发布状态', () => {
    it('只读用户可以读引用，不能改发布状态', async () => {
      const refs = await request(readerApp.getHttpServer()).get(`/action-modules/${dummyModule.id}/references`)
      expect(refs.status).toBe(200)
      const pub = await request(readerApp.getHttpServer())
        .post(`/action-modules/${dummyModule.id}/versions/v1/publication`)
        .send({ status: 'deprecated', reason: '准备升级' })
      expect(pub.status).toBe(403)
      expect(service.updatePublication).not.toHaveBeenCalled()
    })

    it('发布者可以弃用版本', async () => {
      const res = await request(adminApp.getHttpServer())
        .post(`/action-modules/${dummyModule.id}/versions/v1/publication`)
        .send({ status: 'deprecated', reason: '准备升级' })
      expect(res.status).toBe(200)
      expect(service.updatePublication).toHaveBeenCalled()
    })
  })

  describe('AM-D 编写期映射', () => {
    const resolveBody = {
      targetId: dummyModule.targetId,
      expression: '查询订单',
      mode: 'rules',
      idempotencyKey: 'resolve-01',
    }

    it('无权限不能解析或关闭', async () => {
      await request(noPermApp.getHttpServer()).post('/action-modules/resolve').send(resolveBody).expect(403)
      await request(noPermApp.getHttpServer()).get(`/action-modules/resolutions/${dummyModule.id}`).expect(403)
      await request(noPermApp.getHttpServer())
        .post(`/action-modules/resolutions/${dummyModule.id}/close`)
        .send({ outcome: 'abandoned' })
        .expect(403)
      expect(service.resolve).not.toHaveBeenCalled()
      expect(service.closeResolution).not.toHaveBeenCalled()
    })

    it('有 module:read 与 target:read 可以解析、读取和关闭', async () => {
      const resolved = await request(readerApp.getHttpServer()).post('/action-modules/resolve').send(resolveBody).expect(200)
      expect(resolved.body.requestId).toBe('req-1')
      expect(service.resolve).toHaveBeenCalled()
      await request(readerApp.getHttpServer()).get(`/action-modules/resolutions/${dummyModule.id}`).expect(200)
      await request(readerApp.getHttpServer())
        .post(`/action-modules/resolutions/${dummyModule.id}/close`)
        .send({ outcome: 'abandoned' })
        .expect(200)
      expect(service.closeResolution).toHaveBeenCalled()
    })
  })
})


describe('ActionModules real HTTP → database', () => {
  let handle: Awaited<ReturnType<typeof openIsolatedDb>>
  let db: DbHandle
  let account: RequestAccount
  let app: INestApplication
  let targets: TargetsStore
  let targetId: string
  const content: ModuleContent = {
    contract: { inputs: [], outputs: [], effectCeiling: 'READ_ONLY', preconditions: [], postconditions: [{ meaning: '页面正确', verification: { kind: 'step', stepId: '77777777-7777-4777-8777-777777777777' } }] },
    implementations: [{ implementationKey: 'default', kind: 'structured_steps', steps: [{ id: '77777777-7777-4777-8777-777777777777', name: '结果断言', type: 'assert', effectType: 'READ_ONLY', input: { expect: { kind: 'text_contains', value: '成功' } } }], outputMapping: {} }],
  }
  beforeAll(async () => {
    handle = await openIsolatedDb(`cairn_am_http_${newId().replaceAll('-', '')}`)
    db = expose(handle)
    const rbac = new RbacStore(db, { hash: async (v) => v, verify: async (v, h) => v === h })
    const role = (await rbac.listRoles()).items.find((r) => r.key === 'admin')!
    const created = await rbac.createAccount({ email: 'review@example.test', displayName: '模块复查', password: 'Fixture-password-123', roleIds: [role.id] }, null)
    account = { ...admin, id: created.id }
    targets = new TargetsStore(db, () => Buffer.from('fixture'))
    targetId = (await targets.createTarget({ loginFields: null, authMethod: 'manual', captchaMode: 'none', status: 'active', name: '隔离目标', code: 'am-review', entryUrl: 'https://example.test' }, account)).id
    app = await buildApp(account, new ActionModulesService(db))
  })
  afterAll(async () => { await app?.close(); await handle?.close() })
  it('创建/发布重复请求稳定，元数据 OCC 与草稿 OCC 共享 revision', async () => {
    const server = app.getHttpServer()
    const body = { targetId, key: 'review.http', name: 'HTTP复查', idempotencyKey: newId() }
    const created = await request(server).post('/action-modules').send(body).expect(201)
    const retry = await request(server).post('/action-modules').send(body).expect(201)
    expect(retry.body).toEqual(created.body)
    const path = `/action-modules/${created.body.id}`
    await request(server).post(path).send({ baseRevision: 0, name: '新名称' }).expect(200)
    const conflict = await request(server).post(`${path}/draft`).send({ baseRevision: 0, content }).expect(409)
    expect(conflict.body.code).toBe('MODULE_DRAFT_CONFLICT')
    await request(server).post(`${path}/draft`).send({ baseRevision: 1, content }).expect(200)
    const pubBody = { expectedRevision: 2, idempotencyKey: newId() }
    const pub = await request(server).post(`${path}/publish`).send(pubBody).expect(200)
    expect(pub.body.latestVersionNo).toBe(1)
    const again = await request(server).post(`${path}/publish`).send(pubBody).expect(200)
    expect(again.body).toEqual(pub.body)
    const versions = await request(server).get(`${path}/versions`).expect(200)
    expect(versions.body.items).toHaveLength(1)
    const other = await request(server).post('/action-modules').send({ ...body, key: 'review.other', idempotencyKey: newId() }).expect(201)
    await request(server).get(`/action-modules/${other.body.id}/versions/${versions.body.items[0].id}`).expect(404)
  })
  it('副作用越界和缺失验证通过 HTTP 返回字段诊断', async () => {
    const created = await request(app.getHttpServer()).post('/action-modules').send({ targetId, key: 'review.blocked', name: '发布闸门', idempotencyKey: newId() }).expect(201)
    const invalid = structuredClone(content)
    invalid.implementations[0]!.steps.unshift({ id: newId(), type: 'click', name: '写操作', effectType: 'SIDE_EFFECT', input: { target: { framePath: [], candidates: [{ by: 'testId', value: 'submit' }] } } })
    const path = `/action-modules/${created.body.id}`
    await request(app.getHttpServer()).post(`${path}/draft`).send({ baseRevision: 0, content: invalid }).expect(200)
    const blocked = await request(app.getHttpServer()).post(`${path}/publish`).send({ expectedRevision: 1, idempotencyKey: newId() }).expect(400)
    expect(blocked.body.code).toBe('MODULE_COMPILE_BLOCKED')
    expect(blocked.body.details.diagnostics).toContainEqual(expect.objectContaining({ code: 'MODULE_EFFECT_EXCEEDS_CEILING', fieldPath: ['implementations', '0', 'steps', '0', 'effectType'] }))
  })
  it('AMC 可通过 HTTP 弃用版本并读取引用列表', async () => {
    const server = app.getHttpServer()
    const created = await request(server).post('/action-modules').send({ targetId, key: 'review.pub', name: '状态治理', idempotencyKey: newId() }).expect(201)
    const path = `/action-modules/${created.body.id}`
    await request(server).post(`${path}/draft`).send({ baseRevision: 0, content }).expect(200)
    await request(server).post(`${path}/publish`).send({ expectedRevision: 1, idempotencyKey: newId() }).expect(200)
    const versions = await request(server).get(`${path}/versions`).expect(200)
    const versionId = versions.body.items[0].id
    const deprecated = await request(server).post(`${path}/versions/${versionId}/publication`).send({ status: 'deprecated', reason: '准备升级' }).expect(200)
    expect(deprecated.body.publicationStatus).toBe('deprecated')
    const refs = await request(server).get(`${path}/references`).expect(200)
    expect(refs.body.items).toEqual([])
  })
  it('删除 Target 后详情/版本及发布均不可访问', async () => {
    await targets.deleteTarget(targetId, account)
    const list = await request(app.getHttpServer()).get('/action-modules').expect(200)
    expect(list.body.total).toBe(0)
  })
})
