import {
  advanceMapReferenceScan,
  listMapReferenceScanWork,
  loadTargetScanAssets,
  loadTargetScanScenarios,
  type DbHandle,
} from '@cairn/db'
import { cluesFromScenarioStep, proposeMapReferenceCandidates } from '@cairn/map'
import { isAuthoringDocumentV2, normalizeAuthoringDocument, parseScenarioDocument } from '@cairn/shared'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { DB_HANDLE } from '../db/db.module'

type ScanAssetRow = Awaited<ReturnType<typeof loadTargetScanAssets>>['assets'][number]
type ScanAssetCache = Map<string, { projectionId: string; assets: ScanAssetRow[] }>

@Injectable()
export class MapReferenceScanService {
  private readonly logger = new Logger(MapReferenceScanService.name)
  private ticking = false
  private readonly assetCache: ScanAssetCache = new Map()

  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async tick(limit = 2): Promise<{ advanced: number }> {
    if (this.ticking) return { advanced: 0 }
    this.ticking = true
    try {
      return await advanceMapReferenceScans(this.handle, { limit }, this.assetCache)
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
  cache: ScanAssetCache = new Map(),
): Promise<{ advanced: number }> {
  const work = await listMapReferenceScanWork(handle, { limit: input.limit ?? 2 })
  let advanced = 0
  for (const item of work) {
    if (!item.lastScenarioId && item.scannedCount === 0) cache.delete(item.targetId)
    let cached = cache.get(item.targetId)
    if (!cached) {
      const loaded = await loadTargetScanAssets(handle, item.targetId)
      cached = { projectionId: loaded.projectionId ?? '', assets: loaded.assets }
      cache.set(item.targetId, cached)
    }
    const remaining = await loadTargetScanScenarios(handle, item.targetId, {
      afterScenarioId: item.lastScenarioId,
      limit: 9,
    })
    const batch = remaining.slice(0, 8).map((scenario) => {
      const documentSteps = isAuthoringDocumentV2(scenario.document)
        ? normalizeAuthoringDocument(scenario.document).nodes.flatMap(node => node.kind === 'step' ? [node.step] : [])
        : parseScenarioDocument(scenario.document).steps
      const steps = documentSteps.map(cluesFromScenarioStep)
      return {
        scenarioId: scenario.scenarioId,
        scenarioVersionId: scenario.scenarioVersionId,
        steps: proposeMapReferenceCandidates({ steps, assets: cached.assets }),
      }
    })
    const result = await advanceMapReferenceScan(handle, {
      targetId: item.targetId,
      expectedLastScenarioId: item.lastScenarioId,
      requestedAt: item.requestedAt,
      batch,
      complete: remaining.length <= 8,
    })
    if (result.complete) cache.delete(item.targetId)
    advanced += 1
  }
  return { advanced }
}
