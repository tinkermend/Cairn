import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_REPORT_CONFIG, EXPORT_ARTIFACTS_PROTOCOL, type ReportConfig } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { createRunWithSnapshot, createScenarioWithVersion, createSuite, createSuiteRun, publishSuite, registerWorker, advanceSuiteRun, type NativeHandle } from '../test-entry.js'
import { createReport, enqueueReportExport, getReport, getExportJob, loadReportRevisionDocument, claimExportJobs, completeExportJob, cancelExportJob, retryExportJob, getCachedReportArtifacts, deleteReport } from '../reports/reports.js'
import { saveReportProfile, saveScenarioReportDefaults, listReportProfileVersions } from '../reports/profiles.js'
import { getExportMaterials, reserveExportArtifact, commitReportMaterial, finishReportMaterials } from '../reports/materials.js'
import { createReportBundle, deriveMemberReport, getReportBundleFiles } from '../reports/bundles.js'
import { generateDueSuiteReports } from '../reports/automatic.js'
import { attachArtifactBytes } from '../objects/artifacts.js'
import { createHash } from 'node:crypto'
import { exportDatabase, importDatabase } from '../transfer.js'
import { expose } from '../database.js'
import { TargetsStore } from '../console/targets.js'
import { reserveReportLogo } from '../reports/queries.js'
import { deleteRun, getRunCleanupStatus, previewDeleteRun, retryRunCleanup } from '../runs/runs.js'

describe.each(DRIVERS)('%s 报告完整交付', { timeout: 60_000 }, (driver) => {
  let handle: NativeHandle, actorId: string, targetId: string
  const actor = () => ({ kind: 'console' as const, id: actorId })
  beforeAll(async () => {
    handle = await openContractDb(driver)
    const t = schemaFor(handle.db); actorId = newId(); targetId = newId()
    await handle.db.insert(t.consoleAccounts).values({ id: actorId, displayName: '交付验收', email: `${actorId}@example.com`, status: 'active' })
    const [admin] = await handle.db.select().from(t.consoleRoles).where(eq(t.consoleRoles.key, 'admin'))
    await handle.db.insert(t.consoleAccountRoles).values({ consoleAccountId: actorId, consoleRoleId: admin!.id, targetScopeMode: 'all' })
    await handle.db.insert(t.targets).values({ id: targetId, code: targetId, name: '巡检目标', entryUrl: 'https://example.com' })
  })
  beforeEach(async () => { const t = schemaFor(handle.db); await handle.db.update(t.exportJobs).set({ status: 'failed', leaseUntil: null }); await handle.db.update(t.workers).set({ status: 'STOPPED' }); await handle.db.update(t.consoleAccounts).set({ status: 'active' }).where(eq(t.consoleAccounts.id, actorId)) })
  afterAll(async () => { await handle?.close() })
  async function scenario() { return createScenarioWithVersion(handle.db, { targetId, name: `订单巡检 ${newId()}`, actor: actor(), steps: [{ id: newId(), name: '检查金额', type: 'echo', effectType: 'READ_ONLY', input: { value: 'ok' } }] }) }
  async function run(scenarioId?: string) {
    const made = await createRunWithSnapshot(handle.db, { scenarioId: scenarioId ?? (await scenario()).id, actor: actor() }), t = schemaFor(handle.db)
    await handle.db.update(t.runs).set({ status: 'SUCCEEDED', outcomeStatus: 'PASS', evidenceStatus: 'COMPLETE', finishedAt: new Date() }).where(eq(t.runs.id, made.detail.id))
    return made.detail.id
  }
  async function report(runId: string, config: Partial<ReportConfig> = {}) { return createReport(handle.db, { subject: { kind: 'RUN', runId }, scope: 'run', stage: 'final', config, idempotencyKey: newId() }, actor()) }
  async function worker() { const identity = { workerId: `report-${newId()}`, instanceId: newId() }; await registerWorker(handle.db, { ...identity, capacity: 1, maxSessions: 1, lostAfterSeconds: 120, protocolCapabilities: [EXPORT_ARTIFACTS_PROTOCOL] }); return identity }
  async function claim(identity: Awaited<ReturnType<typeof worker>>) { const [job] = await claimExportJobs(handle.db, identity); expect(job).toBeTruthy(); return { jobId: job!.id, ...identity, claimEpoch: job!.claimEpoch } }
  async function screenshot(runId: string) { const t = schemaFor(handle.db), objectId = newId(), id = newId(); await handle.db.insert(t.storedObjects).values({ id: objectId, runId, ownerKind: 'run', objectKey: `${runId}/${objectId}`, status: 'available', contentType: 'image/png', byteSize: 12, digest: 'sha256:source', retainUntil: new Date(Date.now() + 86400_000) }); await handle.db.insert(t.evidences).values({ id, runId, type: 'screenshot', status: 'available', objectId, digest: 'sha256:source', byteSize: 12 }); return { id, objectId } }
  async function suite(auto = false, profileId?: string) {
    const s = await scenario()
    const definition = await createSuite(handle.db, { targetId, name: `系统巡检 ${newId()}`, document: { schemaVersion: 1, groups: [{ id: 'orders', name: '订单检查' }], sharedInput: {}, members: [{ memberId: 'one', ordinal: 0, groupId: 'orders', scenarioId: s.id, scenarioVersionId: s.published!.versionId, input: {} }], failurePolicy: 'continue', autoGenerateFinalReport: auto, reportProfileId: profileId } }, actor())
    await publishSuite(handle.db, definition.id, { expectedRevision: definition.draft.revision, idempotencyKey: newId() }, actor())
    return (await createSuiteRun(handle.db, { suiteId: definition.id, idempotencyKey: newId() }, actor())).observation
  }
  async function summary(id: string) { return createReport(handle.db, { subject: { kind: 'SUITE_RUN', suiteRunId: id }, scope: 'suite_summary', stage: 'phase', config: { screenshotScope: 'none' }, idempotencyKey: newId() }, actor()) }
  async function output(grant: Awaited<ReturnType<typeof claim>>, kind: 'report_pdf' | 'report_docx' = 'report_pdf') { const a = await reserveExportArtifact(handle.db, grant, { kind, fileName: 'report.pdf', contentType: 'application/pdf' }); await attachArtifactBytes(handle.db, { artifactId: a.id, byteSize: 12, digest: 'sha256:render' }); return a.id }

  it('配置档 OCC、不可变版本和新运行冻结：修改后旧报告仍使用旧标题', async () => {
    const s = await scenario(), profile = await saveReportProfile(handle.db, null, { targetId, name: newId(), config: { ...DEFAULT_REPORT_CONFIG, title: '第一版 {scenarioName}', includeEvidenceIndex: false, includeAttemptHistory: false }, editScope: 'scenario' }, actor())
    await saveScenarioReportDefaults(handle.db, s.id, { profileId: profile.id, expectedRevision: 0 }, actor())
    const oldRun = await run(s.id)
    await saveReportProfile(handle.db, profile.id, { targetId, name: profile.name, config: { ...profile.config, title: '第二版 {scenarioName}', includeEvidenceIndex: true }, expectedRevision: 1, editScope: 'scenario' }, actor())
    await expect(saveReportProfile(handle.db, profile.id, { targetId, name: profile.name, config: profile.config, expectedRevision: 1, editScope: 'scenario' }, actor())).rejects.toMatchObject({ code: 'REPORT_PROFILE_REVISION_CONFLICT' })
    const frozen = await report(oldRun)
    expect(frozen.currentRevision!.title).toBe(`第一版 ${s.name}`)
    expect(frozen.currentRevision!.config).toMatchObject({ includeEvidenceIndex: false, includeAttemptHistory: false })
    expect((await report(await run(s.id))).currentRevision!.title).toBe(`第二版 ${s.name}`)
    expect((await listReportProfileVersions(handle.db, profile.id, {}, actorId)).items.map((item) => item.revision)).toEqual([2, 1])
  })

  it('取材前清理保留缺项；已复制材料封存后不随原图变化', async () => {
    const id = await run(), a = await screenshot(id), b = await screenshot(id)
    const made = await report(id, { screenshotScope: 'selected', selectedEvidenceIds: [a.id, b.id] })
    expect(made.currentRevision!.sealedAt).toBeNull()
    const identity = await worker(), grant = await claim(identity), t = schemaFor(handle.db)
    await handle.db.update(t.storedObjects).set({ deleteRequestedAt: new Date() }).where(eq(t.storedObjects.id, a.objectId))
    const rows = await getExportMaterials(handle.db, grant)
    expect(rows.find((row) => row.evidenceId === a.id)!.sourceAvailable).toBe(false)
    await commitReportMaterial(handle.db, grant, { materialId: rows.find((row) => row.evidenceId === a.id)!.id, missingReason: '原图已清理' })
    const copy = await reserveExportArtifact(handle.db, grant, { kind: 'report_material', fileName: 'copy.jpg', contentType: 'image/jpeg' })
    await attachArtifactBytes(handle.db, { artifactId: copy.id, byteSize: 9, digest: 'sha256:copy' })
    await expect(commitReportMaterial(handle.db, grant, { materialId: rows.find((row) => row.evidenceId === b.id)!.id, artifactId: copy.id, byteSize: 9, digest: 'sha256:wrong', width: 20, height: 20 })).rejects.toMatchObject({ code: 'REPORT_MATERIAL_INVALID' })
    await commitReportMaterial(handle.db, grant, { materialId: rows.find((row) => row.evidenceId === b.id)!.id, artifactId: copy.id, byteSize: 9, digest: 'sha256:copy', width: 20, height: 20 })
    await finishReportMaterials(handle.db, grant)
    const sealed = await loadReportRevisionDocument(handle.db, made.currentRevision!.id)
    expect(sealed.revision.contentCompleteness).toBe('partial'); expect(sealed.revision.document!.materials).toHaveLength(2)
    const digest = sealed.revision.documentDigest
    await handle.db.update(t.storedObjects).set({ deleteRequestedAt: new Date() }).where(eq(t.storedObjects.id, b.objectId))
    expect((await loadReportRevisionDocument(handle.db, made.currentRevision!.id)).revision.documentDigest).toBe(digest)
  })

  it('取消取材使旧持有者不能发布，重试不创建任何业务运行', async () => {
    const id = await run(), image = await screenshot(id), made = await report(id, { screenshotScope: 'selected', selectedEvidenceIds: [image.id] })
    const identity = await worker(), grant = await claim(identity), t = schemaFor(handle.db)
    const before = await handle.db.select({ id: t.runs.id }).from(t.runs)
    await cancelExportJob(handle.db, grant.jobId, actor())
    await expect(finishReportMaterials(handle.db, grant)).rejects.toMatchObject({ code: 'EXPORT_CLAIM_LOST' })
    const retry = await retryExportJob(handle.db, grant.jobId, newId(), actor())
    expect(retry.retryCount).toBe(1)
    const next = await claim(identity), material = (await getExportMaterials(handle.db, next))[0]!
    await commitReportMaterial(handle.db, next, { materialId: material.id, missingReason: '本次材料不可用' }); await finishReportMaterials(handle.db, next)
    expect((await getReport(handle.db, made.id)).currentRevision!.sealedAt).toBeTruthy()
    expect(await handle.db.select({ id: t.runs.id }).from(t.runs)).toEqual(before)
  })

  it('同一修订和格式只发布一份有效产物，未使用的重复对象登记清理', async () => {
    const made = await report(await run()), identity = await worker(), t = schemaFor(handle.db)
    const ids = []
    for (let index = 0; index < 2; index++) {
      await enqueueReportExport(handle.db, made.id, made.currentRevision!.id, ['pdf'], actor(), newId())
      const grant = await claim(identity), artifactId = await output(grant); ids.push(artifactId)
      await completeExportJob(handle.db, { ...grant, artifactIds: [artifactId], status: 'complete' })
    }
    expect((await getCachedReportArtifacts(handle.db, made.currentRevision!.id, ['pdf'], actorId))[0]!.artifact.id).toBe(ids[0])
    expect((await handle.db.select().from(t.storedObjects).where(eq(t.storedObjects.artifactId, ids[1]!)))[0]!.deleteRequestedAt).toBeTruthy()
  })

  it('报告包固定总子修订与取数时间，部分格式失败可重试，删除总报告撤销所有派生件', async () => {
    const parent = await suite(), made = await summary(parent.id), revision = made.currentRevision!.id, identity = await worker()
    expect((await loadReportRevisionDocument(handle.db, revision)).revision.document!.source.groups).toEqual([{ id: 'orders', name: '订单检查' }])
    const child = await deriveMemberReport(handle.db, revision, { memberId: 'one', config: { title: '独立子标题' }, idempotencyKey: newId() }, actor())
    const childDocument = await loadReportRevisionDocument(handle.db, child.currentRevision!.id)
    expect(childDocument.revision.parentReportRevisionId).toBe(revision)
    expect(childDocument.revision.document!.asOf).toBe((await loadReportRevisionDocument(handle.db, revision)).revision.document!.asOf)
    const request = { reportRevisionId: revision, formats: ['pdf' as const], includeChildReports: true, idempotencyKey: newId() }
    const bundle = await createReportBundle(handle.db, request, actor())
    expect((await createReportBundle(handle.db, request, actor())).id).toBe(bundle.id)
    const first = await claim(identity); await completeExportJob(handle.db, { ...first, artifactIds: [await output(first)], status: 'complete' })
    const second = await claim(identity); await completeExportJob(handle.db, { ...second, artifactIds: [], status: 'failed', error: '模拟单格式故障' })
    const packed = await claim(identity); expect(packed.jobId).toBe(bundle.id)
    const files = await getReportBundleFiles(handle.db, packed)
    expect(files.entries).toHaveLength(2); expect(files.entries.flatMap((entry) => entry.files)).toHaveLength(1)
    await completeExportJob(handle.db, { ...packed, artifactIds: [], status: 'failed', error: '模拟打包故障' })
    const retry = await retryExportJob(handle.db, packed.jobId, newId(), actor())
    expect(retry.status).toBe('queued')
    await deleteReport(handle.db, made.id, actor())
    await expect(getReport(handle.db, child.id, actorId)).rejects.toMatchObject({ code: 'REPORT_NOT_FOUND' })
  })

  it('完成后自动报告只生成一次，等证据结算且冻结配置；撤权失败与运行结论分离', async () => {
    const profile = await saveReportProfile(handle.db, null, { targetId, name: newId(), config: { ...DEFAULT_REPORT_CONFIG, title: '冻结总报告' }, editScope: 'suite' }, actor())
    const parent = await suite(true, profile.id), t = schemaFor(handle.db)
    await saveReportProfile(handle.db, profile.id, { targetId, name: profile.name, config: { ...profile.config, title: '新配置' }, expectedRevision: 1, editScope: 'suite' }, actor())
    await handle.db.update(t.runs).set({ status: 'SUCCEEDED', evidenceStatus: 'PENDING', outcomeStatus: 'PASS', finishedAt: new Date() }).where(eq(t.runs.id, parent.items[0]!.childRunId))
    await advanceSuiteRun(handle.db, parent.id); await generateDueSuiteReports(handle.db)
    expect((await handle.db.select().from(t.suiteReportTriggers).where(eq(t.suiteReportTriggers.suiteRunId, parent.id)))[0]!.status).toBe('pending')
    await handle.db.update(t.runs).set({ evidenceStatus: 'COMPLETE' }).where(eq(t.runs.id, parent.items[0]!.childRunId)); await advanceSuiteRun(handle.db, parent.id)
    await Promise.all([generateDueSuiteReports(handle.db), generateDueSuiteReports(handle.db)])
    const trigger = (await handle.db.select().from(t.suiteReportTriggers).where(eq(t.suiteReportTriggers.suiteRunId, parent.id)))[0]!
    expect(trigger.status).toBe('created'); expect((await getReport(handle.db, trigger.reportId!)).currentRevision!.title).toBe('冻结总报告')
    expect((await handle.db.select().from(t.reports).where(eq(t.reports.suiteRunId, parent.id)))).toHaveLength(1)
    const revoked = await suite(true)
    await handle.db.update(t.runs).set({ status: 'SUCCEEDED', outcomeStatus: 'PASS', evidenceStatus: 'COMPLETE', finishedAt: new Date() }).where(eq(t.runs.id, revoked.items[0]!.childRunId)); await advanceSuiteRun(handle.db, revoked.id)
    await handle.db.update(t.consoleAccounts).set({ status: 'disabled' }).where(eq(t.consoleAccounts.id, actorId)); await generateDueSuiteReports(handle.db)
    expect((await handle.db.select().from(t.suiteReportTriggers).where(eq(t.suiteReportTriggers.suiteRunId, revoked.id)))[0]!.status).toBe('failed')
    expect((await handle.db.select().from(t.suiteRuns).where(eq(t.suiteRuns.id, revoked.id)))[0]!.verdict).toBe('all_pass')
  })

  it('导出硬并发上限、失联接管和期限回收不会容许旧持有者提交', async () => {
    const made = await report(await run()), t = schemaFor(handle.db)
    for (let index = 0; index < 6; index++) await enqueueReportExport(handle.db, made.id, made.currentRevision!.id, ['pdf'], actor(), newId())
    const identities = await Promise.all(Array.from({ length: 5 }, () => worker()))
    const claims = await Promise.all(identities.map((identity) => claimExportJobs(handle.db, { ...identity, limit: 8 })))
    expect(claims.flat()).toHaveLength(4); expect(claims.every((jobs) => jobs.length <= 1)).toBe(true)
    const index = claims.findIndex((jobs) => jobs.length), old = claims[index]![0]!, owner = identities[index]!
    expect(await claimExportJobs(handle.db, owner)).toHaveLength(0)
    const orphan = await reserveExportArtifact(handle.db, { jobId: old.id, ...owner, claimEpoch: old.claimEpoch }, { kind: 'report_pdf', fileName: 'uncommitted.pdf', contentType: 'application/pdf' })
    await attachArtifactBytes(handle.db, { artifactId: orphan.id, byteSize: 12, digest: 'sha256:orphan' })
    await handle.db.update(t.exportJobs).set({ leaseUntil: new Date(0) }).where(eq(t.exportJobs.id, old.id))
    const next = (await claimExportJobs(handle.db, identities[claims.findIndex((jobs) => !jobs.length)]!))[0]!
    expect(next.id).toBe(old.id); expect(next.claimEpoch).toBe(old.claimEpoch + 1)
    expect(await completeExportJob(handle.db, { jobId: old.id, ...owner, claimEpoch: old.claimEpoch, artifactIds: [orphan.id], status: 'complete' })).toBe(false)
    await handle.db.update(t.exportJobs).set({ leaseUntil: new Date(0), deadlineAt: new Date(0) }).where(eq(t.exportJobs.id, old.id))
    await claimExportJobs(handle.db, owner)
    expect((await getExportJob(handle.db, old.id)).status).toBe('failed')
    expect((await handle.db.select().from(t.storedObjects).where(eq(t.storedObjects.artifactId, orphan.id)))[0]!.deleteRequestedAt).toBeTruthy()
  })

  it('新产物遇到活跃旧协议节点时拒绝写入', async () => {
    const id = await run(), identity = await worker(), t = schemaFor(handle.db)
    await handle.db.update(t.workers).set({ protocolCapabilities: ['export-artifacts@1'] }).where(eq(t.workers.id, identity.workerId))
    await expect(report(id)).rejects.toMatchObject({ code: 'REPORT_DEPLOYMENT_NOT_READY' })
  })

  it('删除运行的预览、清理状态和重试包含报告产物，不提前宣称清理完成', async () => {
    const id = await run(), original = await screenshot(id), made = await report(id, { screenshotScope: 'none' })
    const identity = await worker(), t = schemaFor(handle.db)
    await enqueueReportExport(handle.db, made.id, made.currentRevision!.id, ['pdf'], actor(), newId())
    const grant = await claim(identity), fileId = await output(grant)
    await completeExportJob(handle.db, { ...grant, artifactIds: [fileId], status: 'complete' })
    expect((await previewDeleteRun(handle.db, id)).counts).toMatchObject({ storedObjects: 2, reports: 1, totalBytes: 24 })
    await deleteRun(handle.db, id, actor())
    await handle.db.update(t.storedObjects).set({ status: 'purged', purgedAt: new Date() }).where(eq(t.storedObjects.id, original.objectId))
    const progress = await getRunCleanupStatus(handle.db, id)
    expect(progress).toMatchObject({ status: 'in_progress', totalObjects: 2, purgedObjects: 1 })
    await handle.db.update(t.storedObjects).set({ purgeAttempts: 3, lastPurgeErrorAt: new Date() }).where(eq(t.storedObjects.artifactId, fileId))
    await retryRunCleanup(handle.db, id, actor())
    expect((await handle.db.select().from(t.storedObjects).where(eq(t.storedObjects.artifactId, fileId)))[0]!.purgeAttempts).toBe(0)
  })

  it('没有运行的目标仍会计量、清除和重试品牌 Logo，未知字节独立统计', async () => {
    const t = schemaFor(handle.db), logoTarget = newId()
    await handle.db.insert(t.targets).values({ id: logoTarget, code: logoTarget, name: '仅品牌素材', entryUrl: 'https://example.com' })
    const logo = await reserveReportLogo(handle.db, { targetId: logoTarget, editScope: 'scenario', fileName: 'logo.png' }, actor())
    await attachArtifactBytes(handle.db, { artifactId: logo.id, byteSize: 12, digest: 'sha256:logo' })
    await handle.db.update(t.storedObjects).set({ byteSize: null }).where(eq(t.storedObjects.artifactId, logo.id))
    const store = new TargetsStore(expose(handle), () => Buffer.from('unused'))
    const account = { id: actorId, displayName: '交付验收', email: `${actorId}@example.com`, status: 'active' as const, roles: [], permissions: [] }
    expect((await store.previewDeleteTarget(logoTarget)).counts).toMatchObject({ runs: 0, storedObjects: 1, unknownByteObjects: 1 })
    expect(await store.deleteTarget(logoTarget, account)).toMatchObject({ status: 'pending', totalObjects: 1, unknownByteObjects: 1 })
    await handle.db.update(t.storedObjects).set({ purgeAttempts: 3, lastPurgeErrorAt: new Date() }).where(eq(t.storedObjects.artifactId, logo.id))
    await store.retryTargetCleanup(logoTarget, account)
    const [object] = await handle.db.select().from(t.storedObjects).where(eq(t.storedObjects.artifactId, logo.id))
    expect(object!.deleteRequestedAt).toBeTruthy(); expect(object!.purgeAttempts).toBe(0)
  })

  it.skipIf(!DRIVERS.includes('mysql'))('跨库转储保留报告、配置版本、材料关系、固定包清单与实际文件摘要', async () => {
    const t = schemaFor(handle.db)
    await handle.db.update(t.storedObjects).set({ status: 'purged', purgedAt: new Date() })
    const made = await report(await run()), identity = await worker()
    await enqueueReportExport(handle.db, made.id, made.currentRevision!.id, ['pdf'], actor(), newId())
    const grant = await claim(identity), bytes = Buffer.from('report-transfer-fixture'), digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const file = await reserveExportArtifact(handle.db, grant, { kind: 'report_pdf', fileName: '中文报告.pdf', contentType: 'application/pdf' })
    await attachArtifactBytes(handle.db, { artifactId: file.id, byteSize: bytes.length, digest })
    await completeExportJob(handle.db, { ...grant, artifactIds: [file.id], status: 'complete' })
    await handle.db.update(t.workers).set({ status: 'STOPPED' })
    await handle.db.update(t.runs).set({ status: 'CANCELLED', finishedAt: new Date(), evidenceStatus: 'COMPLETE' }).where(inArray(t.runs.status, ['QUEUED', 'RUNNING']))
    const target = await openContractDb(driver === 'postgres' ? 'mysql' : 'postgres')
    try {
      const options = { writersStopped: true as const, allowMillisecondPrecisionLoss: true, verifyObject: async (object: { objectKey: string; byteSize: number; digest: string }) => { expect(object.objectKey).toBe(file.objectKey); expect(object.byteSize).toBe(bytes.length); expect(object.digest).toBe(digest) } }
      const archive = await exportDatabase(expose(handle), (handle as Awaited<ReturnType<typeof openContractDb>>).env, options)
      await importDatabase(expose(target), target.env, archive, options)
      const restored = await exportDatabase(expose(target), target.env, options)
      for (const name of ['reports', 'reportRevisions', 'reportSourceSnapshots', 'reportRevisionMaterials', 'reportProfiles', 'reportProfileVersions', 'runReportContexts', 'scenarioReportDefaults', 'exportJobs', 'artifacts', 'reportRevisionOutputs', 'suiteReportTriggers']) expect(restored.tables[name]).toEqual(archive.tables[name])
    } finally { await target.close() }
  })
})
