import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../client.js'
import { atomic, schemaFor } from '../native.js'
import { assertTargetPermission, lockConsoleAuthorization } from '../console/target-authorization.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { cursorFilter, paginateResults } from '../cursor.js'
import { createArtifact } from '../objects/artifacts.js'
import { getArtifact } from '../objects/artifacts.js'
import { REPORT_LIMITS, type CreateReportBody } from '@cairn/shared'
import { assertReportEditor } from './profiles.js'
import { captureSource, getExportJob, getReport, toRevision } from './reports.js'
import { reportScreenshotRefs } from './materials.js'

export async function getReportSourceOptions(db: Db, subject: CreateReportBody['subject'], actorId: string) {
  return atomic(db, async (tx) => {
    const captured = await captureSource(tx, subject, actorId)
    await assertTargetPermission(tx, actorId, captured.targetId, 'report:read')
    return { targetId: captured.targetId, config: captured.defaults, screenshots: reportScreenshotRefs(captured.payload), canGenerateFinal: captured.terminal && !captured.evidencePending }
  })
}

export async function listReportRevisions(db: Db, reportId: string, actorId: string, cursor?: string) {
  await getReport(db, reportId, actorId)
  const { reportRevisions } = schemaFor(db)
  const rows = await db.select().from(reportRevisions).where(and(eq(reportRevisions.reportId, reportId), cursorFilter(reportRevisions.createdAt, reportRevisions.id, cursor))).orderBy(desc(reportRevisions.createdAt), desc(reportRevisions.id)).limit(21)
  const page = paginateResults(rows, 20)
  return { items: page.items.map(toRevision), nextCursor: page.nextCursor }
}

export async function listReportExportJobs(db: Db, reportId: string, actorId: string, cursor?: string) {
  await getReport(db, reportId, actorId)
  const { exportJobs } = schemaFor(db)
  const rows = await db.select().from(exportJobs).where(and(eq(exportJobs.reportId, reportId), cursorFilter(exportJobs.createdAt, exportJobs.id, cursor))).orderBy(desc(exportJobs.createdAt), desc(exportJobs.id)).limit(21)
  const page = paginateResults(rows, 20)
  return { items: await Promise.all(page.items.map((row) => getExportJob(db, row.id, actorId))), nextCursor: page.nextCursor }
}

export async function reserveReportLogo(db: Db, input: { targetId: string; editScope: 'scenario' | 'suite'; fileName: string }, actor: AuditActor) {
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actor.id)
    await assertReportEditor(tx, input.targetId, actor.id, input.editScope)
    const reserved = await createArtifact(tx, { targetId: input.targetId, actorId: actor.id, fileName: input.fileName, kind: 'brand_logo', contentType: 'image/png', retainUntil: new Date(Date.now() + 365 * 86400_000) })
    await recordAudit(tx, actor, 'report.asset.upload', 'artifact', reserved.id, '上传报告品牌图片')
    return reserved
  })
}

export async function recordReportDownload(db: Db, artifactId: string, actor: AuditActor) {
  await getArtifact(db, artifactId, actor.id, 'report:export')
  await recordAudit(db, actor, 'report.download', 'artifact', artifactId, '下载报告产物')
}
