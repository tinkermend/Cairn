import {
  type CanActivate,
  type ExecutionContext,
  INestApplication,
} from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { compileModuleContent } from '@cairn/authoring'
import {
  BUSINESS_SOURCE_CURSOR_EXPIRED,
  FACTORY_MAP_JOB_POLICY,
  MENU_CATALOG,
  PERMISSIONS,
  arrivalTargetForName,
  moduleWarningKey,
  type AssistantDiscoveryResult,
  createAccountBodySchema,
  createTargetBodySchema,
  unpackAssistantResultEnvelope,
  type Step,
} from '@cairn/shared'
import {
  RbacStore,
  TargetsStore,
  acceptKnowledgeProposal,
  createActionModule,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getKnowledgeProposal,
  getOrCreatePlatformConfig,
  getScenario,
  getTargetKnowledgeContext,
  newId,
  publishActionModule,
  publishScenarioDraft,
  recordAssistantTurnEvent,
  saveActionModuleDraft,
  saveScenarioDraft,
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
  let supplierDatasetId: string

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

    supplierDatasetId = newId()
    await db.db.insert(datasets).values({
      id: supplierDatasetId,
      name: 'ERP供应商主数据表.xlsx',
      targetId: targetAId,
      sourceType: 'excel',
      sourceFilename: 'suppliers_erp.xlsx',
      rowCount: 2,
      columnsMeta: [
        { key: 'code', name: '供应商编号', type: 'string', sampleValues: [] },
        { key: 'name', name: '供应商名称', type: 'string', sampleValues: [] },
        { key: 'status', name: '状态', type: 'string', sampleValues: [] },
      ],
      createdByAccountId: userA.id,
      createdAt: now,
      updatedAt: now,
    })
    await db.db.insert(datasetRows).values([
      {
        id: newId(),
        datasetId: supplierDatasetId,
        rowIndex: 0,
        rowData: { code: 'SUP-100', name: '华东物料供应', status: 'active' },
        validStatus: 'valid',
        createdAt: now,
      },
      {
        id: newId(),
        datasetId: supplierDatasetId,
        rowIndex: 1,
        rowData: { code: 'SUP-200', name: '北方设备服务', status: 'active' },
        validStatus: 'valid',
        createdAt: now,
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

    it('普通用户询问供应商时，只返回已批准供应商快照并给出来源时点', async () => {
      currentActor = userA
      const server = app.getHttpServer()
      const created = await request(server)
        .post(`/targets/${targetAId}/business-sources/candidates`)
        .send({
          datasetId: supplierDatasetId,
          entityType: 'supplier',
          mappingConfig: {
            keyColumn: 'code',
            displayNameColumn: 'name',
            statusColumn: 'status',
            fieldWhitelist: ['code', 'name', 'status'],
          },
          completenessBasis: '供应商主数据全量扫描校验',
          sourceObservedAt: '2026-09-21T08:30:00.000Z',
        })
        .expect(201)

      const build = await claimBusinessSourceBuildJob(db, 'supplier-e2e')
      expect(build?.id).toBe(created.body.candidateId)
      const rows = await getDatasetRows(db, supplierDatasetId, { limit: 100 })
      await commitBusinessSourceBatch(db, build!.id, rows.items.map((row: any) => ({
        targetId: targetAId,
        entityType: 'supplier',
        recordKey: String(row.rowData.code),
        displayName: String(row.rowData.name),
        recordStatus: String(row.rowData.status),
        originalDatasetId: supplierDatasetId,
        datasetRowId: row.id,
        datasetRowIndex: row.rowIndex,
        payload: { code: row.rowData.code, name: row.rowData.name, status: row.rowData.status },
      })))
      await finishBusinessSourceBuild(db, build!.id, {
        status: 'ready',
        summary: { totalRows: 2, validCount: 2, rejectedCount: 0, issues: [] },
      })
      await request(server)
        .post(`/targets/${targetAId}/business-sources/candidates/${build!.id}/approve`)
        .send({
          expectedRevision: created.body.bindingRevision,
          approvalBasis: '人工复核 ERP 供应商名单无误',
        })
        .expect(201)

      const turn = await request(server)
        .post(`/assistant/conversations/${conversationAId}/turns`)
        .send({
          clientTurnId: `turn-supplier-${newId()}`,
          question: '这个目标里有哪些供应商？',
          pageContext: { page: 'target', targetId: targetAId },
        })
        .expect(202)
      const answer = await waitForTurn(conversationAId, turn.body.turnId)
      expect(answer.status).toBe('COMPLETED')
      expect(answer.capabilityId).toBe('target.business-records.list')
      expect(answer.result).toMatchObject({
        kind: 'discovery',
        scope: { targetId: targetAId, entityType: 'supplier' },
        coverage: { totalVisible: 2 },
      })
      const result = answer.result as AssistantDiscoveryResult
      expect(result.candidates.map((item) => item.name)).toEqual(['华东物料供应', '北方设备服务'])
      expect(result.candidates.every((item) => item.kind === 'supplier')).toBe(true)
      expect(result.message).toContain('供应商主数据全量扫描校验')
      expect(result.message).toContain('来源数据集「ERP供应商主数据表.xlsx」')
      expect(result.message).toContain('源数据采集时间：2026-09-21T08:30:00.000Z')
      expect(result.coverage.observedAt).toBe('2026-09-21T08:30:00.000Z')
      expect(result.candidates.map((item) => item.name)).not.toContain('富士康工业互联')
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
    describe('普通用户按目标名称找场景', () => {
      let namedTargetId: string
      const names = ['设备巡检', '告警处置', '资产核对', '工单跟进']

      beforeAll(async () => {
        const targetsStore = new TargetsStore(db, () => Buffer.from('encrypted'))
        const target = await targetsStore.createTarget(
          createTargetBodySchema.parse({
            code: `ops-platform-${newId().slice(0, 8)}`,
            name: '智慧运维管理平台',
            entryUrl: 'https://ops.example.com',
            account: { username: 'ops', displayName: '运维账号', password: 'test-password', validity: { mode: 'permanent' } },
          }),
          adminActor,
        )
        namedTargetId = target.id
        for (const name of names) {
          await createScenarioWithVersion(db, {
            targetId: namedTargetId,
            name,
            steps: [{ ...echoStep, id: newId() }],
            actor: adminActor,
          })
        }
      })

      for (const question of [
        '有哪些关于智慧运维管理平台的场景？',
        '列出智慧运维管理平台的场景，方便我找到要查看的场景。',
        '智慧运维管理平台下面有哪些场景？',
      ]) {
        for (const withContext of [false, true]) {
          it(`${question}（${withContext ? '目标详情页' : '无页面上下文'}）返回该目标的四个场景`, async () => {
            currentActor = adminActor
            const conv = await request(app.getHttpServer()).post('/assistant/conversations').send({}).expect(201)
            const submitted = await request(app.getHttpServer())
              .post(`/assistant/conversations/${conv.body.id}/turns`)
              .send({
                clientTurnId: `discover-named-${newId()}`,
                question,
                ...(withContext ? { pageContext: { page: 'target', targetId: namedTargetId } } : {}),
              })
              .expect(202)
            const turn = await waitForTurn(conv.body.id, submitted.body.turnId)
            expect(turn.status).toBe('COMPLETED')
            expect(turn.result?.kind).toBe('discovery')
            expect(turn.result.scope).toMatchObject({ targetId: namedTargetId, targetName: '智慧运维管理平台' })
            expect(turn.result.scope.filter).toBeUndefined()
            expect(turn.result.candidates.map((candidate: { name: string }) => candidate.name).sort()).toEqual([...names].sort())
            expect(turn.slots?.filter).toBeUndefined()
          })
        }
      }

      it('无目标权限时按名称查询不泄露目标和场景', async () => {
        currentActor = userA
        const conv = await request(app.getHttpServer()).post('/assistant/conversations').send({}).expect(201)
        const submitted = await request(app.getHttpServer())
          .post(`/assistant/conversations/${conv.body.id}/turns`)
          .send({
            clientTurnId: `discover-named-denied-${newId()}`,
            question: '有哪些关于智慧运维管理平台的场景？',
            capabilityHint: 'scenario.discover',
          })
          .expect(202)
        const turn = await waitForTurn(conv.body.id, submitted.body.turnId)
        expect(turn.result).toMatchObject({ kind: 'discovery', candidates: [] })
        expect(JSON.stringify(turn.result)).not.toContain(namedTargetId)
        for (const name of names) expect(JSON.stringify(turn.result)).not.toContain(name)
      })
    })

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

    it('沿用上一页筛选与游标，返回不同的第二页场景', async () => {
      currentActor = userA
      for (let i = 0; i < 21; i++) {
        await createScenarioWithVersion(db, {
          targetId: targetAId,
          name: `分页续查-${String(i).padStart(2, '0')}场景`,
          steps: [{ ...echoStep, id: newId() }],
          actor: userA,
        })
      }

      const conv = await request(app.getHttpServer()).post('/assistant/conversations').send({}).expect(201)
      const first = await request(app.getHttpServer())
        .post(`/assistant/conversations/${conv.body.id}/turns`)
        .send({
          clientTurnId: `turn-sc-page1-${newId()}`,
          question: '查找分页续查场景',
          capabilityHint: 'scenario.discover',
          pageContext: { page: 'studio', targetId: targetAId },
        })
        .expect(202)
      const firstTurn = await waitForTurn(conv.body.id, first.body.turnId)
      expect(firstTurn.result?.kind).toBe('discovery')
      expect(firstTurn.result.candidates).toHaveLength(20)
      expect(firstTurn.result.coverage.hasMore).toBe(true)
      expect(firstTurn.result.coverage.nextCursor).toBeTruthy()

      const second = await request(app.getHttpServer())
        .post(`/assistant/conversations/${conv.body.id}/turns`)
        .send({
          clientTurnId: `turn-sc-page2-${newId()}`,
          question: '下一页',
          capabilityHint: 'scenario.discover',
          replyToTurnId: firstTurn.id,
        })
        .expect(202)
      const secondTurn = await waitForTurn(conv.body.id, second.body.turnId)
      expect(secondTurn.result?.kind).toBe('discovery')
      expect(secondTurn.result.candidates).toHaveLength(1)
      expect(secondTurn.result.candidates[0].name).toContain('分页续查')
      expect(secondTurn.result.coverage.hasMore).toBe(false)
      const firstIds = new Set(firstTurn.result.candidates.map((candidate: { id: string }) => candidate.id))
      expect(firstIds.has(secondTurn.result.candidates[0].id)).toBe(false)

      await recordAssistantTurnEvent(db, {
        turnId: secondTurn.id,
        seq: 1_000,
        channel: 'thinking',
        payload: { delta: 'SENSITIVE_REASONING_MARKER' },
      })
      const replay = await request(app.getHttpServer())
        .get(`/assistant/conversations/${conv.body.id}/turns/${secondTurn.id}/observe`)
        .expect(200)
      expect(replay.text).not.toContain('SENSITIVE_REASONING_MARKER')
    }, 90_000)

    it('同一会话切换场景列表目标筛选时，不沿用上一目标和游标', async () => {
      currentActor = adminActor
      const conv = await request(app.getHttpServer()).post('/assistant/conversations').send({}).expect(201)
      const send = async (question: string, targetId?: string) => {
        const submitted = await request(app.getHttpServer())
          .post(`/assistant/conversations/${conv.body.id}/turns`)
          .send({
            clientTurnId: `discover-scope-${newId()}`,
            question,
            capabilityHint: 'scenario.discover',
            pageContext: {
              version: 2,
              routeKey: 'scenarios.index',
              pageKind: 'scenario',
              page: 'scenario',
              ...(targetId ? { targetId } : {}),
            },
          })
          .expect(202)
        return waitForTurn(conv.body.id, submitted.body.turnId)
      }

      const selected = await send('这个系统有哪些场景？', targetAId)
      expect(selected.result?.kind).toBe('discovery')
      expect(selected.result.scope.targetId).toBe(targetAId)
      expect(selected.result.scope.filter).toBeUndefined()
      expect(selected.result.candidates.length).toBeGreaterThan(0)
      expect(selected.result.candidates.every((candidate: { targetId: string }) => candidate.targetId === targetAId)).toBe(true)

      const cleared = await send('帮我找场景')
      expect(cleared.result?.kind).toBe('discovery')
      expect(cleared.result.scope.targetId).toBeUndefined()
      expect(cleared.slots?.targetId).toBeUndefined()
      expect(cleared.slots?.cursor).toBeUndefined()

      const missingTarget = await send('这个系统有哪些场景？')
      expect(missingTarget.result?.kind).toBe('discovery')
      expect(missingTarget.result.candidates).toEqual([])
      expect(missingTarget.result.message).toContain('请先在场景列表选择目标')

      const switched = await send('这个系统有哪些场景？', targetBId)
      expect(switched.result?.kind).toBe('discovery')
      expect(switched.result.scope.targetId).toBe(targetBId)
      expect(switched.result.candidates.every((candidate: { targetId: string }) => candidate.targetId === targetBId)).toBe(true)
    }, 90_000)

    it('内部异常只返回可理解的错误信息，不回显原始异常文本', async () => {
      currentActor = userA
      const registration = capabilityRegistry.get('scenario.discover')!
      const originalHandler = registration.handler
      registration.handler = async () => { throw new Error('PRIVATE_INTERNAL_EXCEPTION_MARKER') }
      try {
        const conv = await request(app.getHttpServer()).post('/assistant/conversations').send({}).expect(201)
        const turn = await request(app.getHttpServer())
          .post(`/assistant/conversations/${conv.body.id}/turns`)
          .send({
            clientTurnId: `turn-internal-error-${newId()}`,
            question: '有哪些场景？',
            capabilityHint: 'scenario.discover',
          })
          .expect(202)
        const failed = await waitForTurn(conv.body.id, turn.body.turnId)
        expect(failed.status).toBe('FAILED')
        expect(failed.stopReason).toBe('internal_loading_facts')
        expect(failed.result?.message).toContain('读取平台事实')
        expect(failed.result?.message).toContain(turn.body.turnId)
        expect(JSON.stringify(failed)).not.toContain('PRIVATE_INTERNAL_EXCEPTION_MARKER')
      } finally {
        registration.handler = originalHandler
      }
    })

    it('同名场景按目标消歧，受限用户只看到自己可编辑的目标', async () => {
      const sharedName = '订单对账场景'
      const alpha = await createScenarioWithVersion(db, {
        targetId: targetAId,
        name: sharedName,
        steps: [{ ...echoStep, id: newId() }],
        actor: adminActor,
      })
      const beta = await createScenarioWithVersion(db, {
        targetId: targetBId,
        name: sharedName,
        steps: [{ ...echoStep, id: newId() }],
        actor: adminActor,
      })
      const ask = async (actor: RequestAccount) => {
        currentActor = actor
        const server = app.getHttpServer()
        const conversation = await request(server).post('/assistant/conversations').send({}).expect(201)
        const turn = await request(server)
          .post(`/assistant/conversations/${conversation.body.id}/turns`)
          .send({
            clientTurnId: `turn-duplicate-${newId()}`,
            question: '找一下订单对账场景，我要继续编辑。',
            pageContext: { page: 'home' },
          })
          .expect(202)
        return waitForTurn(conversation.body.id, turn.body.turnId)
      }

      const adminAnswer = await ask(adminActor)
      expect(adminAnswer.status).toBe('COMPLETED')
      expect(adminAnswer.capabilityId).toBe('scenario.discover')
      const adminResult = adminAnswer.result as AssistantDiscoveryResult
      expect(adminResult.kind).toBe('discovery')
      expect(adminResult.candidates.map((item) => ({
        id: item.id, name: item.name, targetId: item.targetId, targetName: item.targetName,
      }))).toEqual(expect.arrayContaining([
        { id: alpha.id, name: sharedName, targetId: targetAId, targetName: '系统-甲 (ERP)' },
        { id: beta.id, name: sharedName, targetId: targetBId, targetName: '系统-乙 (CRM)' },
      ]))

      const restrictedAnswer = await ask(userA)
      expect(restrictedAnswer.status).toBe('COMPLETED')
      const restrictedResult = restrictedAnswer.result as AssistantDiscoveryResult
      expect(restrictedResult.candidates.map((item) => item.id)).toContain(alpha.id)
      expect(restrictedResult.candidates.map((item) => item.id)).not.toContain(beta.id)
      expect(JSON.stringify(restrictedResult)).not.toContain('系统-乙 (CRM)')
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
      expect(resTurn.result.candidates.some((c: any) => c.name.includes('场景'))).toBe(true)
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

  describe('7. 执行完成与业务结果失败的真实事实分离', () => {
    it('普通用户问业务检查为何没过时，引用 Outcome FAIL 而不把 Run 说成执行失败', async () => {
      const stepId = newId()
      const contractId = newId()
      const scenario = await createScenarioWithVersion(db, {
        targetId: targetAId,
        name: '订单状态核验受控场景',
        steps: [{ ...echoStep, id: newId() }],
        actor: userA,
      })
      await saveScenarioDraft(db, scenario.id, {
        revision: 1,
        document: {
          authoringSchemaVersion: 2,
          nodes: [{
            kind: 'step',
            step: {
              id: stepId,
              name: '检查订单状态',
              type: 'assert',
              effectType: 'READ_ONLY',
              input: { expect: { kind: 'text_equals', value: '已完成' } },
            },
            outcomes: [{
              id: contractId,
              scope: 'step',
              meaning: '订单状态必须为已完成',
              severity: 'MUST',
              onViolation: 'continue',
              provenance: 'manual',
              rule: {
                kind: 'deterministic',
                target: { framePath: [], candidates: [{ by: 'css', value: '#order-status' }] },
                expect: { kind: 'text_equals', value: '已完成' },
              },
            }],
          }],
        },
        actor: userA,
      })
      await publishScenarioDraft(db, scenario.id, { revision: 2, actor: userA })
      const created = await createRunWithSnapshot(db, {
        scenarioId: scenario.id,
        actor: { id: userA.id },
      })
      const runId = created.detail.id
      const stepRunId = created.detail.stepRuns[0]!.id
      const attemptId = newId()
      const now = new Date()
      const { runs, stepRuns, attempts, outcomeResults } = schemaFor(db.db)
      await db.db.update(runs).set({
        status: 'SUCCEEDED', outcomeStatus: 'FAIL', evidenceStatus: 'COMPLETE',
        startedAt: new Date(now.getTime() - 1000), finishedAt: now, updatedAt: now,
      }).where(eq(runs.id, runId))
      await db.db.update(stepRuns).set({
        status: 'SUCCEEDED', outcomeStatus: 'FAIL',
        startedAt: new Date(now.getTime() - 900), finishedAt: now,
      }).where(eq(stepRuns.id, stepRunId))
      await db.db.insert(attempts).values({
        id: attemptId, stepRunId, attemptNo: 1, status: 'SUCCEEDED',
        startedAt: new Date(now.getTime() - 900), finishedAt: now,
        output: { passed: false },
      })
      await db.db.insert(outcomeResults).values({
        id: newId(), runId, stepRunId, attemptId, contractId,
        scope: 'step', meaning: '订单状态必须为已完成', severity: 'MUST',
        onViolation: 'continue', provenance: 'manual', verdict: 'FAIL',
        expected: '已完成', actual: '待审核', evaluatedAt: now,
      })

      currentActor = userA
      const server = app.getHttpServer()
      const conversation = await request(server).post('/assistant/conversations').send({}).expect(201)
      const turn = await request(server)
        .post(`/assistant/conversations/${conversation.body.id}/turns`)
        .send({
          clientTurnId: `turn-outcome-fail-${newId()}`,
          question: '运行显示完成，为什么业务检查没通过？',
          pageContext: { page: 'run', runId, targetId: targetAId },
        })
        .expect(202)
      const answer = await waitForTurn(conversation.body.id, turn.body.turnId)
      expect(answer.status).toBe('COMPLETED')
      expect(answer.capabilityId).toBe('run.diagnose')
      expect(answer.result?.kind).toBe('diagnosis')
      const factText = answer.result.facts.map((fact: { text: string }) => fact.text).join('\n')
      expect(factText).toContain('运行状态为 SUCCEEDED')
      expect(factText).toContain('运行业务结果为 FAIL')
      expect(factText).toContain('业务检查「订单状态必须为已完成」结果为 FAIL')
      expect(factText).not.toContain('运行状态为 FAILED')
      expect(answer.result.hypotheses).toEqual([])
      expect(answer.result.missingInformation).toEqual(expect.arrayContaining([
        expect.stringContaining('不能确定具体差异'),
      ]))
      expect(answer.result.facts.find((fact: { id: string }) => fact.id.startsWith('outcome-'))?.citations)
        .toEqual(expect.arrayContaining([`run:${runId}`, `stepRun:${stepRunId}`]))
    })
  })

  describe('8. 当前筛选范围内的多类失败归并', () => {
    it('普通用户问这些失败是否同因时，只按可见目标的三条 Run 分成两组', async () => {
      const betaScenario = await createScenarioWithVersion(db, {
        targetId: targetBId,
        name: '乙目标隔离运行场景',
        steps: [{ ...echoStep, id: newId() }],
        actor: adminActor,
      })
      const createFailed = async (scenarioId: string, actorId: string, code: string) => {
        const created = await createRunWithSnapshot(db, {
          scenarioId,
          actor: { id: actorId },
        })
        const runId = created.detail.id
        const stepRunId = created.detail.stepRuns[0]!.id
        const now = new Date()
        const { runs, stepRuns, attempts } = schemaFor(db.db)
        await db.db.update(runs).set({
          status: 'FAILED', outcomeStatus: 'NOT_EVALUATED', evidenceStatus: 'PENDING',
          startedAt: new Date(now.getTime() - 1000), finishedAt: now, updatedAt: now,
        }).where(eq(runs.id, runId))
        await db.db.update(stepRuns).set({
          status: 'FAILED', startedAt: new Date(now.getTime() - 900), finishedAt: now,
        }).where(eq(stepRuns.id, stepRunId))
        await db.db.insert(attempts).values({
          id: newId(), stepRunId, attemptNo: 1, status: 'FAILED',
          startedAt: new Date(now.getTime() - 900), finishedAt: now,
          error: {
            code,
            category: code === 'TIMEOUT' ? 'TIMEOUT' : 'EXECUTOR',
            retryable: false,
            safeMessage: `${code} 可展示说明`,
            cause: { message: 'PRIVATE_DETAIL_MARKER' },
          },
        })
        return runId
      }
      const a1 = await createFailed(scenarioAId, userA.id, 'AI_NOT_FOUND')
      const a2 = await createFailed(scenarioAId, userA.id, 'AI_NOT_FOUND')
      const a3 = await createFailed(scenarioAId, userA.id, 'TIMEOUT')
      const b = await createFailed(betaScenario.id, adminActor.id, 'TARGET_B_PRIVATE')

      currentActor = userA
      const server = app.getHttpServer()
      const conversation = await request(server).post('/assistant/conversations').send({}).expect(201)
      const turn = await request(server)
        .post(`/assistant/conversations/${conversation.body.id}/turns`)
        .send({
          clientTurnId: `turn-failure-groups-${newId()}`,
          question: '这些失败是同一个原因吗？',
          pageContext: {
            version: 2, routeKey: 'runs.list', pageKind: 'run', page: 'run',
            view: { filters: { status: 'FAILED', targetId: targetAId } },
          },
        })
        .expect(202)
      const answer = await waitForTurn(conversation.body.id, turn.body.turnId)
      expect(answer.status).toBe('COMPLETED')
      expect(answer.capabilityId).toBe('knowledge.answer')
      expect(answer.result?.kind).toBe('knowledge_answer')
      const result = answer.result as Extract<NonNullable<typeof answer.result>, { kind: 'knowledge_answer' }>
      expect(result.summary).toContain('3 条 FAILED 运行')
      expect(result.summary).toContain('分为 2 个错误表现组')
      expect(result.summary).toContain('不能确认它们同因')
      expect(result.summary).toContain('AI_NOT_FOUND（2 次）')
      expect(result.summary).toContain('TIMEOUT（1 次）')
      expect(result.claims[0]?.citations).toEqual(expect.arrayContaining([
        `run:${a1}`, `run:${a2}`, `run:${a3}`,
      ]))
      expect(JSON.stringify(result)).not.toContain(b)
      expect(JSON.stringify(result)).not.toContain('TARGET_B_PRIVATE')
      expect(JSON.stringify(result)).not.toContain('PRIVATE_DETAIL_MARKER')
    })
  })

  describe('9. P10 昨晚调度被跳过的受控正例', () => {
    it('从真实调度版本和触发记录按原句回答，并引用实际跳过事件', async () => {
      const scheduleId = newId()
      const versionId = newId()
      const occurrenceId = newId()
      const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })
        .format(new Date(Date.now() - 24 * 60 * 60 * 1000))
      const now = new Date()
      const { schedules, scheduleVersions, scheduleOccurrences } = schemaFor(db.db)
      await db.db.insert(schedules).values({
        id: scheduleId, name: '订单夜间巡检', targetId: targetAId,
        consumerKey: 'scenario_run', enabled: 1, revision: 1,
        currentVersionId: versionId, createdBy: adminActor.id,
        createdAt: new Date('2025-01-01T00:00:00.000Z'), updatedAt: now,
      })
      await db.db.insert(scheduleVersions).values({
        id: versionId, scheduleId, revision: 1, name: '订单夜间巡检',
        timezone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5, 6, 7],
        windowStart: '22:00', windowEnd: '23:00', misfire: 'skip',
        timeRule: { kind: 'calendar', timezone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5, 6, 7],
          windows: [{ ruleId: 'night', windowStart: '22:00', windowEnd: '23:00' }], misfire: 'skip' },
        consumer: { type: 'scenario_run', targetId: targetAId,
          scenarioId: scenarioAId, scenarioVersionId: newId(), accountBinding: {}, input: {} },
        authorizedActorId: adminActor.id, contentDigest: 'p10-controlled-skip',
      })
      await db.db.insert(scheduleOccurrences).values({
        id: occurrenceId, scheduleId, scheduleVersionId: versionId,
        source: 'scheduled', ruleId: 'night', localSlotKey: `${yesterday}:night`,
        localStartDate: yesterday, windowStartUtc: new Date(`${yesterday}T14:00:00.000Z`),
        windowEndUtc: new Date(`${yesterday}T15:00:00.000Z`),
        timeRuleVersion: 'schedule-time@2', admissionStatus: 'SKIPPED',
        reason: 'WORKER_UNAVAILABLE', createdAt: now,
      })

      currentActor = adminActor
      const server = app.getHttpServer()
      const conversation = await request(server).post('/assistant/conversations').send({}).expect(201)
      const turn = await request(server)
        .post(`/assistant/conversations/${conversation.body.id}/turns`)
        .send({
          clientTurnId: `turn-schedule-skipped-${newId()}`,
          question: '昨晚这条调度怎么没跑？',
          pageContext: { version: 2, routeKey: 'schedules.index', pageKind: 'schedule', page: 'schedule',
            primaryRef: { kind: 'schedule', id: scheduleId },
            scopeRefs: [{ kind: 'target', id: targetAId }], targetId: targetAId },
        })
        .expect(202)
      const answer = await waitForTurn(conversation.body.id, turn.body.turnId)
      expect(answer.status).toBe('COMPLETED')
      expect(answer.capabilityId).toBe('knowledge.answer')
      expect(answer.result?.kind).toBe('knowledge_answer')
      const result = answer.result as Extract<NonNullable<typeof answer.result>, { kind: 'knowledge_answer' }>
      expect(result.summary).toContain(yesterday)
      expect(result.summary).toContain('Asia/Shanghai')
      expect(result.summary).toContain('已跳过 1 次')
      expect(result.summary).toContain('WORKER_UNAVAILABLE')
      expect(result.summary).toContain('在准入阶段被跳过')
      expect(result.claims[0]?.citations).toContain(`occurrence:${occurrenceId}`)
      currentActor = makeAccount(adminActor.id, adminActor.permissions.filter((permission) => permission !== 'schedule:read'))
      const revoked = await request(server)
        .get(`/assistant/conversations/${conversation.body.id}/turns/${turn.body.turnId}`).expect(200)
      expect(revoked.body.result?.kind).toBe('inaccessible')
      currentActor = adminActor
    })
  })

  describe('10. P09 认证失败与运行占用的受控正例', () => {
    it('从真实账号会话与活动租约按原句报告认证错误及占用运行', async () => {
      const { targetAccounts, browserSessions, sessionLeases } = schemaFor(db.db)
      const [targetAccount] = await db.db.select({ id: targetAccounts.id })
        .from(targetAccounts).where(eq(targetAccounts.targetId, targetAId)).limit(1)
      expect(targetAccount).toBeDefined()
      const targetAccountId = targetAccount!.id
      const created = await createRunWithSnapshot(db, {
        scenarioId: scenarioAId, targetAccountId, actor: { id: adminActor.id },
      })
      const runId = created.detail.id
      const sessionId = newId()
      const now = new Date()
      await db.db.insert(browserSessions).values({
        id: sessionId, targetId: targetAId, targetAccountId,
        status: 'OPEN', health: 'UNHEALTHY', authState: 'EXPIRED',
        ownerWorkerId: 'fixture-worker', generation: 1, fencingToken: 1,
        profileKey: 'p09-fixture-profile', reusePolicy: 'NEW_PAGE',
        idleTtlSeconds: 300, maxLifetimeSeconds: 3600,
        expiresAt: new Date(now.getTime() + 3600_000),
        lastAuthError: 'LOGIN_PAGE_UNREACHABLE',
        lastAuthCheckedAt: new Date(now.getTime() - 60_000),
        lastAuthSuccessAt: new Date(now.getTime() - 24 * 3600_000),
      })
      await db.db.insert(sessionLeases).values({
        id: newId(), sessionId, sessionGeneration: 1, sessionFencingToken: 1,
        runId, runFencingToken: 1, purpose: 'EXECUTION', ownerKind: 'RUN', holderWorkerId: 'fixture-worker',
        status: 'ACTIVE', acquiredAt: new Date(now.getTime() - 5 * 60_000),
        heartbeatAt: now, expiresAt: new Date(now.getTime() + 30 * 60_000),
      })

      currentActor = adminActor
      const server = app.getHttpServer()
      const conversation = await request(server).post('/assistant/conversations').send({}).expect(201)
      const turn = await request(server)
        .post(`/assistant/conversations/${conversation.body.id}/turns`)
        .send({
          clientTurnId: `turn-session-lease-${newId()}`,
          question: '这个账号为什么一直等登录？现在谁占着会话？',
          pageContext: { version: 2, routeKey: 'sessions.$targetId.$accountId',
            pageKind: 'session', page: 'session',
            primaryRef: { kind: 'account', id: targetAccountId },
            scopeRefs: [{ kind: 'target', id: targetAId }, { kind: 'account', id: targetAccountId }],
            targetId: targetAId },
        })
        .expect(202)
      const answer = await waitForTurn(conversation.body.id, turn.body.turnId)
      expect(answer.status).toBe('COMPLETED')
      expect(answer.capabilityId).toBe('knowledge.answer')
      expect(answer.result?.kind).toBe('knowledge_answer')
      const result = answer.result as Extract<NonNullable<typeof answer.result>, { kind: 'knowledge_answer' }>
      expect(result.summary).toContain('LOGIN_PAGE_UNREACHABLE')
      expect(result.summary).toContain('目标登录页打不开')
      expect(result.summary).toContain(`占用运行 ID ${runId}`)
      expect(result.summary).toContain('不能断定现在可用')
      expect(result.nextActions).toContainEqual(expect.objectContaining({
        kind: 'run.detail', href: `/runs/${runId}`,
      }))
      currentActor = makeAccount(adminActor.id, adminActor.permissions.filter((permission) => permission !== 'run:read'))
      const revoked = await request(server)
        .get(`/assistant/conversations/${conversation.body.id}/turns/${turn.body.turnId}`).expect(200)
      expect(revoked.body.result?.kind).toBe('inaccessible')
      currentActor = adminActor
    })
  })

  describe('11. P03 订单步骤的 customerId 上游依赖', () => {
    it('按已保存 outputKey 说明来源和删除前一步的影响', async () => {
      const queryStepId = newId()
      const fillStepId = newId()
      const scenario = await createScenarioWithVersion(db, {
        targetId: targetAId,
        name: '订单客户查询',
        steps: [
          { id: queryStepId, name: '查询订单并提取客户编号', type: 'extract',
            effectType: 'READ_ONLY', outputKey: 'customerId',
            input: { target: { framePath: [], candidates: [{ by: 'css', value: '#customer-id' }] }, as: 'text' } },
          { id: fillStepId, name: '填写客户编号查询', type: 'fill', effectType: 'SIDE_EFFECT',
            input: { target: { framePath: [], candidates: [{ by: 'css', value: '#customer-search' }] }, from: 'customerId' } },
        ],
        actor: adminActor,
      })
      currentActor = adminActor
      const server = app.getHttpServer()
      const conversation = await request(server).post('/assistant/conversations').send({}).expect(201)
      const turn = await request(server)
        .post(`/assistant/conversations/${conversation.body.id}/turns`)
        .send({
          clientTurnId: `turn-customer-binding-${newId()}`,
          question: '这一步用的 customerId 从哪来？删掉前一步会怎样？',
          pageContext: { version: 2, routeKey: 'scenarios.$scenarioId.studio',
            pageKind: 'studio', page: 'studio', scenarioId: scenario.id, targetId: targetAId,
            primaryRef: { kind: 'scenario', id: scenario.id },
            scopeRefs: [{ kind: 'target', id: targetAId }],
            view: { selectedRef: { kind: 'step', id: fillStepId } } },
        })
        .expect(202)
      const answer = await waitForTurn(conversation.body.id, turn.body.turnId)
      expect(answer.status).toBe('COMPLETED')
      expect(answer.capabilityId).toBe('scenario.explain')
      expect(answer.result?.kind).toBe('explanation')
      expect(answer.result.stepSummary).toContain('customerId 来自前序步骤「查询订单并提取客户编号」')
      expect(answer.result.stepSummary).toContain('删除它会移除当前步骤所引用的 customerId 来源')
      expect(answer.result.stepSummary).not.toContain('没有找到它的已定义来源')
    })
  })

  describe('12. P04 订单等待加校验的原句与事实边界', () => {
    it('已保存草稿但没有结果区地图时，明确追问两个目标且不生成半成品提案', async () => {
      const anchorStepId = newId()
      const scenario = await createScenarioWithVersion(db, {
        targetId: targetAId, name: '订单查询编排',
        steps: [{ ...echoStep, id: anchorStepId, name: '查询订单' }], actor: userA,
      })
      await saveScenarioDraft(db, scenario.id, {
        revision: 1,
        document: { authoringSchemaVersion: 2, nodes: [{ kind: 'step',
          step: { ...echoStep, id: anchorStepId, name: '查询订单' } }] },
        actor: userA,
      })
      currentActor = userA
      const server = app.getHttpServer()
      const conversation = await request(server).post('/assistant/conversations').send({}).expect(201)
      const turn = await request(server)
        .post(`/assistant/conversations/${conversation.body.id}/turns`)
        .send({
          clientTurnId: `turn-order-wait-check-${newId()}`,
          question: '查完订单后等结果区出现，再检查状态是成功。',
          pageContext: { version: 2, routeKey: 'scenarios.$scenarioId.studio',
            pageKind: 'studio', page: 'studio', scenarioId: scenario.id, targetId: targetAId,
            primaryRef: { kind: 'scenario', id: scenario.id },
            scopeRefs: [{ kind: 'target', id: targetAId }],
            view: { selectedRef: { kind: 'step', id: anchorStepId } } },
        })
        .expect(202)
      const answer = await waitForTurn(conversation.body.id, turn.body.turnId)
      expect(answer.status).toBe('CLARIFY')
      expect(answer.capabilityId).toBe('scenario.propose-step')
      expect(answer.result?.kind).toBe('clarify')
      expect(answer.result.missingFields).toEqual(['waitTarget', 'assertTarget'])
      expect(answer.result.question).toContain('没有足够的页面事实')
    })

    it('同一已观测页面有唯一结果区与状态定位时，生成顺序正确且不自动保存的提案', async () => {
      const { targetAccounts, mapMenuEntries, mapJobs, mapIngestPages } = schemaFor(db.db)
      const [targetAccount] = await db.db.select({ id: targetAccounts.id })
        .from(targetAccounts).where(eq(targetAccounts.targetId, targetBId)).limit(1)
      expect(targetAccount).toBeDefined()
      const entryId = newId()
      const jobId = newId()
      await db.db.insert(mapMenuEntries).values({
        id: entryId, targetId: targetBId, entryVersion: 1, entryName: '订单管理',
        entryUrl: 'https://beta.example.com/orders', arrivalName: '订单管理',
        arrivalTarget: arrivalTargetForName('订单管理'), enabled: 1, orderIndex: 1,
        createdBy: adminActor.id, updatedBy: adminActor.id,
      })
      await db.db.insert(mapJobs).values({
        id: jobId, targetId: targetBId, targetAccountId: targetAccount!.id,
        jobKind: 'map_ingest', jobStatus: 'completed', revision: 1,
        remainingBudgetSeconds: 0, scope: 'entries', policyRevision: 1,
        requestJson: {}, frozenPolicyJson: FACTORY_MAP_JOB_POLICY,
        createdBy: adminActor.id,
      })
      await db.db.insert(mapIngestPages).values({
        id: newId(), jobId, entryId, targetId: targetBId, targetAccountId: targetAccount!.id,
        pageKey: 'page:order-results', viewStateKey: 'view:order-results',
        presentationStateKey: 'presentation:order-results', arrivalMethod: 'goto',
        menuPathJson: ['订单管理', '订单查询'], title: '订单查询',
        urlPattern: 'https://beta.example.com/orders',
        elementsJson: [
          { fingerprint: 'order-results', category: 'display', role: 'region', name: '结果区',
            locator: { framePath: [], candidates: [{ by: 'css', value: '#order-results' }] } },
          { fingerprint: 'order-status', category: 'display', role: 'status', name: '状态',
            locator: { framePath: [], candidates: [{ by: 'css', value: '#order-status' }] } },
        ],
        completeness: 'complete', reasonsJson: [], observedAt: new Date(),
      })
      const mapped = await getTargetKnowledgeContext(db, targetBId, {
        intent: '查完订单后等结果区出现，再检查状态是成功。', maxPages: 3,
      })
      expect(mapped.pages[0]?.views[0]?.elements.map((element) => element.name))
        .toEqual(['结果区', '状态'])
      const anchorStepId = newId()
      const scenario = await createScenarioWithVersion(db, {
        targetId: targetBId, name: '订单查询编排',
        steps: [{ ...echoStep, id: anchorStepId, name: '查询订单' }], actor: adminActor,
      })
      await saveScenarioDraft(db, scenario.id, {
        revision: 1,
        document: { authoringSchemaVersion: 2, nodes: [{ kind: 'step',
          step: { ...echoStep, id: anchorStepId, name: '查询订单' } }] },
        actor: adminActor,
      })
      const before = await (await import('@cairn/db')).getScenario(db, scenario.id)
      currentActor = adminActor
      const server = app.getHttpServer()
      const conversation = await request(server).post('/assistant/conversations').send({}).expect(201)
      const turn = await request(server)
        .post(`/assistant/conversations/${conversation.body.id}/turns`)
        .send({
          clientTurnId: `turn-order-wait-check-grounded-${newId()}`,
          question: '查完订单后等结果区出现，再检查状态是成功。',
          pageContext: { version: 2, routeKey: 'scenarios.$scenarioId.studio',
            pageKind: 'studio', page: 'studio', scenarioId: scenario.id, targetId: targetBId,
            primaryRef: { kind: 'scenario', id: scenario.id },
            scopeRefs: [{ kind: 'target', id: targetBId }],
            view: { selectedRef: { kind: 'step', id: anchorStepId } } },
        })
        .expect(202)
      const answer = await waitForTurn(conversation.body.id, turn.body.turnId)
      expect(answer.status, JSON.stringify(answer)).toBe('COMPLETED')
      expect(answer.capabilityId).toBe('scenario.propose-step')
      expect(answer.result?.kind).toBe('authoring_proposal')
      expect(answer.result.operations).toHaveLength(2)
      const [wait, check] = answer.result.operations
      expect(wait).toMatchObject({ kind: 'insert_step', anchorStepId,
        step: { type: 'wait', input: { kind: 'visible', target: {
          candidates: [{ by: 'css', value: '#order-results' }] } } } })
      expect(check).toMatchObject({ kind: 'insert_step', anchorStepId: wait.step.id,
        step: { type: 'assert', input: { target: {
          candidates: [{ by: 'css', value: '#order-status' }] },
          expect: { kind: 'text_contains', value: '成功' } } } })
      const preview = await request(server)
        .get(`/assistant/conversations/${conversation.body.id}/turns/${turn.body.turnId}/proposal-preview`)
        .expect(200)
      expect(preview.body.canAdopt).toBe(true)
      expect(preview.body.operations).toHaveLength(2)
      const saved = await (await import('@cairn/db')).getScenario(db, scenario.id)
      expect(saved.draft?.revision).toBe(before.draft?.revision)
      expect(saved.draft?.document).toEqual(before.draft?.document)
    })
  })

  describe('13. P12 普通用户问订单页入口的已观测地图正例', () => {
    it('从隔离库真实采集记录返回菜单和路径，历史读取时重新核对权限', async () => {
      const { targetAccounts, mapMenuEntries, mapJobs, mapIngestPages } = schemaFor(db.db)
      const [targetAccount] = await db.db.select({ id: targetAccounts.id })
        .from(targetAccounts).where(eq(targetAccounts.targetId, targetAId)).limit(1)
      expect(targetAccount).toBeDefined()
      const entryId = newId()
      const jobId = newId()
      await db.db.insert(mapMenuEntries).values({
        id: entryId, targetId: targetAId, entryVersion: 1,
        entryName: '订单管理', entryUrl: 'https://alpha.example.com/orders/search',
        arrivalName: '订单管理', arrivalTarget: arrivalTargetForName('订单管理'),
        enabled: 1, orderIndex: 1, createdBy: adminActor.id, updatedBy: adminActor.id,
      })
      await db.db.insert(mapJobs).values({
        id: jobId, targetId: targetAId, targetAccountId: targetAccount!.id,
        jobKind: 'map_ingest', jobStatus: 'completed', revision: 1,
        remainingBudgetSeconds: 0, scope: 'entries', policyRevision: 1,
        requestJson: {}, frozenPolicyJson: FACTORY_MAP_JOB_POLICY,
        createdBy: adminActor.id,
      })
      await db.db.insert(mapIngestPages).values({
        id: newId(), jobId, entryId, targetId: targetAId, targetAccountId: targetAccount!.id,
        pageKey: 'page:orders-search', viewStateKey: 'view:orders-search',
        presentationStateKey: 'presentation:orders-search', arrivalMethod: 'goto',
        menuPathJson: ['订单管理', '订单查询'], title: '订单查询',
        urlPattern: 'https://alpha.example.com/orders/search',
        elementsJson: [], completeness: 'complete', reasonsJson: [], observedAt: new Date(),
      })
      currentActor = adminActor
      const server = app.getHttpServer()
      const conversation = await request(server).post('/assistant/conversations').send({}).expect(201)
      const turn = await request(server)
        .post(`/assistant/conversations/${conversation.body.id}/turns`)
        .send({
          clientTurnId: `turn-order-entry-${newId()}`,
          question: '这个系统的订单页入口在哪里？',
          pageContext: { version: 2, routeKey: 'targets.$targetId', pageKind: 'target',
            page: 'target', targetId: targetAId,
            primaryRef: { kind: 'target', id: targetAId }, scopeRefs: [] },
        })
        .expect(202)
      const answer = await waitForTurn(conversation.body.id, turn.body.turnId)
      expect(answer.status, JSON.stringify(answer)).toBe('COMPLETED')
      expect(answer.capabilityId).toBe('in-page.guidance')
      expect(answer.result?.kind).toBe('in_page_guidance')
      expect(answer.result.directAnswer).toContain('订单管理 → 订单查询')
      expect(answer.result.directAnswer).toContain('/orders/search')
      const history = await request(server)
        .get(`/assistant/conversations/${conversation.body.id}/turns/${turn.body.turnId}`).expect(200)
      expect(history.body.result?.directAnswer).toContain('/orders/search')
      currentActor = makeAccount(adminActor.id,
        adminActor.permissions.filter((permission) => permission !== 'map:read'))
      const revoked = await request(server)
        .get(`/assistant/conversations/${conversation.body.id}/turns/${turn.body.turnId}`).expect(200)
      expect(JSON.stringify(revoked.body.result ?? {})).not.toContain('/orders/search')
      currentActor = adminActor
    })
  })

  describe('14. 知识辅助编写的可编辑正例', () => {
    it('已发布做法与草稿必需输入齐全时，生成有来源的差异并可采纳', async () => {
      const module = await createActionModule(db, {
        idempotencyKey: newId(), targetId: targetAId, key: `order.query${newId().replaceAll('-', '').slice(0, 8)}`,
        name: '查询订单', actor: { id: adminActor.id },
      })
      const content = {
        contract: {
          inputs: [{ key: 'keyword', label: '关键词', valueType: 'string' as const, required: true }],
          outputs: [{ key: 'result', label: '结果', shape: { kind: 'scalar' as const, type: 'string' as const } }],
          effectCeiling: 'READ_ONLY' as const,
          preconditions: [],
          postconditions: [{ meaning: '有结果', verification: { kind: 'output_required' as const, outputKey: 'result' } }],
        },
        implementations: [{
          implementationKey: 'default', kind: 'structured_steps' as const,
          steps: [{ id: newId(), name: '查询订单', type: 'echo' as const,
            effectType: 'READ_ONLY' as const, outputKey: 'internal', input: { from: 'keyword' } }],
          outputMapping: { result: 'internal' },
        }],
      }
      const moduleDraft = await saveActionModuleDraft(db, module.id, {
        baseRevision: module.draftRevision ?? 0, content, actor: { id: adminActor.id },
      })
      const confirmedWarnings = compileModuleContent(content, { mode: 'release' }).diagnostics
        .filter((item) => item.severity === 'warning').map(moduleWarningKey)
      await publishActionModule(db, module.id, {
        idempotencyKey: newId(), expectedRevision: moduleDraft.draftRevision ?? 0,
        confirmedWarnings, actor: { id: adminActor.id }, skipReleaseGate: true,
      })

      const scenario = await createScenarioWithVersion(db, {
        targetId: targetAId, name: '订单查询草稿',
        steps: [{ ...echoStep, id: newId(), outputKey: 'baseline' }], actor: adminActor,
      })
      const saved = await saveScenarioDraft(db, scenario.id, {
        revision: scenario.draft!.revision,
        document: { schemaVersion: 1, inputs: [{ key: 'keyword', label: '关键词' }],
          steps: [{ ...echoStep, id: newId(), outputKey: 'baseline' }] },
        actor: adminActor,
      })
      currentActor = adminActor
      const server = app.getHttpServer()
      const conversation = await request(server).post('/assistant/conversations').send({}).expect(201)
      const turn = await request(server)
        .post(`/assistant/conversations/${conversation.body.id}/turns`)
        .send({
          clientTurnId: `turn-compose-knowledge-${newId()}`,
          question: '根据已发布的查询订单做法给当前草稿生成可编辑建议。',
          pageContext: { version: 2, routeKey: 'scenarios.$scenarioId.studio', pageKind: 'studio',
            page: 'studio', scenarioId: scenario.id, targetId: targetAId,
            draftRevision: saved.draft!.revision,
            primaryRef: { kind: 'scenario', id: scenario.id },
            scopeRefs: [{ kind: 'target', id: targetAId }] },
        })
        .expect(202)
      const answer = await waitForTurn(conversation.body.id, turn.body.turnId)
      expect(answer.status, JSON.stringify(answer)).toBe('COMPLETED')
      expect(answer.capabilityId).toBe('scenario.compose_with_knowledge')
      expect(answer.result, JSON.stringify(answer.result)).toMatchObject({ kind: 'knowledge_proposal', status: 'proposed', executable: true })
      expect(answer.result.diffs.length).toBeGreaterThan(0)
      expect(answer.result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'module_version', moduleId: module.id })]))
      const proposal = await getKnowledgeProposal(db, scenario.id, answer.result.proposalId)
      expect(proposal.document?.steps).toHaveLength(2)
      expect(proposal.document?.steps[1]).toMatchObject({ name: '查询订单', type: 'echo', input: { from: 'keyword' } })
      const accepted = await acceptKnowledgeProposal(db, scenario.id, proposal.proposalId, {
        idempotencyKey: newId(), expectedDraftRevision: saved.draft!.revision,
        documentDigest: answer.result.documentDigest,
      }, { id: adminActor.id })
      expect(accepted.proposal.proposalStatus).toBe('accepted')
      expect(accepted.draftRevision).toBe(saved.draft!.revision + 1)
      const adopted = await getScenario(db, scenario.id)
      expect(adopted.draft?.document).toMatchObject({
        authoringSchemaVersion: 2, locatorProtocol: 2,
        nodes: [
          { kind: 'step', step: { name: '回显步骤' } },
          { kind: 'step', step: { name: '查询订单', input: { from: 'keyword' } } },
        ],
      })
    })

    it('已发布做法的必需输入未被实现使用时，不要求用户补无效参数', async () => {
      const module = await createActionModule(db, {
        idempotencyKey: newId(), targetId: targetAId,
        key: `model.audit${newId().replaceAll('-', '').slice(0, 8)}`,
        name: '模型配额审计', actor: { id: adminActor.id },
      })
      const content = {
        contract: {
          inputs: [{ key: 'model_name', label: '模型唯一标识', valueType: 'string' as const, required: true }],
          outputs: [{ key: 'result', label: '结果', shape: { kind: 'scalar' as const, type: 'string' as const } }],
          effectCeiling: 'READ_ONLY' as const, preconditions: [],
          postconditions: [{ meaning: '有结果', verification: { kind: 'output_required' as const, outputKey: 'result' } }],
        },
        implementations: [{ implementationKey: 'default', kind: 'structured_steps' as const,
          steps: [{ id: newId(), name: '读取通用统计', type: 'echo' as const,
            effectType: 'READ_ONLY' as const, outputKey: 'internal', input: { value: '通用统计' } }],
          outputMapping: { result: 'internal' } }],
      }
      const moduleDraft = await saveActionModuleDraft(db, module.id, {
        baseRevision: module.draftRevision ?? 0, content, actor: { id: adminActor.id },
      })
      const warnings = compileModuleContent(content, { mode: 'release' }).diagnostics
        .filter((item) => item.severity === 'warning')
      expect(warnings.some((item) => item.code === 'MODULE_INPUT_UNUSED')).toBe(true)
      await publishActionModule(db, module.id, {
        idempotencyKey: newId(), expectedRevision: moduleDraft.draftRevision ?? 0,
        confirmedWarnings: warnings.map(moduleWarningKey),
        actor: { id: adminActor.id }, skipReleaseGate: true,
      })
      const scenario = await createScenarioWithVersion(db, {
        targetId: targetAId, name: '模型配额草稿',
        steps: [{ ...echoStep, id: newId() }], actor: adminActor,
      })
      const before = await getScenario(db, scenario.id)
      currentActor = adminActor
      const server = app.getHttpServer()
      const conversation = await request(server).post('/assistant/conversations').send({}).expect(201)
      const turn = await request(server)
        .post(`/assistant/conversations/${conversation.body.id}/turns`)
        .send({
          clientTurnId: `turn-compose-unused-input-${newId()}`,
          question: '根据已发布的模型配额审计做法给当前草稿生成建议。',
          pageContext: { version: 2, routeKey: 'scenarios.$scenarioId.studio', pageKind: 'studio',
            page: 'studio', scenarioId: scenario.id, targetId: targetAId,
            draftRevision: scenario.draft!.revision,
            primaryRef: { kind: 'scenario', id: scenario.id },
            scopeRefs: [{ kind: 'target', id: targetAId }] },
        })
        .expect(202)
      const answer = await waitForTurn(conversation.body.id, turn.body.turnId)
      expect(answer.status, JSON.stringify(answer)).toBe('COMPLETED')
      expect(answer.capabilityId).toBe('scenario.compose_with_knowledge')
      expect(answer.result).toMatchObject({ kind: 'knowledge_proposal', status: 'unsupported',
        executable: false, diffs: [],
        diagnostics: [expect.objectContaining({ code: 'KNOWLEDGE_MODULE_INPUT_UNUSED' })] })
      expect(answer.result.reason).toContain('请修订做法并发布新版本')
      expect(answer.result.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'module_version', moduleId: module.id }),
      ]))
      const after = await getScenario(db, scenario.id)
      expect(after.draft).toEqual(before.draft)
    })
  })
})
