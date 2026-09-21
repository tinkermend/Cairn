import { and, asc, eq, isNull } from 'drizzle-orm'
import {
  runObservationSchema,
  type RunEvidenceStatus,
  type RunObservation,
  type RunStatus,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { toEvidenceMetadata } from '../objects/evidence-map.js'
import { loadRunDetail } from '../runs/runs.js'
import { earliestEventSeq } from './events.js'

export type RunObservationProgress = {
  status: RunStatus
  evidenceStatus: RunEvidenceStatus
  eventSeq: number
  earliestEventSeq: number
}

export async function loadRunObservationProgress(
  db: Db,
  runId: string,
): Promise<RunObservationProgress | null> {
  const { runs } = schemaFor(db)
  const [row] = await db
    .select({
      status: runs.status,
      evidenceStatus: runs.evidenceStatus,
      eventSeq: runs.eventSeq,
    })
    .from(runs)
    .where(and(eq(runs.id, runId), isNull(runs.deletedAt)))
    .limit(1)
  if (!row) return null
  return {
    status: row.status,
    evidenceStatus: row.evidenceStatus,
    eventSeq: row.eventSeq,
    earliestEventSeq: await earliestEventSeq(db, runId),
  }
}

export async function loadRunObservation(db: Db, runId: string): Promise<RunObservation | null> {
  const { runs, evidences } = schemaFor(db)
  const [runRow] = await db
    .select({
      id: runs.id,
      eventSeq: runs.eventSeq,
    })
    .from(runs)
    .where(and(eq(runs.id, runId), isNull(runs.deletedAt)))
    .limit(1)
  if (!runRow) return null
  const run = await loadRunDetail(db, runId)
  if (!run) return null
  const rows = await db
    .select()
    .from(evidences)
    .where(eq(evidences.runId, runId))
    .orderBy(asc(evidences.createdAt), asc(evidences.id))
  return runObservationSchema.parse({
    run,
    evidence: { items: rows.map((row) => toEvidenceMetadata(row)) },
    eventSeq: runRow.eventSeq,
    earliestEventSeq: await earliestEventSeq(db, runId),
  })
}

