import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EXPORT_ARTIFACTS_PROTOCOL } from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { createRunWithSnapshot, createScenarioWithVersion, createSuite, createSuiteRun, publishSuite, registerWorker, type NativeHandle } from '../test-entry.js'
import { claimExportJobs, completeExportJob, createReport, createReportRevision, deleteReport, enqueueReportExport, getReport, getExportJob, listReports, loadReportRevisionDocument, previewReport } from '../reports/reports.js'
import { createArtifact, attachArtifactBytes, getArtifact } from '../objects/artifacts.js'
import { deleteRun } from '../runs/runs.js'

describe.each(DRIVERS)('%s 报告交付与恢复', (driver) => {
  let handle: NativeHandle
  let actorId: string, targetId: string, scenarioId: string, scenarioVersionId: string
  const actor = () => ({ id: actorId })
  beforeAll(async () => {
    handle = await openContractDb(driver)
    const { consoleAccounts, consoleRoles, consoleAccountRoles, targets } = schemaFor(handle.db)
    actorId = newId(); targetId = newId()
    await handle.db.insert(consoleAccounts).values({ id: actorId, displayName: '报告验收', email: `${actorId}@example.com`, status: 'active' })
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db.insert(consoleAccountRoles).values({ consoleAccountId: actorId, consoleRoleId: admin!.id, targetScopeMode: 'all' })
    await handle.db.insert(targets).values({ id: targetId, code: targetId, name: '报告系统', entryUrl: 'https://example.com' })
    const scenario = await createScenarioWithVersion(handle.db, { targetId, name: '报告场景', actor: actor(), steps: [
      { id: newId(), name: '检查订单', type: 'echo', effectType: 'READ_ONLY', input: { value: 'ok' } },
    ] })
    scenarioId = scenario.id
    scenarioVersionId = scenario.published!.versionId
  })
  beforeEach(async () => {
    const { exportJobs } = schemaFor(handle.db)
    await handle.db.update(exportJobs).set({ status: 'failed', leaseUntil: null })
  })
  afterAll(async () => { await handle?.close() })

  async function run(ready = true) {
    const made = await createRunWithSnapshot(handle.db, { scenarioId, actor: actor() })
    if (ready) {
      const { runs } = schemaFor(handle.db)
      await handle.db.update(runs).set({ status: 'SUCCEEDED', outcomeStatus: 'PASS', evidenceStatus: 'COMPLETE', finishedAt: new Date() }).where(eq(runs.id, made.detail.id))
    }
    return made.detail.id
  }
  const body = (runId: string, key = newId()) => ({ subject: { kind: 'RUN' as const, runId }, stage: 'final' as const, scope: 'run' as const, config: { screenshotScope: 'none' as const }, idempotencyKey: key })
  async function worker() {
    const identity = { workerId: `report-${newId()}`, instanceId: newId() }
    await registerWorker(handle.db, { ...identity, capacity: 1, maxSessions: 1, lostAfterSeconds: 60, protocolCapabilities: [EXPORT_ARTIFACTS_PROTOCOL] })
    return identity
  }
  async function job() {
    const runId = await run()
    const report = await createReport(handle.db, body(runId), actor())
    const exportJob = await enqueueReportExport(handle.db, report.id, report.currentRevision!.id, ['pdf'], actor(), newId())
    return { runId, report, exportJob }
  }
  async function artifact() {
    const made = await createArtifact(handle.db, { targetId, actorId, kind: 'report_pdf', fileName: '巡检.pdf', contentType: 'application/pdf', retainUntil: new Date(Date.now() + 60_000) })
    await attachArtifactBytes(handle.db, { artifactId: made.id, byteSize: 3, digest: 'sha256:test' })
    return made.id
  }

  it('执行终态但证据待收集时拒绝终稿和终稿修订，缺失证据明确标为部分内容', async () => {
    const id = await run(false)
    const phase = await createReport(handle.db, { ...body(id), stage: 'phase' }, actor())
    const { runs } = schemaFor(handle.db)
    await handle.db.update(runs).set({ status: 'SUCCEEDED', finishedAt: new Date() }).where(eq(runs.id, id))
    expect((await previewReport(handle.db, body(id), actorId)).canGenerateFinal).toBe(false)
    await expect(createReport(handle.db, body(id), actor())).rejects.toMatchObject({ code: 'REPORT_NOT_READY' })
    await expect(createReportRevision(handle.db, phase.id, { stage: 'final', reason: '转终稿', idempotencyKey: newId() }, actor())).rejects.toMatchObject({ code: 'REPORT_NOT_READY' })
    await handle.db.update(runs).set({ evidenceStatus: 'INCOMPLETE' }).where(eq(runs.id, id))
    const report = await createReport(handle.db, body(id), actor())
    expect(report.currentRevision!.contentCompleteness).toBe('partial')
    expect((await loadReportRevisionDocument(handle.db, report.currentRevision!.id)).revision.document!.gaps.join('')).toContain('必要证据不完整')
  })

  it('创建和修订并发幂等，冲突键拒绝，不覆盖旧快照', async () => {
    const id = await run(), request = body(id)
    const [first, duplicate] = await Promise.all([createReport(handle.db, request, actor()), createReport(handle.db, request, actor())])
    expect(duplicate.id).toBe(first.id)
    await expect(createReport(handle.db, { ...request, config: { title: '不同标题' } }, actor())).rejects.toMatchObject({ code: 'REPORT_IDEMPOTENCY_CONFLICT' })
    const revision = { reason: '更新标题', config: { title: '修订二' }, idempotencyKey: newId() }
    const [a, b] = await Promise.all([createReportRevision(handle.db, first.id, revision, actor()), createReportRevision(handle.db, first.id, revision, actor())])
    expect(a.currentRevision!.id).toBe(b.currentRevision!.id)
    expect(a.currentRevision!.revisionNo).toBe(2)
    expect(a.currentRevision!.parentReportRevisionId).toBeNull()
    const original = await loadReportRevisionDocument(handle.db, first.currentRevision!.id)
    expect(original.revision.title).toBe(first.currentRevision!.title)
    expect((await listReports(handle.db, { runId: id }, actorId)).items).toHaveLength(1)
    expect((await listReports(handle.db, { runId: id, scope: 'suite_summary' }, actorId)).items).toHaveLength(0)
  })

  it('证据中心的集合筛选同时包含总报告和成员报告，并可按范围区分', async () => {
    const suite = await createSuite(handle.db, { targetId, name: '报告关联集合', document: { schemaVersion: 1, groups: [], sharedInput: {}, failurePolicy: 'continue', autoGenerateFinalReport: false, members: [{ memberId: 'one', ordinal: 0, scenarioId, scenarioVersionId, input: {} }] } }, actor())
    await publishSuite(handle.db, suite.id, { expectedRevision: suite.draft.revision, idempotencyKey: newId() }, actor())
    const { observation } = await createSuiteRun(handle.db, { suiteId: suite.id, idempotencyKey: newId() }, actor())
    const { targets } = schemaFor(handle.db)
    await handle.db.update(targets).set({ name: '运行结束后的新名称' }).where(eq(targets.id, targetId))
    const child = await createReport(handle.db, { ...body(observation.items[0]!.childRunId), stage: 'phase' }, actor())
    const summary = await createReport(handle.db, { subject: { kind: 'SUITE_RUN', suiteRunId: observation.id }, stage: 'phase', scope: 'suite_summary', config: { title: '{systemName} {runNumber}' }, idempotencyKey: newId() }, actor())
    expect(child.currentRevision!.title).toContain('报告系统')
    expect(summary.currentRevision!.title).toBe(`报告系统 ${observation.id.slice(0, 8)}`)
    await handle.db.update(targets).set({ name: '报告系统' }).where(eq(targets.id, targetId))
    for (const query of [{ suiteId: suite.id }, { suiteRunId: observation.id }]) {
      expect((await listReports(handle.db, query, actorId)).items.map((report) => report.id).sort()).toEqual([child.id, summary.id].sort())
      expect((await listReports(handle.db, { ...query, scope: 'suite_summary' }, actorId)).items.map((report) => report.id)).toEqual([summary.id])
    }
  })

  it('重复导出允许重试，同键不同格式拒绝；跨 Worker 重领后旧持有者不能提交', async () => {
    const { report, exportJob } = await job()
    const next = await enqueueReportExport(handle.db, report.id, report.currentRevision!.id, ['pdf'], actor(), newId())
    expect(next.id).not.toBe(exportJob.id)
    const key = newId()
    await enqueueReportExport(handle.db, report.id, report.currentRevision!.id, ['pdf'], actor(), key)
    await expect(enqueueReportExport(handle.db, report.id, report.currentRevision!.id, ['docx'], actor(), key)).rejects.toMatchObject({ code: 'EXPORT_IDEMPOTENCY_CONFLICT' })
    const w1 = await worker(), w2 = await worker()
    const [claimed] = await claimExportJobs(handle.db, w1)
    const { exportJobs } = schemaFor(handle.db)
    await handle.db.update(exportJobs).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(exportJobs.id, claimed!.id))
    const [reclaimed] = await claimExportJobs(handle.db, w2)
    expect(reclaimed!.id).toBe(claimed!.id)
    expect(reclaimed!.claimEpoch).toBe(claimed!.claimEpoch + 1)
    const artifactId = await artifact()
    await expect(getArtifact(handle.db, artifactId, actorId)).rejects.toMatchObject({ code: 'ARTIFACT_NOT_AVAILABLE' })
    expect(await completeExportJob(handle.db, { ...w1, jobId: claimed!.id, claimEpoch: claimed!.claimEpoch, artifactIds: [artifactId], status: 'complete' })).toBe(false)
    expect(await completeExportJob(handle.db, { ...w2, jobId: reclaimed!.id, claimEpoch: reclaimed!.claimEpoch, artifactIds: [artifactId], status: 'complete' })).toBe(true)
    expect((await getArtifact(handle.db, artifactId, actorId)).available).toBe(true)
  })

  it('来源删除、当前权限撤销及报告删除均阻止旧产物继续下载', async () => {
    const { runId, report } = await job(), identity = await worker()
    const [claimed] = await claimExportJobs(handle.db, identity)
    const artifactId = await artifact()
    await completeExportJob(handle.db, { ...identity, jobId: claimed!.id, claimEpoch: claimed!.claimEpoch, artifactIds: [artifactId], status: 'complete' })
    const { consoleAccounts, reports } = schemaFor(handle.db)
    await handle.db.update(consoleAccounts).set({ status: 'disabled' }).where(eq(consoleAccounts.id, actorId))
    await expect(getArtifact(handle.db, artifactId, actorId)).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    await handle.db.update(consoleAccounts).set({ status: 'active' }).where(eq(consoleAccounts.id, actorId))
    await deleteRun(handle.db, runId, actor())
    await expect(getArtifact(handle.db, artifactId, actorId)).rejects.toMatchObject({ code: 'REPORT_SOURCE_NOT_FOUND' })
    expect((await listReports(handle.db, { runId }, actorId)).items).toHaveLength(0)
    await deleteReport(handle.db, report.id, actor())
    expect((await handle.db.select().from(reports).where(eq(reports.id, report.id)))[0]!.deletedAt).toBeTruthy()
    await expect(getReport(handle.db, report.id, actorId)).rejects.toMatchObject({ code: 'REPORT_NOT_FOUND' })
  })

  it('排队后撤销导出权限，Worker 不发布文件', async () => {
    const { exportJob } = await job(), identity = await worker()
    const [claimed] = await claimExportJobs(handle.db, identity)
    const artifactId = await artifact()
    const { consoleAccounts } = schemaFor(handle.db)
    await handle.db.update(consoleAccounts).set({ status: 'disabled' }).where(eq(consoleAccounts.id, actorId))
    expect(await completeExportJob(handle.db, { ...identity, jobId: claimed!.id, claimEpoch: claimed!.claimEpoch, artifactIds: [artifactId], status: 'complete' })).toBe(true)
    await handle.db.update(consoleAccounts).set({ status: 'active' }).where(eq(consoleAccounts.id, actorId))
    expect((await getExportJob(handle.db, exportJob.id, actorId)).status).toBe('failed')
    await expect(getArtifact(handle.db, artifactId, actorId)).rejects.toMatchObject({ code: 'ARTIFACT_NOT_AVAILABLE' })
  })
})
