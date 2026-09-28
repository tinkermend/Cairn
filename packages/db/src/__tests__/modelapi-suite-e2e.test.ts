import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  suiteDocumentSchema,
  validateStageDependencies,
  signReportToken,
  verifyReportToken,
  type ScenarioOutputDecl,
  type Step,
  type SuiteStage,
} from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  advanceSuiteRun,
  createScenarioWithVersion,
  createSuite,
  createSuiteRun,
  getSuiteRunObservation,
  publishSuite,
  rerunSuiteItem,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { generateDueSuiteReports } from '../reports/automatic.js'
import { getReport, loadReportRevisionDocument } from '../reports/reports.js'
import { settleRunOutput } from '../runs/output.js'

describe.each(DRIVERS)('%s modelapi中转站 - 场景集4阶段全链路端到端验收', { timeout: 90_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `modelapi_suite_${Date.now().toString(36)}`)
    const { consoleAccounts, consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'modelapi-admin',
      email: `admin-${actorId}@modelapi.im`,
      status: 'active',
    })
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db.insert(consoleAccountRoles).values({
      consoleAccountId: actorId,
      consoleRoleId: admin!.id,
      targetScopeMode: 'all',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function seedModelApiTarget(accountSessionMode: 'exclusive' | 'concurrent' = 'exclusive', maxConcurrentSessions = 1) {
    const { targets, targetAccounts } = schemaFor(handle.db)
    const targetId = newId()
    await handle.db.insert(targets).values({
      id: targetId,
      code: `modelapi-${targetId}`,
      name: 'modelapi中转站',
      entryUrl: 'https://modelapi.im/dashboard',
      status: 'active',
      sessionPolicy: {
        accountSessionMode,
      },
    })

    const targetAccountId = newId()
    await handle.db.insert(targetAccounts).values({
      id: targetAccountId,
      targetId,
      username: 'tinkermend@gmail.com',
      displayName: '模型中转主账号',
      status: 'active',
      maxConcurrentSessions,
    })

    // 场景 1: 环境探活与 SessionToken 生成（阶段 1）
    // 编译器要求业务输出引用的每个变量都能追溯到某个步骤的 outputKey；
    // 测试本身通过直接写 runs.context 来模拟执行结果（见下方 settleRunOutput 前的 update），
    // 这两个 echo 步骤只用于让编译通过，其字面值不参与断言。
    const step1: Step = {
      id: newId(),
      name: '访问仪表盘',
      type: 'navigate',
      effectType: 'READ_ONLY',
      input: { url: 'https://modelapi.im/dashboard' },
    }
    const step1Latency: Step = {
      id: newId(),
      name: '记录网络延迟',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { value: 0 },
      outputKey: 'apiLatency',
    }
    const step1Token: Step = {
      id: newId(),
      name: '生成 SessionToken',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { value: '' },
      outputKey: 'sessionToken',
    }
    const outputDecl1: ScenarioOutputDecl = {
      summaryTemplate: '环境探活成功，生成 SessionToken ${sessionToken}',
      metrics: [
        { key: 'latency_ms', name: '网络延迟', fromContextKey: 'apiLatency', unit: 'ms' },
      ],
      dataRowFields: [
        { columnKey: 'session_token', columnHeader: 'Token', fromContextKey: 'sessionToken' },
      ],
    }
    const scAuth = await createScenarioWithVersion(handle.db, {
      targetId,
      name: 'modelapi中转站-环境探活与SessionToken生成',
      steps: [step1, step1Latency, step1Token],
      outputs: outputDecl1,
      actor: { id: actorId },
    })

    // 场景 2: 模型列表与配额巡检（阶段 2）
    const step2: Step = {
      id: newId(),
      name: '获取模型与余额',
      type: 'navigate',
      effectType: 'READ_ONLY',
      input: { url: 'https://modelapi.im/models' },
    }
    const step2ModelCount: Step = {
      id: newId(),
      name: '记录可用模型数',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { value: 0 },
      outputKey: 'modelCount',
    }
    const step2Balance: Step = {
      id: newId(),
      name: '记录账户余额',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { value: 0 },
      outputKey: 'balanceUsd',
    }
    const outputDecl2: ScenarioOutputDecl = {
      summaryTemplate: '模型巡检完成，可用模型 ${modelCount} 个，账户余额 $${balanceUsd}',
      metrics: [
        { key: 'model_count', name: '可用模型数', fromContextKey: 'modelCount', unit: '个' },
        { key: 'balance', name: '账户余额', fromContextKey: 'balanceUsd', unit: 'USD' },
      ],
      dataRowFields: [
        { columnKey: 'models', columnHeader: '模型数量', fromContextKey: 'modelCount' },
      ],
    }
    const scQuota = await createScenarioWithVersion(handle.db, {
      targetId,
      name: 'modelapi中转站-模型列表与配额巡检',
      steps: [step2, step2ModelCount, step2Balance],
      outputs: outputDecl2,
      actor: { id: actorId },
    })

    // 场景 3: API限流与高频压测异常检测（阶段 2 负向/异常用例）
    const step3: Step = {
      id: newId(),
      name: '高频并发调用',
      type: 'navigate',
      effectType: 'READ_ONLY',
      input: { url: 'https://modelapi.im/api/v1/chat/completions' },
    }
    const scStress = await createScenarioWithVersion(handle.db, {
      targetId,
      name: 'modelapi中转站-API限流与高频压测异常检测',
      steps: [step3],
      actor: { id: actorId },
    })

    return { targetId, targetAccountId, scAuth, scQuota, scStress }
  }

  it('端到端测试 1 (完整生命周期正向闭环): 多阶段编排 -> 跨阶段变量注入 -> 4级综合报告 -> HMAC分享令牌 -> 局部重跑与报告合流v2', async () => {
    const { targetId, targetAccountId, scAuth, scQuota, scStress } = await seedModelApiTarget('concurrent', 2)

    // 1. 构建符合阶段 4 规范的场景集定义
    const suiteCreated = await createSuite(
      handle.db,
      {
        targetId,
        name: 'modelapi中转站-全链路日常巡检与风控套件',
        document: suiteDocumentSchema.parse({
          schemaVersion: 1,
          defaultTargetAccountId: targetAccountId,
          autoGenerateFinalReport: true,
          groups: [],
          stages: [
            {
              id: 'stage-auth',
              name: '探活与鉴权阶段',
              ordinal: 0,
              executionMode: 'sequential',
              maxConcurrency: 1,
              failurePolicy: 'stop',
              members: [
                {
                  memberId: 'm_auth',
                  ordinal: 0,
                  displayName: '环境探活与Token生成',
                  scenarioId: scAuth.id,
                  scenarioVersionId: scAuth.published!.versionId,
                  targetAccountId,
                  input: {},
                },
              ],
            },
            {
              id: 'stage-inspect',
              name: '业务巡检与风控压测阶段',
              ordinal: 1,
              executionMode: 'parallel',
              maxConcurrency: 2,
              failurePolicy: 'continue',
              members: [
                {
                  memberId: 'm_quota',
                  ordinal: 0,
                  displayName: '模型列表与配额巡检',
                  scenarioId: scQuota.id,
                  scenarioVersionId: scQuota.published!.versionId,
                  targetAccountId,
                  input: {
                    authToken: '${stage[stage-auth].members[m_auth].output.customData.session_token}',
                  },
                },
                {
                  memberId: 'm_stress',
                  ordinal: 1,
                  displayName: 'API限流与高频压测',
                  scenarioId: scStress.id,
                  scenarioVersionId: scStress.published!.versionId,
                  targetAccountId,
                  input: {
                    authToken: '${stage[stage-auth].members[m_auth].output.customData.session_token}',
                  },
                },
              ],
            },
          ],
          members: [],
        }),
      },
      { kind: 'console', id: actorId },
    )

    // 发布场景集
    await publishSuite(
      handle.db,
      suiteCreated.id,
      { expectedRevision: suiteCreated.draft.revision, idempotencyKey: `pub-${suiteCreated.id}` },
      { kind: 'console', id: actorId },
    )

    // 2. 启动场景集运行
    const { observation: initObs } = await createSuiteRun(
      handle.db,
      {
        suiteId: suiteCreated.id,
        idempotencyKey: newId(),
      },
      { kind: 'console', id: actorId },
    )

    expect(initObs.status).toBe('RUNNING')
    expect(initObs.items).toHaveLength(3)

    const mAuthItem = initObs.items.find((i) => i.memberId === 'm_auth')!
    const mQuotaItem = initObs.items.find((i) => i.memberId === 'm_quota')!
    const mStressItem = initObs.items.find((i) => i.memberId === 'm_stress')!

    // 验证 Stage 1 被激活，Stage 2 保持惰性注册 (childRunId = null)
    expect(mAuthItem.stageId).toBe('stage-auth')
    expect(mAuthItem.admission).toBe('ACTIVE')
    expect(mAuthItem.childRunId).toBeTruthy()

    expect(mQuotaItem.stageId).toBe('stage-inspect')
    expect(mQuotaItem.admission).toBe('PENDING')
    expect(mQuotaItem.childRunId).toBeNull()

    expect(mStressItem.stageId).toBe('stage-inspect')
    expect(mStressItem.admission).toBe('PENDING')
    expect(mStressItem.childRunId).toBeNull()

    // 3. 模拟 Stage 1 完成，装配业务输出 (Output Contract 契约结算)
    const { runs } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        outcomeStatus: 'PASS',
        evidenceStatus: 'COMPLETE',
        finishedAt: new Date(),
        context: {
          sessionToken: 'sess_modelapi_8848',
          apiLatency: 120,
        },
      })
      .where(eq(runs.id, mAuthItem.childRunId!))

    // 结算 Run 业务输出
    const authOutput = await settleRunOutput(handle.db, mAuthItem.childRunId!)
    expect(authOutput).toBeTruthy()
    expect(authOutput!.status).toBe('NORMAL')
    expect(authOutput!.summary).toContain('生成 SessionToken sess_modelapi_8848')
    expect(authOutput!.metrics.latency_ms).toBe(120)
    expect(authOutput!.dataRow.session_token).toBe('sess_modelapi_8848')

    // 4. 推进场景集: Stage 1 结算，Stage 2 惰性激活并跨阶段插值
    const stage2Obs = await advanceSuiteRun(handle.db, initObs.id)
    expect(stage2Obs.status).toBe('RUNNING')

    const activeQuota = stage2Obs.items.find((i) => i.memberId === 'm_quota')!
    const activeStress = stage2Obs.items.find((i) => i.memberId === 'm_stress')!

    expect(activeQuota.admission).toBe('ACTIVE')
    expect(activeQuota.childRunId).toBeTruthy()
    expect(activeStress.admission).toBe('ACTIVE')
    expect(activeStress.childRunId).toBeTruthy()

    // 检查 Stage 2 产生的子 Run 是否成功注入变量
    const [quotaRun] = await handle.db.select().from(runs).where(eq(runs.id, activeQuota.childRunId!))
    const quotaSnapshot = quotaRun!.snapshot as any
    expect(quotaSnapshot.input.authToken).toBe('sess_modelapi_8848')

    const [stressRun] = await handle.db.select().from(runs).where(eq(runs.id, activeStress.childRunId!))
    const stressSnapshot = stressRun!.snapshot as any
    expect(stressSnapshot.input.authToken).toBe('sess_modelapi_8848')

    // 5. 模拟 Stage 2 执行结果: m_quota 成功，m_stress 抛出业务异常 Finding
    await handle.db
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        outcomeStatus: 'PASS',
        evidenceStatus: 'COMPLETE',
        finishedAt: new Date(),
        context: {
          modelCount: 18,
          balanceUsd: 245.5,
        },
      })
      .where(eq(runs.id, activeQuota.childRunId!))
    await settleRunOutput(handle.db, activeQuota.childRunId!)

    // m_stress 触发 429 限流异常
    await handle.db
      .update(runs)
      .set({
        status: 'FAILED',
        outcomeStatus: 'FAIL',
        evidenceStatus: 'COMPLETE',
        finishedAt: new Date(),
        context: {
          errorDetail: 'HTTP 429 Too Many Requests',
        },
      })
      .where(eq(runs.id, activeStress.childRunId!))
    const stressOutput = await settleRunOutput(handle.db, activeStress.childRunId!)
    expect(stressOutput!.status).toBe('ANOMALOUS')
    expect(stressOutput!.findings.length).toBeGreaterThanOrEqual(1)

    // 6. 推进场景集至全量终态
    const settledSuiteObs = await advanceSuiteRun(handle.db, initObs.id)
    expect(settledSuiteObs.status).toBe('COMPLETED')
    expect(settledSuiteObs.verdict).toBe('anomalies_found')

    // 7. 自动生成综合巡检总报告 (Report Revision 1)
    const generatedCount = await generateDueSuiteReports(handle.db)
    expect(generatedCount).toBeGreaterThanOrEqual(1)

    // 读取生成的总报告并校验 4 层架构
    const { suiteReportTriggers } = schemaFor(handle.db)
    const [trigger] = await handle.db.select().from(suiteReportTriggers).where(eq(suiteReportTriggers.suiteRunId, initObs.id))
    expect(trigger?.status).toBe('created')
    expect(trigger?.reportId).toBeTruthy()

    const reportDto = await getReport(handle.db, trigger!.reportId!, actorId)
    expect(reportDto.currentRevision?.revisionNo).toBe(1)

    const revDoc = await loadReportRevisionDocument(handle.db, reportDto.currentRevision!.id)
    const summaryBlock = revDoc.revision.document!.sections[0]?.blocks[0] as any
    expect(summaryBlock.type).toBe('suite_business_summary')

    // L0: 扣分制健康分核验（存在 1 个异常项扣 20 分，满分 100）
    expect(summaryBlock.totalCount).toBe(3)
    expect(summaryBlock.anomalousCount).toBe(1)
    expect(summaryBlock.normalCount).toBe(2)
    expect(summaryBlock.healthScore).toBeLessThan(100)

    // L1: 6 列巡检大宽表核验
    expect(summaryBlock.gridRows).toHaveLength(3)
    const quotaGridRow = summaryBlock.gridRows.find((r: any) => r.memberId === 'm_quota')!
    expect(quotaGridRow.metrics.model_count).toBe(18)
    expect(quotaGridRow.metrics.balance).toBe(245.5)

    // L2: 异常画廊核验
    expect(summaryBlock.aggregatedFindings.length).toBeGreaterThanOrEqual(1)
    expect(summaryBlock.aggregatedFindings[0].severity).toBe('HIGH')

    // 8. 校验免登录只读安全链接 HMAC-SHA256 Token 签名与验签
    const jwtSecret = 'test_secret_for_modelapi_verification_8848'
    const exp = Math.floor(Date.now() / 1000) + 3600
    const signedToken = await signReportToken(
      {
        suiteRunId: initObs.id,
        reportRevisionId: reportDto.currentRevision!.id,
        scope: 'readonly_report',
        exp,
      },
      jwtSecret,
    )
    expect(signedToken).toContain('.')

    // 验证合法 Token 能被正确解码
    const verified = await verifyReportToken(signedToken, jwtSecret)
    expect(verified.suiteRunId).toBe(initObs.id)
    expect(verified.scope).toBe('readonly_report')

    // 9. 局部重跑核心闭环: 只重跑失败成员 m_stress
    const rerunResult = await rerunSuiteItem(
      handle.db,
      {
        suiteRunId: initObs.id,
        memberId: 'm_stress',
      },
      { kind: 'console', id: actorId },
    )
    expect(rerunResult.runId).toBeTruthy()
    expect(rerunResult.suiteRun.status).toBe('RUNNING')

    const rerunItem = rerunResult.suiteRun.items.find((i) => i.memberId === 'm_stress')!
    expect(rerunItem.rerunCount).toBe(1)
    expect(rerunItem.originalRunId).toBe(activeStress.childRunId)
    expect(rerunItem.childRunId).toBe(rerunResult.runId)

    // 10. 重跑子 Run 成功通过
    await handle.db
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        outcomeStatus: 'PASS',
        evidenceStatus: 'COMPLETE',
        finishedAt: new Date(),
        context: {
          stressTestStatus: 'PASS',
          qpsAchieved: 50,
        },
      })
      .where(eq(runs.id, rerunResult.runId))
    await settleRunOutput(handle.db, rerunResult.runId)

    // 推进场景集完成
    const finalSuiteObs = await advanceSuiteRun(handle.db, initObs.id)
    expect(finalSuiteObs.status).toBe('COMPLETED')
    expect(finalSuiteObs.verdict).toBe('all_pass')

    // 11. 校验 ReportRevision 自动合流升级为 Revision 2
    const updatedReport = await getReport(handle.db, trigger!.reportId!, actorId)
    expect(updatedReport.currentRevision?.revisionNo).toBe(2)
    const rev2Doc = await loadReportRevisionDocument(handle.db, updatedReport.currentRevision!.id)
    const rev2SummaryBlock = rev2Doc.revision.document!.sections[0]?.blocks[0] as any

    // 全量通过，健康分恢复为满分 100 分
    expect(rev2SummaryBlock.healthScore).toBe(100)
    expect(rev2SummaryBlock.anomalousCount).toBe(0)
    expect(rev2SummaryBlock.normalCount).toBe(3)
  })

  it('端到端测试 2 (静态拓扑依赖校验负向用例): 拦截前向依赖、同阶段依赖与无效成员', async () => {
    // 跨阶段非法前向引用 (Stage 0 引用 Stage 1 的变量)
    const forwardInvalidStages = [
      {
        id: 'stage-1',
        name: '阶段一',
        ordinal: 0,
        executionMode: 'parallel' as const,
        maxConcurrency: 1,
        failurePolicy: 'stop' as const,
        members: [
          {
            memberId: 'm1',
            ordinal: 0,
            displayName: '非法引用后置变量',
            scenarioId: newId(),
            scenarioVersionId: newId(),
            input: {
              data: '${stage[stage-2].members[m2].output.token}',
            },
          },
        ],
      },
      {
        id: 'stage-2',
        name: '阶段二',
        ordinal: 1,
        executionMode: 'parallel' as const,
        maxConcurrency: 1,
        failurePolicy: 'continue' as const,
        members: [
          {
            memberId: 'm2',
            ordinal: 0,
            displayName: '后置成员',
            scenarioId: newId(),
            scenarioVersionId: newId(),
            input: {},
          },
        ],
      },
    ]

    const forwardErrors = validateStageDependencies(forwardInvalidStages)
    expect(forwardErrors.some((e) => e.code === 'FORWARD_STAGE_VARIABLE_FORBIDDEN')).toBe(true)

    // 同阶段内互相引用（禁止 Stage 内部直接隐式依赖）
    const intraInvalidStages: SuiteStage[] = [
      {
        id: 'stage-1',
        name: '阶段一',
        ordinal: 0,
        executionMode: 'parallel' as const,
        maxConcurrency: 2,
        failurePolicy: 'stop' as const,
        members: [
          {
            memberId: 'm1',
            ordinal: 0,
            displayName: '产生者',
            scenarioId: newId(),
            scenarioVersionId: newId(),
            input: {},
          },
          {
            memberId: 'm2',
            ordinal: 1,
            displayName: '同阶段消费者',
            scenarioId: newId(),
            scenarioVersionId: newId(),
            input: {
              token: '${stage[stage-1].members[m1].output.token}',
            },
          },
        ],
      },
    ]

    const intraErrors = validateStageDependencies(intraInvalidStages)
    expect(intraErrors.some((e) => e.code === 'INTRA_STAGE_VARIABLE_FORBIDDEN')).toBe(true)

    // 引用不存在的 Stage
    const notFoundStages = [
      {
        id: 'stage-1',
        name: '阶段一',
        ordinal: 0,
        executionMode: 'parallel' as const,
        maxConcurrency: 1,
        failurePolicy: 'stop' as const,
        members: [
          {
            memberId: 'm1',
            ordinal: 0,
            displayName: '引用虚无',
            scenarioId: newId(),
            scenarioVersionId: newId(),
            input: {
              token: '${stage[stage-non-existent].members[m_ghost].output.token}',
            },
          },
        ],
      },
    ]

    const notFoundErrors = validateStageDependencies(notFoundStages)
    expect(notFoundErrors.some((e) => e.code === 'STAGE_NOT_FOUND')).toBe(true)
  })

  it('端到端测试 3 (熔断策略 failurePolicy: stop 负向用例): 阶段一失败自动熔断后续阶段', async () => {
    const { targetId, targetAccountId, scAuth, scQuota } = await seedModelApiTarget()

    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: 'modelapi中转站-熔断验证套件',
        document: suiteDocumentSchema.parse({
          schemaVersion: 1,
          groups: [],
          stages: [
            {
              id: 'stage-critical',
              name: '关键探活阶段',
              ordinal: 0,
              executionMode: 'sequential',
              maxConcurrency: 1,
              failurePolicy: 'stop',
              members: [
                {
                  memberId: 'm_crit',
                  ordinal: 0,
                  displayName: '网关健康检查',
                  scenarioId: scAuth.id,
                  scenarioVersionId: scAuth.published!.versionId,
                  targetAccountId,
                  input: {},
                },
              ],
            },
            {
              id: 'stage-subsequent',
              name: '后置业务阶段',
              ordinal: 1,
              executionMode: 'parallel',
              maxConcurrency: 2,
              failurePolicy: 'continue',
              members: [
                {
                  memberId: 'm_sub',
                  ordinal: 0,
                  displayName: '后续查询',
                  scenarioId: scQuota.id,
                  scenarioVersionId: scQuota.published!.versionId,
                  targetAccountId,
                  input: {},
                },
              ],
            },
          ],
          members: [],
        }),
      },
      { kind: 'console', id: actorId },
    )

    await publishSuite(handle.db, created.id, { expectedRevision: created.draft.revision, idempotencyKey: `pub-${created.id}` }, { kind: 'console', id: actorId })

    const { observation: runObs } = await createSuiteRun(handle.db, { suiteId: created.id, idempotencyKey: newId() }, { kind: 'console', id: actorId })
    const critItem = runObs.items.find((i) => i.memberId === 'm_crit')!

    // 阶段一执行失败
    const { runs } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({
        status: 'FAILED',
        outcomeStatus: 'FAIL',
        evidenceStatus: 'COMPLETE',
        finishedAt: new Date(),
      })
      .where(eq(runs.id, critItem.childRunId!))
    await settleRunOutput(handle.db, critItem.childRunId!)

    // 推进场景集
    const advancedObs = await advanceSuiteRun(handle.db, runObs.id)
    expect(advancedObs.status).toBe('COMPLETED')
    expect(advancedObs.verdict).toBe('anomalies_found')

    // 验证 Stage 2 的成员由于 failurePolicy: stop 被标记为 SKIPPED，并且永远没有创建子 Run
    const subItem = advancedObs.items.find((i) => i.memberId === 'm_sub')!
    expect(subItem.admission).toBe('SKIPPED')
    expect(subItem.skipReason).toBe('failure_policy_stop')
    expect(subItem.childRunId).toBeNull()
  })

  it('端到端测试 4 (独占账号互斥并发控制守卫 Account Mutex Guard): 限制同一独占账号在并发阶段的排队放行', async () => {
    // 设置 accountSessionMode 为 'exclusive'
    const { targetId, targetAccountId, scAuth, scQuota } = await seedModelApiTarget('exclusive')

    const created = await createSuite(
      handle.db,
      {
        targetId,
        name: 'modelapi中转站-账号排他并发守卫套件',
        document: suiteDocumentSchema.parse({
          schemaVersion: 1,
          groups: [],
          stages: [
            {
              id: 'stage-parallel-same-account',
              name: '并行同账号阶段',
              ordinal: 0,
              executionMode: 'parallel',
              maxConcurrency: 3,
              failurePolicy: 'continue',
              members: [
                {
                  memberId: 'm_acc_1',
                  ordinal: 0,
                  displayName: '巡检1',
                  scenarioId: scAuth.id,
                  scenarioVersionId: scAuth.published!.versionId,
                  targetAccountId,
                  input: {},
                },
                {
                  memberId: 'm_acc_2',
                  ordinal: 1,
                  displayName: '巡检2',
                  scenarioId: scQuota.id,
                  scenarioVersionId: scQuota.published!.versionId,
                  targetAccountId,
                  input: {},
                },
              ],
            },
          ],
          members: [],
        }),
      },
      { kind: 'console', id: actorId },
    )

    await publishSuite(handle.db, created.id, { expectedRevision: created.draft.revision, idempotencyKey: `pub-${created.id}` }, { kind: 'console', id: actorId })

    const { observation } = await createSuiteRun(handle.db, { suiteId: created.id, idempotencyKey: newId() }, { kind: 'console', id: actorId })

    const item1 = observation.items.find((i) => i.memberId === 'm_acc_1')!
    const item2 = observation.items.find((i) => i.memberId === 'm_acc_2')!

    // 尽管 maxConcurrency 为 3，但同一账号由于 exclusive 互斥锁，第一项 ACTIVE，第二项必须保持 PENDING 排队！
    expect(item1.admission).toBe('ACTIVE')
    expect(item2.admission).toBe('PENDING')

    // 模拟第一项完成
    const { runs } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        outcomeStatus: 'PASS',
        evidenceStatus: 'COMPLETE',
        finishedAt: new Date(),
      })
      .where(eq(runs.id, item1.childRunId!))
    await settleRunOutput(handle.db, item1.childRunId!)

    // 推进场景集，第二项获得账号许可并转为 ACTIVE
    const nextObs = await advanceSuiteRun(handle.db, observation.id)
    const nextItem2 = nextObs.items.find((i) => i.memberId === 'm_acc_2')!
    expect(nextItem2.admission).toBe('ACTIVE')
  })

  it('端到端测试 5 (HMAC免登录只读分享令牌安全边界负向用例): 拦截伪造、篡改与过期令牌', async () => {
    const secret = 'strong_system_hmac_secret_key_8848'
    const nowSec = Math.floor(Date.now() / 1000)

    // 1. 过期令牌
    const expiredToken = await signReportToken(
      {
        suiteRunId: newId(),
        reportRevisionId: newId(),
        scope: 'readonly_report',
        exp: nowSec - 60, // 1分钟前过期
      },
      secret,
    )
    await expect(verifyReportToken(expiredToken, secret)).rejects.toThrow('TOKEN_EXPIRED')

    // 2. 篡改签名令牌
    const validToken = await signReportToken(
      {
        suiteRunId: newId(),
        reportRevisionId: newId(),
        scope: 'readonly_report',
        exp: nowSec + 3600,
      },
      secret,
    )
    const tamperedSigToken = `${validToken}tampered`
    await expect(verifyReportToken(tamperedSigToken, secret)).rejects.toThrow('INVALID_TOKEN_SIGNATURE')

    // 3. 错误密钥验签
    await expect(verifyReportToken(validToken, 'wrong_secret_key')).rejects.toThrow('INVALID_TOKEN_SIGNATURE')

    // 4. 畸形格式令牌
    await expect(verifyReportToken('bad-token-without-dot', secret)).rejects.toThrow('INVALID_TOKEN_FORMAT')
  })
})
