import {
  BadRequestException,
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
import { PERMISSIONS, SCENARIO_ERROR_CODES, TARGET_ERROR_CODES } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { ScenariosController } from './scenarios.controller'
import { ScenariosService } from './scenarios.service'
import { listenForSupertest } from '../__tests__/http-app'

const now = '2026-09-10T00:00:00.000Z'
const scenario = {
  id: '33333333-3333-4333-8333-333333333333',
  targetId: '11111111-1111-4111-8111-111111111111',
  name: '回显',
  status: 'active' as const,
  latestVersionId: '44444444-4444-4444-8444-444444444444',
  latestVersionNo: 1,
  stepCount: 1,
  createdAt: now,
  updatedAt: now,
  steps: [
    {
      id: '55555555-5555-4555-8555-555555555555',
      name: '回显',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { value: 'hello' },
    },
  ],
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
  permissions: ['workflow:read', 'run:read'],
}

const writer: RequestAccount = {
  ...admin,
  id: 'acc-writer',
  permissions: ['workflow:read', 'workflow:write'],
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
    list: vi.fn(async () => ({ items: [scenario] })),
    get: vi.fn(async () => scenario),
    create: vi.fn(async () => scenario),
    update: vi.fn(async () => scenario),
    saveDraft: vi.fn(async () => scenario),
    publish: vi.fn(async () => scenario),
    trial: vi.fn(async () => ({ detail: { id: 'run-1' }, created: true })),
    remove: vi.fn(async () => undefined),
    versions: vi.fn(async () => ({ items: [] })),
    capabilities: vi.fn(async () => ({
      executableStepTypes: ['echo', 'navigate'],
      unavailableReasons: [{ type: 'ai_action', code: 'AI_DISABLED', message: 'off' }],
    })),
    createRecordingBinding: vi.fn(async () => ({ binding: { id: 'bind-1' }, ticket: 't'.repeat(64) })),
    listRecordingImports: vi.fn(async () => ({ bindings: [], drafts: [], receipts: [] })),
    previewRecordingImport: vi.fn(async () => ({ items: [] })),
    applyRecordingImport: vi.fn(async () => ({ receipt: { id: 'r1' }, scenario })),
    createKnowledgeProposal: vi.fn(async () => ({ proposalId: scenario.id })),
    getKnowledgeProposal: vi.fn(),
    acceptKnowledgeProposal: vi.fn(),
    rejectKnowledgeProposal: vi.fn(),
    previewModuleExpansion: vi.fn(async () => ({ definition: { schemaVersion: 1, inputs: [], steps: [] }, diagnostics: [] })),
    inlineModuleInvocation: vi.fn(async () => scenario),
    previewModuleUpgrade: vi.fn(async () => ({ diffs: [], document: { authoringSchemaVersion: 2, schemaVersion: 1, inputs: [], nodes: [] }, diagnostics: [] })),
    upgradeModule: vi.fn(async () => scenario),
    previewModuleExtract: vi.fn(async () => ({ ok: true, stepIds: [], inputs: [], outputs: [], effectCeiling: 'READ_ONLY', postconditionCandidates: [], parameterizable: [] })),
    extractModule: vi.fn(async () => ({ id: scenario.id })),
    previewModuleReplace: vi.fn(async () => ({ equal: true, steps: [], invocation: { kind: 'module', invocationId: scenario.id, name: 'm', moduleId: scenario.id, implementationKey: 'default', inputBindings: {}, outputBindings: {} } })),
    replaceModule: vi.fn(async () => scenario),
    acceptModuleResolution: vi.fn(async () => ({
      request: { requestId: scenario.id, status: 'matched', candidates: [], inputSuggestions: {}, unknowns: [], outcome: 'accepted' },
      scenario,
      diagnostics: [],
    })),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [ScenariosController],
    providers: [
      Reflector,
      { provide: ScenariosService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('Scenarios HTTP', () => {
  const service = mockService()
  let adminApp: INestApplication
  let viewerApp: INestApplication
  let writerApp: INestApplication

  beforeAll(async () => {
    adminApp = await buildApp(admin, service)
    viewerApp = await buildApp(viewer, service)
    writerApp = await buildApp(writer, service)
  })

  beforeEach(() => vi.clearAllMocks())

  afterAll(async () => {
    await adminApp.close()
    await viewerApp.close()
    await writerApp.close()
  })

  it('能力查询只需 workflow:read，且不把 capabilities 当成场景 id', async () => {
    await request(viewerApp.getHttpServer()).get('/scenarios/capabilities').expect(200)
    expect(service.capabilities).toHaveBeenCalled()
    expect(service.get).not.toHaveBeenCalled()
  })

  it('无 workflow:write 不能新建', async () => {
    await request(viewerApp.getHttpServer())
      .post('/scenarios')
      .send({ targetId: scenario.targetId, name: 'x', steps: scenario.steps })
      .expect(403)
    expect(service.create).not.toHaveBeenCalled()
  })

  it('创建返回 201，删除返回 200', async () => {
    await request(adminApp.getHttpServer())
      .post('/scenarios')
      .send({ targetId: scenario.targetId, name: 'x', steps: scenario.steps })
      .expect(201)
    await request(adminApp.getHttpServer()).post(`/scenarios/${scenario.id}/delete`).expect(200)
  })

  it('领域码 SCENARIO_DISABLED / TARGET_DISABLED / SCENARIO_HAS_RUNS 原样透传', async () => {
    service.create.mockRejectedValueOnce(
      new ConflictException({ code: 'TARGET_DISABLED', message: '目标系统已停用，不能新建场景' }),
    )
    const disabledTarget = await request(adminApp.getHttpServer())
      .post('/scenarios')
      .send({ targetId: scenario.targetId, name: 'x', steps: scenario.steps })
    expect(disabledTarget.body.code).toBe('TARGET_DISABLED')
    expect(TARGET_ERROR_CODES).toContain(disabledTarget.body.code)

    service.create.mockRejectedValueOnce(
      new BadRequestException({ code: 'SCENARIO_UNRESOLVED_REF', message: '前向引用' }),
    )
    const forward = await request(adminApp.getHttpServer())
      .post('/scenarios')
      .send({ targetId: scenario.targetId, name: 'y', steps: scenario.steps })
    expect(forward.body.code).toBe('SCENARIO_UNRESOLVED_REF')
    expect(SCENARIO_ERROR_CODES).toContain(forward.body.code)

    service.remove.mockRejectedValueOnce(
      new ConflictException({ code: 'SCENARIO_HAS_RUNS', message: '请先删除该场景下的运行' }),
    )
    const hasRuns = await request(adminApp.getHttpServer()).post(`/scenarios/${scenario.id}/delete`)
    expect(hasRuns.body.code).toBe('SCENARIO_HAS_RUNS')

    service.get.mockRejectedValueOnce(
      new NotFoundException({ code: SCENARIO_ERROR_CODES[0], message: '场景不存在' }),
    )
    const missing = await request(adminApp.getHttpServer()).get(`/scenarios/${scenario.id}`)
    expect(missing.body.code).toBe('SCENARIO_NOT_FOUND')
  })

  it('改步骤不再走更新接口', async () => {
    await request(adminApp.getHttpServer())
      .post(`/scenarios/${scenario.id}`)
      .send({ steps: scenario.steps })
      .expect(400)
    expect(service.update).not.toHaveBeenCalled()
  })

  it('保存草稿需要 workflow:write', async () => {
    await request(viewerApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/draft`)
      .send({
        revision: 1,
        document: { schemaVersion: 1, inputs: [], steps: scenario.steps },
      })
      .expect(403)
    expect(service.saveDraft).not.toHaveBeenCalled()
  })

  it('试跑需要 workflow:write、run:execute 且 target:read', async () => {
    await request(viewerApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/trial`)
      .send({ revision: 1 })
      .expect(403)
    await request(writerApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/trial`)
      .send({ revision: 1 })
      .expect(403)
    expect(service.trial).not.toHaveBeenCalled()
  })

  it('保存草稿与发布走新入口', async () => {
    await request(adminApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/draft`)
      .send({
        revision: 1,
        document: { schemaVersion: 1, inputs: [], steps: scenario.steps },
      })
      .expect(200)
    await request(adminApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/publish`)
      .send({ revision: 1 })
      .expect(200)
    await request(adminApp.getHttpServer()).post(`/scenarios/${scenario.id}/trial`).send({ revision: 1 }).expect(201)
    expect(service.saveDraft).toHaveBeenCalled()
    expect(service.publish).toHaveBeenCalled()
    expect(service.trial).toHaveBeenCalled()
  })

  it('录制绑定与回填需要 target:read，预览只需读权限', async () => {
    await request(writerApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/recording-bindings`)
      .send({ revision: 1, insertAnchor: { kind: 'start' } })
      .expect(403)
    await request(writerApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/recording-imports/apply`)
      .send({
        idempotencyKey: 'import-0001',
        baseRevision: 1,
        recordingDraftId: '66666666-6666-4666-8666-666666666666',
        normalizerVersion: 'recording-normalizer@2',
        sourceDigest: 'a'.repeat(64),
        insertAnchor: { kind: 'start' },
        dispositions: [{ sourceIndexes: [0], disposition: 'discard', reason: '不需要' }],
      })
      .expect(403)
    await request(viewerApp.getHttpServer()).get(`/scenarios/${scenario.id}/recording-imports`).expect(403)
    expect(service.createRecordingBinding).not.toHaveBeenCalled()
    expect(service.applyRecordingImport).not.toHaveBeenCalled()

    await request(adminApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/recording-bindings`)
      .send({ revision: 1, insertAnchor: { kind: 'start' } })
      .expect(201)
    expect(service.createRecordingBinding).toHaveBeenCalled()
  })

  it('OME14 无 map:read 不能接受知识建议，无 ai:assist 不能生成', async () => {
    await request(writerApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/knowledge-proposals/${scenario.id}/accept`)
      .send({
        idempotencyKey: 'accept-0001',
        expectedDraftRevision: 1,
        documentDigest: 'a'.repeat(64),
      })
      .expect(403)
    await request(writerApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/knowledge-proposals`)
      .send({
        idempotencyKey: 'propose-0001',
        question: '根据已有知识按订单号查询状态',
        expectedDraftRevision: 1,
        documentDigest: 'a'.repeat(64),
      })
      .expect(403)
    expect(service.acceptKnowledgeProposal).not.toHaveBeenCalled()
    expect(service.createKnowledgeProposal).not.toHaveBeenCalled()
  })

  it('动作模块展开预览需要 module:read，内联替换需要写权限且校验 expectedDraftLockVersion', async () => {
    await request(viewerApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/module-expansion-preview`)
      .send({})
      .expect(403)

    const previewRes = await request(adminApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/module-expansion-preview`)
      .send({})
      .expect(200)
    expect(previewRes.body).toHaveProperty('definition')
    expect(service.previewModuleExpansion).toHaveBeenCalled()

    await request(viewerApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/nodes/inv-1/inline`)
      .send({ expectedDraftLockVersion: 1 })
      .expect(403)

    await request(writerApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/nodes/inv-1/inline`)
      .send({})
      .expect(400)

    await request(writerApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/nodes/inv-1/inline`)
      .send({ expectedDraftLockVersion: 2 })
      .expect(200)
    expect(service.inlineModuleInvocation).toHaveBeenCalled()
  })

  it('AM-C 升级预览需要 module:read，写入与提炼需要对应写权限', async () => {
    const invocationId = '55555555-5555-4555-8555-555555555555'
    const versionId = '44444444-4444-4444-8444-444444444444'
    await request(viewerApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/module-upgrade-preview`)
      .send({ invocationId, toVersionId: versionId })
      .expect(403)
    await request(writerApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/module-upgrade`)
      .send({
        invocationId,
        toVersionId: versionId,
        baseRevision: 1,
        idempotencyKey: 'up-1',
      })
      .expect(403)
    await request(writerApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/module-extract`)
      .send({
        stepIds: [scenario.steps[0]!.id],
        name: '提炼',
        key: 'order.extract',
        idempotencyKey: 'ex-1',
      })
      .expect(403)

    await request(adminApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/module-upgrade-preview`)
      .send({ invocationId, toVersionId: versionId })
      .expect(200)
    await request(adminApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/module-upgrade`)
      .send({
        invocationId,
        toVersionId: versionId,
        baseRevision: 1,
        idempotencyKey: 'up-1',
      })
      .expect(200)
    await request(adminApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/module-extract-preview`)
      .send({ stepIds: [scenario.steps[0]!.id] })
      .expect(200)
    expect(service.previewModuleUpgrade).toHaveBeenCalled()
    expect(service.upgradeModule).toHaveBeenCalled()
    expect(service.previewModuleExtract).toHaveBeenCalled()
  })

  it('AM-D 接受映射需要 workflow:write、module:read 与 target:read', async () => {
    const requestId = '66666666-6666-4666-8666-666666666666'
    const versionId = '44444444-4444-4444-8444-444444444444'
    const body = {
      moduleVersionId: versionId,
      inputBindings: {},
      outputBindings: {},
      baseRevision: 1,
      idempotencyKey: 'accept-01',
    }
    await request(viewerApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/module-resolutions/${requestId}/accept`)
      .send(body)
      .expect(403)
    await request(writerApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/module-resolutions/${requestId}/accept`)
      .send(body)
      .expect(403)
    await request(adminApp.getHttpServer())
      .post(`/scenarios/${scenario.id}/module-resolutions/${requestId}/accept`)
      .send(body)
      .expect(200)
    expect(service.acceptModuleResolution).toHaveBeenCalled()
  })
})
