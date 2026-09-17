import {
  type CanActivate,
  type ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  RbacStore,
  TargetsStore,
  countRunsForScenario,
  createTerminology,
  prepareModuleDraftTrial,
  type DbHandle,
} from '@cairn/db'
import { expose, newId, openIsolatedDb } from '@cairn/db/testing'
import { compileModuleContent } from '@cairn/authoring'
import { PERMISSIONS, moduleWarningKey, type ModuleContent } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter.js'
import type { RequestAccount } from '../common/request-account.js'
import { PermissionsGuard } from '../rbac/permissions.guard.js'
import { ActionModulesController } from './action-modules.controller.js'
import { ActionModulesService } from './action-modules.service.js'
import { ScenariosController } from '../scenarios/scenarios.controller.js'
import { ScenariosService } from '../scenarios/scenarios.service.js'
import { listenForSupertest } from '../__tests__/http-app.js'

const admin: RequestAccount = {
  id: 'acc-admin',
  displayName: 'Admin',
  email: 'admin@example.com',
  status: 'active',
  roles: [{ id: 'admin', key: 'admin', name: 'Administrator', kind: 'system' }],
  permissions: [...PERMISSIONS],
}

class StaticAuthGuard implements CanActivate {
  constructor(private readonly account: RequestAccount) {}
  canActivate(context: ExecutionContext): boolean {
    if (!this.account) throw new UnauthorizedException('未认证')
    context.switchToHttp().getRequest().account = this.account
    return true
  }
}

function echoContent(name = '查询订单'): ModuleContent {
  const stepId = newId()
  return {
    contract: {
      inputs: [{ key: 'orderNo', label: '订单号', valueType: 'string', required: true }],
      outputs: [{ key: 'result', label: '结果', shape: { kind: 'scalar', type: 'string' } }],
      effectCeiling: 'READ_ONLY',
      preconditions: [],
      postconditions: [{ meaning: '有结果', verification: { kind: 'output_required', outputKey: 'result' } }],
    },
    implementations: [{
      implementationKey: 'default',
      kind: 'structured_steps',
      steps: [{
        id: stepId,
        name,
        type: 'echo',
        effectType: 'READ_ONLY',
        outputKey: 'internal',
        input: { from: 'orderNo' },
      }],
      outputMapping: { result: 'internal' },
    }],
  }
}

function confirmedWarnings(content: ModuleContent) {
  return compileModuleContent(content, { mode: 'release' }).diagnostics
    .filter((item) => item.severity === 'warning')
    .map(moduleWarningKey)
}

describe('AM-D HTTP → 真实库', { timeout: 30_000 }, () => {
  let handle: Awaited<ReturnType<typeof openIsolatedDb>>
  let db: DbHandle
  let account: RequestAccount
  let app: INestApplication
  let targetId: string
  let otherTargetId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(`cairn_amd_http_${newId().replaceAll('-', '')}`)
    db = expose(handle)
    const rbac = new RbacStore(db, { hash: async (v) => v, verify: async (v, h) => v === h })
    const role = (await rbac.listRoles()).items.find((r) => r.key === 'admin')!
    const created = await rbac.createAccount({
      email: 'amd-http@example.test',
      displayName: 'AM-D HTTP',
      password: 'Fixture-password-123',
      roleIds: [role.id],
    }, null)
    account = { ...admin, id: created.id }
    const targets = new TargetsStore(db, () => Buffer.from('fixture'))
    targetId = (await targets.createTarget({
      loginFields: null, authMethod: 'manual', captchaMode: 'none', status: 'active',
      name: 'AM-D HTTP 目标',
      code: `amd-http-${newId().slice(0, 8)}`,
      entryUrl: 'https://example.test',
    }, account)).id
    otherTargetId = (await targets.createTarget({
      loginFields: null, authMethod: 'manual', captchaMode: 'none', status: 'active',
      name: 'AM-D 其他目标',
      code: `amd-other-${newId().slice(0, 8)}`,
      entryUrl: 'https://other.example.test',
    }, account)).id

    const moduleRef = await Test.createTestingModule({
      controllers: [ActionModulesController, ScenariosController],
      providers: [
        Reflector,
        { provide: ActionModulesService, useValue: new ActionModulesService(db) },
        { provide: ScenariosService, useValue: new ScenariosService(db) },
        { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    await listenForSupertest(app)
  })

  afterAll(async () => {
    await app?.close()
    await handle?.close()
  })

  function moduleKey(prefix: string) {
    return `${prefix}${newId().replaceAll('-', '').slice(0, 8)}`
  }

  async function publishNamed(forTargetId: string, key: string, name: string) {
    const server = app.getHttpServer()
    const content = echoContent(name)
    const created = await request(server).post('/action-modules').send({
      targetId: forTargetId, key, name, idempotencyKey: newId(),
    }).expect(201)
    const path = `/action-modules/${created.body.id}`
    await request(server).post(`${path}/draft`).send({ baseRevision: 0, content }).expect(200)
    await request(server).post(`${path}/publish`).send({
      expectedRevision: 1,
      confirmedWarnings: confirmedWarnings(content),
      idempotencyKey: newId(),
    }).expect(200)
    const versions = await request(server).get(`${path}/versions`).expect(200)
    return { id: created.body.id as string, versionId: versions.body.items[0].id as string }
  }

  async function createScenario(name: string) {
    const created = await request(app.getHttpServer()).post('/scenarios').send({
      targetId,
      name,
      steps: [{
        id: newId(),
        name: '占位',
        type: 'delay',
        effectType: 'READ_ONLY',
        input: { durationMs: 10 },
      }],
    }).expect(201)
    return { id: created.body.id as string, revision: created.body.draft.revision as number }
  }

  it('AMD-03 其他 Target 同名模块不出现在候选中', async () => {
    const local = await publishNamed(targetId, moduleKey('order.iso'), '隔离查询订单')
    const foreign = await publishNamed(otherTargetId, moduleKey('order.iso'), '隔离查询订单')
    const resolved = await request(app.getHttpServer()).post('/action-modules/resolve').send({
      targetId,
      expression: '隔离查询订单',
      mode: 'rules',
      idempotencyKey: `resolve-${newId()}`,
    }).expect(200)
    expect(resolved.body.candidates.map((item: { moduleId: string }) => item.moduleId)).toContain(local.id)
    expect(resolved.body.candidates.some((item: { moduleId: string }) => item.moduleId === foreign.id)).toBe(false)
  })

  it('AMD-05 无命中不创建 Run，也不触发探索', async () => {
    const scenario = await createScenario('无命中')
    const before = await countRunsForScenario(db, scenario.id)
    const resolved = await request(app.getHttpServer()).post('/action-modules/resolve').send({
      targetId,
      scenarioId: scenario.id,
      expression: '煮一杯咖啡',
      mode: 'rules_then_ai',
      idempotencyKey: `resolve-${newId()}`,
    }).expect(200)
    expect(resolved.body.status).toBe('no_match')
    expect(resolved.body.aiSkipped).toBe('ai_layer_not_open')
    expect(await countRunsForScenario(db, scenario.id)).toBe(before)
  })

  it('AMD-07 接受写入、OCC、幂等与候选外拒绝', async () => {
    const published = await publishNamed(targetId, moduleKey('order.accept'), '查询订单')
    const scenario = await createScenario('接受映射')
    const resolved = await request(app.getHttpServer()).post('/action-modules/resolve').send({
      targetId,
      scenarioId: scenario.id,
      expression: '查询订单 SO123',
      mode: 'rules',
      idempotencyKey: `resolve-${newId()}`,
    }).expect(200)
    expect(['matched', 'suggested']).toContain(resolved.body.status)
    const versionId = resolved.body.candidates[0].moduleVersionId as string
    expect(versionId).toBe(published.versionId)
    const acceptPath = `/scenarios/${scenario.id}/module-resolutions/${resolved.body.requestId}/accept`
    const acceptKey = `accept-${newId()}`
    const first = await request(app.getHttpServer()).post(acceptPath).send({
      moduleVersionId: versionId,
      inputBindings: { orderNo: { kind: 'literal', value: 'SO123' } },
      outputBindings: {},
      baseRevision: scenario.revision,
      idempotencyKey: acceptKey,
    }).expect(200)
    expect(first.body.request.outcome).toBe('accepted')
    const nodes = first.body.scenario.draft.document.nodes as Array<{ kind: string; moduleVersionId?: string }>
    expect(nodes.some((node) => node.kind === 'module' && node.moduleVersionId === versionId)).toBe(true)

    const again = await request(app.getHttpServer()).post(acceptPath).send({
      moduleVersionId: versionId,
      inputBindings: { orderNo: { kind: 'literal', value: 'CHANGED' } },
      outputBindings: {},
      baseRevision: scenario.revision,
      idempotencyKey: acceptKey,
    }).expect(200)
    expect(again.body.scenario.draft.revision).toBe(first.body.scenario.draft.revision)

    await request(app.getHttpServer()).post(acceptPath).send({
      moduleVersionId: versionId,
      inputBindings: {},
      outputBindings: {},
      baseRevision: scenario.revision,
      idempotencyKey: `accept-${newId()}`,
    }).expect(409).expect((res) => {
      expect(res.body.code).toBe('RESOLUTION_ALREADY_SETTLED')
    })

    const second = await createScenario('冲突保留')
    const pending = await request(app.getHttpServer()).post('/action-modules/resolve').send({
      targetId,
      scenarioId: second.id,
      expression: '查询订单',
      mode: 'rules',
      idempotencyKey: `resolve-${newId()}`,
    }).expect(200)
    const pendingPath = `/scenarios/${second.id}/module-resolutions/${pending.body.requestId}/accept`
    await request(app.getHttpServer()).post(pendingPath).send({
      moduleVersionId: pending.body.candidates[0].moduleVersionId,
      inputBindings: {},
      outputBindings: {},
      baseRevision: second.revision - 1,
      idempotencyKey: `accept-${newId()}`,
    }).expect(409).expect((res) => {
      expect(res.body.code).toBe('SCENARIO_DRAFT_CONFLICT')
    })
    const still = await request(app.getHttpServer()).get(`/action-modules/resolutions/${pending.body.requestId}`).expect(200)
    expect(still.body.outcome).toBe('pending')

    await request(app.getHttpServer()).post(pendingPath).send({
      moduleVersionId: published.id,
      inputBindings: {},
      outputBindings: {},
      baseRevision: second.revision,
      idempotencyKey: `accept-${newId()}`,
    }).expect(409).expect((res) => {
      expect(res.body.code).toBe('RESOLUTION_CANDIDATE_MISMATCH')
    })
  })

  it('只消费 confirmed 术语，并拒绝写入验证场景', async () => {
    const published = await publishNamed(targetId, moduleKey('product.off'), '商品下架')
    await request(app.getHttpServer()).post(`/action-modules/${published.id}`).send({
      baseRevision: (await request(app.getHttpServer()).get(`/action-modules/${published.id}`).expect(200)).body.draftRevision,
      aliases: ['下架商品'],
    }).expect(200)
    await createTerminology(db, targetId, {
      idempotencyKey: `term-${newId()}`,
      canonicalName: '商品下架',
      aliases: ['下架'],
      meaning: '把在售商品改为下架',
      termStatus: 'confirmed',
    }, { id: account.id })

    const byTerm = await request(app.getHttpServer()).post('/action-modules/resolve').send({
      targetId,
      expression: '下架',
      mode: 'rules',
      idempotencyKey: `resolve-${newId()}`,
    }).expect(200)
    expect(byTerm.body.candidates[0].moduleId).toBe(published.id)
    expect(byTerm.body.candidates[0].matchedBy.some((item: { field: string }) => item.field === 'term')).toBe(true)

    const verification = await prepareModuleDraftTrial(db, published.id, {
      inputs: { orderNo: 'SO-1' },
      actor: { id: account.id },
    })
    await request(app.getHttpServer()).post('/action-modules/resolve').send({
      targetId,
      scenarioId: verification.scenarioId,
      expression: '商品下架',
      mode: 'rules',
      idempotencyKey: `resolve-${newId()}`,
    }).expect(400).expect((res) => {
      expect(res.body.code).toBe('RESOLUTION_SCENARIO_NOT_WRITABLE')
    })
  })
})
