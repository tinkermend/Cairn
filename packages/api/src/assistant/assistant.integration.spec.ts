import {
  INestApplication,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
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
  newId,
  RbacStore,
  TargetsStore,
} from '@cairn/db'
import { openIsolatedDb } from '@cairn/db/testing'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { listenForSupertest } from '../__tests__/http-app'
import { AssistantController } from './assistant.controller'
import { AssistantService } from './assistant.service'
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
    const created = await rbac.createAccount(
      createAccountBodySchema.parse({
        email: 'assist-owner',
        displayName: '助手主人',
        password: 'test-password',
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
    const service = new AssistantService(
      db,
      new PlatformConfigService(db, secrets),
      new TargetsService(db, secrets),
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
    const turn = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: 'viewer-propose-1',
        question: '把指令写清楚',
        capabilityHint: 'scenario.propose-step',
        pageContext: { page: 'studio', scenarioId, stepId: echo.id, draftRevision: 1 },
      })
      .expect(200)
    expect(turn.body.result).toMatchObject({ kind: 'unsupported', reasonCode: 'CAPABILITY_FORBIDDEN' })
    current = owner
  })

  it('没有目标访问权限时不能诊断，也不返回目标名称', async () => {
    current = account(owner.id, ['ai:assist', 'run:read', 'workflow:read'])
    const caps = await request(app.getHttpServer()).get('/assistant/capabilities').expect(200)
    expect(caps.body.items.find((item: { id: string }) => item.id === 'run.diagnose')?.available).toBe(false)
    const turn = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: 'no-target-diagnose-1',
        question: '这次为什么失败',
        capabilityHint: 'run.diagnose',
        pageContext: { page: 'run', runId },
      })
      .expect(200)
    expect(turn.body.result).toMatchObject({ kind: 'unsupported', reasonCode: 'CAPABILITY_FORBIDDEN' })
    expect(JSON.stringify(turn.body)).not.toContain('泰坦')
    current = owner
  })

  it('有目标权限时可以诊断；导览问句与诊断 hint 冲突则澄清', async () => {
    const diagnosed = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: 'owner-diagnose-1',
        question: '这次为什么失败',
        capabilityHint: 'run.diagnose',
        pageContext: { page: 'run', runId },
      })
      .expect(200)
    expect(diagnosed.body.result.kind).toBe('diagnosis')
    expect(diagnosed.body.result.facts.length).toBeGreaterThan(0)
    expect(JSON.stringify(diagnosed.body.result.facts)).not.toContain('hidden')

    const clarify = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: 'owner-clarify-1',
        question: '目标账号在哪里配置？',
        capabilityHint: 'run.diagnose',
        pageContext: { page: 'run', runId },
      })
      .expect(200)
    expect(clarify.body.result.kind).toBe('clarify')
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
    const turn = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: 'guide-no-target-1',
        question: '在哪里配置目标账号？',
      })
      .expect(200)
    expect(turn.body.result).toMatchObject({
      kind: 'unsupported',
      reasonCode: 'GUIDE_UNAVAILABLE',
    })
    expect(turn.body.result).not.toHaveProperty('items')
    expect(JSON.stringify(turn.body.result)).not.toContain('泰坦')
    current = owner
  })

  it('解释已保存草稿时不混入已发布版本', async () => {
    current = owner
    const turn = await request(app.getHttpServer())
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
      .expect(200)
    expect(turn.body.result.kind).toBe('explanation')
    expect(turn.body.result.summary).toContain('巡检')
    current = owner
  })
})
