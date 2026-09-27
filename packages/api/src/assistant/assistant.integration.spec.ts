import {
  INestApplication,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createAccountBodySchema,
  createTargetBodySchema,
  PERMISSIONS,
  SYSTEM_ROLE_DEFINITIONS,
  type Step,
} from '@cairn/shared'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  getOrCreatePlatformConfig,
  getScenario,
  newId,
  RbacStore,
  saveScenarioDraft,
  TargetsStore,
} from '@cairn/db'
import { openIsolatedDb } from '@cairn/db/testing'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { listenForSupertest, unusedChangeHint } from '../__tests__/http-app'
import { AssistantController } from './assistant.controller'
import { AssistantAsyncRunner } from './async-runner'
import { AssistantService } from './assistant.service'
import { AssistantCapabilityRegistry } from './registry'
import { PlatformConfigService } from '../platform-config/platform-config.service'
import { TargetsService } from '../targets/targets.service'
import { LocalSecretProvider } from '../secrets/local-secret-provider'

const echo: Step = {
  id: newId(),
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

function account(
  id: string,
  permissions: readonly string[],
  extra: Partial<RequestAccount> = {},
): RequestAccount {
  return {
    id,
    displayName: '测试账号',
    email: 'assist@example.com',
    status: 'active',
    roles: [{ id: 'custom', key: 'custom', name: '自定义', kind: 'custom' }],
    permissions: [...permissions],
    ...extra,
  }
}

describe('助手权限先行（真实仓储）', { timeout: 30_000 }, () => {
  let db: Awaited<ReturnType<typeof openIsolatedDb>>
  let app: INestApplication
  let current: RequestAccount
  let owner: RequestAccount
  let runId: string
  let scenarioId: string
  let conversationId: string

  beforeAll(async () => {
    db = await openIsolatedDb(`cairn_assist_${newId().replaceAll('-', '')}`)
    const rbac = new RbacStore(db, {
      hash: async (value) => value,
      verify: async (value, hash) => value === hash,
    })
    // 创建目标系统需要「全部目标」范围：走产品授权路径，给 admin 角色 + 全范围。
    const adminRoleId = (await rbac.listRoles()).items.find((role) => role.key === 'admin')!.id
    const created = await rbac.createAccount(
      createAccountBodySchema.parse({
        email: 'assist-owner',
        displayName: '助手主人',
        password: 'test-password',
        roleIds: [adminRoleId],
        targetScopes: [{ roleId: adminRoleId, mode: 'all' }],
      }),
      null,
    )
    owner = account(created.id, PERMISSIONS, {
      displayName: created.displayName,
      email: created.email,
      roles: created.roles,
    })
    current = owner
    const targets = new TargetsStore(db, () => Buffer.from('encrypted'))
    const target = await targets.createTarget(
      createTargetBodySchema.parse({
        code: 'titan-demo',
        name: '泰坦',
        entryUrl: 'https://example.com',
        account: { username: 'tester', displayName: '测试账号', password: 'hidden', validity: { mode: 'permanent' } },
      }),
      owner,
    )
    const scenario = await createScenarioWithVersion(db, {
      targetId: target.id,
      name: '巡检',
      steps: [{ ...echo, id: newId() }],
      actor: owner,
    })
    scenarioId = scenario.id
    const run = await createRunWithSnapshot(db, { scenarioId: scenario.id, actor: owner })
    runId = run.detail.id
    await getOrCreatePlatformConfig(db)
    const secrets = new LocalSecretProvider(Buffer.alloc(32, 7))
    const platformConfig = new PlatformConfigService(db, secrets)
    vi.spyOn(platformConfig, 'resolvePlatformAiAccess').mockResolvedValue({
      revision: 1,
      baseUrl: 'http://127.0.0.1:9999',
      model: 'test-model',
      provider: 'openai',
      thinkingMode: 'off',
      apiKey: 'test-key',
      requestTimeoutMs: 10000,
      maxCallsPerTurn: 4,
      maxOutputTokens: 2000,
    })
    const targetsService = new TargetsService(db, secrets)
    const service = new AssistantService(
      db,
      platformConfig,
      targetsService,
      new AssistantAsyncRunner(
        db,
        unusedChangeHint,
        platformConfig,
        targetsService,
        new AssistantCapabilityRegistry(),
      ),
      unusedChangeHint,
    )
    const guard: CanActivate = {
      canActivate(context: ExecutionContext) {
        context.switchToHttp().getRequest().account = current
        return true
      },
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [AssistantController],
      providers: [
        Reflector,
        { provide: AssistantService, useValue: service },
        { provide: APP_GUARD, useValue: guard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    await listenForSupertest(app)
    const createdConv = await request(app.getHttpServer()).post('/assistant/conversations').send({}).expect(201)
    conversationId = createdConv.body.id
  })

  afterAll(async () => {
    await app?.close()
    await db?.close()
  })

  afterEach(() => {
    current = owner
  })

  async function waitForTurn(conversationId: string, turnId: string) {
    for (let i = 0; i < 50; i++) {
      const res = await request(app.getHttpServer())
        .get(`/assistant/conversations/${conversationId}/turns/${turnId}`)
        .expect(200)
      if (res.body.status !== 'RUNNING' && res.body.status !== 'QUEUED') {
        return res.body
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`Timeout waiting for turn ${turnId}`)
  }

  it('没有 ai:assist 不能进入助手', async () => {
    current = account(owner.id, ['run:read', 'target:read'])
    await request(app.getHttpServer()).get('/assistant/capabilities').expect(403)
    current = owner
  })

  it('只读角色可以使用助手，但不能申请改步骤', async () => {
    current = account(owner.id, SYSTEM_ROLE_DEFINITIONS.viewer.permissions)
    const caps = await request(app.getHttpServer()).get('/assistant/capabilities').expect(200)
    expect(caps.body.items.find((item: { id: string }) => item.id === 'run.diagnose')?.available).toBe(true)
    expect(caps.body.items.find((item: { id: string }) => item.id === 'scenario.propose-step')?.available).toBe(
      false,
    )
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: 'viewer-propose-1',
        question: '把指令写清楚',
        capabilityHint: 'scenario.propose-step',
        pageContext: { page: 'studio', scenarioId, stepId: echo.id, draftRevision: 1 },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.result).toMatchObject({ kind: 'unsupported', reasonCode: 'CAPABILITY_FORBIDDEN' })
    current = owner
  })

  it('没有目标访问权限时不能诊断，也不返回目标名称', async () => {
    current = account(owner.id, ['ai:assist', 'run:read', 'workflow:read'])
    const caps = await request(app.getHttpServer()).get('/assistant/capabilities').expect(200)
    expect(caps.body.items.find((item: { id: string }) => item.id === 'run.diagnose')?.available).toBe(false)
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: 'no-target-diagnose-1',
        question: '这次为什么失败',
        capabilityHint: 'run.diagnose',
        pageContext: { page: 'run', runId },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.result).toMatchObject({ kind: 'unsupported', reasonCode: 'CAPABILITY_FORBIDDEN' })
    expect(JSON.stringify(turn)).not.toContain('泰坦')
    current = owner
  })

  it('有目标权限时可以诊断；导览问句与诊断 hint 冲突则澄清', async () => {
    const subDiag = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: 'owner-diagnose-1',
        question: '这次为什么失败',
        capabilityHint: 'run.diagnose',
        pageContext: { page: 'run', runId },
      })
      .expect(202)
    const diagnosed = await waitForTurn(conversationId, subDiag.body.turnId)
    expect(diagnosed.result.kind).toBe('diagnosis')
    expect(diagnosed.result.facts.length).toBeGreaterThan(0)
    expect(JSON.stringify(diagnosed.result.facts)).not.toContain('hidden')

    const subClarify = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: 'owner-clarify-1',
        question: '目标账号在哪里配置？',
        capabilityHint: 'run.diagnose',
        pageContext: { page: 'run', runId },
      })
      .expect(202)
    const clarify = await waitForTurn(conversationId, subClarify.body.turnId)
    expect(clarify.result.kind).toBe('clarify')
  })

  it('撤销目标权限后历史诊断只保留不可访问提示', async () => {
    current = account(owner.id, ['ai:assist', 'run:read', 'workflow:read'])
    const turns = await request(app.getHttpServer())
      .get(`/assistant/conversations/${conversationId}/turns`)
      .expect(200)
    const diagnosed = turns.body.items.find(
      (item: { clientTurnId: string }) => item.clientTurnId === 'owner-diagnose-1',
    )
    expect(diagnosed.result).toEqual({ kind: 'inaccessible', message: '相关运行或目标已不可访问' })
    expect(JSON.stringify(diagnosed)).not.toContain('泰坦')
    current = owner
  })

  it('没有目标权限时导览不给出目标入口', async () => {
    current = account(owner.id, ['ai:assist', 'run:read'])
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: 'guide-no-target-1',
        question: '在哪里配置目标账号？',
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.result).toMatchObject({
      kind: 'unsupported',
      reasonCode: 'GUIDE_UNAVAILABLE',
    })
    expect(turn.result).not.toHaveProperty('items')
    expect(JSON.stringify(turn.result)).not.toContain('泰坦')
    current = owner
  })

  it('解释已保存草稿时不混入已发布版本', async () => {
    current = owner
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `owner-explain-${crypto.randomUUID()}`,
        question: '这个场景在做什么',
        capabilityHint: 'scenario.explain',
        pageContext: {
          page: 'studio',
          scenarioId,
          draftRevision: 1,
          versionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.result.kind).toBe('explanation')
    expect(turn.result.summary).toContain('巡检')
    current = owner
  })

  it('默认解释 V2 草稿保留 MUST 成功条件，显式发布版不混入草稿条件', async () => {
    const click: Step = {
      id: newId(),
      name: '点击提交',
      type: 'click',
      effectType: 'SIDE_EFFECT',
      input: { target: { framePath: [], candidates: [{ by: 'label', value: '提交' }] } },
    }
    const scenario = await createScenarioWithVersion(db, {
      targetId: (await getScenario(db, scenarioId)).targetId,
      name: '提交订单',
      steps: [click],
      actor: owner,
    })
    const saved = await saveScenarioDraft(db, scenario.id, {
      revision: 1,
      document: {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [{
          kind: 'step',
          step: click,
          outcomes: [{
            id: newId(),
            scope: 'step',
            meaning: '提交后出现订单成功提示',
            severity: 'MUST',
            onViolation: 'halt',
            provenance: 'manual',
            rule: { kind: 'deterministic', expect: { kind: 'exists' } },
          }],
        }],
      },
      actor: owner,
    })
    expect(saved.draft?.revision).toBe(2)

    const submit = async (clientTurnId: string, pageContext: Record<string, unknown>) => {
      const response = await request(app.getHttpServer())
        .post(`/assistant/conversations/${conversationId}/turns`)
        .send({
          clientTurnId,
          question: '这个场景怎么判断提交成功？',
          capabilityHint: 'scenario.explain',
          pageContext: { page: 'studio', scenarioId: scenario.id, ...pageContext },
        })
        .expect(202)
      return waitForTurn(conversationId, response.body.turnId)
    }

    const draft = await submit(`outcome-draft-${crypto.randomUUID()}`, {})
    expect(draft.result.kind).toBe('explanation')
    expect(draft.result.summary).toContain('草稿（修订版本 2）')
    expect(draft.result.summary).toContain('MUST「提交后出现订单成功提示」')
    expect(draft.result.diagnostics.map((item: { code: string }) => item.code)).not.toContain('SCENARIO_NO_OUTCOME')
    expect(JSON.stringify(draft.result)).not.toMatch(/没有成功条件|没有断言/)

    const published = await submit(`outcome-published-${crypto.randomUUID()}`, {
      versionId: scenario.published!.versionId,
    })
    expect(published.result.kind).toBe('explanation')
    expect(published.result.summary).toContain('已发布版本 1')
    expect(published.result.summary).not.toContain('提交后出现订单成功提示')
    expect(published.result.diagnostics.map((item: { code: string }) => item.code)).toContain('SCENARIO_NO_OUTCOME')
  })

  it('提问“添加步骤在页面哪里”时精准返回 in_page_guidance 而非全量目标菜单', async () => {
    current = owner
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `guidance-${crypto.randomUUID()}`,
        question: '添加步骤在页面哪里？',
        pageContext: {
          page: 'studio',
          scenarioId,
          draftRevision: 1,
        },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.result.kind).toBe('in_page_guidance')
    expect(turn.result.directAnswer).toContain('左侧步骤编排列表')
    expect(turn.result.directAnswer).toContain('【+ 添加步骤】')
    expect(turn.result).not.toHaveProperty('items')
    expect(JSON.stringify(turn.result)).not.toContain('目标系统')
  })

  it('Studio 正例：选中单步时解释当前步骤，返回 stepSummary 且关联步骤类型与名称', async () => {
    current = owner
    const step = ((await getScenario(db, scenarioId)).draft?.document as any)?.steps?.[0]
    expect(step).toBeDefined()
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `step-explain-pos-${crypto.randomUUID()}`,
        question: '请解释当前步骤的作用',
        capabilityHint: 'scenario.explain',
        pageContext: {
          page: 'studio',
          scenarioId,
          draftRevision: 1,
          stepId: step.id,
        },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.result.kind).toBe('explanation')
    expect(turn.result.stepSummary).toContain('回显')
    expect(turn.result.stepSummary).toContain('echo')
  })

  it('Studio 反例：选中不存在的 stepId 时平滑降级为场景级解释，stepSummary 不臆造虚构事实', async () => {
    current = owner
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `step-explain-neg-${crypto.randomUUID()}`,
        question: '请解释当前步骤的作用',
        capabilityHint: 'scenario.explain',
        pageContext: {
          page: 'studio',
          scenarioId,
          draftRevision: 1,
          stepId: crypto.randomUUID(),
        },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.result.kind).toBe('explanation')
    expect(turn.result.stepSummary).toBeUndefined()
    expect(turn.result.summary).toContain('巡检')
  })
})
