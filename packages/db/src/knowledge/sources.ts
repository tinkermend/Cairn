import { and, eq } from 'drizzle-orm'
import { knowledgeSourceRefSchema, mapReleaseManifestSchema, type KnowledgeSourceRef } from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { getMapFact } from '../map/facts.js'
import { requireMapAsset } from '../map/view.js'
import { knowledgeNotFound } from './errors.js'

/** Ownership is checked even for trusted internal callers; access is supplied by the API. */
export async function validateKnowledgeSources(db: Db, targetId: string, sources: readonly KnowledgeSourceRef[], access?: {
  runRead: boolean; workflowRead: boolean; moduleRead: boolean; scenarioId?: string
}) {
  const tables = schemaFor(db)
  for (const value of sources) {
    const source = knowledgeSourceRefSchema.parse(value)
    if (source.kind === 'map_asset') {
      await requireMapAsset(db, targetId, source.assetRef)
      if (source.mapReleaseId) {
        const [release] = await db.select().from(tables.mapReleases).where(eq(tables.mapReleases.id, source.mapReleaseId)).limit(1)
        if (!release || release.targetId !== targetId || !mapReleaseManifestSchema.parse(release.manifest).items.some(item =>
          Object.entries(source.assetRef).every(([key, value]) => (key === 'targetId' ? release.targetId : (item as Record<string, unknown>)[key]) === value)
        )) knowledgeNotFound()
      }
    } else if (source.kind === 'map_observation' || source.kind === 'map_verification') {
      const fact = await getMapFact(db, { targetId, factType: source.kind === 'map_observation' ? 'observation' : 'verification', factId: source.kind === 'map_observation' ? source.observationId : source.verificationId })
      if (fact.type === 'observation') {
        if (access && !(fact.observation.sourceType === 'recorder' ? access.workflowRead : access.runRead)) knowledgeNotFound()
      } else {
        if (access && 'runId' in fact.verification.verificationSource && !access.runRead) knowledgeNotFound()
        await validateKnowledgeSources(db, targetId, fact.verification.observationIds.map(observationId => ({ kind: 'map_observation', observationId })), access)
      }
    } else if (source.kind === 'term') {
      const [term] = await db.select().from(tables.mapTerminologyEntries).where(and(eq(tables.mapTerminologyEntries.id, source.termId), eq(tables.mapTerminologyEntries.targetId, targetId))).limit(1)
      const [revision] = await db.select().from(tables.mapTerminologyRevisions).where(and(eq(tables.mapTerminologyRevisions.termId, source.termId), eq(tables.mapTerminologyRevisions.revision, source.revision))).limit(1)
      if (!term || !revision) knowledgeNotFound()
      await validateKnowledgeSources(db, targetId, (revision.payload.sources ?? []) as KnowledgeSourceRef[], access)
    } else if (source.kind === 'module_version') {
      if (access && !access.moduleRead) knowledgeNotFound()
      const [module] = await db.select().from(tables.actionModules).where(and(eq(tables.actionModules.id, source.moduleId), eq(tables.actionModules.targetId, targetId))).limit(1)
      const [version] = await db.select().from(tables.actionModuleVersions).where(and(eq(tables.actionModuleVersions.id, source.moduleVersionId), eq(tables.actionModuleVersions.moduleId, source.moduleId))).limit(1)
      if (!module || !version || version.contentDigest !== source.contentDigest) knowledgeNotFound()
    } else {
      if (access && !access.runRead) knowledgeNotFound()
      let runId: string
      if (source.kind === 'attempt') {
        const [attempt] = await db.select().from(tables.attempts).where(eq(tables.attempts.id, source.attemptId)).limit(1)
        if (!attempt) knowledgeNotFound()
        const [step] = await db.select().from(tables.stepRuns).where(eq(tables.stepRuns.id, attempt.stepRunId)).limit(1)
        if (!step || (source.runId && source.runId !== step.runId)) knowledgeNotFound()
        runId = step.runId
      } else {
        const [evidence] = await db.select().from(tables.evidences).where(eq(tables.evidences.id, source.evidenceId)).limit(1)
        if (!evidence || (source.attemptId && source.attemptId !== evidence.attemptId)) knowledgeNotFound()
        runId = evidence.runId
      }
      const [run] = await db.select().from(tables.runs).where(eq(tables.runs.id, runId)).limit(1)
      if (!run || run.deletedAt || run.targetId !== targetId || (access?.scenarioId && run.scenarioId !== access.scenarioId)) knowledgeNotFound()
    }
  }
}
