import { asc, eq } from 'drizzle-orm'
import { runObservationSchema, type RunObservation } from '@cairn/shared'
import type { Db } from '../client.js'
import { lockRunRow } from '../leases/leases.js'
import { atomic, schemaFor } from '../native.js'
import { toEvidenceMetadata } from '../objects/evidence-map.js'
import { loadRunDetail } from '../runs/runs.js'
import { earliestEventSeq } from './events.js'

export async function loadRunObservation(db: Db, runId: string): Promise<RunObservation | null> {
  return atomic(db, async (tx) => {
    const locked = await lockRunRow(tx, runId)
    if (!locked) return null
    const run = await loadRunDetail(tx, runId)
    if (!run) return null
    const { evidences } = schemaFor(tx)
    const rows = await tx
      .select()
      .from(evidences)
      .where(eq(evidences.runId, runId))
      .orderBy(asc(evidences.createdAt), asc(evidences.id))
    return runObservationSchema.parse({
      run,
      evidence: { items: rows.map((row) => toEvidenceMetadata(row)) },
      eventSeq: locked.eventSeq,
      earliestEventSeq: await earliestEventSeq(tx, runId),
    })
  })
}
