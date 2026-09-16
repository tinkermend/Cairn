import {
  advanceMapReferenceScan,
  listMapReferenceScanWork,
  loadTargetScanSource,
  type DbHandle,
} from '@cairn/db'
import { cluesFromScenarioStep, proposeMapReferenceCandidates } from '@cairn/map'
import { isAuthoringDocumentV2, normalizeAuthoringDocument, parseScenarioDocument } from '@cairn/shared'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { DB_HANDLE } from '../db/db.module'

@Injectable()
export class MapReferenceScanService {
  private readonly logger = new Logger(MapReferenceScanService.name)
  private ticking = false

  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async tick(limit = 2): Promise<{ advanced: number }> {
    if (this.ticking) return { advanced: 0 }
    this.ticking = true
    try {
      return await advanceMapReferenceScans(this.handle, { limit })
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : error, '地图引用扫描失败')
      return { advanced: 0 }
    } finally {
      this.ticking = false
    }
  }
}

export async function advanceMapReferenceScans(
  handle: DbHandle,
  input: { limit?: number } = {},
): Promise<{ advanced: number }> {
  const work = await listMapReferenceScanWork(handle, { limit: input.limit ?? 2 })
  let advanced = 0
  for (const item of work) {
    const source = await loadTargetScanSource(handle, item.targetId, { afterScenarioId: item.lastScenarioId, limit: 9 })
    const assets = source.assets.map((asset) => ({
      assetRefKey: asset.assetRefKey,
      pageId: asset.pageId,
      objectId: asset.objectId,
      routeTemplate: asset.routeTemplate,
      semanticName: asset.semanticName || undefined,
    }))
    const remaining = source.scenarios
    const batch = remaining.slice(0, 8).map((scenario) => {
      const documentSteps = isAuthoringDocumentV2(scenario.document)
        ? normalizeAuthoringDocument(scenario.document).nodes.flatMap(node => node.kind === 'step' ? [node.step] : [])
        : parseScenarioDocument(scenario.document).steps
      const steps = documentSteps.map(cluesFromScenarioStep)
      return {
        scenarioId: scenario.scenarioId,
        scenarioVersionId: scenario.scenarioVersionId,
        steps: proposeMapReferenceCandidates({ steps, assets }),
      }
    })
    await advanceMapReferenceScan(handle, {
      targetId: item.targetId,
      expectedLastScenarioId: item.lastScenarioId,
      requestedAt: item.requestedAt,
      batch,
      complete: remaining.length <= 8,
    })
    advanced += 1
  }
  return { advanced }
}
