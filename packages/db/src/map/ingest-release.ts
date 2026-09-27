import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import type { Db } from '../client.js'
import { atomic, clockNow, jsonTextEquals, locked, schemaFor } from '../native.js'
import { MAP_ASSETS_POLICY_VERSION } from './projections.js'
import { sealMapReleaseTx } from './releases.js'

/** 投影消费完作业事实后封存；重复 tick 由作业行锁和 commandKey 保证幂等。 */
export async function sealCompletedMapIngestJobs(db: Db, limit = 16): Promise<number> {
  const { mapJobs } = schemaFor(db)
  const candidates = await db.select({ id: mapJobs.id }).from(mapJobs)
    .where(and(eq(mapJobs.jobKind, 'map_ingest'), eq(mapJobs.jobStatus, 'completed'),
      ne(mapJobs.scope, 'detect_top_menus'), isNull(mapJobs.releaseId),
      jsonTextEquals(db, mapJobs.ingestSummary, ['outcome'], 'complete')))
    .orderBy(mapJobs.createdAt).limit(Math.min(limit, 64))
  let sealed = 0
  for (const candidate of candidates) {
    const done = await atomic(db, async tx => {
      const { mapJobs, mapJobSlices, mapObservations, mapProjectionHeads, mapProjections } = schemaFor(tx)
      const [job] = await locked(tx, tx.select().from(mapJobs).where(eq(mapJobs.id, candidate.id)))
      if (!job || job.jobStatus !== 'completed' || job.ingestSummary?.outcome !== 'complete' || job.releaseId) return false
      const slices = await tx.select({ runId: mapJobSlices.runId }).from(mapJobSlices)
        .where(eq(mapJobSlices.jobId, job.id))
      if (!slices.length) return false
      const [lastFact] = await tx.select({ seq: mapObservations.ingestSeq }).from(mapObservations)
        .where(and(eq(mapObservations.targetId, job.targetId), eq(mapObservations.sourceType, 'map_ingest'),
          inArray(mapObservations.sourceRunId, slices.map(slice => slice.runId))))
        .orderBy(desc(mapObservations.ingestSeq)).limit(1)
      if (!lastFact) return false
      const [head] = await tx.select().from(mapProjectionHeads)
        .where(eq(mapProjectionHeads.targetId, job.targetId)).limit(1)
      if (!head) return false
      const [projection] = await tx.select().from(mapProjections)
        .where(eq(mapProjections.id, head.currentProjectionId)).limit(1)
      if (!projection || projection.cursor < lastFact.seq || !['active', 'ready'].includes(projection.status)) return false
      const release = await sealMapReleaseTx(tx, {
        targetId: job.targetId, projectionId: projection.id,
        expectedProjectionRevision: projection.revision,
        policyVersion: MAP_ASSETS_POLICY_VERSION,
        commandKey: `map-ingest:${job.id}`,
        actorId: job.createdBy,
        source: 'map_ingest', jobId: job.id,
      })
      await tx.update(mapJobs).set({ releaseId: release.releaseId,
        revision: job.revision + 1, updatedAt: await clockNow(tx) }).where(eq(mapJobs.id, job.id))
      return true
    })
    if (done) sealed++
  }
  return sealed
}
