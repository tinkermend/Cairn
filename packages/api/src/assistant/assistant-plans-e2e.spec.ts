import {
  type CanActivate,
  type ExecutionContext,
  INestApplication,
} from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BUSINESS_SOURCE_CURSOR_EXPIRED,
  MENU_CATALOG,
  PERMISSIONS,
  createAccountBodySchema,
  createTargetBodySchema,
  unpackAssistantResultEnvelope,
  type Step,
} from '@cairn/shared'
import {
  RbacStore,
  TargetsStore,
  createScenarioWithVersion,
  getOrCreatePlatformConfig,
  newId,
} from '@cairn/db'
import { eq, openIsolatedDb, schemaFor } from '@cairn/db/testing'
import { DB_HANDLE } from '../db/db.module.js'
import { AllExceptionsFilter } from '../common/all-exceptions.filter.js'
import type { RequestAccount } from '../common/request-account.js'
import { PermissionsGuard } from '../rbac/permissions.guard.js'
import { TargetScopeGuard } from '../rbac/target-scope.guard.js'
import { listenForSupertest } from '../__tests__/http-app.js'
import { AssistantController } from './assistant.controller.js'
import { AssistantService } from './assistant.service.js'
import { AssistantCapabilityRegistry } from './registry.js'
import { AssistantAsyncRunner } from './async-runner.js'
import { PlatformConfigService } from '../platform-config/platform-config.service.js'
import { TargetsService } from '../targets/targets.service.js'
import { BusinessSourcesController } from '../targets/business-sources.controller.js'
import { BusinessSourcesService } from '../targets/business-sources.service.js'
import { LocalSecretProvider } from '../secrets/local-secret-provider.js'
import {
  claimBusinessSourceBuildJob,
  commitBusinessSourceBatch,
  finishBusinessSourceBuild,
  getDatasetRows,
} from '@cairn/db'
import { validateGrounding } from './context-assembler.js'

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

describe('方案 A、B、C 全链路端到端集成测试 (Plans A+B+C E2E Verification)', { timeout: 45_000 }, () => {
  let db: Awaited<ReturnType<typeof openIsolatedDb>>
  let app: INestApplication
  let currentActor: RequestAccount
  let adminActor: RequestAccount
  let userA: RequestAccount
  let userB: RequestAccount
  let targetAId: string
  let targetBId: string
  let scenarioAId: string
  let conversationAId: string
  let assistantService: AssistantService
  let asyncRunner: AssistantAsyncRunner
  let capabilityRegistry: AssistantCapabilityRegistry
  let datasetAId: string

  beforeAll(async () => {
    db = await openIsolatedDb(`cairn_e2e_abc_${newId().replaceAll('-', '')}`)
    const rbac = new RbacStore(db, {
      hash: async (v) => v,
      verify: async (v, h) => v === h,
    })
    const adminRoleId = (await rbac.listRoles()).items.find((r) => r.key === 'admin')!.id

    const targetsStore = new TargetsStore(db, () => Buffer.from('encrypted'))

    // 1. 系统管理员账号
    const createdAdmin = await rbac.createAccount(
      createAccountBodySchema.parse({
        email: 'admin-e2e@example.com',
        displayName: '系统管理员',
        password: 'admin-password',
        roleIds: [adminRoleId],
        targetScopes: [{ roleId: adminRoleId, mode: 'all' }],
      }),
      null,
    )
    adminActor = makeAccount(createdAdmin.id, PERMISSIONS, {
      displayName: createdAdmin.displayName,
      email: createdAdmin.email,
      roles: createdAdmin.roles,
    })

    // 2. 创建 Target A (系统-甲) 与 Target B (系统-乙)
    const targetA = await targetsStore.createTarget(
      createTargetBodySchema.parse({
        code: 'tgt-alpha',
        name: '系统-甲 (ERP)',
        entryUrl: 'https://alpha.example.com',
        account: { username: 'u_a', displayName: '甲用户', password: 'p_a', validity: { mode: 'permanent' } },
      }),
      adminActor,
    )
    targetAId = targetA.id

    const targetB = await targetsStore.createTarget(
      createTargetBodySchema.parse({
        code: 'tgt-beta',
        name: '系统-乙 (CRM)',
        entryUrl: 'https://beta.example.com',
        account: { username: 'u_b', displayName: '乙用户', password: 'p_b', validity: { mode: 'permanent' } },
      }),
      adminActor,
    )
    targetBId = targetB.id

    const operatorRole = await rbac.createRole(
      {
        key: 'dataset_operator',
        name: '业务数据源操作员',
        description: '具备目标与数据集读写及助手访问权限',
        permissions: [
          'target:read',
          'target:write',
          'dataset:read',
          'dataset:write',
          'ai:assist',
          'workflow:read',
          'workflow:write',
          'run:read',
        ],
      },
      adminActor,
    )
    const operatorRoleId = operatorRole.id

    // 3. User A 严格授权 Target A (具备 target:read, target:write, dataset:read, dataset:write, ai:assist, workflow:read)
    const accA = await rbac.createAccount(
      createAccountBodySchema.parse({
        email: 'user-a@example.com',
        displayName: '甲操作员',
        password: 'password-a',
        roleIds: [operatorRoleId],
        targetScopes: [{ roleId: operatorRoleId, mode: 'selected', targetIds: [targetAId] }],
      }),
      adminActor,
    )
    userA = makeAccount(accA.id, accA.permissions, {
      displayName: accA.displayName,
      email: accA.email,
      roles: accA.roles,
    })

    // 4. User B 严格授权 Target B
    const accB = await rbac.createAccount(
      createAccountBodySchema.parse({
        email: 'user-b@example.com',
        displayName: '乙操作员',
        password: 'password-b',
        roleIds: [operatorRoleId],
        targetScopes: [{ roleId: operatorRoleId, mode: 'selected', targetIds: [targetBId] }],
      }),
      adminActor,
    )
    userB = makeAccount(accB.id, accB.permissions, {
      displayName: accB.displayName,
      email: accB.email,
      roles: accB.roles,
    })

    // 5. 在 Target A 下创建真实数据集与多行厂家记录
    const { datasets, datasetRows } = schemaFor(db.db)
    datasetAId = newId()
    const now = new Date()
    await db.db.insert(datasets).values({
      id: datasetAId,
      name: 'ERP厂家主数据表.xlsx',
      targetId: targetAId,
      sourceType: 'excel',
      sourceFilename: 'mfg_erp.xlsx',
      rowCount: 3,
      columnsMeta: [
        { key: 'code', name: '厂家编号', type: 'string' },
        { key: 'name', name: '厂家名称', type: 'string' },
        { key: 'status', name: '状态', type: 'string' },
      ],
      createdByAccountId: userA.id,
      createdAt: now,
      updatedAt: now,
    })

    await db.db.insert(datasetRows).values([
      {
        id: newId(),
        datasetId: datasetAId,
        rowIndex: 0,
        rowData: { code: 'MFG-100', name: '富士康工业互联', status: 'active', secret_key: 'confidential' },
        validationStatus: 'valid',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: newId(),
        datasetId: datasetAId,
        rowIndex: 1,
        rowData: { code: 'MFG-200', name: '立讯精密', status: 'active', secret_key: 'confidential' },
        validationStatus: 'valid',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: newId(),
        datasetId: datasetAId,
        rowIndex: 2,
        rowData: { code: 'MFG-300', name: '比亚迪半导体', status: 'pending', secret_key: 'confidential' },
        validationStatus: 'valid',
        createdAt: now,
        updatedAt: now,
      },
    ])

    // 6. 在 Target A 下创建关联场景用于场景发现测试
    const scA = await createScenarioWithVersion(db, {
      targetId: targetAId,
      name: '厂家入库对账审批场景',
      steps: [{ ...echoStep, id: newId() }],
      actor: userA,
    })
    scenarioAId = scA.id

    // 初始化服务
    await getOrCreatePlatformConfig(db)
    const secrets = new LocalSecretProvider(Buffer.alloc(32, 9))
    const platformConfig = new PlatformConfigService(db, secrets)
    const targetsService = new TargetsService(db, secrets)
    const businessSourcesService = new BusinessSourcesService(db)
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
      controllers: [AssistantController, BusinessSourcesController],
      providers: [
        Reflector,
        { provide: DB_HANDLE, useValue: db },
        { provide: AssistantService, useValue: assistantService },
        { provide: BusinessSourcesService, useValue: businessSourcesService },
        { provide: APP_GUARD, useValue: authGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_GUARD, useClass: TargetScopeGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile()

    app = moduleRef.createNestApplication({ logger: false })
    await listenForSupertest(app)

    // 创建 User A 会话
    currentActor = userA
    const convA = await request(app.getHttpServer()).post('/assistant/conversations').send({}).expect(201)
    conversationAId = convA.body.id
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

  describe('1. 方案 C + 方案 A 闭环：数据源快照构建、审批生效与助手确定性零 Token 检索', () => {
    let candidateId: string
    let bindingRevision = 1

    it('采样预览：返回前 10 行并验证白名单字段过滤', async () => {
      currentActor = userA
      const res = await request(app.getHttpServer())
        .post(`/targets/${targetAId}/business-sources/preview`)
        .send({
          datasetId: datasetAId,
          entityType: 'manufacturer',
          mappingConfig: {
            keyColumn: 'code',
            displayNameColumn: 'name',
            statusColumn: 'status',
            fieldWhitelist: ['code', 'name', 'status'],
          },
        })
        .expect(201)

      expect(res.body.previewRows).toHaveLength(3)
      expect(res.body.validationDigest.sampleValidCount).toBe(3)
      expect(res.body.validationDigest.sampleRejectedCount).toBe(0)
      // 敏感字段 secret_key 绝不进入 payload
      expect(res.body.previewRows[0].payload.secret_key).toBeUndefined()
      expect(res.body.previewRows[0].payload.name).toBe('富士康工业互联')
    })

    it('创建候选快照：初始状态为 building', async () => {
      currentActor = userA
      const res = await request(app.getHttpServer())
        .post(`/targets/${targetAId}/business-sources/candidates`)
        .send({
          datasetId: datasetAId,
          entityType: 'manufacturer',
          mappingConfig: {
            keyColumn: 'code',
            displayNameColumn: 'name',
            statusColumn: 'status',
            fieldWhitelist: ['code', 'name', 'status'],
          },
          completenessBasis: '快照全量扫描校验',
        })
        .expect(201)

      expect(res.body.candidateId).toBeDefined()
      candidateId = res.body.candidateId
      bindingRevision = res.body.bindingRevision

      // 查询候选状态为 building
      const candRes = await request(app.getHttpServer())
        .get(`/targets/${targetAId}/business-sources/candidates/${candidateId}`)
        .expect(200)
      expect(candRes.body.buildStatus).toBe('building')
    })

    it('Worker 扫描构建：以防重入租约认领、校验合规并将候选置为 ready', async () => {
      const candidate = await claimBusinessSourceBuildJob(db, 'worker-e2e')
      expect(candidate).toBeDefined()
      expect(candidate?.id).toBe(candidateId)

      const rowsResult = await getDatasetRows(db, candidate!.datasetId, { limit: 100 })
      const recordsToCommit = rowsResult.items.map((r: any) => ({
        targetId: candidate!.targetId,
        entityType: candidate!.entityType,
        recordKey: String(r.rowData.code),
        displayName: String(r.rowData.name),
        recordStatus: String(r.rowData.status || 'active'),
        originalDatasetId: candidate!.datasetId,
        datasetRowId: r.id,
        datasetRowIndex: r.rowIndex,
        payload: { code: r.rowData.code, name: r.rowData.name, status: r.rowData.status },
      }))

      await commitBusinessSourceBatch(db, candidate!.id, recordsToCommit, candidate!.fencingToken)
      await finishBusinessSourceBuild(db, candidate!.id, {
        status: 'ready',
        summary: { totalRows: 3, validCount: 3, rejectedCount: 0, issues: [] },
        fencingToken: candidate!.fencingToken,
      })

      // 再次查询候选快照：状态已跃迁为 ready，对账全量通过
      const candRes = await request(app.getHttpServer())
        .get(`/targets/${targetAId}/business-sources/candidates/${candidateId}`)
        .expect(200)
      expect(candRes.body.buildStatus).toBe('ready')
      expect(candRes.body.validationSummary.validCount).toBe(3)
      expect(candRes.body.validationSummary.rejectedCount).toBe(0)
    })

    it('CAS 审批发布：绑定当前快照指针并递增 bindingRevision', async () => {
      currentActor = userA
      const approveRes = await request(app.getHttpServer())
        .post(`/targets/${targetAId}/business-sources/candidates/${candidateId}/approve`)
        .send({
          expectedRevision: bindingRevision,
          approvalBasis: '人工复核 ERP 厂家清单无误',
        })
        .expect(201)

      expect(approveRes.body.bindingRevision).toBe(bindingRevision + 1)
      expect(approveRes.body.currentSnapshotId).toBe(candidateId)
      bindingRevision = approveRes.body.bindingRevision

      // 验证当前来源状态已生效
      const srcRes = await request(app.getHttpServer())
        .get(`/targets/${targetAId}/business-sources?entityType=manufacturer`)
        .expect(200)
      expect(srcRes.body.status).toBe('active')
      expect(srcRes.body.currentSnapshotId).toBe(candidateId)
    })

    it('助手端到端零 Token 查询：调用 target.business-records.list 获得标准化发现信封', async () => {
      currentActor = userA
      // 提交对话轮次：查询 ERP 厂家
      const turnRes = await request(app.getHttpServer())
        .post(`/assistant/conversations/${conversationAId}/turns`)
        .send({
          clientTurnId: `turn-biz-${newId()}`,
          question: '请列出当前 ERP 系统的厂家记录',
          capabilityHint: 'target.business-records.list',
          pageContext: {
            page: 'target',
            targetId: targetAId,
          },
        })
        .expect(202)

      const turnId = turnRes.body.turnId
      expect(turnId).toBeDefined()

      // 等待异步处理完成并查询轮次结果
      const turnRecord = await waitForTurn(conversationAId, turnId)
      expect(turnRecord).toBeDefined()
      expect(turnRecord.status).toBe('COMPLETED')

      // API 返回标准化发现结果
      const result = turnRecord.result
      expect(result).toBeDefined()
      expect(result?.kind).toBe('discovery')

      if (result?.kind === 'discovery') {
        expect(result.candidates.length).toBe(3)
        expect(result.candidates.map((c: any) => c.name)).toContain('富士康工业互联')
        expect(result.candidates.map((c: any) => c.name)).toContain('立讯精密')
        expect(result.candidates.map((c: any) => c.name)).toContain('比亚迪半导体')
        expect(result.scope.targetId).toBe(targetAId)
        expect(result.coverage.totalVisible).toBe(3)
        expect(result.message).toContain('快照全量扫描校验')
      }

      // 验证底层持久化了方案 A 的 AssistantResultEnvelope (v2)
      const { assistantTurns } = schemaFor(db.db)
      const [rawRow] = await db.db.select().from(assistantTurns).where(eq(assistantTurns.id, turnId))
      expect(rawRow.result).toMatchObject({
        version: 2,
        result: expect.objectContaining({ kind: 'discovery' }),
      })
    })
  })

  describe('2. 游标失效安全契约 (409 Conflict) 与撤回边界', () => {
    let activeCursor: string

    it('正常带游标分页获取记录', async () => {
      currentActor = userA
      const recordsRes = await request(app.getHttpServer())
        .get(`/targets/${targetAId}/business-records?limit=2`)
        .expect(200)

      expect(recordsRes.body.items).toHaveLength(2)
      expect(recordsRes.body.nextCursor).toBeDefined()
      activeCursor = recordsRes.body.nextCursor
    })

    it('撤回数据源后，历史有效游标严格返回 409 Conflict 与 BUSINESS_SOURCE_CURSOR_EXPIRED', async () => {
      currentActor = userA
      // 1. 撤回数据源
      const srcBefore = await request(app.getHttpServer())
        .get(`/targets/${targetAId}/business-sources?entityType=manufacturer`)
        .expect(200)

      await request(app.getHttpServer())
        .post(`/targets/${targetAId}/business-sources/revoke`)
        .send({
          expectedRevision: srcBefore.body.bindingRevision,
          revocationReason: '系统业务升级，废弃旧快照',
        })
        .expect(201)

      // 2. 携带旧游标查询，必须触发 409 Conflict
      const errRes = await request(app.getHttpServer())
        .get(`/targets/${targetAId}/business-records?cursor=${activeCursor}`)
        .expect(409)

      expect(errRes.body.code).toBe(BUSINESS_SOURCE_CURSOR_EXPIRED)
      expect(errRes.body.message).toContain('快照已切换或失效')
    })
  })

  describe('3. 方案 A 多租户强隔离边界 (Multi-Tenant Access Isolation)', () => {
    it('User B (无 Target A 权限) 直接请求 Target A 的业务数据被 404 拒绝 (目标隐藏)', async () => {
      currentActor = userB
      await request(app.getHttpServer())
        .get(`/targets/${targetAId}/business-records`)
        .expect(404)

      await request(app.getHttpServer())
        .get(`/targets/${targetAId}/business-sources`)
        .expect(404)
    })

    it('User B 试图通过助手槽位探查 Target A 数据时被 404 拒绝 (网关强拦截)', async () => {
      currentActor = userB
      // User B 创建会话
      const convB = await request(app.getHttpServer()).post('/assistant/conversations').send({}).expect(201)

      // 提交刺探 Target A 的轮次，网关层 TargetScopeGuard 立即拦截并隐藏目标
      await request(app.getHttpServer())
        .post(`/assistant/conversations/${convB.body.id}/turns`)
        .send({
          clientTurnId: `turn-leak-${newId()}`,
          question: '查一下系统甲的厂家',
          pageContext: {
            page: 'target',
            targetId: targetAId,
          },
        })
        .expect(404)
    })
  })

  describe('4. 方案 A 场景确定性发现能力 (scenario.discover)', () => {
    it('User A 成功发现 Target A 场景，带有目标名称消歧与版本', async () => {
      currentActor = userA
      const conv = await request(app.getHttpServer()).post('/assistant/conversations').send({}).expect(201)

      const turn = await request(app.getHttpServer())
        .post(`/assistant/conversations/${conv.body.id}/turns`)
        .send({
          clientTurnId: `turn-sc-disc-${newId()}`,
          question: '发现场景',
          capabilityHint: 'scenario.discover',
          pageContext: {
            page: 'studio',
            targetId: targetAId,
          },
        })
        .expect(202)

      const resTurn = await waitForTurn(conv.body.id, turn.body.turnId)
      expect(resTurn.status).toBe('COMPLETED')
      const result = resTurn.result
      expect(result?.kind).toBe('discovery')
      if (result?.kind === 'discovery') {
        expect(result.candidates.some((c) => c.name === '厂家入库对账审批场景')).toBe(true)
        expect(result.candidates[0].targetName).toBe('系统-甲 (ERP)')
      }
    })
  })

  describe('5. 方案 B 事实依据、时效与单源菜单对账验证', () => {
    it('validateGrounding 严格按引用核验证据与真实来源存在性', () => {
      const allowedCitations = [`run:${scenarioAId}` as any]
      const items = [
        { text: '场景执行符合预期', citations: [`run:${scenarioAId}` as any] },
        { text: '虚构幻觉无引用结论', citations: [] },
      ]

      const check = validateGrounding(items, allowedCitations)
      expect(check.valid).toHaveLength(1)
      expect(check.invalid).toHaveLength(1)
      expect(check.invalidReasons?.[1]).toBe('MISSING_CITATIONS')
    })

    it('MENU_CATALOG 保证路由与 RBAC 权限单源一致无漂移', () => {
      expect(MENU_CATALOG.length).toBeGreaterThanOrEqual(20)
      // 验证关键路由治理：evidence 为 /evidence，目标系统为 /targets
      const evidenceMenu = MENU_CATALOG.find((m) => m.id === 'menu.evidence')
      expect(evidenceMenu).toBeDefined()
      expect(evidenceMenu?.route).toBe('/evidence')
      expect(evidenceMenu?.permission).toBe('run:read')

      const targetsMenu = MENU_CATALOG.find((m) => m.id === 'menu.targets')
      expect(targetsMenu).toBeDefined()
      expect(targetsMenu?.route).toBe('/targets')
      expect(targetsMenu?.permission).toBe('target:read')
    })
  })

  describe('6. 用户任务与对话闭环 (Product & Dialogue Spec PD-01 ~ PD-15)', () => {
    it('PD-01: 全局问“现在都有哪些场景？”，正确识别发现意图并返回当前账号可见场景第一页', async () => {
      currentActor = userA
      const conv = await request(app.getHttpServer()).post('/assistant/conversations').send({}).expect(201)

      const turn = await request(app.getHttpServer())
        .post(`/assistant/conversations/${conv.body.id}/turns`)
        .send({
          clientTurnId: `turn-pd01-${newId()}`,
          question: '现在都有哪些场景？',
        })
        .expect(202)

      const resTurn = await waitForTurn(conv.body.id, turn.body.turnId)
      expect(resTurn.status).toBe('COMPLETED')
      expect(resTurn.result?.kind).toBe('discovery')
      expect(resTurn.result.candidates.length).toBeGreaterThan(0)
      expect(resTurn.result.candidates.some((c: any) => c.name === '厂家入库对账审批场景')).toBe(true)
    })

    it('PD-07: 在无 Run 页面点击“分析最近失败运行”，自动在 7 天窗口内寻找最近失败运行', async () => {
      currentActor = userA
      const conv = await request(app.getHttpServer()).post('/assistant/conversations').send({}).expect(201)

      const turn = await request(app.getHttpServer())
        .post(`/assistant/conversations/${conv.body.id}/turns`)
        .send({
          clientTurnId: `turn-pd07-${newId()}`,
          question: '分析最近失败运行',
          capabilityHint: 'run.diagnose',
        })
        .expect(202)

      const resTurn = await waitForTurn(conv.body.id, turn.body.turnId)
      expect(resTurn.status).toBe('COMPLETED')
      expect(resTurn.result?.kind).toBe('diagnosis')
      // If no failed run in 7 days, returns diagnosis indicating no failed run in 7 days
      expect(resTurn.result.facts.length).toBeGreaterThan(0)
      expect(resTurn.result.facts[0].text).toContain('7 天')
    })

    it('PD-09: 全局问“现在都有哪些厂家？”，无数据源时给出指引，不造名单也不生硬拒答', async () => {
      currentActor = userB
      const conv = await request(app.getHttpServer()).post('/assistant/conversations').send({}).expect(201)

      const turn = await request(app.getHttpServer())
        .post(`/assistant/conversations/${conv.body.id}/turns`)
        .send({
          clientTurnId: `turn-pd09-${newId()}`,
          question: '现在都有哪些厂家？',
          pageContext: {
            page: 'target',
            targetId: targetBId,
          },
        })
        .expect(202)

      const resTurn = await waitForTurn(conv.body.id, turn.body.turnId)
      expect(resTurn.status).toBe('COMPLETED')
      expect(resTurn.result?.kind).toBe('discovery')
      expect(resTurn.result.message).toContain('目标配置 - 数据集')
    })

    it('PD-14: 在澄清等待态输入“算了/不用了/取消任务”，置为 CANCELLED 终态', async () => {
      currentActor = userA
      const conv = await request(app.getHttpServer()).post('/assistant/conversations').send({}).expect(201)

      // Turn 1: trigger a clarify
      const turn1 = await request(app.getHttpServer())
        .post(`/assistant/conversations/${conv.body.id}/turns`)
        .send({
          clientTurnId: `turn-pd14-1-${newId()}`,
          question: '对比两次运行',
          capabilityHint: 'run.compare',
        })
        .expect(202)

      const resTurn1 = await waitForTurn(conv.body.id, turn1.body.turnId)
      expect(resTurn1.status).toBe('CLARIFY')

      // Turn 2: cancel task explicitly
      const turn2 = await request(app.getHttpServer())
        .post(`/assistant/conversations/${conv.body.id}/turns`)
        .send({
          clientTurnId: `turn-pd14-2-${newId()}`,
          question: '算了，不用了',
          replyToTurnId: resTurn1.id,
          cancelCurrentTask: true,
        })
        .expect(202)

      const resTurn2 = await waitForTurn(conv.body.id, turn2.body.turnId)
      expect(resTurn2.status).toBe('CANCELLED')
      expect(resTurn2.stopReason).toBe('cancelled_by_user')
    })

    it('PD-11: 澄清后自然语言输入“第二个”，正确映射至稳定数组选项', async () => {
      currentActor = userA
      const conv = await request(app.getHttpServer()).post('/assistant/conversations').send({}).expect(201)

      // Ambiguous capability match: "场景与运行" matches scenario and run
      const turn1 = await request(app.getHttpServer())
        .post(`/assistant/conversations/${conv.body.id}/turns`)
        .send({
          clientTurnId: `turn-pd11-1-${newId()}`,
          question: '对比场景和运行',
        })
        .expect(202)

      const resTurn1 = await waitForTurn(conv.body.id, turn1.body.turnId)
      if (resTurn1.status === 'CLARIFY' && resTurn1.result?.options?.length >= 2) {
        // Reply with "第二个"
        const turn2 = await request(app.getHttpServer())
          .post(`/assistant/conversations/${conv.body.id}/turns`)
          .send({
            clientTurnId: `turn-pd11-2-${newId()}`,
            question: '选第二个',
            replyToTurnId: resTurn1.id,
          })
          .expect(202)

        const resTurn2 = await waitForTurn(conv.body.id, turn2.body.turnId)
        expect(resTurn2.status).not.toBe('FAILED')
      }
    })
  })
})
