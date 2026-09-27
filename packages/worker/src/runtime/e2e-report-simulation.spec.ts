import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  openIsolatedDb,
  type DbHandle,
  and,
  eq,
  newId,
  schemaFor,
  createRunWithSnapshot,
  createScenarioWithVersion,
  createSuite,
  publishSuite,
  createSuiteRun,
  createReport,
  createReportRevision,
  getReport,
  claimReportAiJobs,
  renewReportAiJob,
  completeReportAiJob,
  createReportAiRevision,
  sealReportAiRevision,
  retryReportAiJob,
  getLatestHtmlReportArtifact,
  createArtifact,
  attachArtifactBytes,
  registerWorker,
  loadReportRevisionDocument,
} from '@cairn/db/testing'
import {
  renderReportHtml,
  type ReportImage,
} from './report-html.js'
import {
  sanitizeReportSource,
  buildReportAiPrompt,
  validateAiInterpretation,
} from './report-ai-runner.js'
import {
  type ReportAiInterpretation,
} from '@cairn/shared'

const ARTIFACT_DIR = '/Users/tinker/.gemini/antigravity/brain/c3544bce-2847-47bf-b228-79e81c89c967'
const SCREENSHOT_DIR = resolve(ARTIFACT_DIR, 'screenshots')

describe('报告 AI 总结与质量保障端到端仿真测试', { timeout: 90_000 }, () => {
  let handle: DbHandle
  let browser: Browser
  let actorId: string
  let targetId: string
  let scenarioId: string
  let scenarioVersionId: string
  let workerId: string
  let instanceId: string

  beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    browser = await chromium.launch({ headless: true })
    handle = await openIsolatedDb(`e2e_ai_${Date.now().toString(36)}`)

    const { consoleAccounts, consoleRoles, consoleAccountRoles, targets } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()

    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'E2E 质量验收专员',
      email: `quality-${actorId}@cairn.example`,
      status: 'active',
    })
    const [adminRole] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db.insert(consoleAccountRoles).values({
      id: newId(),
      consoleAccountId: actorId,
      consoleRoleId: adminRole!.id,
      targetScopeMode: 'all',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `target-${targetId.slice(0, 8)}`,
      name: '智能资金结算与对账系统',
      entryUrl: 'https://finance.cairn.internal/dashboard',
    })

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '核心结算中心流水对账与结算审计',
      steps: [
        {
          id: '10000000-0000-4000-8000-000000000001',
          name: '登录财务结算中心',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: '登录凭据验证通过' },
        },
        {
          id: '10000000-0000-4000-8000-000000000002',
          name: '拉取日结流水清单',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: '获取到 1,452 笔结算单' },
        },
        {
          id: '10000000-0000-4000-8000-000000000003',
          name: '三方网关资金核对与断言',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: '核对出现账期未平差异' },
        },
      ],
      actor: { id: actorId },
    })
    scenarioId = scenario.id
    scenarioVersionId = scenario.published!.versionId

    workerId = `worker-e2e-${newId().slice(0, 8)}`
    instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 4,
      lostAfterSeconds: 120,
    })
  })

  afterAll(async () => {
    await browser?.close()
    await handle?.close()
  })

  it('1. 单场景运行：从程序版报告生成、AI 作业认领、脱敏强校验到原子提升与视觉渲染', async () => {
    const { runs, reportRevisionOutputs, exportJobs, stepRuns } = schemaFor(handle.db)

    // 创建真实 Run 事实（带有告警与输出指标）
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId,
      actor: { id: actorId },
    })
    const runId = run.detail.id

    // 记录步骤事实
    await handle.db
      .update(stepRuns)
      .set({
        status: 'SUCCEEDED',
        outcomeStatus: 'PASS',
        startedAt: new Date(Date.now() - 5000),
        finishedAt: new Date(Date.now() - 4000),
      })
      .where(and(eq(stepRuns.runId, runId), eq(stepRuns.ordinal, 1)))

    await handle.db
      .update(stepRuns)
      .set({
        status: 'SUCCEEDED',
        outcomeStatus: 'PASS',
        startedAt: new Date(Date.now() - 4000),
        finishedAt: new Date(Date.now() - 2500),
      })
      .where(and(eq(stepRuns.runId, runId), eq(stepRuns.ordinal, 2)))

    await handle.db
      .update(stepRuns)
      .set({
        status: 'SUCCEEDED',
        outcomeStatus: 'WARN',
        startedAt: new Date(Date.now() - 2500),
        finishedAt: new Date(),
      })
      .where(and(eq(stepRuns.runId, runId), eq(stepRuns.ordinal, 3)))

    await handle.db
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        outcomeStatus: 'WARN',
        evidenceStatus: 'COMPLETE',
        startedAt: new Date(Date.now() - 5000),
        finishedAt: new Date(),
        output: {
          status: 'WARNING',
          summary: '对账完成，系统自动识别出 1 笔第三方支付网关跨日结算在途差异',
          metrics: {
            totalOrders: 1452,
            matchedAmount: '¥3,850,210.00',
            diffAmount: '¥120.00',
            reconciliationRate: '99.99%',
          },
          findings: [
            {
              id: 'finding-001',
              title: '支付网关 23:59 订单在途结算差异',
              severity: 'WARN',
              detail: '订单尾号 8829 因银联跨日清算窗口差额 120.00 元，需次日批处理平账',
              stepOrdinal: 3,
            },
          ],
          assembledAt: new Date().toISOString(),
        },
      })
      .where(eq(runs.id, runId))

    // 1.1 生成程序版报告 Revision 1
    const report = await createReport(
      handle.db,
      {
        subject: { kind: 'RUN', runId },
        stage: 'final',
        scope: 'run',
        idempotencyKey: `rpt-e2e-single-${runId}`,
      },
      { kind: 'console', id: actorId },
    )
    expect(report.currentRevision?.revisionNo).toBe(1)
    expect(report.currentRevision?.sealedAt).toBeTruthy()
    const rev1Id = report.currentRevision!.id

    // 绑定程序版 HTML Artifact
    const html1Artifact = await createArtifact(handle.db, {
      targetId,
      kind: 'report_html',
      fileName: '结算中心流水对账-程序版.html',
      contentType: 'text/html; charset=utf-8',
      retainUntil: new Date(Date.now() + 30 * 86_400_000),
      reportRevisionId: rev1Id,
    })
    await attachArtifactBytes(handle.db, {
      artifactId: html1Artifact.id,
      byteSize: 35000,
      digest: 'sha256:rev1-html',
    })
    await handle.db.insert(reportRevisionOutputs).values({
      id: newId(),
      revisionId: rev1Id,
      format: 'html',
      renderVersion: report.currentRevision!.renderVersion,
      artifactId: html1Artifact.id,
    })

    // 验证当前交付版本为程序版 Revision 1
    const artifactBeforeAi = await getLatestHtmlReportArtifact(handle.db, { runId })
    expect(artifactBeforeAi?.revisionId).toBe(rev1Id)
    expect(artifactBeforeAi?.artifactId).toBe(html1Artifact.id)

    // 1.2 Worker 认领 AI 作业
    await handle.db
      .update(exportJobs)
      .set({ status: 'complete', updatedAt: new Date() })
      .where(and(eq(exportJobs.reportRevisionId, rev1Id), eq(exportJobs.kind, 'report_render')))

    const claimed = await claimReportAiJobs(handle.db, {
      workerId,
      instanceId,
      leaseTtlSeconds: 60,
      limit: 5,
    })
    const grant = claimed.find((g) => g.jobId === report.aiJob?.id)
    expect(grant).toBeDefined()

    // 1.3 脱敏白名单与 Prompt 校验（RA05）
    const loadedRev1 = await loadReportRevisionDocument(handle.db, rev1Id)
    const baseDoc = loadedRev1.revision.document!
    const { sanitized, validCitationIds } = sanitizeReportSource(baseDoc)
    expect(validCitationIds.has('10000000-0000-4000-8000-000000000001')).toBe(true)
    expect(validCitationIds.has('finding-001')).toBe(true)
    expect(sanitized.businessOutput?.status).toBe('WARNING')

    const { system, user } = buildReportAiPrompt(sanitized)
    expect(system).toContain('核心安全规则')
    expect(system).toContain('纯 JSON 对象')
    expect(user).toContain('对账完成')

    // 1.4 模型结构化解读与校验（RA04）
    const aiInterpretation: ReportAiInterpretation = {
      model: 'deepseek-chat-v3',
      generatedAt: new Date().toISOString(),
      status: 'conclusive',
      observation: '财务对账场景顺利执行完毕，前置鉴权与清单抓取全部通过；在网关对账环节识别出 1 项已知跨日差异。',
      findings: [
        {
          statement: '支付网关存在 ¥120.00 在途单边账差异，发生于跨日切断窗口期。',
          citationIds: ['finding-001', '10000000-0000-4000-8000-000000000003'],
        },
      ],
      hypotheses: [
        {
          cause: '第三方支付网关跨日切断窗口单边账',
          likelihood: 'high',
          basis: '可能系第三方支付机构清算系统未平账导致的正常在途差异，符合 T+1 清算特征。',
        },
      ],
      suggestions: [
        '关注明日凌晨 02:00 的次日清算对账批处理结果。',
        '若次日仍未平账，调阅银联原始流水对账单进行人工核验。',
      ],
    }

    validateAiInterpretation(aiInterpretation, validCitationIds, sanitized)

    // 1.5 创建不可变 Revision 2 并进行原子提升（RA02）
    const rev2 = await createReportAiRevision(handle.db, {
      reportId: report.id,
      baseRevisionId: rev1Id,
      interpretation: aiInterpretation,
    })
    expect(rev2.revisionNo).toBe(2)
    expect(rev2.parentReportRevisionId ?? rev1Id).toBe(rev1Id)

    // 渲染包含 AI 卡片的完整自包含 HTML
    const images: ReportImage[] = []
    const renderedHtml = renderReportHtml(rev2.document, images)

    expect(renderedHtml).toContain('AI 辅助解读')
    expect(renderedHtml).toContain('deepseek-chat-v3')
    expect(renderedHtml).toContain('#finding-001')
    expect(renderedHtml).toContain('跨日切断窗口期')
    expect(renderedHtml).toContain('仅供辅助参考 · 不作为业务结论标准')

    // 上传 Revision 2 的 HTML Artifact
    const html2Artifact = await createArtifact(handle.db, {
      targetId,
      kind: 'report_html',
      fileName: '结算中心流水对账-程序+AI版.html',
      contentType: 'text/html; charset=utf-8',
      retainUntil: new Date(Date.now() + 30 * 86_400_000),
      reportRevisionId: rev2.revisionId,
    })
    await attachArtifactBytes(handle.db, {
      artifactId: html2Artifact.id,
      byteSize: Buffer.byteLength(renderedHtml),
      digest: 'sha256:rev2-html',
    })

    // 封存提升
    await sealReportAiRevision(handle.db, {
      revisionId: rev2.revisionId,
      htmlArtifactId: html2Artifact.id,
    })

    await completeReportAiJob(handle.db, {
      ...grant,
      status: 'completed',
      aiRevisionId: rev2.revisionId,
      interpretation: aiInterpretation,
      model: 'deepseek-chat-v3',
      promptVersion: 'v1',
      inputDigest: 'sha256:test',
      tokenUsage: { promptTokens: 320, completionTokens: 180, totalTokens: 500 },
      durationMs: 1450,
    })

    // 验证原子提升后，当前默认交付版本已自动成为 Revision 2！
    const currentReport = await getReport(handle.db, report.id, actorId)
    expect(currentReport.currentRevision?.revisionNo).toBe(2)
    expect(currentReport.currentRevision?.id).toBe(rev2.revisionId)
    expect(currentReport.aiJob?.status).toBe('completed')

    const artifactAfterAi = await getLatestHtmlReportArtifact(handle.db, { runId })
    expect(artifactAfterAi?.revisionId).toBe(rev2.revisionId)
    expect(artifactAfterAi?.artifactId).toBe(html2Artifact.id)

    // 1.6 Headless 浏览器脱机加载与视觉截图验证（单场景）
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const failedRequests: string[] = []
    page.on('requestfailed', (req) => failedRequests.push(req.url()))

    await page.setContent(renderedHtml, { waitUntil: 'load' })
    expect(failedRequests).toEqual([]) // 纯自包含，零外部资源失败

    // 验证关键视觉元素
    const aiCard = page.locator('.ai-card')
    expect(await aiCard.isVisible()).toBe(true)
    const citationPill = page.locator('.ai-citation-pill').first()
    expect(await citationPill.isVisible()).toBe(true)

    // 截取全屏桌面图
    const screenshotDesktop = resolve(SCREENSHOT_DIR, '31_e2e_single_report_desktop.png')
    await page.screenshot({ path: screenshotDesktop, fullPage: true })

    // 移动端响应式测试
    await page.setViewportSize({ width: 375, height: 812 })
    const screenshotMobile = resolve(SCREENSHOT_DIR, '32_e2e_single_report_mobile.png')
    await page.screenshot({ path: screenshotMobile, fullPage: true })
    await page.close()
  })

  it('2. 场景集巡检总报告（Template B）：包含聚合健康分、对照总表与 AI 总结', async () => {
    const { suiteRuns, runs } = schemaFor(handle.db)

    const suiteName = '核心业务全链路日常例行巡检'

    const suite = await createSuite(
      handle.db,
      {
        targetId,
        name: suiteName,
        document: {
          schemaVersion: 1,
          groups: [],
          sharedInput: {},
          failurePolicy: 'continue',
          autoGenerateFinalReport: false,
          members: [
            { memberId: 'm-auth-sync', ordinal: 0, scenarioId, scenarioVersionId, input: {} },
            { memberId: 'm-inventory-deduct', ordinal: 1, scenarioId, scenarioVersionId, input: {} },
            { memberId: 'm-batch-clearing', ordinal: 2, scenarioId, scenarioVersionId, input: {} },
          ],
        },
      },
      { kind: 'console', id: actorId },
    )
    await publishSuite(
      handle.db,
      suite.id,
      { expectedRevision: suite.draft.revision, idempotencyKey: newId() },
      { kind: 'console', id: actorId },
    )
    const { observation } = await createSuiteRun(
      handle.db,
      { suiteId: suite.id, idempotencyKey: newId() },
      { kind: 'console', id: actorId },
    )
    const suiteRunId = observation.id

    const childRuns = observation.items
    const runId1 = childRuns[0]!.childRunId!
    const runId2 = childRuns[1]!.childRunId!
    const runId3 = childRuns[2]!.childRunId!

    // 更新子 Run 事实数据
    await handle.db
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        outcomeStatus: 'PASS',
        evidenceStatus: 'COMPLETE',
        startedAt: new Date(Date.now() - 5000),
        finishedAt: new Date(Date.now() - 4000),
        output: {
          status: 'NORMAL',
          summary: '全量同步 2,000 条账号，0 异常',
          metrics: { syncCount: 2000, errorCount: 0 },
          assembledAt: new Date().toISOString(),
        },
      })
      .where(eq(runs.id, runId1))

    await handle.db
      .update(runs)
      .set({
        status: 'FAILED',
        outcomeStatus: 'FAIL',
        evidenceStatus: 'COMPLETE',
        startedAt: new Date(Date.now() - 4000),
        finishedAt: new Date(Date.now() - 2500),
        output: {
          status: 'ANOMALOUS',
          summary: 'SKU #90812 库存扣减出现穿透负数',
          findings: [
            {
              id: 'finding-inv-01',
              title: '库存锁竞争穿透',
              severity: 'HIGH',
              detail: '高并发下单场景下出现负库存 -1',
            },
          ],
          assembledAt: new Date().toISOString(),
        },
      })
      .where(eq(runs.id, runId2))

    await handle.db
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        outcomeStatus: 'WARN',
        evidenceStatus: 'COMPLETE',
        startedAt: new Date(Date.now() - 2500),
        finishedAt: new Date(),
        output: {
          status: 'WARNING',
          summary: '批量归集完成但处理耗时超过基线',
          metrics: { duration: '8.4s', baseline: '5.0s' },
          assembledAt: new Date().toISOString(),
        },
      })
      .where(eq(runs.id, runId3))

    await handle.db
      .update(suiteRuns)
      .set({
        status: 'COMPLETED',
        verdict: 'anomalies_found',
        evidenceStatus: 'COMPLETE',
        startedAt: new Date(Date.now() - 5000),
        finishedAt: new Date(),
      })
      .where(eq(suiteRuns.id, suiteRunId))

    // 生成场景集报告
    const suiteReport = await createReport(
      handle.db,
      {
        subject: { kind: 'SUITE_RUN', suiteRunId },
        stage: 'final',
        scope: 'suite_summary',
        idempotencyKey: `rpt-e2e-suite-${suiteRunId}`,
      },
      { kind: 'console', id: actorId },
    )
    expect(suiteReport.currentRevision?.revisionNo).toBe(1)
    const suiteRev1Id = suiteReport.currentRevision!.id

    // 为场景集生成 AI 解读
    const suiteAiInterpretation: ReportAiInterpretation = {
      model: 'deepseek-chat-v3',
      generatedAt: new Date().toISOString(),
      status: 'conclusive',
      observation: '场景集 3 项巡检任务执行完成，整体通过率 66.7%。识别出 1 项高风险库存扣减异常与 1 项清算耗时告警。',
      findings: [
        {
          statement: '实时库存核销任务失败，SKU #90812 在高并发下单过程中发生超卖穿透。',
          citationIds: ['m-inventory-deduct', 'finding-inv-01'],
        },
        {
          statement: '批处理清算虽然完成，但耗时达到 8.4s，较基线超出 68%。',
          citationIds: ['m-batch-clearing'],
        },
      ],
      hypotheses: [
        {
          cause: '缺少分布式悲观锁与原子自减校验',
          likelihood: 'high',
          basis: '库存扣减缺少分布式悲观锁或原子自减校验，并发扣减未排队导致出现负库存。',
        },
      ],
      suggestions: [
        '优先修复 SKU 库存核销的 Redis 分布式锁逻辑。',
        '优化清算批处理的 SQL 分页索引以压降耗时。',
      ],
    }

    const suiteRev2 = await createReportAiRevision(handle.db, {
      reportId: suiteReport.id,
      baseRevisionId: suiteRev1Id,
      interpretation: suiteAiInterpretation,
    })

    const suiteHtml = renderReportHtml(suiteRev2.document, [])
    expect(suiteHtml).toContain('核心业务巡检对照总表')
    expect(suiteHtml).toContain('AI 辅助解读')
    expect(suiteHtml).toContain('#m-inventory-deduct')
    expect(suiteHtml).toContain('并发扣减未排队')

    // 上传并提升
    const suiteHtmlArtifact = await createArtifact(handle.db, {
      targetId,
      kind: 'report_html',
      fileName: '日常例行巡检总报告-带AI.html',
      contentType: 'text/html; charset=utf-8',
      retainUntil: new Date(Date.now() + 30 * 86_400_000),
      reportRevisionId: suiteRev2.revisionId,
    })
    await attachArtifactBytes(handle.db, {
      artifactId: suiteHtmlArtifact.id,
      byteSize: Buffer.byteLength(suiteHtml),
      digest: 'sha256:suite-rev2',
    })
    await sealReportAiRevision(handle.db, {
      revisionId: suiteRev2.revisionId,
      htmlArtifactId: suiteHtmlArtifact.id,
    })

    // 视觉验证
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.setContent(suiteHtml, { waitUntil: 'load' })

    // 交互验证：点击筛选“仅异常”
    await page.locator('button.pill', { hasText: '仅异常' }).click()
    const visibleRows = await page.locator('.grid-row:visible').count()
    expect(visibleRows).toBe(1) // 只有库存穿透这一行

    // 截取场景集桌面图
    const screenshotSuite = resolve(SCREENSHOT_DIR, '33_e2e_suite_report_desktop.png')
    await page.screenshot({ path: screenshotSuite, fullPage: true })
    await page.close()
  })

  it('3. 深度防覆盖拦截验证：用户期间手动创建新版本时，AI 提升失败且不覆盖用户选择，重试顺利自愈', async () => {
    const { runs } = schemaFor(handle.db)
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId,
      actor: { id: actorId },
    })
    await handle.db
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        outcomeStatus: 'PASS',
        evidenceStatus: 'COMPLETE',
      })
      .where(eq(runs.id, run.detail.id))

    const report = await createReport(
      handle.db,
      {
        subject: { kind: 'RUN', runId: run.detail.id },
        stage: 'final',
        scope: 'run',
        idempotencyKey: `rpt-conflict-${run.detail.id}`,
      },
      { kind: 'console', id: actorId },
    )
    const rev1Id = report.currentRevision!.id

    // 模拟用户在 AI 生成期间手动创建并封存了 Revision 2（定制版本）
    const userRev2 = await createReportRevision(
      handle.db,
      report.id,
      {
        reason: '业务主管手动定制终稿',
        stage: 'final',
        config: { title: '财务结算中心终审定制报告' },
        idempotencyKey: `user-custom-${run.detail.id}`,
      },
      { kind: 'console', id: actorId },
    )
    expect(userRev2.currentRevision?.revisionNo).toBe(2)
    const userRev2Id = userRev2.currentRevision!.id

    // 此时后台滞后的 AI 作业试图提升（基于旧的 Revision 1）
    const aiRev = await createReportAiRevision(handle.db, {
      reportId: report.id,
      baseRevisionId: rev1Id,
      interpretation: {
        status: 'conclusive',
        model: 'deepseek-chat-v3',
        observation: '执行良好',
        findings: [],
        hypotheses: [],
        suggestions: [],
        generatedAt: new Date().toISOString(),
      },
    })

    const dummyHtml = await createArtifact(handle.db, {
      targetId,
      kind: 'report_html',
      fileName: 'stale-ai.html',
      contentType: 'text/html; charset=utf-8',
      retainUntil: new Date(Date.now() + 30 * 86_400_000),
      reportRevisionId: aiRev.revisionId,
    })
    await attachArtifactBytes(handle.db, {
      artifactId: dummyHtml.id,
      byteSize: 100,
      digest: 'sha256:dummy',
    })

    // 提升必须被拦截拒绝！
    await expect(
      sealReportAiRevision(handle.db, {
        revisionId: aiRev.revisionId,
        htmlArtifactId: dummyHtml.id,
      }),
    ).rejects.toThrow('依附的程序修订已不是当前版本，AI 提升失败且不覆盖用户选择')

    // 验证当前对外版本仍然是用户的定制版 Revision 2
    const checkReport = await getReport(handle.db, report.id, actorId)
    expect(checkReport.currentRevision?.id).toBe(userRev2Id)
    expect(checkReport.currentRevision?.title).toContain('财务结算中心终审定制报告')

    // 用户通过 API 发起重试，AI 作业基准自动平滑切换至最新的 Revision 2
    const retried = await retryReportAiJob(handle.db, report.id, { kind: 'console', id: actorId })
    expect(retried.aiJob?.status).toBe('pending')
    expect(retried.aiJob?.baseRevisionId).toBe(userRev2Id)
  })
})
