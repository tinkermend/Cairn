import { and, eq, inArray } from 'drizzle-orm'
import {
  artifactDtoSchema,
  artifactObjectKeyFor,
  type ArtifactDto,
  type ArtifactKind,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, schemaFor, updateRows } from '../native.js'
import { notFound } from '../runs/errors.js'
import { assertTargetPermission } from '../console/target-authorization.js'
import { getReport } from '../reports/reports.js'

export async function createArtifact(
  db: Db,
  input: {
    targetId: string
    kind: ArtifactKind
    fileName: string
    contentType: string
    retainUntil: Date
    actorId?: string
    exportJobId?: string
    reportRevisionId?: string
  },
) {
  const id = newId()
  const objectId = newId()
  const objectKey = artifactObjectKeyFor(id, objectId)
  await atomic(db, async (tx) => {
    const { artifacts, storedObjects } = schemaFor(tx)
    await tx.insert(artifacts).values({
      id,
      targetId: input.targetId,
      kind: input.kind,
      fileName: input.fileName,
      contentType: input.contentType,
      retainUntil: input.retainUntil,
      createdByConsoleAccountId: input.actorId ?? null,
      exportJobId: input.exportJobId,
      reportRevisionId: input.reportRevisionId,
    })
    await tx.insert(storedObjects).values({
      id: objectId,
      objectKey,
      ownerKind: 'artifact',
      artifactId: id,
      status: 'pending',
      contentType: input.contentType,
      retainUntil: input.retainUntil,
    })
  })
  return { id, objectId, objectKey }
}

export async function getArtifact(
  db: Db,
  artifactId: string,
  actorId?: string,
  permission: 'report:read' | 'report:export' = 'report:read',
): Promise<ArtifactDto> {
  const { artifacts, storedObjects, exportJobArtifacts, exportJobs } = schemaFor(db)
  const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1)
  if (!artifact) throw notFound('ARTIFACT_NOT_FOUND', '产物不存在')
  if (actorId) await assertTargetPermission(db, actorId, artifact.targetId, permission)
  if (['report_docx', 'report_pdf', 'report_bundle'].includes(artifact.kind)) {
    const [source] = await db.select({ reportId: exportJobs.reportId }).from(exportJobArtifacts)
      .innerJoin(exportJobs, eq(exportJobs.id, exportJobArtifacts.jobId))
      .where(and(eq(exportJobArtifacts.artifactId, artifactId), inArray(exportJobs.status, ['complete', 'partial']))).limit(1)
    if (!source?.reportId) throw notFound('ARTIFACT_NOT_AVAILABLE', '产物尚未交付')
    await getReport(db, source.reportId, actorId)
  } else if (artifact.kind === 'report_material') {
    // Internal materials are not standalone downloads.
    throw notFound('ARTIFACT_NOT_AVAILABLE', '请通过报告访问材料')
  }
  const [object] = await db
    .select()
    .from(storedObjects)
    .where(and(eq(storedObjects.artifactId, artifactId), eq(storedObjects.ownerKind, 'artifact')))
    .limit(1)
  return artifactDtoSchema.parse({
    id: artifact.id,
    kind: artifact.kind,
    fileName: artifact.fileName,
    contentType: artifact.contentType,
    byteSize: artifact.byteSize,
    digest: artifact.digest,
    retainUntil: artifact.retainUntil.toISOString(),
    available: object?.status === 'available' && artifact.retainUntil > new Date() && object.retainUntil > new Date() && !object.deleteRequestedAt,
  })
}

export async function getArtifactObject(db: Db, artifactId: string) {
  const metadata = await getArtifact(db, artifactId)
  if (!metadata.available) throw notFound('ARTIFACT_NOT_AVAILABLE', '产物已过期或不可用')
  const { artifacts, storedObjects } = schemaFor(db)
  const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1)
  if (!artifact) throw notFound('ARTIFACT_NOT_FOUND', '产物不存在')
  const [object] = await db
    .select()
    .from(storedObjects)
    .where(and(eq(storedObjects.artifactId, artifactId), eq(storedObjects.ownerKind, 'artifact')))
    .limit(1)
  if (!object || object.status !== 'available') throw notFound('ARTIFACT_NOT_AVAILABLE', '产物尚未就绪')
  return { artifact, object }
}

export async function attachArtifactBytes(
  db: Db,
  input: { artifactId: string; byteSize: number; digest: string; now?: Date },
) {
  const now = input.now ?? new Date()
  return atomic(db, async (tx) => {
    const { artifacts, storedObjects } = schemaFor(tx)
    const updated = await updateRows(tx, storedObjects, {
      status: 'available',
      byteSize: input.byteSize,
      digest: input.digest,
      availableAt: now,
    }, and(eq(storedObjects.artifactId, input.artifactId), eq(storedObjects.status, 'pending')), { id: storedObjects.id })
    if (!updated.length) throw notFound('ARTIFACT_NOT_AVAILABLE', '产物不可写入')
    await tx
    .update(artifacts)
    .set({ byteSize: input.byteSize, digest: input.digest })
    .where(eq(artifacts.id, input.artifactId))
  })
}
