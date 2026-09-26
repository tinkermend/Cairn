import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  attachArtifactBytes,
  claimReportAiJobs,
  completeReportAiJob,
  createArtifact,
  createReport,
  createReportAiRevision,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getLatestHtmlReportArtifact,
  getReport,
  loadReportRevisionDocument,
  registerWorker,
  renewReportAiJob,
  retryReportAiJob,
  sealReportAiRevision,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

describe.each(DRIVERS)('%s 报告 AI 异步修订与原子提升', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let scenarioId: string
  let workerId: string
  let instanceId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `rpt_ai_${Date.now().toString(36)}`)
    const { consoleAccounts, consoleRoles, consoleAccountRoles, targets } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'report-ai-tester',
      email: `report-ai-${actorId}@example.com`,
      status: 'active',
    })
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db.insert(consoleAccountRoles).values({
      id: newId(),
      consoleAccountId: actorId,
      consoleRoleId: admin!.id,
      targetScopeMode: 'all',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `rpt-${targetId}`,
      name: 'AI 报告测试目标',
      entryUrl: 'https://shop.example/home',
    })

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: 'AI 报告测试场景',
      steps: [
        {
          id: '00000000-0000-4000-8000-0000000000d1',
          name: '步骤1',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 'ok' },
        },
      ],
      actor: { id: actorId },
    })
    scenarioId = scenario.id

    workerId = `worker-${newId()}`
    instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 4,
      lostAfterSeconds: 120,
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('RA01 & RA02: 继承策略下自动排队 AI 作业，未就绪修订不抢占程序版，封存后原子提升', async () => {
    const { runs, reportRevisionOutputs, exportJobs } = schemaFor(handle.db)
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId,
      actor: { id: actorId },
    })
    await handle.db
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        updatedAt: new Date(),
        outcomeStatus: 'PASS',
        evidenceStatus: 'COMPLETE',
      })
      .where(eq(runs.id, run.detail.id))

    // 1. 创建程序版报告（默认 outputPolicy.aiSummaryPolicy 为 inherit）
    const report = await createReport(
      handle.db,
      {
        subject: { kind: 'RUN', runId: run.detail.id },
        stage: 'final',
        scope: 'run',
        idempotencyKey: `rpt-ai-inherit-${run.detail.id}`,
      },
      { kind: 'console', id: actorId },
    )

    // 程序版 Revision 1 已封存
    expect(report.currentRevision?.revisionNo).toBe(1)
    expect(report.currentRevision?.sealedAt).toBeTruthy()
    const rev1Id = report.currentRevision!.id

    // 挂靠初始 HTML Artifact 并可用
    const html1 = await createArtifact(handle.db, {
      targetId,
      kind: 'report_html',
      fileName: 'report-v1.html',
      contentType: 'text/html; charset=utf-8',
      retainUntil: new Date(Date.now() + 30 * 86_400_000),
      reportRevisionId: rev1Id,
    })
    await attachArtifactBytes(handle.db, {
      artifactId: html1.id,
      byteSize: 1024,
      digest: 'sha256:dummy1',
    })
    await handle.db.insert(reportRevisionOutputs).values({
      id: newId(),
      revisionId: rev1Id,
      format: 'html',
      renderVersion: report.currentRevision!.renderVersion,
      artifactId: html1.id,
    })

    // 验证最新的可交付 HTML Artifact 必须是 rev1
    const artifact1 = await getLatestHtmlReportArtifact(handle.db, { runId: run.detail.id })
    expect(artifact1).toBeDefined()
    expect(artifact1?.revisionId).toBe(rev1Id)
    expect(artifact1?.artifactId).toBe(html1.id)

    // 2. 检查自动排队的 AI 作业
    expect(report.aiJob).toBeDefined()
    expect(report.aiJob?.status).toBe('pending')

    // 模拟程序版 HTML 渲染任务已完成，解除 AI 作业排队依赖
    await handle.db
      .update(exportJobs)
      .set({ status: 'complete', updatedAt: new Date() })
      .where(and(eq(exportJobs.reportRevisionId, rev1Id), eq(exportJobs.kind, 'report_render')))

    // 3. Worker 领取 AI 作业
    const claimed = await claimReportAiJobs(handle.db, {
      workerId,
      instanceId,
      leaseTtlSeconds: 60,
      limit: 10,
    })
    expect(claimed.length).toBeGreaterThanOrEqual(1)
    const grant = claimed.find((g) => g.jobId === report.aiJob?.id)
    expect(grant).toBeDefined()
    expect(grant?.status).toBe('running')

    // 4. 续租验证
    const renewed = await renewReportAiJob(handle.db, grant!)
    expect(renewed).toBe(true)

    // 5. 模拟 AI 生成成功，创建不可变 Revision 2（初始 sealedAt 为 null）
    const loadedDoc = await loadReportRevisionDocument(handle.db, rev1Id)
    const baseDoc = loadedDoc.revision.document!
    const aiDoc = {
      ...baseDoc,
      aiInterpretation: {
        model: 'deepseek-chat',
        generatedAt: new Date().toISOString(),
        status: 'conclusive' as const,
        observation: '所有步骤均顺利完成，运行事实良好。',
        findings: [],
        hypotheses: [],
        suggestions: ['继续保持常态巡检'],
      },
    }

    const rev2 = await createReportAiRevision(handle.db, {
      reportId: report.id,
      baseRevisionId: rev1Id,
      document: aiDoc,
    })
    expect(rev2.revisionNo).toBe(2)

    // ★ 关键验证：Revision 2 刚创建但尚未 sealed，查询 currentRevision 仍然是 Revision 1！
    const reportBeforeSealing = await getReport(handle.db, report.id, { kind: 'console', id: actorId })
    expect(reportBeforeSealing.currentRevision?.revisionNo).toBe(1)
    expect(reportBeforeSealing.currentRevision?.id).toBe(rev1Id)

    // 查询交付 Artifact 也必须仍是 Revision 1 的 Artifact
    const deliverArtifactBeforeSealing = await getLatestHtmlReportArtifact(handle.db, { runId: run.detail.id })
    expect(deliverArtifactBeforeSealing?.revisionId).toBe(rev1Id)

    // 6. 上传并绑定 Revision 2 的 HTML Artifact
    const html2 = await createArtifact(handle.db, {
      targetId,
      kind: 'report_html',
      fileName: 'report-v2-ai.html',
      contentType: 'text/html; charset=utf-8',
      retainUntil: new Date(Date.now() + 30 * 86_400_000),
      reportRevisionId: rev2.revisionId,
    })
    await attachArtifactBytes(handle.db, {
      artifactId: html2.id,
      byteSize: 2048,
      digest: 'sha256:dummy2',
    })

    // 7. 原子提升（封存 Revision 2）
    await sealReportAiRevision(handle.db, {
      revisionId: rev2.revisionId,
      htmlArtifactId: html2.id,
    })

    // 8. 标记 AI 作业完成
    await completeReportAiJob(handle.db, {
      ...grant!,
      status: 'completed',
      aiRevisionId: rev2.revisionId,
      interpretation: aiDoc.aiInterpretation,
      model: 'deepseek-chat',
      promptVersion: 'v1',
      inputDigest: 'sha256:dummy',
      tokenUsage: { promptTokens: 50, completionTokens: 100, totalTokens: 150 },
      durationMs: 1200,
    })

    // ★ 关键验证：原子提升后，currentRevision 变为 Revision 2
    const reportAfterSealing = await getReport(handle.db, report.id, { kind: 'console', id: actorId })
    expect(reportAfterSealing.currentRevision?.revisionNo).toBe(2)
    expect(reportAfterSealing.currentRevision?.id).toBe(rev2.revisionId)
    expect(reportAfterSealing.currentRevision?.sealedAt).toBeTruthy()
    expect(reportAfterSealing.aiJob?.status).toBe('completed')
    expect(reportAfterSealing.aiJob?.model).toBe('deepseek-chat')

    // 交付 Artifact 也原子提升至 Revision 2 的 Artifact
    const deliverArtifactAfterSealing = await getLatestHtmlReportArtifact(handle.db, { runId: run.detail.id })
    expect(deliverArtifactAfterSealing?.revisionId).toBe(rev2.revisionId)
    expect(deliverArtifactAfterSealing?.artifactId).toBe(html2.id)
  })

  it('RA03: AI 失败或崩溃时降级，程序版 Revision 1 保持原样交付', async () => {
    const { runs, exportJobs } = schemaFor(handle.db)
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId,
      actor: { id: actorId },
    })
    await handle.db
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        updatedAt: new Date(),
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
        idempotencyKey: `rpt-ai-fail-${run.detail.id}`,
      },
      { kind: 'console', id: actorId },
    )
    const rev1Id = report.currentRevision!.id

    // 模拟程序版 HTML 渲染任务已完成，解除 AI 作业排队依赖
    await handle.db
      .update(exportJobs)
      .set({ status: 'complete', updatedAt: new Date() })
      .where(and(eq(exportJobs.reportRevisionId, rev1Id), eq(exportJobs.kind, 'report_render')))

    // 领取并模拟失败
    const claimed = await claimReportAiJobs(handle.db, {
      workerId,
      instanceId,
      leaseTtlSeconds: 60,
      limit: 10,
    })
    const grant = claimed.find((g) => g.jobId === report.aiJob?.id)
    expect(grant).toBeDefined()

    await completeReportAiJob(handle.db, {
      ...grant!,
      status: 'failed',
      error: '模型网关超时 504 Gateway Timeout',
    })

    // 验证报告状态：程序版 Revision 1 完全不受损
    const checked = await getReport(handle.db, report.id, { kind: 'console', id: actorId })
    expect(checked.currentRevision?.revisionNo).toBe(1)
    expect(checked.currentRevision?.id).toBe(rev1Id)
    expect(checked.currentRevision?.sealedAt).toBeTruthy()
    expect(checked.aiJob?.status).toBe('failed')
    expect(checked.aiJob?.error).toContain('模型网关超时')

    // RA06: 允许安全重试 AI 作业
    const retried = await retryReportAiJob(handle.db, report.id, actorId)
    expect(retried.status).toBe('pending')
    expect(retried.error).toBeNull()
  })
})
