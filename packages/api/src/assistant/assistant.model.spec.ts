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
  createAccountBodySchema,
  createTargetBodySchema,
  FACTORY_PLATFORM_CONFIG,
  PERMISSIONS,
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
  let conversationId: string
  const prompts: string[] = []

  beforeAll(async () => {
    db = await openIsolatedDb(`cairn_assist_model_${newId().replaceAll('-', '')}`)
    const rbac = new RbacStore(db, {
      hash: async (value) => value,
      verify: async (value, hash) => value === hash,
    })
    const created = await rbac.createAccount(
      createAccountBodySchema.parse({
        email: 'assist-model',
        displayName: '模型测试',
        password: 'test-password',
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
    const scenario = await createScenarioWithVersion(db, {
      targetId: target.id,
      name: '巡检',
      steps: [{ ...echo, id: newId() }],
      actor: current,
    })
    const run = await createRunWithSnapshot(db, { scenarioId: scenario.id, actor: current })
    runId = run.detail.id
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
        ) as { citations?: string[] }
        if (system.includes('路由器')) {
          return { text: JSON.stringify({ capabilityId: 'run.diagnose' }), model: 'mock-text' }
        }
        if (system.includes('可能原因')) {
          const citations = user.citations?.slice(0, 1) ?? []
          return {
            text: JSON.stringify({
              hypotheses: [{ text: '可能仍在调度或等待资源', citations }],
            }),
            model: 'mock-text',
            usage: { promptTokens: 12, completionTokens: 9 },
          }
        }
        throw new Error(`未预期的模型请求：${system}`)
      },
    }
    const service = new AssistantService(db, platformConfig, new TargetsService(db, secrets), models)
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

  it('启用平台 AI 后能力接口报告模型可用', async () => {
    const caps = await request(app.getHttpServer()).get('/assistant/capabilities').expect(200)
    expect(caps.body.modelEnabled).toBe(true)
  })

  it('自由问句先分类再诊断，假设只能引用事实包', async () => {
    const turn = await request(app.getHttpServer())
      .post(`/assistant/conversations/${conversationId}/turns`)
      .send({
        clientTurnId: `model-diagnose-${crypto.randomUUID()}`,
        question: '帮我看看这个',
        pageContext: { page: 'run', runId },
      })
      .expect(200)
    expect(turn.body.result.kind).toBe('diagnosis')
    expect(turn.body.result.hypotheses[0]?.text).toContain('可能仍在调度')
    expect(JSON.stringify(prompts)).not.toContain('hidden')
    expect(JSON.stringify(prompts)).not.toContain('泰坦')
  })
})
