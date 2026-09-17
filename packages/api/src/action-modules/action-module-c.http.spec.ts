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
  getOrCreatePlatformConfig,
  registerPlatformAiSecret,
  updatePlatformConfig,
  type DbHandle,
} from '@cairn/db'
import { expose, newId, openIsolatedDb } from '@cairn/db/testing'
import { compileModuleContent } from '@cairn/authoring'
import {
  FACTORY_PLATFORM_CONFIG,
  PERMISSIONS,
  moduleWarningKey,
  upgradeWarningKey,
  type ModuleContent,
  type ScenarioAuthoringDocumentV2,
  type Step,
} from '@cairn/shared'
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

function echoContent(): ModuleContent {
  const stepId = newId()
  return {
    contract: {
      inputs: [{ key: 'keyword', label: '关键词', valueType: 'string', required: true }],
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
        name: '回显',
        type: 'echo',
        effectType: 'READ_ONLY',
        outputKey: 'internal',
        input: { from: 'keyword' },
      }],
      outputMapping: { result: 'internal' },
    }],
  }
}

function aiContent(): ModuleContent {
  const base = echoContent()
  const extractId = newId()
  return {
    ...base,
    implementations: [{
      implementationKey: 'default',
      kind: 'structured_steps',
      steps: [{
        id: extractId,
        name: 'AI 提取',
        type: 'ai_extract',
        effectType: 'READ_ONLY',
        outputKey: 'internal',
        input: {
          instruction: '提取页面上的结果文本',
          outputSchema: { kind: 'scalar', type: 'string' },
        },
      }],
      outputMapping: { result: 'internal' },
    }],
  }
}

function confirmedModuleWarnings(content: ModuleContent) {
  return compileModuleContent(content, { mode: 'release' }).diagnostics
    .filter((item) => item.severity === 'warning')
    .map(moduleWarningKey)
}

describe('AM-C HTTP → 真实库', { timeout: 30_000 }, () => {
  let handle: Awaited<ReturnType<typeof openIsolatedDb>>
  let db: DbHandle
  let account: RequestAccount
  let app: INestApplication
  let targetId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(`cairn_amc_http_${newId().replaceAll('-', '')}`)
    db = expose(handle)
    const rbac = new RbacStore(db, { hash: async (v) => v, verify: async (v, h) => v === h })
    const role = (await rbac.listRoles()).items.find((r) => r.key === 'admin')!
    const created = await rbac.createAccount({
      email: 'amc-http@example.test',
      displayName: 'AM-C HTTP',
      password: 'Fixture-password-123',
      roleIds: [role.id],
    }, null)
    account = { ...admin, id: created.id }
    const targets = new TargetsStore(db, () => Buffer.from('fixture'))
    targetId = (await targets.createTarget({
      loginFields: null, authMethod: 'manual', captchaMode: 'none', status: 'active',
      name: 'AM-C HTTP 目标',
      code: `amc-http-${newId().slice(0, 8)}`,
      entryUrl: 'https://example.test',
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

  async function publishModule(key: string, content: ModuleContent) {
    const server = app.getHttpServer()
    const created = await request(server).post('/action-modules').send({
      targetId, key, name: key, idempotencyKey: newId(),
    }).expect(201)
    const path = `/action-modules/${created.body.id}`
    await request(server).post(`${path}/draft`).send({ baseRevision: 0, content }).expect(200)
    await request(server).post(`${path}/publish`).send({
      expectedRevision: 1,
      confirmedWarnings: confirmedModuleWarnings(content),
      idempotencyKey: newId(),
    }).expect(200)
    const versions = await request(server).get(`${path}/versions`).expect(200)
    return { id: created.body.id as string, path, versions: versions.body.items as { id: string; versionNo: number }[] }
  }

  async function createInvocationScenario(name: string, moduleId: string, versionId: string, invocationId = newId()) {
    const server = app.getHttpServer()
    const created = await request(server).post('/scenarios').send({
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
    const document: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [{ key: 'keyword', label: '关键词' }],
      nodes: [{
        kind: 'module',
        invocationId,
        name: '查询',
        moduleId,
        moduleVersionId: versionId,
        implementationKey: 'default',
        inputBindings: { keyword: { kind: 'from', key: 'keyword' } },
        outputBindings: { result: 'result' },
      }],
    }
    const saved = await request(server).post(`/scenarios/${created.body.id}/draft`).send({
      revision: created.body.draft.revision,
      document,
    }).expect(200)
    return { id: created.body.id as string, invocationId, revision: saved.body.draft.revision as number }
  }

  it('AMC-05 执行方式变 AI 需确认，未配置浏览器 AI 时发布场景被阻断', async () => {
    const server = app.getHttpServer()
    const published = await publishModule(`order.amcai${newId().replaceAll('-', '').slice(0, 8)}`, echoContent())
    const scenario = await createInvocationScenario('升到 AI', published.id, published.versions[0]!.id)
    const versionsBefore = (await request(server).get(`/scenarios/${scenario.id}/versions`).expect(200)).body.items.length

    const secretId = newId()
    await registerPlatformAiSecret(db, {
      id: secretId,
      baseUrl: 'https://model.example/v1',
      ciphertext: Buffer.from('encrypted'),
      actor: { id: account.id },
    })
    const enabled = {
      ...FACTORY_PLATFORM_CONFIG,
      browserAi: {
        ...FACTORY_PLATFORM_CONFIG.browserAi,
        enabled: true,
        baseUrl: 'https://model.example/v1',
        model: 'demo',
        modelFamily: 'openai',
        secretRef: { provider: 'local' as const, secretId },
      },
    }
    const disabled = { ...enabled, browserAi: { ...enabled.browserAi, enabled: false } }
    let config = await getOrCreatePlatformConfig(db, { document: enabled, reason: 'AMC-05 初始化' })
    if (!config.document.browserAi.enabled) {
      config = await updatePlatformConfig(db, {
        expectedRevision: config.revision,
        document: enabled,
        reason: 'AMC-05 启用浏览器 AI',
        actor: { id: account.id },
      })
    }

    const ai = aiContent()
    await request(server).post(`${published.path}/draft`).send({
      baseRevision: (await request(server).get(published.path).expect(200)).body.draftRevision,
      content: ai,
    }).expect(200)
    const afterDraft = await request(server).get(published.path).expect(200)
    await request(server).post(`${published.path}/publish`).send({
      expectedRevision: afterDraft.body.draftRevision,
      confirmedWarnings: confirmedModuleWarnings(ai),
      idempotencyKey: newId(),
    }).expect(200)
    const v2 = (await request(server).get(`${published.path}/versions`).expect(200)).body.items[0] as { id: string }

    await updatePlatformConfig(db, {
      expectedRevision: config.revision,
      document: disabled,
      reason: 'AMC-05 关闭浏览器 AI',
      actor: { id: account.id },
    })

    const preview = await request(server).post(`/scenarios/${scenario.id}/module-upgrade-preview`).send({
      invocationId: scenario.invocationId,
      toVersionId: v2.id,
    }).expect(200)
    expect(preview.body.diffs).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MODULE_UPGRADE_EXECUTION_MODE', severity: 'warning' }),
    ]))

    await request(server).post(`/scenarios/${scenario.id}/module-upgrade`).send({
      invocationId: scenario.invocationId,
      toVersionId: v2.id,
      baseRevision: scenario.revision,
      idempotencyKey: newId(),
    }).expect(409)

    const warnings = (preview.body.diffs as { severity: string }[])
      .filter((item) => item.severity === 'warning')
      .map((item) => upgradeWarningKey(item as never))
    const upgraded = await request(server).post(`/scenarios/${scenario.id}/module-upgrade`).send({
      invocationId: scenario.invocationId,
      toVersionId: v2.id,
      baseRevision: scenario.revision,
      confirmedWarnings: warnings,
      idempotencyKey: newId(),
    }).expect(200)
    expect((await request(server).get(`/scenarios/${scenario.id}/versions`).expect(200)).body.items.length).toBe(versionsBefore)

    const blocked = await request(server).post(`/scenarios/${scenario.id}/publish`).send({
      revision: upgraded.body.draft.revision,
    }).expect(400)
    expect(blocked.body.code).toBe('SCENARIO_COMPILE_BLOCKED')
    expect(blocked.body.details.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SCENARIO_UNKNOWN_STEP_TYPE' }),
    ]))
  })

  it('AMC-03/11 HTTP：补绑定升级、提炼不改原场景、替换后展开等价', async () => {
    const server = app.getHttpServer()
    const v1Content = echoContent()
    const published = await publishModule(`order.amcup${newId().replaceAll('-', '').slice(0, 8)}`, v1Content)
    const next = echoContent()
    next.contract.inputs.push({ key: 'limit', label: '条数', valueType: 'number', required: true })
    await request(server).post(`${published.path}/draft`).send({
      baseRevision: (await request(server).get(published.path).expect(200)).body.draftRevision,
      content: next,
    }).expect(200)
    const afterDraft = await request(server).get(published.path).expect(200)
    await request(server).post(`${published.path}/publish`).send({
      expectedRevision: afterDraft.body.draftRevision,
      confirmedWarnings: confirmedModuleWarnings(next),
      idempotencyKey: newId(),
    }).expect(200)
    const v2 = (await request(server).get(`${published.path}/versions`).expect(200)).body.items[0] as { id: string }
    const scenario = await createInvocationScenario('待补绑定', published.id, published.versions[0]!.id)

    const preview = await request(server).post(`/scenarios/${scenario.id}/module-upgrade-preview`).send({
      invocationId: scenario.invocationId,
      toVersionId: v2.id,
    }).expect(200)
    expect(preview.body.diffs).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MODULE_UPGRADE_INPUT_REQUIRED', severity: 'blocking' }),
    ]))
    await request(server).post(`/scenarios/${scenario.id}/module-upgrade`).send({
      invocationId: scenario.invocationId,
      toVersionId: v2.id,
      baseRevision: scenario.revision,
      idempotencyKey: newId(),
    }).expect(409)
    await request(server).post(`/scenarios/${scenario.id}/module-upgrade`).send({
      invocationId: scenario.invocationId,
      toVersionId: v2.id,
      baseRevision: scenario.revision,
      bindingsPatch: { limit: { kind: 'literal', value: 10 } },
      idempotencyKey: newId(),
    }).expect(200)

    const fill: Step = {
      id: newId(),
      name: '回显输入',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { from: 'keyword' },
    }
    const extract: Step = {
      id: newId(),
      name: '提取',
      type: 'extract',
      effectType: 'READ_ONLY',
      outputKey: 'extracted',
      input: { target: { framePath: [], candidates: [{ by: 'text', value: '结果' }] }, as: 'text' },
    }
    const assert: Step = {
      id: newId(),
      name: '断言',
      type: 'assert',
      effectType: 'READ_ONLY',
      input: { expect: { kind: 'text_contains', value: '完成' } },
    }
    const later: Step = {
      id: newId(),
      name: '后续',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { from: 'extracted' },
    }
    const created = await request(server).post('/scenarios').send({
      targetId,
      name: '待提炼',
      steps: [{
        id: newId(),
        name: '占位',
        type: 'delay',
        effectType: 'READ_ONLY',
        input: { durationMs: 10 },
      }],
    }).expect(201)
    const extractDoc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [{ key: 'keyword', label: '关键词' }],
      nodes: [
        { kind: 'step', step: fill },
        { kind: 'step', step: extract },
        { kind: 'step', step: assert },
        { kind: 'step', step: later },
      ],
    }
    const saved = await request(server).post(`/scenarios/${created.body.id}/draft`).send({
      revision: created.body.draft.revision,
      document: extractDoc,
    }).expect(200)
    const proposal = await request(server).post(`/scenarios/${created.body.id}/module-extract-preview`).send({
      stepIds: [fill.id, extract.id, assert.id],
    }).expect(200)
    expect(proposal.body.inputs).toHaveLength(1)
    expect(proposal.body.outputs).toHaveLength(1)
    expect(proposal.body.postconditionCandidates).toHaveLength(1)

    const extracted = await request(server).post(`/scenarios/${created.body.id}/module-extract`).send({
      stepIds: [fill.id, extract.id, assert.id],
      name: '查询结果',
      key: `order.amcex${newId().replaceAll('-', '').slice(0, 8)}`,
      confirmedPostconditionStepIds: [assert.id],
      idempotencyKey: newId(),
    }).expect(200)
    expect((await request(server).get(`/scenarios/${created.body.id}`).expect(200)).body.draft.revision).toBe(saved.body.draft.revision)

    await request(server).post(`/action-modules/${extracted.body.id}/publish`).send({
      expectedRevision: extracted.body.draftRevision,
      confirmedWarnings: confirmedModuleWarnings(extracted.body.draftContent),
      idempotencyKey: newId(),
    }).expect(200)
    const extractedVersion = (await request(server).get(`/action-modules/${extracted.body.id}/versions`).expect(200)).body.items[0]
    const compare = await request(server).post(`/scenarios/${created.body.id}/module-replace-preview`).send({
      stepIds: [fill.id, extract.id, assert.id],
      moduleVersionId: extractedVersion.id,
    }).expect(200)
    expect(compare.body.equal).toBe(true)
    const replaced = await request(server).post(`/scenarios/${created.body.id}/module-replace`).send({
      stepIds: [fill.id, extract.id, assert.id],
      moduleVersionId: extractedVersion.id,
      baseRevision: saved.body.draft.revision,
      idempotencyKey: newId(),
    }).expect(200)
    expect(replaced.body.draft.document.nodes[0].kind).toBe('module')
    const expansion = await request(server).post(`/scenarios/${created.body.id}/module-expansion-preview`).send({}).expect(200)
    expect(expansion.body.definition.steps.map((step: { type: string }) => step.type)).toEqual(
      expect.arrayContaining(['echo', 'extract', 'assert', 'echo']),
    )
  })
})
