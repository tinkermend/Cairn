import {
  commitMapProjectionBatch,
  DomainError,
  ensureMapProjection,
  listMapProjectionWork,
  loadMapProjectionState,
  readMapFacts,
  recordMapProjectionFailure,
  type DbHandle,
} from '@cairn/db'
import { planProjectionBatch } from '@cairn/map'
import { MAP_PROJECTION_BATCH_MAX, type MapContentAvailability } from '@cairn/shared'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { DB_HANDLE } from '../db/db.module'

@Injectable()
export class MapProjectionService {
  private readonly logger = new Logger(MapProjectionService.name)
  private ticking = false

  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async tick(limit = 4): Promise<{ advanced: number }> {
    if (this.ticking) return { advanced: 0 }
    this.ticking = true
    try {
      return await advanceMapProjections(this.handle, { limit })
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : error, '地图投影处理失败')
      return { advanced: 0 }
    } finally {
      this.ticking = false
    }
  }
}

export async function advanceMapProjections(
  handle: DbHandle,
  input: { limit?: number } = {},
): Promise<{ advanced: number }> {
  const work = await listMapProjectionWork(handle, { limit: input.limit ?? 4 })
  let advanced = 0
  for (const item of work) {
    await ensureMapProjection(handle, item.targetId)
    const state = await loadMapProjectionState(handle, item.projectionId)
    const throughSeq = item.status === 'shadow' ? (item.sourceWatermark ?? state.cursor) : item.committedSeq
    const page = await readMapFacts(handle, {
      targetId: item.targetId,
      afterSeq: state.cursor,
      throughSeq,
      limit: MAP_PROJECTION_BATCH_MAX,
    })
    const plan = planProjectionBatch({
      state,
      facts: page.facts.map((fact) =>
        fact.type === 'observation'
          ? {
              type: 'observation' as const,
              ingestSeq: fact.ingestSeq,
              observation: fact.observation,
              contentAvailability: fact.contentAvailability as MapContentAvailability,
            }
          : {
              type: 'verification' as const,
              ingestSeq: fact.ingestSeq,
              verification: fact.verification,
              contentAvailability: fact.contentAvailability as MapContentAvailability,
            },
      ),
      now: new Date().toISOString(),
    })
    try {
      await commitMapProjectionBatch(handle, {
        projectionId: item.projectionId,
        expectedCursor: state.cursor,
        expectedRevision: state.revision,
        plan,
      })
      advanced += 1
    } catch (error) {
      if (error instanceof DomainError && error.code === 'MAP_PROJECTION_STALE') continue
      const message = error instanceof Error ? error.message : 'MAP_PROJECTION_FAILED'
      await recordMapProjectionFailure(handle, { projectionId: item.projectionId, message }).catch(() => undefined)
    }
  }
  return { advanced }
}
