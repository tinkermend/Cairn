import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'

export function targetCleanupObjectFilter(db: Db, targetId: string) {
  const { storedObjects, runs, artifacts } = schemaFor(db)
  return or(
    sql`${storedObjects.runId} IN (SELECT ${runs.id} FROM ${runs} WHERE ${runs.targetId} = ${targetId})`,
    sql`${storedObjects.artifactId} IN (SELECT ${artifacts.id} FROM ${artifacts} WHERE ${artifacts.targetId} = ${targetId})`,
  )!
}

export async function runCleanupObjectScope(db: Db, runId: string) {
  const { reports, suiteRunItems, storedObjects } = schemaFor(db)
  const parents = await db.select({ id: suiteRunItems.suiteRunId }).from(suiteRunItems).where(eq(suiteRunItems.childRunId, runId))
  const related = await db.select({ id: reports.id }).from(reports).where(or(eq(reports.runId, runId), parents.length ? inArray(reports.suiteRunId, parents.map((row) => row.id)) : undefined))
  const ownership = await reportTreeOwnership(db, related.map((row) => row.id))
  return { ...ownership, filter: or(eq(storedObjects.runId, runId), ownership.artifactIds.length ? inArray(storedObjects.artifactId, ownership.artifactIds) : undefined)! }
}

export async function reportTreeOwnership(db: Db, rootIds: string[]) {
  if (!rootIds.length) return { reportIds: [], artifactIds: [] }
  const { reportRevisions, exportJobs, artifacts, exportJobArtifacts } = schemaFor(db)
  const ids = new Set(rootIds)
  let frontier = rootIds
  while (frontier.length) {
    const revisions = await db.select({ id: reportRevisions.id }).from(reportRevisions).where(inArray(reportRevisions.reportId, frontier))
    if (!revisions.length) break
    const children = await db.select({ id: reportRevisions.reportId }).from(reportRevisions).where(inArray(reportRevisions.parentReportRevisionId, revisions.map((row) => row.id)))
    frontier = children.map((row) => row.id).filter((id) => !ids.has(id))
    frontier.forEach((id) => ids.add(id))
  }
  const reportIds = [...ids]
  const revisions = await db.select({ id: reportRevisions.id }).from(reportRevisions).where(inArray(reportRevisions.reportId, reportIds))
  const owned = revisions.length ? await db.select({ id: artifacts.id }).from(artifacts).where(inArray(artifacts.reportRevisionId, revisions.map((row) => row.id))) : []
  const legacy = await db.select({ id: exportJobArtifacts.artifactId }).from(exportJobArtifacts).innerJoin(exportJobs, eq(exportJobs.id, exportJobArtifacts.jobId)).where(inArray(exportJobs.reportId, reportIds))
  const artifactIds = [...new Set([...owned, ...legacy].map((row) => row.id))]
  return { reportIds, artifactIds }
}

/** Revocation follows derived revisions, without touching Run facts or original Evidence. */
export async function revokeReportTrees(db: Db, rootIds: string[], markDeleted = true) {
  if (!rootIds.length) return
  const { reports, exportJobs, storedObjects } = schemaFor(db)
  const { reportIds, artifactIds } = await reportTreeOwnership(db, rootIds), now = new Date()
  if (markDeleted) await db.update(reports).set({ deletedAt: now }).where(and(inArray(reports.id, reportIds), isNull(reports.deletedAt)))
  await db.update(exportJobs).set({ status: 'cancelled', error: '报告或来源已删除', leaseUntil: null, updatedAt: now }).where(and(inArray(exportJobs.reportId, reportIds), inArray(exportJobs.status, ['queued', 'running'])))
  if (artifactIds.length) await db.update(storedObjects).set({ deleteRequestedAt: now }).where(inArray(storedObjects.artifactId, artifactIds))
}
