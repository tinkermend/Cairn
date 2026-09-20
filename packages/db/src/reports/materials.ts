import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { REPORT_LIMITS, reportDocumentSchema, type JsonValue, type ReportConfig, type ReportMaterialDto } from '@cairn/shared'
import type { Db } from '../client.js'
import { atomic, locked, schemaFor } from '../native.js'
import { newId } from '../id.js'
import { badRequest, conflict, notFound } from '../runs/errors.js'
import { sha256Hex } from '../runs/digest.js'
import { createArtifact } from '../objects/artifacts.js'
import { cleanupUnusedJobArtifacts, guardExportJob, insertExportJob, type ExportGrant } from './reports.js'

type EvidenceRef = { evidenceId: string; runId: string; caption: string; anomalous: boolean; status: string; digest: string | null }
const object = (value: JsonValue | undefined): Record<string, JsonValue> => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const array = (value: JsonValue | undefined): Array<Record<string, JsonValue>> => Array.isArray(value) ? value.map(object) : []

export function reportScreenshotRefs(source: Record<string, JsonValue>): EvidenceRef[] {
  if (source.kind === 'SUITE_RUN') return array(source.items).flatMap((member) => reportScreenshotRefs(object(member.run)))
  const steps = new Map(array(source.stepRuns).map((step) => [String(step.id), step]))
  return array(source.evidence).filter((evidence) => evidence.type === 'screenshot').map((evidence) => {
    const step = steps.get(String(evidence.stepRunId))
    const anomalous = !!step && (['FAILED', 'NEEDS_REVIEW', 'CANCELLED'].includes(String(step.status)) || ['FAIL', 'WARN', 'UNKNOWN'].includes(String(step.outcomeStatus)) || array(step.attempts).some((attempt) => !!attempt.error))
    return { evidenceId: String(evidence.evidenceId), runId: String(source.runId), status: String(evidence.status), digest: typeof evidence.digest === 'string' ? evidence.digest : null,
      caption: `${String(source.scenarioName ?? '场景')} · ${String(step?.name ?? '运行截图')}`, anomalous }
  })
}

export async function prepareReportMaterials(db: Db, input: { reportId: string; revisionId: string; targetId: string; source: Record<string, JsonValue>; config: ReportConfig; actorId: string }) {
  const { reportRevisionMaterials, evidences, storedObjects, artifacts } = schemaFor(db)
  const all = reportScreenshotRefs(input.source)
  const selectedIds = new Set(input.config.selectedEvidenceIds ?? [])
  if (input.config.screenshotScope === 'selected' && [...selectedIds].some((id) => !all.some((item) => item.evidenceId === id))) throw badRequest('REPORT_EVIDENCE_OUT_OF_SCOPE', '选中的截图不属于本次报告来源')
  const selected = input.config.screenshotScope === 'none' ? [] : all.filter((item) => input.config.screenshotScope === 'selected' ? selectedIds.has(item.evidenceId) : item.anomalous)
  if (selected.length > REPORT_LIMITS.screenshots) throw badRequest('REPORT_MATERIAL_LIMIT', `截图超过 ${REPORT_LIMITS.screenshots} 张，请手动调整选图范围`)
  let totalBytes = 0, pending = 0
  for (const item of selected) {
    const [source] = await db.select({ evidence: evidences, object: storedObjects }).from(evidences).leftJoin(storedObjects, eq(storedObjects.id, evidences.objectId)).where(eq(evidences.id, item.evidenceId)).limit(1)
    const bytes = source?.object?.byteSize
    if (bytes != null) totalBytes += bytes
    if (bytes != null && bytes > REPORT_LIMITS.imageBytes) throw badRequest('REPORT_IMAGE_LIMIT', '单张截图超过 8 MiB，请减少截图范围或使用较小截图')
    const available = item.status === 'available' && source?.object?.status === 'available' && !source.object.deleteRequestedAt && source.object.retainUntil > new Date()
    if (available) pending++
    await db.insert(reportRevisionMaterials).values({ id: newId(), revisionId: input.revisionId, kind: 'screenshot', evidenceId: item.evidenceId, runId: item.runId, sourceObjectId: source?.object?.id ?? null,
      sourceDigest: item.digest ?? source?.object?.digest ?? null, status: available ? 'pending' : 'missing', missingReason: available ? null : '来源截图尚未上传、已过期或已被清理', caption: item.caption, byteSize: bytes ?? null })
  }
  if (input.config.logoArtifactId) {
    const [source] = await db.select({ artifact: artifacts, object: storedObjects }).from(artifacts).innerJoin(storedObjects, eq(storedObjects.artifactId, artifacts.id)).where(and(eq(artifacts.id, input.config.logoArtifactId), eq(artifacts.targetId, input.targetId), eq(artifacts.kind, 'brand_logo'))).limit(1)
    const available = source?.object.status === 'available' && !source.object.deleteRequestedAt && source.object.retainUntil > new Date()
    totalBytes += source?.object.byteSize ?? 0
    if (available) pending++
    await db.insert(reportRevisionMaterials).values({ id: newId(), revisionId: input.revisionId, kind: 'logo', sourceArtifactId: input.config.logoArtifactId, sourceObjectId: source?.object.id ?? null, sourceDigest: source?.object.digest ?? null, caption: '组织标识', status: available ? 'pending' : 'missing', missingReason: available ? null : 'Logo 已不可用' })
  }
  if (totalBytes > REPORT_LIMITS.materialBytes) throw badRequest('REPORT_MATERIAL_LIMIT', '报告材料超过 512 MiB，请减少所选截图')
  if (pending) await insertExportJob(db, { kind: 'report_materialize', reportId: input.reportId, revisionId: input.revisionId, targetId: input.targetId, actorId: input.actorId, key: `materials:${input.revisionId}`, manifest: { revisionId: input.revisionId } })
  else await sealReportMaterials(db, input.revisionId)
}

export async function sealReportMaterials(db: Db, revisionId: string) {
  const { reportRevisions, reportRevisionMaterials } = schemaFor(db)
  const [revision] = await locked(db, db.select().from(reportRevisions).where(eq(reportRevisions.id, revisionId)))
  if (!revision || revision.sealedAt) return
  const rows = await db.select().from(reportRevisionMaterials).where(eq(reportRevisionMaterials.revisionId, revisionId)).orderBy(asc(reportRevisionMaterials.id))
  if (rows.some((row) => row.status === 'pending')) throw conflict('REPORT_MATERIAL_PENDING', '报告材料仍在准备')
  const materials: ReportMaterialDto[] = rows.filter((row) => row.kind !== 'index').map((row) => ({ id: row.id, kind: row.kind as 'screenshot' | 'logo', evidenceId: row.evidenceId, artifactId: row.artifactId, runId: row.runId, caption: row.caption, digest: row.digest, width: row.width, height: row.height, missingReason: row.missingReason }))
  const base = reportDocumentSchema.parse(revision.document)
  const gaps = [...new Set([...base.gaps, ...materials.filter((row) => row.missingReason).map((row) => `${row.caption}：${row.missingReason}`)])]
  const document = reportDocumentSchema.parse({ ...base, identity: { reportId: revision.reportId, revisionId: revision.id, revisionNo: revision.revisionNo, parentRevisionId: revision.parentReportRevisionId }, generatedAt: new Date().toISOString(), materials, gaps })
  await db.update(reportRevisions).set({ document, documentDigest: sha256Hex(document), sealedAt: new Date(), preparationError: null, contentCompleteness: gaps.length ? 'partial' : 'complete' }).where(eq(reportRevisions.id, revisionId))
}

export async function getExportMaterials(db: Db, grant: ExportGrant) {
  const job = await guardExportJob(db, grant)
  const { reportRevisionMaterials, storedObjects } = schemaFor(db)
  if (!job.reportRevisionId) throw notFound('REPORT_NOT_FOUND', '任务没有报告修订')
  const rows = await db.select().from(reportRevisionMaterials).where(eq(reportRevisionMaterials.revisionId, job.reportRevisionId)).orderBy(asc(reportRevisionMaterials.id))
  const result = []
  for (const row of rows.filter((item) => item.kind !== 'index')) {
    const objectId = job.kind === 'report_materialize' ? row.sourceObjectId : null
    const [source] = objectId ? await db.select().from(storedObjects).where(eq(storedObjects.id, objectId)).limit(1)
      : row.artifactId ? await db.select().from(storedObjects).where(eq(storedObjects.artifactId, row.artifactId)).limit(1) : []
    result.push({ ...row, objectKey: source?.objectKey ?? null, sourceAvailable: !!source && source.status === 'available' && !source.deleteRequestedAt && source.retainUntil > new Date(), currentByteSize: source?.byteSize ?? null })
  }
  return result
}

export async function reserveExportArtifact(db: Db, grant: ExportGrant, input: { kind: 'report_material' | 'report_docx' | 'report_pdf' | 'report_bundle'; fileName: string; contentType: string }) {
  return atomic(db, async (tx) => {
    const job = await guardExportJob(tx, grant, true)
    const retainUntil = new Date(Date.now() + (input.kind === 'report_bundle' ? REPORT_LIMITS.bundleRetentionHours * 3_600_000 : REPORT_LIMITS.retentionDays * 86_400_000))
    return createArtifact(tx, { ...input, targetId: job.targetId, actorId: job.createdByConsoleAccountId, exportJobId: job.id, reportRevisionId: job.reportRevisionId!, retainUntil })
  })
}

export async function commitReportMaterial(db: Db, grant: ExportGrant, input: { materialId: string; artifactId?: string; digest?: string; byteSize?: number; width?: number; height?: number; missingReason?: string }) {
  return atomic(db, async (tx) => {
    const job = await guardExportJob(tx, grant, true)
    const { reportRevisionMaterials, reportRevisions, artifacts, storedObjects } = schemaFor(tx)
    const [revision] = await locked(tx, tx.select().from(reportRevisions).where(eq(reportRevisions.id, job.reportRevisionId!)))
    if (!revision || revision.sealedAt || job.kind !== 'report_materialize') throw conflict('REPORT_ALREADY_SEALED', '报告材料已封存')
    const [material] = await tx.select().from(reportRevisionMaterials).where(and(eq(reportRevisionMaterials.id, input.materialId), eq(reportRevisionMaterials.revisionId, revision.id))).limit(1)
    if (!material) throw notFound('REPORT_MATERIAL_NOT_FOUND', '材料不属于当前修订')
    if (material.status !== 'pending') return
    if (input.artifactId) {
      const [artifact] = await tx.select({ id: artifacts.id, digest: artifacts.digest, byteSize: artifacts.byteSize }).from(artifacts).innerJoin(storedObjects, eq(storedObjects.artifactId, artifacts.id))
        .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.exportJobId, job.id), eq(artifacts.reportRevisionId, revision.id), eq(artifacts.kind, 'report_material'), eq(artifacts.targetId, job.targetId), eq(storedObjects.status, 'available'), isNull(storedObjects.deleteRequestedAt))).limit(1)
      if (!artifact || !input.digest || !input.width || !input.height || artifact.digest !== input.digest || artifact.byteSize !== input.byteSize || input.byteSize! > REPORT_LIMITS.imageBytes || input.width * input.height > REPORT_LIMITS.imagePixels) throw badRequest('REPORT_MATERIAL_INVALID', '材料摘要、尺寸或归属无效')
    }
    await tx.update(reportRevisionMaterials).set({ artifactId: input.artifactId ?? null, digest: input.digest ?? null, byteSize: input.byteSize ?? material.byteSize, width: input.width ?? null, height: input.height ?? null, status: input.artifactId ? 'ready' : 'missing', missingReason: input.artifactId ? null : (input.missingReason ?? '材料读取失败').slice(0, 256) }).where(eq(reportRevisionMaterials.id, material.id))
    const [total] = await tx.select({ size: sql<number>`COALESCE(SUM(${reportRevisionMaterials.byteSize}), 0)` }).from(reportRevisionMaterials).where(eq(reportRevisionMaterials.revisionId, revision.id))
    if (Number(total?.size ?? 0) > REPORT_LIMITS.materialBytes) throw badRequest('REPORT_MATERIAL_LIMIT', '实际材料超过 512 MiB，请新建修订并减少截图')
  })
}

export async function finishReportMaterials(db: Db, grant: ExportGrant) {
  return atomic(db, async (tx) => {
    const job = await guardExportJob(tx, grant, true)
    if (job.kind !== 'report_materialize' || !job.reportRevisionId) throw badRequest('EXPORT_JOB_KIND_INVALID', '任务类型无效')
    await sealReportMaterials(tx, job.reportRevisionId)
    const { exportJobs, reportRevisions } = schemaFor(tx)
    const [revision] = await tx.select().from(reportRevisions).where(eq(reportRevisions.id, job.reportRevisionId)).limit(1)
    await tx.update(exportJobs).set({ status: 'complete', contentCompleteness: revision!.contentCompleteness, progress: '材料已封存', leaseUntil: null, updatedAt: new Date() }).where(eq(exportJobs.id, job.id))
    await cleanupUnusedJobArtifacts(tx, job.id)
  })
}
