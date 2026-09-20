import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import {
  CANDIDATE_GROUPS_PROTOCOL,
  MAP_JOBS_PROTOCOL,
  MODULE_MANIFEST_PROTOCOL,
  OUTCOME_MANIFEST_PROTOCOL,
  RUNTIME_INVARIANT_MANIFEST_PROTOCOL,
  SUITE_ADMISSION_PROTOCOL,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, jsonArrayIncludes, jsonHasKey, schemaFor } from '../native.js'

export async function readMonitorClock(db: Db): Promise<Date> {
  return clockNow(db)
}

export function asCount(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

export function occupancyStatuses() {
  return ['CREATING', 'OPEN', 'CLOSING'] as const
}

export function claimableRunCondition(db: Db, asOf: Date): SQL {
  const { runs, suiteRunItems } = schemaFor(db)
  return and(
    inArray(runs.status, ['RECOVERING', 'QUEUED']),
    isNull(runs.deletedAt),
    isNull(runs.cancelRequestedAt),
    or(isNull(runs.deadlineAt), sql`${runs.deadlineAt} > ${asOf}`),
    sql`(
      ${runs.executionOrigin} <> 'suite_member'
      OR EXISTS (
        SELECT 1 FROM ${suiteRunItems} admitted
        WHERE admitted.child_run_id = ${runs.id}
          AND admitted.admission_status = 'ACTIVE'
      )
    )`,
  )!
}

export function workerCoversSnapshot(db: Db): SQL {
  const { runs, workers } = schemaFor(db)
  return and(
    or(
      sql`NOT (${jsonHasKey(db, runs.snapshot, 'moduleManifest')})`,
      jsonArrayIncludes(db, workers.protocolCapabilities, MODULE_MANIFEST_PROTOCOL),
    ),
    or(
      sql`NOT (${jsonHasKey(db, runs.snapshot, 'candidateGroups')})`,
      jsonArrayIncludes(db, workers.protocolCapabilities, CANDIDATE_GROUPS_PROTOCOL),
    ),
    or(
      sql`NOT (${jsonHasKey(db, runs.snapshot, 'mapJob')})`,
      jsonArrayIncludes(db, workers.protocolCapabilities, MAP_JOBS_PROTOCOL),
    ),
    or(
      sql`NOT (${jsonHasKey(db, runs.snapshot, 'outcomeManifest')})`,
      jsonArrayIncludes(db, workers.protocolCapabilities, OUTCOME_MANIFEST_PROTOCOL),
    ),
    or(
      sql`NOT (${jsonHasKey(db, runs.snapshot, 'runtimeInvariantManifest')})`,
      jsonArrayIncludes(db, workers.protocolCapabilities, RUNTIME_INVARIANT_MANIFEST_PROTOCOL),
    ),
    or(
      sql`NOT (${jsonHasKey(db, runs.snapshot, 'suiteAdmission')})`,
      jsonArrayIncludes(db, workers.protocolCapabilities, SUITE_ADMISSION_PROTOCOL),
    ),
  )!
}

export function onlineClaimerCondition(db: Db, asOf: Date): SQL {
  const { workers } = schemaFor(db)
  return and(
    eq(workers.status, 'READY'),
    sql`${workers.heartbeatExpiresAt} IS NOT NULL AND ${workers.heartbeatExpiresAt} > ${asOf}`,
  )!
}
