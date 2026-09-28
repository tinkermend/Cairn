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
  beginAssistantTurn,
  completeAssistantTurn,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getOrCreatePlatformConfig,
  getScenario,
  newId,
  publishScenarioDraft,
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
import * as modelSession from './model-session'
import { PlatformConfigService } from '../platform-config/platform-config.service'
import { TargetsService } from '../targets/targets.service'
import { LocalSecretProvider } from '../secrets/local-secret-provider'
import { RUN_FAILURE_DIGEST_CITATION } from './handlers/knowledge-answer.handler'

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
  let targetId: string
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
    targetId = target.id
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

  async function saveHistoricalTurn(
    result: Parameters<typeof completeAssistantTurn>[1]['result'],
    slots: Record<string, unknown>,
    thinkingText?: string,
  ) {
    const token = newId()
    const started = await beginAssistantTurn(db, {
      conversationId,
      ownerAccountId: owner.id,
      clientTurnId: `history-${newId()}`,
      requestDigest: newId(),
      question: '检查泰坦目标的情况',
      deadlineAt: new Date(Date.now() + 60_000),
      processingToken: token,
      userLimit: 10,
      platformLimit: 10,
    })
    await completeAssistantTurn(db, {
      turnId: started.turn.id,
      ownerAccountId: owner.id,
      processingToken: token,
      status: 'COMPLETED',
      capabilityId: result?.kind === 'knowledge_answer' ? 'knowledge.answer'
        : result?.kind === 'diagnosis' ? 'run.diagnose' : 'in-page.guidance',
      slots,
      result,
      thinkingText,
    })
    return started.turn.id
  }

  it('没有 ai:assist 不能进入助手', async () => {
    current = account(owner.id, ['run:read', 'target:read'])
    await request(app.getHttpServer()).get('/assistant/capabilities').expect(403)
    current = owner
  })

  it('旧澄清选项没有 kind 时，选择能力仍按能力执行', async () => {
    const parentTurnId = await saveHistoricalTurn({
      kind: 'clarify',
      question: '请选择本次要执行的操作。',
      missingFields: ['capabilityId'],
      options: [{ id: 'run.diagnose', label: '运行诊断' }],
    }, {})
    const submitted = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `legacy-capability-choice-${newId()}`,
        question: '这次运行为什么失败？',
        replyToTurnId: parentTurnId,
        selectedOptionId: 'run.diagnose',
        pageContext: { page: 'run', runId, targetId, scenarioId },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, submitted.body.turnId)
    expect(turn.status).toBe('COMPLETED')
    expect(turn.capabilityId).toBe('run.diagnose')
    expect(turn.result.kind).toBe('diagnosis')
  })

  it('从运行页澄清选择有源问答后，完成轮次可按所引用 Run 回读', async () => {
    const parentTurnId = await saveHistoricalTurn({
      kind: 'clarify',
      question: '请选择本次要执行的操作。',
      missingFields: ['capabilityId'],
      options: [{ id: 'knowledge.answer', label: '有源开放问答' }],
    }, {})
    const submitted = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `legacy-knowledge-choice-${newId()}`,
        question: '请按记录列出这次运行的执行状态和业务结果。',
        replyToTurnId: parentTurnId,
        selectedOptionId: 'knowledge.answer',
        pageContext: { page: 'run', runId, targetId, scenarioId },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, submitted.body.turnId)
    expect(turn.status).toBe('COMPLETED')
    expect(turn.capabilityId).toBe('knowledge.answer')
    expect(turn.result.kind).toBe('knowledge_answer')
    expect(turn.result.claims.some((claim: { citations: string[] }) =>
      claim.citations.includes(`run:${runId}`))).toBe(true)
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

  it('同一账号失去会话权限后，历史有源问答的摘要、结论在单轮、列表和 SSE 中均隐藏', async () => {
    const marker = '泰坦账号认证状态私有标记'
    const turnId = await saveHistoricalTurn({
      kind: 'knowledge_answer',
      summary: marker,
      claims: [{ factKind: 'observed', text: marker, citations: [`target:${targetId}`] }],
      missing: [],
      asOf: new Date().toISOString(),
      nextActions: [],
    }, { targetId }, marker)
    const path = `/assistant/conversations/${conversationId}/turns/${turnId}`

    const before = await request(app.getHttpServer()).get(path).expect(200)
    expect(before.body.result.kind).toBe('knowledge_answer')
    expect(JSON.stringify(before.body.result)).toContain(marker)

    current = account(owner.id, ['ai:assist', 'target:read'])
    const after = await request(app.getHttpServer()).get(path).expect(200)
    expect(after.body.result.kind).toBe('inaccessible')
    expect(JSON.stringify(after.body)).not.toContain(marker)
    expect(after.body).not.toHaveProperty('thinkingText')

    const list = await request(app.getHttpServer())
      .get(`/assistant/conversations/${conversationId}/turns?limit=100`)
      .expect(200)
    const listed = list.body.items.find((item: { id: string }) => item.id === turnId)
    expect(listed.result.kind).toBe('inaccessible')
    expect(JSON.stringify(listed)).not.toContain(marker)

    const observed = await request(app.getHttpServer()).get(`${path}/observe`).expect(200)
    expect(observed.headers['content-type']).toContain('text/event-stream')
    expect(observed.text).toContain('inaccessible')
    expect(observed.text).not.toContain(marker)
  })

  it('同一账号失去地图权限后，目标知识生成的历史页面指引不再显示', async () => {
    const marker = '泰坦私有菜单路径标记'
    const turnId = await saveHistoricalTurn({
      kind: 'in_page_guidance',
      directAnswer: marker,
      visualPath: [`1. ${marker}`],
    }, { targetId, page: 'target', question: '这个系统的订单页入口在哪？' }, marker)
    const path = `/assistant/conversations/${conversationId}/turns/${turnId}`

    const before = await request(app.getHttpServer()).get(path).expect(200)
    expect(before.body.result.kind).toBe('in_page_guidance')
    expect(before.body.result.directAnswer).toContain('未提供这项页面的可核验入口')
    expect(before.body.result.directAnswer).toContain('不能据此判断页面不存在')
    expect(JSON.stringify(before.body.result)).not.toContain(marker)

    current = account(owner.id, ['ai:assist', 'target:read'])
    const after = await request(app.getHttpServer()).get(path).expect(200)
    expect(after.body.result.kind).toBe('inaccessible')
    expect(JSON.stringify(after.body)).not.toContain(marker)
    expect(after.body).not.toHaveProperty('thinkingText')

    const list = await request(app.getHttpServer())
      .get(`/assistant/conversations/${conversationId}/turns?limit=100`)
      .expect(200)
    const listed = list.body.items.find((item: { id: string }) => item.id === turnId)
    expect(listed.result.kind).toBe('inaccessible')
    expect(JSON.stringify(listed)).not.toContain(marker)

    const observed = await request(app.getHttpServer()).get(`${path}/observe`).expect(200)
    expect(observed.text).toContain('inaccessible')
    expect(observed.text).not.toContain(marker)
  })

  it('旧目标地图指引缺目标槽位时隐藏未经证实的页面路径和缺失断言', async () => {
    const marker = '旧答复断言订单页不存在'
    const turnId = await saveHistoricalTurn({
      kind: 'in_page_guidance',
      directAnswer: marker,
      visualPath: [marker],
    }, { page: 'target', question: '这个系统的订单页入口在哪？' }, marker)
    const read = await request(app.getHttpServer())
      .get(`/assistant/conversations/${conversationId}/turns/${turnId}`)
      .expect(200)
    expect(read.body.result.kind).toBe('inaccessible')
    expect(JSON.stringify(read.body)).not.toContain(marker)
  })

  it('历史页面指引点名目标与保存的目标槽位不一致时不回放旧路径', async () => {
    const marker = '不应显示的跨目标路径'
    const turnId = await saveHistoricalTurn({
      kind: 'in_page_guidance', directAnswer: marker, visualPath: [marker],
    }, { targetId, page: 'target', question: '远端目标的订单页入口在哪里？' }, marker)
    const read = await request(app.getHttpServer())
      .get(`/assistant/conversations/${conversationId}/turns/${turnId}`)
      .expect(200)
    expect(read.body.result.kind).toBe('inaccessible')
    expect(read.body.result.message).toContain('目标范围与提问名称不一致')
    expect(JSON.stringify(read.body)).not.toContain(marker)
  })

  it('历史运行没有具体失败记录时不回放旧根因假设', async () => {
    const marker = '虚构的数据库故障根因'
    const turnId = await saveHistoricalTurn({
      kind: 'diagnosis', observedAt: new Date().toISOString(), eventSeq: 1, focus: 'failure',
      facts: [{ id: 'status', text: '运行状态见运行详情。', citations: [`run:${runId}`] }],
      hypotheses: [{ text: marker, citations: [`run:${runId}`] }],
      missingInformation: [], nextActions: [{ kind: 'run.detail', label: '打开运行详情', href: `/runs/${runId}`, citations: [`run:${runId}`] }],
    }, { runId }, marker)
    const read = await request(app.getHttpServer())
      .get(`/assistant/conversations/${conversationId}/turns/${turnId}`)
      .expect(200)
    expect(read.body.result.kind).toBe('diagnosis')
    expect(read.body.result.hypotheses).toEqual([])
    expect(read.body.result.missingInformation.join(' ')).toContain('历史模型原因未经过语义证据核验，已隐藏')
    expect(JSON.stringify(read.body.result)).not.toContain(marker)
  })

  it('无目标的静态页面指引从当前地标重建，即使原动作没有 actionChip', async () => {
    const marker = '不可重放的旧页面指引内容'
    const turnId = await saveHistoricalTurn({
      kind: 'in_page_guidance',
      directAnswer: marker,
      visualPath: [marker],
    }, { page: 'studio', question: '怎么保存草稿？' }, marker)
    const path = `/assistant/conversations/${conversationId}/turns/${turnId}`
    const read = await request(app.getHttpServer()).get(path).expect(200)
    expect(read.body.result.kind).toBe('in_page_guidance')
    expect(read.body.result.directAnswer).toContain('顶部操作栏')
    expect(read.body.result.directAnswer).toContain('保存')
    expect(read.body.result.shortcutHint).toBe('Cmd/Ctrl + S')
    expect(read.body.result).not.toHaveProperty('actionChip')
    expect(JSON.stringify(read.body)).not.toContain(marker)

    const list = await request(app.getHttpServer())
      .get(`/assistant/conversations/${conversationId}/turns?limit=100`)
      .expect(200)
    const listed = list.body.items.find((item: { id: string }) => item.id === turnId)
    expect(listed.result.directAnswer).toBe(read.body.result.directAnswer)
    expect(JSON.stringify(listed)).not.toContain(marker)
  })

  it('旧页面指引在地标未命中时给可核验边界，缺页面槽位时仍隐藏旧自由文本', async () => {
    const marker = '未核验的旧指引'
    for (const slots of [
      { page: 'studio', question: '那个入口在哪？' },
      { question: '怎么保存草稿？' },
    ]) {
      const turnId = await saveHistoricalTurn({
        kind: 'in_page_guidance',
        directAnswer: marker,
        visualPath: [marker],
        actionChip: { label: '旧按钮', actionKey: 'legacy-action' },
      }, slots)
      const read = await request(app.getHttpServer())
        .get(`/assistant/conversations/${conversationId}/turns/${turnId}`)
        .expect(200)
      expect(read.body.result.kind).toBe('page' in slots ? 'in_page_guidance' : 'inaccessible')
      if ('page' in slots) {
        expect(read.body.result.directAnswer).toContain('已登记界面地标')
        expect(read.body.result.directAnswer).toContain('无法确认')
      }
      expect(JSON.stringify(read.body)).not.toContain(marker)
    }
  })

  it('历史有源问答引用来源无法核验时，连同自由文本摘要整条隐藏', async () => {
    const marker = '未登记事实来源私有标记'
    const turnId = await saveHistoricalTurn({
      kind: 'knowledge_answer',
      summary: marker,
      claims: [{ factKind: 'observed', text: marker, citations: ['unknown:legacy'] }],
      missing: [],
      asOf: new Date().toISOString(),
      nextActions: [],
    }, {})
    const read = await request(app.getHttpServer())
      .get(`/assistant/conversations/${conversationId}/turns/${turnId}`)
      .expect(200)
    expect(read.body.result.kind).toBe('inaccessible')
    expect(JSON.stringify(read.body)).not.toContain(marker)
  })

  it('只有当前仍获授权的官方帮助引用时，历史有源问答仍可读取', async () => {
    const marker = '草稿未保存时仅在画布生效，保存后方可作为发布版本或试跑输入。'
    const falseSummary = '旧摘要：草稿没保存也能直接试跑'
    const turnId = await saveHistoricalTurn({
      kind: 'knowledge_answer',
      summary: falseSummary,
      claims: [{ factKind: 'human_confirmed', text: marker, citations: ['help:studio-steps'] }],
      missing: [{ key: 'trial-without-save', reason: 'missing_steps', description: falseSummary }],
      asOf: new Date().toISOString(),
      nextActions: [{ kind: 'studio.step', label: '前往场景工作室', href: '/scenarios', citations: [] }],
    }, {})
    const read = await request(app.getHttpServer())
      .get(`/assistant/conversations/${conversationId}/turns/${turnId}`)
      .expect(200)
    expect(read.body.result.kind).toBe('knowledge_answer')
    expect(read.body.result.summary).toBe(marker)
    expect(read.body.result.missing).toEqual([])
    expect(read.body.result.nextActions).toEqual([
      { kind: 'studio.step', label: '前往场景工作室', href: '/scenarios', citations: [] },
    ])
    expect(JSON.stringify(read.body.result)).not.toContain(falseSummary)
  })

  it('历史帮助结论虽引用了真实帮助键，若内容与原文相反则整条拒绝回放', async () => {
    const marker = '草稿没保存也能直接试跑'
    const turnId = await saveHistoricalTurn({
      kind: 'knowledge_answer',
      summary: marker,
      claims: [{ factKind: 'human_confirmed', text: marker, citations: ['help:studio-steps'] }],
      missing: [],
      asOf: new Date().toISOString(),
    }, {})
    const read = await request(app.getHttpServer())
      .get(`/assistant/conversations/${conversationId}/turns/${turnId}`)
      .expect(200)
    expect(read.body.result).toEqual({
      kind: 'inaccessible',
      reasonCode: 'UNVERIFIED_HISTORY',
      message: '这条历史帮助结论无法按已发布原文核验，请重新提问',
    })
    expect(JSON.stringify(read.body)).not.toContain(marker)
  })

  it('历史有源问答含旧式推断时，不回放可能错误的摘要和结论', async () => {
    const marker = '这次成功运行实际上失败了'
    const turnId = await saveHistoricalTurn({
      kind: 'knowledge_answer',
      summary: marker,
      claims: [{ factKind: 'inferred', text: marker,
        citations: [`run:${runId}`], premises: ['状态: SUCCEEDED'] }],
      missing: [],
      asOf: new Date().toISOString(),
      nextActions: [],
    }, { runId, targetId }, marker)
    const path = `/assistant/conversations/${conversationId}/turns/${turnId}`
    const single = await request(app.getHttpServer()).get(path).expect(200)
    expect(single.body.result).toEqual({
      kind: 'inaccessible', message: '这条历史推断未按当前证据规则核验，请重新提问',
      reasonCode: 'UNVERIFIED_HISTORY',
    })
    expect(JSON.stringify(single.body)).not.toContain(marker)

    const listed = await request(app.getHttpServer())
      .get(`/assistant/conversations/${conversationId}/turns`).expect(200)
    const item = listed.body.items.find((turn: { id: string }) => turn.id === turnId)
    expect(item?.result?.kind).toBe('inaccessible')
    expect(JSON.stringify(item)).not.toContain(marker)
  })

  it('失败运行归并须带完整 Run 来源清单，并在每次历史读取时重新授权', async () => {
    const marker = '泰坦失败运行归并私有摘要'
    const source = `run:${runId}`
    const result = {
      kind: 'knowledge_answer' as const,
      summary: marker,
      claims: [{ factKind: 'observed' as const, text: '筛选范围内有一条失败运行', citations: [RUN_FAILURE_DIGEST_CITATION, source] }],
      missing: [],
      asOf: new Date().toISOString(),
      nextActions: [{ kind: 'run.detail' as const, label: '查看运行', href: `/runs/${runId}`, citations: [source] }],
    }
    const turnId = await saveHistoricalTurn(result, {})
    const path = `/assistant/conversations/${conversationId}/turns/${turnId}`
    const before = await request(app.getHttpServer()).get(path).expect(200)
    expect(before.body.result.kind).toBe('knowledge_answer')
    expect(before.body.result.summary).toBe(marker)

    current = account(owner.id, ['ai:assist', 'target:read'])
    const after = await request(app.getHttpServer()).get(path).expect(200)
    expect(after.body.result.kind).toBe('inaccessible')
    expect(JSON.stringify(after.body)).not.toContain(marker)
  })

  it('旧归并缺来源清单，以及重复、越界或伪造的来源清单都不可回放', async () => {
    const source = `run:${runId}`
    const marker = '不可回放的归并摘要'
    const base = {
      kind: 'knowledge_answer' as const,
      summary: marker,
      missing: [],
      asOf: new Date().toISOString(),
      nextActions: [] as Array<{ kind: 'run.detail'; label: string; href: string; citations: string[] }>,
    }
    const rejected = [
      { ...base, claims: [{ factKind: 'observed' as const, text: marker, citations: [source] }] },
      { ...base, claims: [{ factKind: 'observed' as const, text: marker, citations: [RUN_FAILURE_DIGEST_CITATION, source, source] }] },
      { ...base, claims: [{ factKind: 'observed' as const, text: marker, citations: [RUN_FAILURE_DIGEST_CITATION, source, `run:${newId()}`] }] },
      { ...base,
        claims: [{ factKind: 'observed' as const, text: marker, citations: [RUN_FAILURE_DIGEST_CITATION, source] }],
        nextActions: [{ kind: 'run.detail' as const, label: '错误链接', href: `/runs/${newId()}`, citations: [source] }],
      },
    ]
    for (const result of rejected) {
      const turnId = await saveHistoricalTurn(result, {})
      const read = await request(app.getHttpServer())
        .get(`/assistant/conversations/${conversationId}/turns/${turnId}`)
        .expect(200)
      expect(read.body.result.kind).toBe('inaccessible')
      expect(JSON.stringify(read.body)).not.toContain(marker)
    }
  })

  it('能力概览历史按当前账号权限重新生成，不沿用旧摘要', async () => {
    const turnId = await saveHistoricalTurn({
      kind: 'knowledge_answer',
      summary: '旧权限下的虚假摘要',
      claims: [{ factKind: 'human_confirmed', text: '旧权限', citations: ['platform:capability_overview'] }],
      missing: [],
      asOf: new Date().toISOString(),
    }, {})
    const path = `/assistant/conversations/${conversationId}/turns/${turnId}`
    const before = await request(app.getHttpServer()).get(path).expect(200)
    expect(before.body.result.kind).toBe('knowledge_answer')
    expect(before.body.result.summary).toContain('运行诊断')
    expect(JSON.stringify(before.body.result)).not.toContain('旧权限下的虚假摘要')

    current = account(owner.id, ['ai:assist'])
    const after = await request(app.getHttpServer()).get(path).expect(200)
    expect(after.body.result.kind).toBe('knowledge_answer')
    expect(after.body.result.summary).not.toContain('- 运行诊断：')
    expect(after.body.result.summary).toContain('功能导览')
  })

  it('目标实时 CPU 无来源提示可读取，但不回放历史自由文本或目标事实', async () => {
    const turnId = await saveHistoricalTurn({
      kind: 'knowledge_answer',
      summary: '旧答复可能含有目标私有事实',
      claims: [{ factKind: 'human_confirmed', text: '旧声明', citations: ['platform:target_cpu_unavailable'] }],
      missing: [{ key: 'target_cpu_metric', reason: 'source_unavailable', description: '旧缺口' }],
      asOf: new Date().toISOString(),
    }, { targetId })
    current = account(owner.id, ['ai:assist'])
    const read = await request(app.getHttpServer())
      .get(`/assistant/conversations/${conversationId}/turns/${turnId}`)
      .expect(200)
    expect(read.body.result.kind).toBe('knowledge_answer')
    expect(read.body.result.summary).toContain('没有这个目标外部实例的实时 CPU 利用率数据')
    expect(JSON.stringify(read.body.result)).not.toContain('旧答复可能含有目标私有事实')
  })

  it('上下文对象不一致提示不回放历史混合事实', async () => {
    const turnId = await saveHistoricalTurn({
      kind: 'knowledge_answer',
      summary: '错误混合的目标与运行事实',
      claims: [{ factKind: 'human_confirmed', text: '旧声明', citations: ['platform:page_context_mismatch'] }],
      missing: [{ key: 'page_context', reason: 'scope_mismatch', description: '旧缺口' }],
      asOf: new Date().toISOString(),
    }, { targetId })
    const read = await request(app.getHttpServer())
      .get(`/assistant/conversations/${conversationId}/turns/${turnId}`)
      .expect(200)
    expect(read.body.result.kind).toBe('knowledge_answer')
    expect(read.body.result.summary).toContain('上下文')
    expect(JSON.stringify(read.body.result)).not.toContain('错误混合的目标与运行事实')
  })

  it.each([
    ['no_matching_facts', '未检索到相关权威事实'],
    ['session_permission_denied', '缺少目标系统或会话读取权限'],
    ['session_read_failed', '健康数据读取失败'],
  ])('固定状态 %s 首次读取可见且撤权后不回放旧自由文本', async (status, expected) => {
    const marker = '泰坦私有账号健康旧结论'
    const turnId = await saveHistoricalTurn({
      kind: 'knowledge_answer',
      summary: marker,
      claims: [{ factKind: 'human_confirmed', text: marker, citations: [`platform:knowledge_status:${status}`] }],
      missing: [{ key: 'session_overview', reason: '旧状态', description: marker }],
      nextActions: [{ kind: 'target.accounts', label: marker, href: `/sessions/${targetId}/${newId()}`, citations: [`target:${targetId}`] }],
      asOf: new Date().toISOString(),
    }, { targetId }, marker)
    const path = `/assistant/conversations/${conversationId}/turns/${turnId}`
    const first = await request(app.getHttpServer()).get(path).expect(200)
    expect(first.body.result.kind).toBe('knowledge_answer')
    expect(first.body.result.summary).toContain(expected)
    expect(first.body.result.nextActions).toBeUndefined()
    expect(JSON.stringify(first.body)).not.toContain(marker)

    current = account(owner.id, ['ai:assist'])
    const after = await request(app.getHttpServer()).get(path).expect(200)
    expect(after.body.result.kind).toBe('knowledge_answer')
    expect(after.body.result.summary).toContain(expected)
    expect(JSON.stringify(after.body)).not.toContain(marker)
    expect(after.body).not.toHaveProperty('thinkingText')
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

  it('只读用户询问从零录制时说明权限缺口，历史回读按当前权限重建', async () => {
    current = account(owner.id, SYSTEM_ROLE_DEFINITIONS.viewer.permissions)
    const sub = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `viewer-recording-guide-${crypto.randomUUID()}`,
        question: '在识途平台中，如何从零录制并编排一个新场景？',
        pageContext: { page: 'home' },
      })
      .expect(202)
    const turn = await waitForTurn(conversationId, sub.body.turnId)
    expect(turn.result.kind).toBe('guide')
    expect(turn.result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '录制与新建场景', href: null, availability: 'forbidden' }),
      expect.objectContaining({ title: '查看已有场景', href: '/scenarios', availability: 'available' }),
    ]))
    expect(JSON.stringify(turn.result)).not.toContain('试跑当前草稿')
    expect(JSON.stringify(turn.result)).not.toContain('保存草稿。4. 点击')

    current = owner
    const withWrite = await request(app.getHttpServer())
      .get(`/assistant/conversations/${conversationId}/turns/${sub.body.turnId}`)
      .expect(200)
    expect(withWrite.body.result.items.map((item: { href: string | null }) => item.href)).toEqual(['/recordings', '/scenarios'])

    current = account(owner.id, SYSTEM_ROLE_DEFINITIONS.viewer.permissions)
    const readAgain = await request(app.getHttpServer())
      .get(`/assistant/conversations/${conversationId}/turns/${sub.body.turnId}`)
      .expect(200)
    expect(readAgain.body.result.items[0].availability).toBe('forbidden')
    expect(JSON.stringify(readAgain.body.result)).not.toContain('/recordings')
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

  it('用户询问未保存画布改动时只说明已保存定义和信息缺口', async () => {
    const modelSpy = vi.spyOn(modelSession, 'generateExplanationText')
    try {
      const sub = await request(app.getHttpServer())
        .post(`/assistant/conversations/${conversationId}/turns`)
        .send({
          clientTurnId: `owner-unsaved-${crypto.randomUUID()}`,
          question: '我刚在画布改了这段步骤但还没保存，为什么不行？',
          capabilityHint: 'scenario.explain',
          pageContext: {
            version: 2,
            routeKey: 'scenarios.$scenarioId',
            pageKind: 'studio',
            page: 'studio',
            scenarioId,
            draft: { isDirty: true, savedRevision: 1 },
          },
        })
        .expect(202)
      const turn = await waitForTurn(conversationId, sub.body.turnId)
      expect(turn.result.kind).toBe('explanation')
      expect(turn.result.summary).toContain('不能判断那段修改为什么不行')
      expect(turn.result.summary).toContain('请先保存草稿')
      expect(modelSpy).not.toHaveBeenCalled()
    } finally {
      modelSpy.mockRestore()
    }
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
            rule: { kind: 'deterministic', target: click.input.target, expect: { kind: 'exists' } },
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

    const modelSpy = vi.spyOn(modelSession, 'generateExplanationText')
    try {
      const draft = await submit(`outcome-draft-${crypto.randomUUID()}`, {})
      expect(draft.result.kind).toBe('explanation')
      expect(draft.result.summary).toContain('草稿（修订版本 2）')
      expect(draft.result.summary).toContain('MUST「提交后出现订单成功提示」')
      expect(draft.result.diagnostics.map((item: { code: string }) => item.code)).not.toContain('SCENARIO_NO_OUTCOME')
      expect(JSON.stringify(draft.result)).not.toMatch(/没有成功条件|没有断言/)
      expect(draft.result.summary).toContain('关联步骤「点击提交」（点击）')
      expect(draft.result.summary).toContain('检查目标元素存在，不满足时中止')

      const published = await submit(`outcome-published-${crypto.randomUUID()}`, {
        versionId: scenario.published!.versionId,
      })
      expect(published.result.kind).toBe('explanation')
      expect(published.result.summary).toContain('已发布版本 1')
      expect(published.result.summary).not.toContain('提交后出现订单成功提示')
      expect(published.result.diagnostics.map((item: { code: string }) => item.code)).toContain('SCENARIO_NO_OUTCOME')
      expect(published.result.summary).toContain('未列出业务成功条件')

      const versioned = await publishScenarioDraft(db, scenario.id, { revision: 2, actor: owner })
      const publishedWithOutcome = await submit(`outcome-published-v2-${crypto.randomUUID()}`, {
        versionId: versioned.published!.versionId,
      })
      expect(publishedWithOutcome.result.kind).toBe('explanation')
      expect(publishedWithOutcome.result.summary).toContain('已发布版本 2')
      expect(publishedWithOutcome.result.summary).toContain('MUST「提交后出现订单成功提示」')
      expect(publishedWithOutcome.result.diagnostics.map((item: { code: string }) => item.code)).not.toContain('SCENARIO_NO_OUTCOME')
      expect(publishedWithOutcome.result.summary).toContain('关联步骤「点击提交」（点击）')
      expect(modelSpy).not.toHaveBeenCalled()
    } finally {
      modelSpy.mockRestore()
    }
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
