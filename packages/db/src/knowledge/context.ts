import { and, desc, eq, isNull, inArray } from 'drizzle-orm'
import type { ModuleCondition, ModulePublicationStatus, Step } from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { getMapSummary, listMapAssets } from '../map/governance.js'
import { knowledgeNotFound } from './errors.js'
import { mapListQuerySchema } from '@cairn/shared'

export type PublishedModuleKnowledgeRow = {
  moduleId: string
  moduleVersionId: string
  name: string
  key: string
  aliases: string[]
  intentExamples: string[]
  tags: string[]
  contentDigest: string
  publicationStatus: ModulePublicationStatus
  steps: Step[]
  preconditions: ModuleCondition[]
  inputs: { key: string; label: string; required: boolean }[]
  postconditions: ModuleCondition[]
}

export async function listPublishedModuleKnowledge(db: Db, targetId: string, selectedVersionIds: string[] = []): Promise<PublishedModuleKnowledgeRow[]> {
  const { actionModules, actionModuleVersions } = schemaFor(db)
  const modules = await db
    .select()
    .from(actionModules)
    .where(and(eq(actionModules.targetId, targetId), isNull(actionModules.deletedAt)))
  const rows: PublishedModuleKnowledgeRow[] = []
  for (const module of modules) {
    const [version] = await db
      .select()
      .from(actionModuleVersions)
      .where(
        and(eq(actionModuleVersions.moduleId, module.id), eq(actionModuleVersions.publicationStatus, 'published'), selectedVersionIds.length ? inArray(actionModuleVersions.id, selectedVersionIds) : undefined),
      )
      .orderBy(desc(actionModuleVersions.versionNo))
      .limit(1)
    if (!version) continue
    const implementation = version.content.implementations[0]
    rows.push({
      moduleId: module.id,
      moduleVersionId: version.id,
      name: module.name,
      key: module.key,
      aliases: module.aliases,
      intentExamples: module.intentExamples,
      tags: module.tags,
      contentDigest: version.contentDigest,
      publicationStatus: version.publicationStatus,
      steps: implementation?.steps ?? [],
      inputs: version.content.contract.inputs,
      preconditions: version.content.contract.preconditions,
      postconditions: version.content.contract.postconditions ?? [],
    })
  }
  return rows
}

export async function loadKnowledgeMapContext(db: Db, targetId: string, requestedReleaseId?: string) {
  const summary = await getMapSummary(db, targetId, mapListQuerySchema.parse({}))
  const publishedReleaseId = requestedReleaseId ?? summary.publishedReleaseId
  if (publishedReleaseId) {
    const { mapReleasePublications } = schemaFor(db)
    const [publication] = await db.select().from(mapReleasePublications).where(and(eq(mapReleasePublications.releaseId, publishedReleaseId), eq(mapReleasePublications.targetId, targetId))).limit(1)
    if (!publication || publication.publicationStatus !== 'published') knowledgeNotFound('地图版本不可用于新的编写建议')
  }
  const objects = await listMapAssets(db, targetId, 'objects', mapListQuerySchema.parse({ releaseId: publishedReleaseId, limit: 20 }))
  return {
    publishedReleaseId,
    assets: objects.items.map((item) => ({ assetRef: item.assetRef, name: item.name })),
  }
}
