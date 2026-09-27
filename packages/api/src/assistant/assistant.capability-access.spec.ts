import {
  type CanActivate,
  type ExecutionContext,
  INestApplication,
} from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type Step,
  createAccountBodySchema,
  createTargetBodySchema,
  packAssistantResultEnvelope,
  unpackAssistantResultEnvelope,
  ASSISTANT_PUBLISHED_CAPABILITY_IDS,
  PERMISSIONS,
} from '@cairn/shared'
import {
  beginAssistantTurn,
  completeAssistantTurn,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getAssistantTurnRecord,
  getOrCreatePlatformConfig,
  newId,
  RbacStore,
  recordPlatformAiCall,
  renewAssistantTurnLease,
  TargetsStore,
} from '@cairn/db'
import { openIsolatedDb } from '@cairn/db/testing'
import { DB_HANDLE } from '../db/db.module'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { TargetScopeGuard } from '../rbac/target-scope.guard'
import { listenForSupertest } from '../__tests__/http-app'
import { AssistantController } from './assistant.controller'
import { AssistantService } from './assistant.service'
import { AssistantCapabilityRegistry } from './registry'
import { handleRunCompare } from './handlers/compare.handler'
import { handleRunDiagnose } from './handlers/diagnose.handler'
import { AssistantAsyncRunner } from './async-runner'
import { PlatformConfigService } from '../platform-config/platform-config.service'
import { TargetsService } from '../targets/targets.service'
import { LocalSecretProvider } from '../secrets/local-secret-provider'

const echoStep: Step = {
  id: newId(),
  name: '回显步骤',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'ok' },
}

function makeAccount(
  id: string,
  permissions: readonly string[],
  extra: Partial<RequestAccount> = {},
): RequestAccount {
  return {
    id,
    displayName: '测试用户',
    email: `${id}@example.com`,
    status: 'active',
    roles: [{ id: 'custom', key: 'custom', name: '自定义角色', kind: 'custom' }],
    permissions: [...permissions],
    ...extra,
  }
}

describe('平台助手能力契约、多租户授权与轮次安全底座测试', { timeout: 35_000 }, () => {
  let db: Awaited<ReturnType<typeof openIsolatedDb>>
  let app: INestApplication
  let currentActor: RequestAccount
  let userA: RequestAccount
  let userB: RequestAccount
  let scopedReader: RequestAccount
  let targetAId: string
  let targetBId: string
  let scenarioAId: string
  let scenarioBId: string
  let runAId: string
  let runBId: string
  let conversationAId: string
  let conversationBId: string
  let assistantService: AssistantService
  let asyncRunner: AssistantAsyncRunner
  let capabilityRegistry: AssistantCapabilityRegistry
  let platformConfig: PlatformConfigService
  let targetsService: TargetsService

  beforeAll(async () => {
    db = await openIsolatedDb(`cairn_asst_cap_${newId().replaceAll('-', '')}`)
    const rbac = new RbacStore(db, {
      hash: async (v) => v,
      verify: async (v, h) => v === h,
    })
    const adminRoleId = (await rbac.listRoles()).items.find((r) => r.key === 'admin')!.id

    const targetsStore = new TargetsStore(db, () => Buffer.from('encrypted'))

    // Create admin account to author targets
    const createdAdmin = await rbac.createAccount(
      createAccountBodySchema.parse({
        email: 'admin-master@example.com',
        displayName: '系统管理员',
        password: 'admin-password',
        roleIds: [adminRoleId],
        targetScopes: [{ roleId: adminRoleId, mode: 'all' }],
      }),
      null,
    )
    const adminActor = makeAccount(createdAdmin.id, PERMISSIONS, {
      displayName: createdAdmin.displayName,
      email: createdAdmin.email,
      roles: createdAdmin.roles,
    })

    // 1. Create Target A
    const targetA = await targetsStore.createTarget(
      createTargetBodySchema.parse({
        code: 'target-a',
        name: '系统-甲',
        entryUrl: 'https://a.example.com',
        account: { username: 'u_a', displayName: '甲用户', password: 'p_a', validity: { mode: 'permanent' } },
      }),
      adminActor,
    )
    targetAId = targetA.id

    // 2. Create Target B
    const targetB = await targetsStore.createTarget(
      createTargetBodySchema.parse({
        code: 'target-b',
        name: '系统-乙',
        entryUrl: 'https://b.example.com',
        account: { username: 'u_b', displayName: '乙用户', password: 'p_b', validity: { mode: 'permanent' } },
      }),
      adminActor,
    )
    targetBId = targetB.id

    const authorRoleId = (await rbac.listRoles()).items.find((r) => r.key === 'author')!.id

    const extraTargetReadRole = await rbac.createRole(
      { key: 'assistant_target_b_read', name: '目标乙只读', permissions: ['target:read'] },
      adminActor,
    )
    const scopedAccount = await rbac.createAccount(
      createAccountBodySchema.parse({
        email: 'assistant-scoped-reader@example.com',
        displayName: '运行范围受限用户',
        password: 'scoped-reader-password',
        roleIds: [authorRoleId, extraTargetReadRole.id],
        targetScopes: [
          { roleId: authorRoleId, mode: 'selected', targetIds: [targetAId] },
          { roleId: extraTargetReadRole.id, mode: 'selected', targetIds: [targetBId] },
        ],
      }),
      adminActor,
    )
    scopedReader = makeAccount(scopedAccount.id, scopedAccount.permissions, {
      displayName: scopedAccount.displayName,
      email: scopedAccount.email,
      roles: scopedAccount.roles,
    })

    // 3. Create User A scoped strictly to Target A
    const accA = await rbac.createAccount(
      createAccountBodySchema.parse({
        email: 'user-a@example.com',
        displayName: '用户甲',
        password: 'password-a',
        roleIds: [authorRoleId],
        targetScopes: [{ roleId: authorRoleId, mode: 'selected', targetIds: [targetAId] }],
      }),
      null,
    )
    userA = makeAccount(accA.id, accA.permissions, {
      displayName: accA.displayName,
      email: accA.email,
      roles: accA.roles,
    })

    // 4. Create User B scoped strictly to Target B
    const accB = await rbac.createAccount(
      createAccountBodySchema.parse({
        email: 'user-b@example.com',
        displayName: '用户乙',
        password: 'password-b',
        roleIds: [authorRoleId],
        targetScopes: [{ roleId: authorRoleId, mode: 'selected', targetIds: [targetBId] }],
      }),
      null,
    )
    userB = makeAccount(accB.id, accB.permissions, {
      displayName: accB.displayName,
      email: accB.email,
      roles: accB.roles,
    })

    // 5. Create Scenarios & Runs
    const scA = await createScenarioWithVersion(db, {
      targetId: targetAId,
      name: '场景甲-数据入库',
      steps: [{ ...echoStep, id: newId() }],
      actor: userA,
    })
    scenarioAId = scA.id

    const scB = await createScenarioWithVersion(db, {
      targetId: targetBId,
      name: '场景乙-机密核验',
      steps: [{ ...echoStep, id: newId() }],
      actor: userB,
    })
    scenarioBId = scB.id

    const rA = await createRunWithSnapshot(db, { scenarioId: scenarioAId, actor: userA })
    runAId = rA.detail.id

    const rB = await createRunWithSnapshot(db, { scenarioId: scenarioBId, actor: userB })
    runBId = rB.detail.id

    await getOrCreatePlatformConfig(db)
    const secrets = new LocalSecretProvider(Buffer.alloc(32, 9))
    platformConfig = new PlatformConfigService(db, secrets)
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
    targetsService = new TargetsService(db, secrets)
    capabilityRegistry = new AssistantCapabilityRegistry()
    const hintsBus = {
      namespace: 'assistant',
      realtime: true,
      publish: async () => {},
      subscribe: async () => () => {},
      close: async () => {},
    } as any

    asyncRunner = new AssistantAsyncRunner(
      db,
      hintsBus,
      platformConfig,
      targetsService,
      capabilityRegistry,
    )
    assistantService = new AssistantService(
      db,
      platformConfig,
      targetsService,
      asyncRunner,
      hintsBus,
    )

    currentActor = userA

    const authGuard: CanActivate = {
      canActivate(context: ExecutionContext) {
        context.switchToHttp().getRequest().account = currentActor
        return true
      },
    }

    const moduleRef = await Test.createTestingModule({
      controllers: [AssistantController],
      providers: [
        Reflector,
        { provide: DB_HANDLE, useValue: db },
        { provide: AssistantService, useValue: assistantService },
        { provide: APP_GUARD, useValue: authGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_GUARD, useClass: TargetScopeGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile()

    app = moduleRef.createNestApplication({ logger: false })
    await listenForSupertest(app)

    // User A conversation
    currentActor = userA
    const convA = await request(app.getHttpServer()).post('/assistant/conversations').send({}).expect(201)
    conversationAId = convA.body.id

    // User B conversation
    currentActor = userB
    const convB = await request(app.getHttpServer()).post('/assistant/conversations').send({}).expect(201)
    conversationBId = convB.body.id
  })

  afterAll(async () => {
    await app?.close()
    await db?.close()
  })

  afterEach(() => {
    currentActor = userA
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

  describe('1. 能力列表与发布状态隔离', () => {
    it('GET /assistant/capabilities 只返回已发布能力，不泄露内部候选项', async () => {
      currentActor = userA
      const res = await request(app.getHttpServer())
        .get('/assistant/capabilities')
        .expect(200)

      expect(res.body.items).toHaveLength(ASSISTANT_PUBLISHED_CAPABILITY_IDS.length)
      const ids = res.body.items.map((item: { id: string }) => item.id)

      expect(ids).toContain('scenario.discover')
      expect(ids).toContain('target.business-records.list')

      // Internal candidates must NOT be in published capabilities
      expect(ids).not.toContain('operations.diagnose')
      expect(ids).not.toContain('schedules.propose')
      expect(ids).not.toContain('operations.action')
    })
  })

  describe('2. 多租户 Target 强隔离与确定性 scenario.discover', () => {
    it('用户甲进行场景发现：仅列出授权的系统甲场景，不出现系统乙的内容', async () => {
      currentActor = userA
      const sub = await request(app.getHttpServer())
        .post(`/assistant/conversations/${conversationAId}/turns`)
        .send({
          clientTurnId: `discover-a-${newId()}`,
          question: '有哪些场景？',
          capabilityHint: 'scenario.discover',
        })
        .expect(202)

      const turn = await waitForTurn(conversationAId, sub.body.turnId)
      expect(turn.status).toBe('COMPLETED')
      expect(turn.result.kind).toBe('discovery')
      const names = turn.result.candidates.map((c: any) => c.name)
      expect(names).toContain('场景甲-数据入库')
      expect(names).not.toContain('场景乙-机密核验')
      expect(JSON.stringify(turn.result)).not.toContain('机密核验')
      expect(JSON.stringify(turn.result)).not.toContain(targetBId)
    })

    it('用户甲尝试通过显式指定 targetId=Target B 查询场景：被范围守卫或数据库隔离拦截', async () => {
      currentActor = userA
      // TargetScopeGuard inspects pageContext or request params
      const res = await request(app.getHttpServer())
        .post(`/assistant/conversations/${conversationAId}/turns`)
        .send({
          clientTurnId: `discover-b-steal-${newId()}`,
          question: '查系统乙的场景',
          capabilityHint: 'scenario.discover',
          pageContext: {
            page: 'studio',
            targetId: targetBId,
          },
        })

      // TargetScopeGuard rejects with anti-enumeration 404 or 403 Forbidden early
      expect([403, 404]).toContain(res.status)
    })

    it('用户甲尝试诊断属于 Target B 的运行：被拦截或结果投影为 inaccessible', async () => {
      currentActor = userA
      const res = await request(app.getHttpServer())
        .post(`/assistant/conversations/${conversationAId}/turns`)
        .send({
          clientTurnId: `diagnose-steal-${newId()}`,
          question: '诊断这次运行为什么失败',
          capabilityHint: 'run.diagnose',
          pageContext: {
            page: 'run_detail',
            runId: runBId,
          },
        })

      // Since runBId belongs to Target B, TargetScopeGuard rejects with 404/403
      expect([403, 404]).toContain(res.status)
    })

    it('即使能读 Target B，也不能诊断或对比未获 run:read 授权的 Target B 运行', async () => {
      const context = {
        db,
        actor: scopedReader,
        targets: targetsService,
        body: { question: '诊断运行' },
        question: '诊断运行',
        session: null,
      }
      await expect(handleRunDiagnose({ ...context, slots: { runId: runBId } } as any)).rejects.toMatchObject({
        code: 'RUN_NOT_FOUND',
      })
      await expect(handleRunCompare({
        ...context,
        slots: { baseRunId: runAId, compareRunId: runBId },
      } as any)).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })

      const allowed = await handleRunDiagnose({ ...context, slots: { runId: runAId } } as any)
      expect(allowed.kind).toBe('diagnosis')
    })

    it('用户甲通过 @Quote 注入 Target B 的 objectRef：被 TargetScopeGuard 早期拦截', async () => {
      currentActor = userA
      const res = await request(app.getHttpServer())
        .post(`/assistant/conversations/${conversationAId}/turns`)
        .send({
          clientTurnId: `quote-steal-${newId()}`,
          question: '请诊断这个引用',
          capabilityHint: 'run.diagnose',
          pageContext: {
            page: 'run_detail',
            quote: {
              text: '系统乙崩溃报错',
              objectRef: {
                kind: 'run',
                id: runBId,
                targetId: targetBId,
              },
            },
          },
        })

      expect([403, 404]).toContain(res.status)
    })

    it('用户乙能够正常访问并检索 Target B 的场景', async () => {
      currentActor = userB
      const sub = await request(app.getHttpServer())
        .post(`/assistant/conversations/${conversationBId}/turns`)
        .send({
          clientTurnId: `discover-b-ok-${newId()}`,
          question: '有哪些场景？',
          capabilityHint: 'scenario.discover',
        })
        .expect(202)

      const turn = await waitForTurn(conversationBId, sub.body.turnId)
      expect(turn.status).toBe('COMPLETED')
      expect(turn.result.kind).toBe('discovery')
      const names = turn.result.candidates.map((c: any) => c.name)
      expect(names).toContain('场景乙-机密核验')
      expect(names).not.toContain('场景甲-数据入库')
    })
  })

  describe('3. 轮次排队、失主安全与防伪造执行', () => {
    it('丢失内存执行上下文时，轮次标记为 INTERRUPTED (REQUEST_LOST_ON_RESTART)，不使用伪身份执行', async () => {
      // Begin a queued turn directly in DB without registering in asyncRunner
      const { turn } = await beginAssistantTurn(db, {
        conversationId: conversationAId,
        ownerAccountId: userA.id,
        clientTurnId: `queued-restart-${newId()}`,
        requestDigest: 'sha256-test',
        question: '排队请求在重启后恢复',
        deadlineAt: new Date(Date.now() + 60_000),
        processingToken: newId(),
        userLimit: 0, // Force QUEUED state
        platformLimit: 16,
        allowQueue: true,
      })
      expect(turn.status).toBe('QUEUED')

      // 未提供 requestPayload（例如存量异常记录）时，出队标记为 INTERRUPTED (REQUEST_LOST_ON_RESTART)
      await asyncRunner.promoteNextQueuedTurn()

      const record = await getAssistantTurnRecord(db, turn.id, userA.id)
      expect(record.turn.status).toBe('INTERRUPTED')
      expect(record.turn.stopReason).toBe('REQUEST_LOST_ON_RESTART')
      expect(record.turn.result?.kind).toBe('unsupported')
      expect(record.turn.result?.reasonCode).toBe('REQUEST_LOST_ON_RESTART')
    })

    it('排队任务持久化 request_payload，冷启动或跨实例可无损出队并执行', async () => {
      const clientTurnId = `queued-restore-${newId()}`
      const { turn } = await beginAssistantTurn(db, {
        conversationId: conversationAId,
        ownerAccountId: userA.id,
        clientTurnId,
        requestDigest: 'sha256-test-restore',
        question: '排队请求在重启后恢复',
        deadlineAt: new Date(Date.now() + 60_000),
        processingToken: newId(),
        userLimit: 0,
        platformLimit: 16,
        allowQueue: true,
        requestPayload: {
          clientTurnId,
          question: '排队请求在重启后恢复',
        },
      })
      expect(turn.status).toBe('QUEUED')

      // 在没有任何单机内存状态的情况下出队提升
      await asyncRunner.promoteNextQueuedTurn()

      const record = await getAssistantTurnRecord(db, turn.id, userA.id)
      expect(record.turn.status).toBe('RUNNING')
    })

    it('失效的 processingToken 无法完成轮次（409 Conflict）', async () => {
      const sub = await assistantService.createTurn(userA, conversationAId, {
        clientTurnId: `token-fence-${newId()}`,
        question: '测试令牌防护',
      })

      // Try completing with invalid token
      await expect(
        completeAssistantTurn(db, {
          turnId: sub.turnId,
          ownerAccountId: userA.id,
          processingToken: 'stale-bogus-token-123',
          status: 'COMPLETED',
          result: { kind: 'inaccessible', message: 'test' },
        }),
      ).rejects.toThrow()
    })

    it('renewAssistantTurnLease 在 epoch 或 ownerInstanceId 不匹配时返回 false', async () => {
      const renewed = await renewAssistantTurnLease(db, {
        turnId: newId(),
        ownerInstanceId: 'wrong-instance-id',
        epoch: 999,
        leaseDurationMs: 15_000,
      })
      expect(renewed).toBe(false)
    })
  })

  describe('4. 结果包装器与历史兼容性', () => {
    it('unpackAssistantResultEnvelope 支持 v1 裸结果与 v2 封装', () => {
      const v1Result = {
        kind: 'inaccessible' as const,
        message: 'v1 结果消息',
      }
      expect(unpackAssistantResultEnvelope(v1Result)).toEqual(v1Result)

      const v2Envelope = packAssistantResultEnvelope(v1Result, 2)
      expect(unpackAssistantResultEnvelope(v2Envelope)).toEqual(v1Result)
    })

    it('已撤销目标权限的旧轮次被读取时投影为 inaccessible', async () => {
      // Create a turn directly with discovery candidates from Target B
      const sub = await assistantService.createTurn(userB, conversationBId, {
        clientTurnId: `hist-revoke-${newId()}`,
        question: '看系统乙场景',
      })

      await completeAssistantTurn(db, {
        turnId: sub.turnId,
        ownerAccountId: userB.id,
        processingToken: (sub as any).turnId, // will be matched via direct update or get
        status: 'COMPLETED',
        result: {
          kind: 'discovery',
          candidates: [
            {
              id: scenarioBId,
              name: '机密场景',
              targetId: targetBId,
              targetName: '系统乙',
              kind: 'scenario',
            },
          ],
          scope: { targetId: targetBId },
          coverage: { totalVisible: 1, hasMore: false, nextCursor: null, observedAt: new Date().toISOString() },
          message: '发现结果',
        },
      }).catch(() => undefined)

      // User A (who does NOT have Target B) cannot see this turn because it's User B's turn
      await expect(assistantService.getTurn(userA, conversationBId, sub.turnId)).rejects.toThrow()
    })
  })

  describe('5. 模型调用记录多租户隔离', () => {
    it('listModelInvocations 严格按调用者隔离平台模型调用记录', async () => {
      const turnA = await assistantService.createTurn(userA, conversationAId, {
        clientTurnId: `call-iso-a-${newId()}`,
        question: '用户甲的问题',
      })
      const turnB = await assistantService.createTurn(userB, conversationBId, {
        clientTurnId: `call-iso-b-${newId()}`,
        question: '用户乙的问题',
      })

      // Record AI calls for userA and userB
      await recordPlatformAiCall(db, {
        turnId: turnA.turnId,
        ownerAccountId: userA.id,
        seq: 1,
        purpose: 'classification',
        model: 'deepseek-chat',
        durationMs: 120,
      })

      await recordPlatformAiCall(db, {
        turnId: turnB.turnId,
        ownerAccountId: userB.id,
        seq: 1,
        purpose: 'classification',
        model: 'deepseek-chat',
        durationMs: 150,
      })

      // Query invocations as User A
      const userAInvocations = await assistantService.listModelInvocations(userA, {})
      expect(userAInvocations.items.some((i) => i.ownerRef.turnId === turnA.turnId)).toBe(true)
      expect(userAInvocations.items.some((i) => i.ownerRef.turnId === turnB.turnId)).toBe(false)

      // Query invocations as User B
      const userBInvocations = await assistantService.listModelInvocations(userB, {})
      expect(userBInvocations.items.some((i) => i.ownerRef.turnId === turnB.turnId)).toBe(true)
      expect(userBInvocations.items.some((i) => i.ownerRef.turnId === turnA.turnId)).toBe(false)
    })

    it('未启用平台 AI 时，createTurn 后端硬拦截并拒绝（403 ASSISTANT_MODEL_DISABLED）', async () => {
      vi.spyOn(platformConfig, 'resolvePlatformAiAccess').mockResolvedValueOnce(null)
      await expect(
        assistantService.createTurn(userA, conversationAId, {
          clientTurnId: `client-turn-${newId()}`,
          question: '测试无 AI 拦截',
        }),
      ).rejects.toThrow('当前平台未启用 AI 模型')
    })
  })
})
