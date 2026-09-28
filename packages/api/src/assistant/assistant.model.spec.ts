import {
  INestApplication,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ASSISTANT_GUIDE_CATALOG,
  createAccountBodySchema,
  createTargetBodySchema,
  FACTORY_PLATFORM_CONFIG,
  PERMISSIONS,
  type Step,
} from '@cairn/shared'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  getAssistantTurnRecord,
  getOrCreatePlatformConfig,
  newId,
  RbacStore,
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
import type { PlatformModelClient } from './model-client'

const echo: Step = {
  id: newId(),
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe('助手接入平台 AI（模拟供应商）', { timeout: 30_000 }, () => {
  let db: Awaited<ReturnType<typeof openIsolatedDb>>
  let app: INestApplication
  let current: RequestAccount
  let runId: string
  let targetId: string
  let targetAccountId: string
  let compareRunId: string
  let conversationId: string
  const prompts: string[] = []

  beforeAll(async () => {
    db = await openIsolatedDb(`cairn_assist_model_${newId().replaceAll('-', '')}`)
    const rbac = new RbacStore(db, {
      hash: async (value) => value,
      verify: async (value, hash) => value === hash,
    })
    const adminRole = (await rbac.listRoles()).items.find((role) => role.key === 'admin')
    if (!adminRole) throw new Error('缺少 admin 角色')
    const created = await rbac.createAccount(
      createAccountBodySchema.parse({
        email: 'assist-model',
        displayName: '模型测试',
        password: 'test-password',
        roleIds: [adminRole.id],
      }),
      null,
    )
    current = {
      id: created.id,
      displayName: created.displayName,
      email: created.email,
      status: 'active',
      roles: created.roles,
      permissions: [...PERMISSIONS],
    }
    const targets = new TargetsStore(db, () => Buffer.from('encrypted'))
    const target = await targets.createTarget(
      createTargetBodySchema.parse({
        code: 'titan-model',
        name: '泰坦',
        entryUrl: 'https://example.com',
        account: { username: 'tester', displayName: '测试账号', password: 'hidden', validity: { mode: 'permanent' } },
      }),
      current,
    )
    targetId = target.id
    targetAccountId = (await targets.listAccounts(target.id)).items[0]!.id
    const scenario = await createScenarioWithVersion(db, {
      targetId: target.id,
      name: '巡检',
      steps: [{ ...echo, id: newId() }],
      actor: current,
    })
    const run = await createRunWithSnapshot(db, { scenarioId: scenario.id, actor: current })
    runId = run.detail.id
    compareRunId = (await createRunWithSnapshot(db, { scenarioId: scenario.id, actor: current })).detail.id
    await getOrCreatePlatformConfig(db)
    const secrets = new LocalSecretProvider(Buffer.alloc(32, 7))
    const platformConfig = new PlatformConfigService(db, secrets)
    const secretRef = (
      await platformConfig.registerSecret(
        { baseUrl: 'https://llm.example/v1', apiKey: 'test-key' },
        current,
      )
    ).secretRef
    const currentConfig = await platformConfig.get()
    await platformConfig.update(
      {
        expectedRevision: currentConfig.revision,
        reason: '测试启用平台助手模型',
        document: {
          ...FACTORY_PLATFORM_CONFIG,
          platformAi: {
            ...FACTORY_PLATFORM_CONFIG.platformAi,
            enabled: true,
            provider: 'deepseek',
            baseUrl: 'https://llm.example/v1',
            model: 'mock-text',
            secretRef,
          },
        },
      },
      current,
    )
    const models: PlatformModelClient = {
      async complete(input) {
        prompts.push(input.messages.map((item) => item.content).join('\n'))
        const system = input.messages[0]?.content ?? ''
        const user = JSON.parse(
          input.messages.find((item) => item.role === 'user')?.content ?? '{}',
        ) as { question?: string }
        if (system.includes('路由器')) {
          return {
            text: JSON.stringify(user.question?.includes('天气') || user.question?.includes('提交付款')
              ? { skillId: 'none', confidence: 0, slots: {} }
              : user.question?.includes('从零录制')
                ? { skillId: 'platform.guide', confidence: 1, slots: { topic: 'studio' } }
              : user.question?.includes('对比运行')
                ? {
                    skillId: 'run.compare', confidence: 1,
                    slots: {
                      baseRunId: '33333333-3333-4333-8333-333333333333',
                      targetRunId: '44444444-4444-4444-8444-444444444444',
                      compareRunId: '55555555-5555-4555-8555-555555555555',
                    },
                  }
              : user.question?.includes('帮我看看这次运行')
                ? { skillId: 'run.diagnose', confidence: 1,
                    slots: {
                      runId: '33333333-3333-4333-8333-333333333333',
                      targetId: '44444444-4444-4444-8444-444444444444',
                    } }
              : { skillId: 'run.diagnose', confidence: 1, slots: {} }),
            model: 'mock-text',
          }
        }
        throw new Error(`未预期的模型请求：${system}`)
      },
    }
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
        models,
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

  it('启用平台 AI 后能力接口报告模型可用', async () => {
    const caps = await request(app.getHttpServer()).get('/assistant/capabilities').expect(200)
    expect(caps.body.modelEnabled).toBe(true)
  })

  it('自由问句先分类再诊断，不生成未经语义核验的根因假设', async () => {
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `model-diagnose-${crypto.randomUUID()}`,
        question: '帮我看看这个',
        pageContext: { page: 'run', runId },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.result.kind).toBe('diagnosis')
    expect(turn.result.hypotheses).toEqual([])
    expect(JSON.stringify(prompts)).not.toContain('hidden')
    expect(JSON.stringify(prompts)).not.toContain('泰坦')
  })

  it('模型提取的对象 ID 不能覆盖运行页已绑定的对象', async () => {
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `model-scoped-run-${crypto.randomUUID()}`,
        question: '帮我看看这次运行',
        pageContext: { page: 'run', runId, targetId },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.status).toBe('COMPLETED')
    expect(turn.result.kind).toBe('diagnosis')
    const stored = await getAssistantTurnRecord(db, turn.id, current.id)
    expect(stored.slots?.runId).toBe(runId)
    expect(stored.slots?.targetId).toBe(targetId)
  })

  it('会话系统列表的账号问法不让模型误选厂家供应商记录', async () => {
    const question = '这个系统有哪些账号正在使用会话？'
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `model-session-list-${crypto.randomUUID()}`,
        question,
        pageContext: {
          version: 2, routeKey: 'sessions.index.systems', pageKind: 'session', page: 'session',
          targetId, scopeRefs: [{ kind: 'target', id: targetId }],
        },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.status).toBe('COMPLETED')
    expect(turn.capabilityId).toBe('knowledge.answer')
    expect(turn.result.summary).toContain('该目标共有 1 个关联账号')
    expect(JSON.stringify(turn.result)).not.toContain('厂家／制造商')
  })

  it('对比显式 Run 时页面与问句 ID 优先于模型给出的 ID', async () => {
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `model-compare-${crypto.randomUUID()}`,
        question: `把这次运行和 ${compareRunId} 对比运行状态`,
        pageContext: { page: 'run', runId },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.status).toBe('COMPLETED')
    expect(turn.result.kind).toBe('compare')
    expect(turn.result.baseRunId).toBe(runId)
    expect(turn.result.targetRunId).toBe(compareRunId)
  })

  it('平台外天气问题直接说明能力边界，不列无关菜单', async () => {
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `model-weather-${crypto.randomUUID()}`,
        question: '明天天气怎么样？',
        pageContext: { page: 'home' },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.status).toBe('COMPLETED')
    expect(turn.result).toMatchObject({ kind: 'unsupported', reasonCode: 'OUT_OF_SCOPE' })
    expect(turn.result.message).toContain('无法查询天气')
  })

  it('平台外执行请求不误套天气文案，也不暗示已经执行', async () => {
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `model-payment-${crypto.randomUUID()}`,
        question: '直接替我提交付款并关掉风险提醒',
        pageContext: { page: 'home' },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.status).toBe('COMPLETED')
    expect(turn.result).toMatchObject({ kind: 'unsupported', reasonCode: 'OUT_OF_SCOPE' })
    expect(turn.result.message).toContain('无法代你执行')
    expect(turn.result.message).not.toContain('天气')
  })

  it('平台是否有某类数据的普通问句不受低置信度模型路由波动影响', async () => {
    const before = prompts.length
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `model-data-availability-${crypto.randomUUID()}`,
        question: '识途里有火星生态数据吗？',
        pageContext: { page: 'home' },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.status).toBe('COMPLETED')
    expect(turn.capabilityId).toBe('knowledge.answer')
    expect(turn.result?.kind).toBe('knowledge_answer')
    expect(turn.result?.missing).toContainEqual(expect.objectContaining({ reason: 'no_matching_facts' }))
    expect(prompts.length).toBe(before)
  })

  it('账号会话页的认证历史问法不交给模型误分到业务记录', async () => {
    const before = prompts.length
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `model-account-auth-history-${crypto.randomUUID()}`,
        question: '这个账号最近一次认证成功是什么时候？',
        pageContext: {
          version: 2, routeKey: 'sessions.$targetId.$accountId', pageKind: 'session', page: 'session',
          primaryRef: { kind: 'account', id: targetAccountId },
          scopeRefs: [{ kind: 'target', id: targetId }, { kind: 'account', id: targetAccountId }],
          targetId,
        },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.capabilityId).toBe('knowledge.answer')
    expect(turn.result?.kind).toBe('knowledge_answer')
    expect(prompts.length).toBe(before)
  })

  it('全量功能导览可保存目录中的全部入口', async () => {
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `model-all-guide-${crypto.randomUUID()}`,
        question: '功能入口',
        capabilityHint: 'platform.guide',
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.status).toBe('COMPLETED')
    expect(turn.result?.kind).toBe('guide')
    expect(turn.result.items).toHaveLength(ASSISTANT_GUIDE_CATALOG.length)
  })

  it('澄清中的运行对比可放弃并在同会话转问助手能力', async () => {
    const first = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `model-compare-clarify-${crypto.randomUUID()}`,
        question: '对比两次运行',
        capabilityHint: 'run.compare',
      })
      .expect(202)
    const clarification = await waitForTurn(conversationId, first.body.turnId)
    expect(clarification.status).toBe('CLARIFY')

    const second = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `model-new-task-${crypto.randomUUID()}`,
        question: '算了，识途能帮我做什么？',
        replyToTurnId: clarification.id,
      })
      .expect(202)
    const answer = await waitForTurn(conversationId, second.body.turnId)
    expect(answer.status).toBe('COMPLETED')
    expect(answer.capabilityId).toBe('knowledge.answer')
    expect(answer.result?.kind).toBe('knowledge_answer')
    expect(answer.result.summary).toContain('运行诊断')
    const previous = await request(app.getHttpServer())
      .get(`/assistant/conversations/${conversationId}/turns/${clarification.id}`)
      .expect(200)
    expect(previous.body.status).toBe('CANCELLED')
    expect(previous.body.stopReason).toBe('superseded_by_new_task')
  })

  it('从零录制问法保留精确的场景导览主题，不被模型宽泛主题覆盖', async () => {
    const before = prompts.length
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `model-recording-${crypto.randomUUID()}`,
        question: '在识途平台中，如何从零录制并编排一个新场景？',
        pageContext: { page: 'home' },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.status).toBe('COMPLETED')
    expect(turn.capabilityId).toBe('platform.guide')
    expect(turn.result?.kind).toBe('guide')
    expect(turn.result.items.map((item: { href: string }) => item.href)).toEqual(['/recordings', '/scenarios'])
    expect(prompts.length).toBe(before)
  })
})
