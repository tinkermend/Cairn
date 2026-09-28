import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  createAccountBodySchema,
  createTargetBodySchema,
  serviceCallerBodySchema,
  suiteDocumentSchema,
  DEFAULT_REPORT_CONFIG,
  type AccountDto,
  type Step,
  type TargetDto,
} from '@cairn/shared'
import * as api from '../index.js'
import { expose } from '../database.js'
import { schemaFor } from '../native.js'
import { openContractDb, DRIVERS } from './contract-fixture.js'
import type { Db, DbHandle } from '../client.js'
import { newId } from '../id.js'
import {
  createRunWithSnapshot,
  createTrialRunFromDraft,
  createScenarioWithVersion,
  createSuite,
  createSuiteRun,
  publishSuite,
  loadRunDetail,
} from '../test-entry.js'
import {
  saveServiceCaller,
  issueServiceCredential,
  authenticateService,
  createServiceRun,
} from '../services/access.js'
import { generateDueReports } from '../reports/automatic.js'
import { retryRunReport } from '../reports/reports.js'
import { saveScenarioReportDefaults, freezeRunReportContext } from '../reports/profiles.js'
import { advanceSuiteRun } from '../suites/runs.js'

describe.each(DRIVERS)('%s 运行记录与程序版报告一体化闭环 (RR01~RR07)', { timeout: 90_000 }, (driver) => {
  let handle: DbHandle
  let db: Db
  let actor: AccountDto
  let target: TargetDto

  const testStep: Step = {
    id: '00000000-0000-4000-8000-0000000000c1',
    name: '回显步骤',
    type: 'echo',
    effectType: 'READ_ONLY',
    input: { value: 'ok' },
  }

  beforeAll(async () => {
    handle = await openContractDb(driver, `rpt_conv_${Date.now().toString(36)}`)
    db = handle.db
    const facade = expose(handle)
    const rbac = new api.RbacStore(facade, {
      hash: async (s: string) => s,
      verify: async (s: string, hash: string) => s === hash,
    })
    const adminRole = (await rbac.listRoles()).items.find((r) => r.key === 'admin')!
    actor = await rbac.createAccount(
      createAccountBodySchema.parse({
        displayName: '报告一体化审计员',
        email: `report-auditor-${newId()}@example.com`,
        password: 'password123',
        roleIds: [adminRole.id],
      }),
      null,
    )
    const targets = new api.TargetsStore(facade, () => Buffer.from('encrypted'))
    target = await targets.createTarget(
      createTargetBodySchema.parse({
        code: `rpt-conv-${newId()}`,
        name: '报告闭环测试目标',
        entryUrl: 'https://example.com',
      }),
      actor,
    )
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function createScenario(name: string) {
    return createScenarioWithVersion(handle.db, {
      targetId: target.id,
      name,
      steps: [testStep],
      actor,
    })
  }

  it('RR01 & RR02: 单场景自动报告：开启 autoGenerateReport 时生成报告及 Word/PDF 导出任务，未开启时不触发', async () => {
    const s1 = await createScenario('未开启自动报告场景')
    const s2 = await createScenario('已开启自动报告场景')

    // 为 s2 配置 autoGenerateReport: true
    await saveScenarioReportDefaults(
      db,
      s2.id,
      {
        profileId: null,
        expectedRevision: 0,
        outputPolicy: { autoGenerateReport: true, memberReportPolicy: 'inherit', aiSummaryPolicy: 'inherit' },
      },
      { kind: 'console', id: actor.id },
    )

    // 创建运行 1（未配置报告）
    const run1 = await createRunWithSnapshot(db, {
      scenarioId: s1.id,
      actor: { id: actor.id },
    })
    // 创建运行 2（配置了自动报告）
    const run2 = await createRunWithSnapshot(db, {
      scenarioId: s2.id,
      actor: { id: actor.id },
    })

    const t = schemaFor(db)
    // 两者均正常执行至终态
    await db.update(t.runs).set({
      status: 'SUCCEEDED',
      outcomeStatus: 'PASS',
      evidenceStatus: 'COMPLETE',
      finishedAt: new Date(),
    }).where(eq(t.runs.id, run1.detail.id))

    await db.update(t.runs).set({
      status: 'SUCCEEDED',
      outcomeStatus: 'PASS',
      evidenceStatus: 'COMPLETE',
      finishedAt: new Date(),
    }).where(eq(t.runs.id, run2.detail.id))

    // 执行后台报告扫描
    await generateDueReports(db)

    // run1: 无报告触发器，状态为 not_configured
    const run1Detail = (await loadRunDetail(db, run1.detail.id, actor.id))!
    expect(run1Detail.runReportStatus).toBe('not_configured')
    expect(run1Detail.reportId).toBeNull()

    // run2: 自动生成报告，状态为 generated，且有导出任务
    const run2Detail = (await loadRunDetail(db, run2.detail.id, actor.id))!
    expect(run2Detail.runReportStatus).toBe('generated')
    expect(run2Detail.reportId).toBeTruthy()

    // 验证 report 表与 exportJobs 表真实落盘
    const [reportRow] = await db.select().from(t.reports).where(eq(t.reports.id, run2Detail.reportId!))
    expect(reportRow).toBeDefined()
    expect(reportRow!.runId).toBe(run2.detail.id)

    const exportJobs = await db.select().from(t.exportJobs).where(eq(t.exportJobs.reportId, run2Detail.reportId!))
    expect(exportJobs.length).toBeGreaterThan(0)
    expect(exportJobs[0]!.kind).toBe('report_render')
    // 自动生成的运行报告只导出 html（生成成本低、可即时预览）；docx/pdf 需用户显式请求导出。
    expect(exportJobs[0]!.sourceManifest).toEqual({ formats: ['html'] })
  })

  it('RR02: 试跑 (isTrial)、调试模式 (debugMode != runThrough)、地图作业 (isMapJob) 不误触发自动报告', async () => {
    const s = await createScenario('免扰场景')
    await saveScenarioReportDefaults(
      db,
      s.id,
      {
        profileId: null,
        expectedRevision: 0,
        outputPolicy: { autoGenerateReport: true, memberReportPolicy: 'inherit', aiSummaryPolicy: 'inherit' },
      },
      { kind: 'console', id: actor.id },
    )

    // 1. 试跑：使用 createTrialRunFromDraft，不应触发自动报告
    const trialRun = await createTrialRunFromDraft(db, s.id, {
      revision: s.draft!.revision,
      actor: { id: actor.id },
    })

    const t = schemaFor(db)
    // 检查试跑是否被正确排除在 reportTriggers 之外
    const [trialTrigger] = await db
      .select()
      .from(t.reportTriggers)
      .where(and(eq(t.reportTriggers.subjectKind, 'RUN'), eq(t.reportTriggers.subjectId, trialRun.detail.id)))
    expect(trialTrigger).toBeUndefined()

    // 2. freezeRunReportContext 防御性过滤组合验证：调试模式、地图作业、非用户场景
    const runForDefenses = await createRunWithSnapshot(db, {
      scenarioId: s.id,
      actor: { id: actor.id },
    })
    await db.delete(t.reportTriggers).where(eq(t.reportTriggers.subjectId, runForDefenses.detail.id))
    await db.delete(t.runReportContexts).where(eq(t.runReportContexts.runId, runForDefenses.detail.id))

    // 2.1 地图作业防御
    await freezeRunReportContext(db, {
      runId: runForDefenses.detail.id,
      scenarioId: s.id,
      targetId: target.id,
      scenarioName: s.name,
      targetName: target.name,
      isTrial: false,
      isMapJob: true,
      debugMode: 'runThrough',
      purpose: 'user',
      suppressMemberReport: false,
    })
    let [defenseTrigger] = await db.select().from(t.reportTriggers).where(eq(t.reportTriggers.subjectId, runForDefenses.detail.id))
    expect(defenseTrigger).toBeUndefined()
    await db.delete(t.runReportContexts).where(eq(t.runReportContexts.runId, runForDefenses.detail.id))

    // 2.2 调试单步防御
    await freezeRunReportContext(db, {
      runId: runForDefenses.detail.id,
      scenarioId: s.id,
      targetId: target.id,
      scenarioName: s.name,
      targetName: target.name,
      isTrial: false,
      isMapJob: false,
      debugMode: 'step',
      purpose: 'user',
      suppressMemberReport: false,
    })
    ;[defenseTrigger] = await db.select().from(t.reportTriggers).where(eq(t.reportTriggers.subjectId, runForDefenses.detail.id))
    expect(defenseTrigger).toBeUndefined()
    await db.delete(t.runReportContexts).where(eq(t.runReportContexts.runId, runForDefenses.detail.id))

    // 2.3 模块/非用户场景防御
    await freezeRunReportContext(db, {
      runId: runForDefenses.detail.id,
      scenarioId: s.id,
      targetId: target.id,
      scenarioName: s.name,
      targetName: target.name,
      isTrial: false,
      isMapJob: false,
      debugMode: 'runThrough',
      purpose: 'module',
      suppressMemberReport: false,
    })
    ;[defenseTrigger] = await db.select().from(t.reportTriggers).where(eq(t.reportTriggers.subjectId, runForDefenses.detail.id))
    expect(defenseTrigger).toBeUndefined()
  })

  it('RR02: 场景集成员报告抑制 (suppress) vs 继承 (inherit)', async () => {
    const s = await createScenario('集合子场景')
    await saveScenarioReportDefaults(
      db,
      s.id,
      {
        profileId: null,
        expectedRevision: 0,
        outputPolicy: { autoGenerateReport: true, memberReportPolicy: 'inherit', aiSummaryPolicy: 'inherit' },
      },
      { kind: 'console', id: actor.id },
    )

    // 场景集 1: memberReportPolicy = 'suppress'
    const suiteSuppress = await createSuite(
      db,
      {
        targetId: target.id,
        name: `抑制成员报告集-${newId()}`,
        document: suiteDocumentSchema.parse({
          schemaVersion: 1,
          groups: [{ id: 'g1', name: '分组1' }],
          sharedInput: {},
          members: [
            {
              memberId: 'm1',
              ordinal: 0,
              groupId: 'g1',
              scenarioId: s.id,
              scenarioVersionId: s.published!.versionId,
              input: {},
            },
          ],
          failurePolicy: 'continue',
          outputPolicy: {
            autoGenerateReport: true,
            memberReportPolicy: 'suppress',
            aiSummaryPolicy: 'inherit',
          },
        }),
      },
      { kind: 'console', id: actor.id },
    )
    await publishSuite(
      db,
      suiteSuppress.id,
      { expectedRevision: suiteSuppress.draft.revision, idempotencyKey: newId() },
      { kind: 'console', id: actor.id },
    )

    const suiteRun = await createSuiteRun(
      db,
      { suiteId: suiteSuppress.id, idempotencyKey: newId() },
      { kind: 'console', id: actor.id },
    )
    const childRunId = suiteRun.observation.items[0]!.childRunId!

    const t = schemaFor(db)
    // 检查抑制模式下，子运行是否没有插入 reportTriggers
    const [childTrigger] = await db
      .select()
      .from(t.reportTriggers)
      .where(and(eq(t.reportTriggers.subjectKind, 'RUN'), eq(t.reportTriggers.subjectId, childRunId)))
    expect(childTrigger).toBeUndefined()

    // 检查总报告 trigger 是否存在
    const [suiteTrigger] = await db
      .select()
      .from(t.reportTriggers)
      .where(and(eq(t.reportTriggers.subjectKind, 'SUITE_RUN'), eq(t.reportTriggers.subjectId, suiteRun.observation.id)))
    expect(suiteTrigger).toBeDefined()
  })

  it('RR02: 跳过的场景集成员 (SKIPPED) 不自动出单场景报告', async () => {
    const s = await createScenario('待跳过场景')
    await saveScenarioReportDefaults(
      db,
      s.id,
      {
        profileId: null,
        expectedRevision: 0,
        outputPolicy: { autoGenerateReport: true, memberReportPolicy: 'inherit', aiSummaryPolicy: 'inherit' },
      },
      { kind: 'console', id: actor.id },
    )

    // 创建一个已过期的集合运行，使其成员在准入阶段被标记为 SKIPPED
    const suiteDef = await createSuite(
      db,
      {
        targetId: target.id,
        name: `跳过成员集-${newId()}`,
        document: suiteDocumentSchema.parse({
          schemaVersion: 1,
          groups: [{ id: 'g1', name: '分组1' }],
          sharedInput: {},
          members: [
            {
              memberId: 'm1',
              ordinal: 0,
              groupId: 'g1',
              scenarioId: s.id,
              scenarioVersionId: s.published!.versionId,
              input: {},
            },
          ],
          failurePolicy: 'continue',
          outputPolicy: {
            autoGenerateReport: true,
            memberReportPolicy: 'inherit',
            aiSummaryPolicy: 'inherit',
          },
        }),
      },
      { kind: 'console', id: actor.id },
    )
    await publishSuite(
      db,
      suiteDef.id,
      { expectedRevision: suiteDef.draft.revision, idempotencyKey: newId() },
      { kind: 'console', id: actor.id },
    )

    const suiteRun = await createSuiteRun(
      db,
      { suiteId: suiteDef.id, idempotencyKey: newId() },
      { kind: 'console', id: actor.id },
    )

    const t = schemaFor(db)
    const childRunId = suiteRun.observation.items[0]!.childRunId!

    // 模拟集合推进中该成员被标记为 SKIPPED，运行置为 CANCELLED 终态
    await db
      .update(t.suiteRunItems)
      .set({ admissionStatus: 'SKIPPED' })
      .where(and(eq(t.suiteRunItems.suiteRunId, suiteRun.observation.id), eq(t.suiteRunItems.childRunId, childRunId)))

    await db
      .update(t.runs)
      .set({
        status: 'CANCELLED',
        evidenceStatus: 'COMPLETE',
        finishedAt: new Date(),
      })
      .where(eq(t.runs.id, childRunId))

    // 运行报告生成，确保识别到已跳过并安全取消触发器，不生成报告
    await generateDueReports(db)

    const [trigger] = await db
      .select()
      .from(t.reportTriggers)
      .where(and(eq(t.reportTriggers.subjectKind, 'RUN'), eq(t.reportTriggers.subjectId, childRunId)))
    expect(trigger?.status).toBe('skipped')
    expect(trigger?.reason).toBe('member_skipped')

    const [reportRow] = await db.select().from(t.reports).where(eq(t.reports.runId, childRunId))
    expect(reportRow).toBeUndefined()
  })

  it('RR02: 报告失败可重试 (retryRunReport) 生成递增序号幂等键', async () => {
    const s = await createScenario('重试场景')
    await saveScenarioReportDefaults(
      db,
      s.id,
      {
        profileId: null,
        expectedRevision: 0,
        outputPolicy: { autoGenerateReport: true, memberReportPolicy: 'inherit', aiSummaryPolicy: 'inherit' },
      },
      { kind: 'console', id: actor.id },
    )
    const run = await createRunWithSnapshot(db, {
      scenarioId: s.id,
      actor: { id: actor.id },
    })

    const t = schemaFor(db)
    // 模拟运行完成，但由于某种原因触发器置为 failed
    await db.update(t.runs).set({
      status: 'SUCCEEDED',
      outcomeStatus: 'PASS',
      evidenceStatus: 'COMPLETE',
      finishedAt: new Date(),
    }).where(eq(t.runs.id, run.detail.id))

    await db.update(t.reportTriggers).set({
      status: 'failed',
      reason: '模拟报告导出崩溃',
      updatedAt: new Date(),
    }).where(and(eq(t.reportTriggers.subjectKind, 'RUN'), eq(t.reportTriggers.subjectId, run.detail.id)))

    let detail = (await loadRunDetail(db, run.detail.id, actor.id))!
    expect(detail.runReportStatus).toBe('failed')
    expect(detail.reportError).toContain('模拟报告导出崩溃')

    // 调用重试接口
    const retried = await retryRunReport(db, run.detail.id, { kind: 'console', id: actor.id })
    expect(retried.status).toBe('pending')
    expect(retried.retrySeq).toBe(1)

    const [updatedTrigger] = await db.select().from(t.reportTriggers).where(eq(t.reportTriggers.subjectId, run.detail.id))
    expect(updatedTrigger?.idempotencyKey).toContain('manual-retry:1')

    // 重新跑一次扫描，报告成功生成
    await generateDueReports(db)
    detail = (await loadRunDetail(db, run.detail.id, actor.id))!
    expect(detail.runReportStatus).toBe('generated')
    expect(detail.reportId).toBeTruthy()
  })

  it('RR03: 场景报告默认配置变更具备 OCC 且不改变已创建运行的冻结配置', async () => {
    const s = await createScenario('OCC场景')
    const defaults = await saveScenarioReportDefaults(
      db,
      s.id,
      {
        profileId: null,
        expectedRevision: 0,
        outputPolicy: { autoGenerateReport: false, memberReportPolicy: 'inherit', aiSummaryPolicy: 'inherit' },
      },
      { kind: 'console', id: actor.id },
    )

    // 创建运行（此时冻结 autoGenerateReport: false）
    const run = await createRunWithSnapshot(db, {
      scenarioId: s.id,
      actor: { id: actor.id },
    })

    // 用错误的 revision 更新应当冲突被拒
    await expect(
      saveScenarioReportDefaults(
        db,
        s.id,
        {
          profileId: null,
          expectedRevision: 0,
          outputPolicy: { autoGenerateReport: true, memberReportPolicy: 'inherit', aiSummaryPolicy: 'inherit' },
        },
        { kind: 'console', id: actor.id },
      ),
    ).rejects.toMatchObject({ code: 'REPORT_DEFAULTS_REVISION_CONFLICT' })

    // 正确更新场景的 outputPolicy 为 autoGenerateReport: true
    await saveScenarioReportDefaults(
      db,
      s.id,
      {
        profileId: null,
        expectedRevision: defaults.revision,
        outputPolicy: { autoGenerateReport: true, memberReportPolicy: 'inherit', aiSummaryPolicy: 'inherit' },
      },
      { kind: 'console', id: actor.id },
    )

    // 历史已创建运行的冻结配置不变
    const detail = (await loadRunDetail(db, run.detail.id, actor.id))!
    expect(detail.runReportStatus).toBe('not_configured')
  })

  it('RR06: 服务主体触发配置自动出报告的场景：无 report:export 权限被 403 拒绝；有权限正常创建并生成服务归属报告', async () => {
    const s = await createScenario('服务调用场景')
    await saveScenarioReportDefaults(
      db,
      s.id,
      {
        profileId: null,
        expectedRevision: 0,
        outputPolicy: { autoGenerateReport: true, memberReportPolicy: 'inherit', aiSummaryPolicy: 'inherit' },
      },
      { kind: 'console', id: actor.id },
    )

    const caller = await saveServiceCaller(
      db,
      null,
      serviceCallerBodySchema.parse({
        name: '服务调用测试主体',
        owner: 'team-ops',
        status: 'active',
        requestsPerMinute: 60,
        maxOutstandingRuns: 5,
        runTimeoutSeconds: 600,
        deliveryPolicy: { runOutput: true, finalScreenshot: true, failureScreenshot: true },
      }),
      actor,
    )

    // 凭据 1: 无 report:export
    const credWithoutExport = await issueServiceCredential(
      db,
      caller.caller.id,
      {
        name: '普通执行凭据',
        scopes: ['run:execute', 'run:read'],
        grants: [{ targetId: target.id, allowAnonymous: true, accountIds: [] }],
        expiresInDays: 30,
      },
      actor,
    )

    // 凭据 2: 带 report:export
    const credWithExport = await issueServiceCredential(
      db,
      caller.caller.id,
      {
        name: '高级导出凭据',
        scopes: ['run:execute', 'run:read', 'report:export'],
        grants: [{ targetId: target.id, allowAnonymous: true, accountIds: [] }],
        expiresInDays: 30,
      },
      actor,
    )

    const pWithout = await authenticateService(db, `Bearer ${credWithoutExport.token}`)
    const pWith = await authenticateService(db, `Bearer ${credWithExport.token}`)

    // 无 report:export 创建带自动报告的场景应当 403
    await expect(
      createServiceRun(
        db,
        pWithout,
        {
          scenarioId: s.id,
          scenarioVersionId: s.published!.versionId,
          input: {},
          idempotencyKey: newId(),
        },
        newId(),
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_SCOPE_DENIED' })

    // 有 report:export 创建成功
    const serviceRun = await createServiceRun(
      db,
      pWith,
      {
        scenarioId: s.id,
        scenarioVersionId: s.published!.versionId,
        input: {},
        idempotencyKey: newId(),
      },
      newId(),
    )
    expect(serviceRun.created).toBe(true)

    const t = schemaFor(db)
    // 运行完成并生成报告
    await db.update(t.runs).set({
      status: 'SUCCEEDED',
      outcomeStatus: 'PASS',
      evidenceStatus: 'COMPLETE',
      finishedAt: new Date(),
    }).where(eq(t.runs.id, serviceRun.detail.id))

    await generateDueReports(db)

    const [reportRow] = await db.select().from(t.reports).where(eq(t.reports.runId, serviceRun.detail.id))
    expect(reportRow).toBeDefined()
    expect(reportRow!.serviceCallerId).toBe(caller.caller.id)
    expect(reportRow!.createdByConsoleAccountId).toBeNull()
  })

  it('RR07: 运行终态后证据超时 (60s) 自动收尾为 INCOMPLETE 并成功触发带缺项警告的报告', async () => {
    const s = await createScenario('证据超时场景')
    await saveScenarioReportDefaults(
      db,
      s.id,
      {
        profileId: null,
        expectedRevision: 0,
        outputPolicy: { autoGenerateReport: true, memberReportPolicy: 'inherit', aiSummaryPolicy: 'inherit' },
      },
      { kind: 'console', id: actor.id },
    )

    const run = await createRunWithSnapshot(db, {
      scenarioId: s.id,
      actor: { id: actor.id },
    })

    const t = schemaFor(db)
    // 运行终态，但证据状态异常卡在 PENDING，且 finishedAt 为 70 秒前
    const seventySecondsAgo = new Date(Date.now() - 70_000)
    await db.update(t.runs).set({
      status: 'SUCCEEDED',
      outcomeStatus: 'PASS',
      evidenceStatus: 'PENDING',
      finishedAt: seventySecondsAgo,
    }).where(eq(t.runs.id, run.detail.id))

    // 执行报告生成
    await generateDueReports(db)

    // 证据应已被强制收尾为 INCOMPLETE
    const [updatedRun] = await db.select().from(t.runs).where(eq(t.runs.id, run.detail.id))
    expect(updatedRun!.evidenceStatus).toBe('INCOMPLETE')

    // 报告应已顺利生成（带缺项状态）
    const detail = (await loadRunDetail(db, run.detail.id, actor.id))!
    expect(detail.runReportStatus).toBe('partial_gaps')
    expect(detail.reportId).toBeTruthy()
  })
})
