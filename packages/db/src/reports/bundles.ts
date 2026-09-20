import { and, asc, eq } from 'drizzle-orm'
import { createReportBundleBodySchema, deriveMemberReportBodySchema, reportConfigSchema, REPORT_RENDER_VERSION, REPORT_TEMPLATE_VERSION, type CreateReportBundleBody, type DeriveMemberReportBody, type JsonValue } from '@cairn/shared'
import type { Db } from '../client.js'
import type { AuditActor } from '../audit/record.js'
import { recordAudit } from '../audit/record.js'
import { assertTargetPermission, lockConsoleAuthorization } from '../console/target-authorization.js'
import { atomic, locked, schemaFor } from '../native.js'
import { newId } from '../id.js'
import { sha256Hex } from '../runs/digest.js'
import { badRequest, conflict, notFound } from '../runs/errors.js'
import { buildDocument, enqueueReportExport, getCachedReportArtifacts, getExportJob, getReport, guardExportJob, insertExportJob, loadReportRevisionDocument, reportTitle, type ExportGrant } from './reports.js'
import { sealReportMaterials } from './materials.js'

export async function deriveMemberReport(db: Db, parentRevisionId: string, body: DeriveMemberReportBody, actor: AuditActor) {
  const input = deriveMemberReportBodySchema.parse(body)
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actor.id)
    const { reports, reportRevisions, reportSourceSnapshots, reportRevisionMaterials } = schemaFor(tx)
    const loaded = await loadReportRevisionDocument(tx, parentRevisionId, actor.id)
    const parent = loaded.revision
    await assertTargetPermission(tx, actor.id, loaded.report.targetId, 'report:export')
    if (!parent.sealedAt || !parent.document || parent.document.source.kind !== 'SUITE_RUN') throw badRequest('REPORT_NOT_READY', '请先封存集合总报告材料')
    const digest = sha256Hex({ parentRevisionId, ...input })
    const [existing] = await tx.select().from(reports).where(and(eq(reports.createdByConsoleAccountId, actor.id), eq(reports.idempotencyKey, input.idempotencyKey))).limit(1)
    if (existing) {
      if (existing.requestDigest !== digest) throw conflict('REPORT_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同子报告')
      return getReport(tx, existing.id, actor.id)
    }
    const members = parent.document.source.items as Array<Record<string, JsonValue>>
    const member = members.find((item) => item.memberId === input.memberId)
    if (!member?.run || typeof member.run !== 'object' || Array.isArray(member.run)) throw notFound('REPORT_MEMBER_NOT_FOUND', '成员不属于该总报告修订')
    const source = member.run
    if (input.config && ['logoArtifactId', 'screenshotScope', 'selectedEvidenceIds'].some((key) => key in input.config!)) throw badRequest('REPORT_MATERIAL_FROZEN', '派生子报告复用总报告已封存的材料；单独选图请从子运行创建报告')
    const materials = (await tx.select().from(reportRevisionMaterials).where(eq(reportRevisionMaterials.revisionId, parent.id)).orderBy(asc(reportRevisionMaterials.id))).filter((item) => item.kind === 'logo' || item.runId === source.runId)
    const defaults = reportConfigSchema.parse(source.reportDefaults ?? {})
    const config = reportConfigSchema.parse({ ...defaults, ...input.config, logoArtifactId: parent.config.logoArtifactId, screenshotScope: parent.config.screenshotScope, selectedEvidenceIds: materials.flatMap((item) => item.evidenceId ? [item.evidenceId] : []) })
    const title = reportTitle(config, { targetId: loaded.report.targetId, defaults, payload: source, terminal: true, evidencePending: source.evidenceStatus === 'PENDING', titleVars: { systemName: String(source.targetName ?? ''), scenarioName: String(member.displayName ?? source.scenarioName ?? ''), runNumber: String(source.runId).slice(0, 8) } })
    const reportId = newId(), revisionId = newId(), snapshotId = newId()
    await tx.insert(reports).values({ id: reportId, targetId: loaded.report.targetId, subjectKind: 'RUN', runId: String(source.runId), createdByConsoleAccountId: actor.id, idempotencyKey: input.idempotencyKey, requestDigest: digest })
    await tx.insert(reportSourceSnapshots).values({ id: snapshotId, reportId, payload: source, digest: sha256Hex(source), capturedAt: new Date(parent.document.asOf) })
    const gaps = source.evidenceStatus === 'COMPLETE' ? [] : ['本次快照的证据尚不完整']
    if (member.admission === 'SKIPPED' || member.skipReason) gaps.push(`成员未执行：${String(member.skipReason ?? '已跳过')}`)
    const document = { ...buildDocument({ stage: parent.stage, title, config, source, gaps }), asOf: parent.document.asOf }
    await tx.insert(reportRevisions).values({ id: revisionId, reportId, revisionNo: 1, stage: parent.stage, scope: 'run', title, config, templateVersion: REPORT_TEMPLATE_VERSION, renderVersion: REPORT_RENDER_VERSION, sourceSnapshotId: snapshotId, parentReportRevisionId: parent.id, document })
    for (const material of materials) await tx.insert(reportRevisionMaterials).values({ ...material, id: newId(), revisionId })
    await sealReportMaterials(tx, revisionId)
    await recordAudit(tx, actor, 'report.create', 'report', reportId, '从固定总报告修订派生子报告')
    return getReport(tx, reportId, actor.id)
  })
}

export async function createReportBundle(db: Db, body: CreateReportBundleBody, actor: AuditActor) {
  const input = createReportBundleBodySchema.parse(body)
  input.formats = [...new Set(input.formats)].sort()
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actor.id)
    const { exportJobs } = schemaFor(tx)
    const digest = sha256Hex(input)
    const [existing] = await tx.select().from(exportJobs).where(and(eq(exportJobs.createdByConsoleAccountId, actor.id), eq(exportJobs.idempotencyKey, input.idempotencyKey))).limit(1)
    if (existing) {
      if (existing.requestDigest !== digest) throw conflict('EXPORT_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同报告包')
      return getExportJob(tx, existing.id, actor.id)
    }
    const loaded = await loadReportRevisionDocument(tx, input.reportRevisionId, actor.id)
    await assertTargetPermission(tx, actor.id, loaded.report.targetId, 'report:export')
    if (!loaded.revision.sealedAt || loaded.report!.subjectKind !== 'SUITE_RUN') throw badRequest('REPORT_NOT_READY', '请先封存集合总报告材料')
    const entries: Array<Record<string, JsonValue>> = []
    const add = async (reportId: string, revisionId: string, name: string, source: Record<string, JsonValue>) => {
      const job = await enqueueReportExport(tx, reportId, revisionId, input.formats, actor, `bundle-file:${sha256Hex({ key: input.idempotencyKey, revisionId })}`)
      entries.push({ reportId, revisionId, name, jobId: job.id, source })
    }
    await add(loaded.report.id, input.reportRevisionId, '总报告', { suiteRunId: loaded.revision.document!.source.suiteRunId!, suiteVersionId: loaded.revision.document!.source.suiteVersionId! })
    if (input.includeChildReports) {
      const members = loaded.revision.document!.source.items as Array<Record<string, JsonValue>>
      for (const [index, member] of members.entries()) {
        const child = await deriveMemberReport(tx, input.reportRevisionId, { memberId: String(member.memberId), idempotencyKey: `bundle-child:${sha256Hex({ key: input.idempotencyKey, memberId: member.memberId })}` }, actor)
        await add(child.id, child.currentRevision!.id, `${String(index + 1).padStart(2, '0')}_${String(member.displayName ?? '成员')}`, { memberId: member.memberId!, runId: member.childRunId!, scenarioVersionId: member.scenarioVersionId! })
      }
    }
    const job = await insertExportJob(tx, { kind: 'report_bundle', reportId: loaded.report.id, revisionId: input.reportRevisionId, targetId: loaded.report.targetId, actorId: actor.id, key: input.idempotencyKey, manifest: { entries, formats: input.formats, jobIds: entries.map((entry) => entry.jobId!), asOf: loaded.revision.document!.asOf, title: loaded.revision.title } })
    await tx.update(exportJobs).set({ requestDigest: digest }).where(eq(exportJobs.id, job))
    await recordAudit(tx, actor, 'report.bundle', 'report', loaded.report.id, `打包 ${entries.length} 份固定报告修订`)
    return getExportJob(tx, job, actor.id)
  })
}

export async function getReportBundleFiles(db: Db, grant: ExportGrant) {
  const job = await guardExportJob(db, grant)
  if (job.kind !== 'report_bundle') throw badRequest('EXPORT_JOB_KIND_INVALID', '不是报告包任务')
  const entries = job.sourceManifest.entries as Array<{ reportId: string; revisionId: string; name: string; jobId: string; source?: Record<string, JsonValue> }>
  const result = []
  for (const entry of entries) {
    await getReport(db, entry.reportId, job.createdByConsoleAccountId)
    const dependency = await getExportJob(db, entry.jobId, job.createdByConsoleAccountId)
    const files = await getCachedReportArtifacts(db, entry.revisionId, job.sourceManifest.formats as Array<'docx' | 'pdf'>, job.createdByConsoleAccountId)
    result.push({ ...entry, files, error: dependency.error, status: dependency.status })
  }
  return { manifest: job.sourceManifest, entries: result }
}
