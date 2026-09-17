import { and, eq, gt, inArray } from 'drizzle-orm'
import {
  FACTORY_PLATFORM_CONFIG,
  SESSION_MAINTENANCE_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  platformConfigDocumentSchema,
  type PlatformSessionScheduling,
  type RunPlacement,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { getPlatformConfig } from '../platform-config/store.js'
import type { WorkerRecord } from '../leases/leases.js'
import type { SessionLeaseRow, SessionOperationRow } from '../records.js'
import { databaseNow, schemaFor } from '../native.js'

const SESSION_CREATE_OPERATION_KINDS = ['PREPARE', 'VALIDATE_AUTH_PROFILE', 'LOGIN'] as const

export type PlacementFacts = {
  waitReason: RunPlacement['waitReason']
  occupyingRunId: string | null
  occupyingOperationId: string | null
  targetWorkerId: string | null
  profileAffinityUntil: string | null
}

export function authWaitLeaseLive(
  lease: { purpose: string; expiresAt: Date; waitDeadlineAt: Date | null },
  asOf: Date,
): boolean {
  if (lease.purpose !== 'AUTH_WAIT') return false
  if (lease.expiresAt.getTime() <= asOf.getTime()) return false
  if (lease.waitDeadlineAt && lease.waitDeadlineAt.getTime() <= asOf.getTime()) return false
  return true
}

export function authHoldFromLease(
  lease: SessionLeaseRow | null,
): { workerId: string; expiresAt: Date; runId: string | null } | null {
  if (!lease || lease.purpose !== 'AUTH_WAIT') return null
  return {
    workerId: lease.holderWorkerId,
    expiresAt: lease.waitDeadlineAt ?? lease.expiresAt,
    runId: lease.runId,
  }
}

export function leaseWaitFacts(
  lease: Pick<SessionLeaseRow, 'purpose' | 'runId' | 'operationId'> | null | undefined,
): PlacementFacts | null {
  if (!lease) return null
  const empty = {
    occupyingRunId: null as string | null,
    occupyingOperationId: null as string | null,
    targetWorkerId: null as string | null,
    profileAffinityUntil: null as string | null,
  }
  if (lease.purpose === 'EXECUTION') {
    return { ...empty, waitReason: 'SESSION_IN_USE_BY_RUN', occupyingRunId: lease.runId }
  }
  if (lease.purpose === 'MAINTENANCE') {
    return { ...empty, waitReason: 'SESSION_IN_MAINTENANCE', occupyingOperationId: lease.operationId }
  }
  if (lease.purpose === 'AUTH_WAIT') {
    return {
      ...empty,
      waitReason: 'SESSION_WAITING_FOR_AUTH',
      occupyingRunId: lease.runId,
      occupyingOperationId: lease.operationId,
    }
  }
  return null
}

export async function readSessionScheduling(
  db: Db,
): Promise<{ scheduling: PlatformSessionScheduling; revision: number }> {
  const current = await getPlatformConfig(db)
  if (!current) {
    return { scheduling: FACTORY_PLATFORM_CONFIG.sessionScheduling, revision: 0 }
  }
  const document = platformConfigDocumentSchema.parse(current.document)
  return { scheduling: document.sessionScheduling, revision: current.revision }
}

export async function findActiveLeaseRow(db: Db, sessionId: string): Promise<SessionLeaseRow | null> {
  const { sessionLeases } = schemaFor(db)
  const [row] = await db
    .select()
    .from(sessionLeases)
    .where(and(eq(sessionLeases.sessionId, sessionId), eq(sessionLeases.status, 'ACTIVE')))
    .limit(1)
  return row ?? null
}

export async function findAuthWaitLeaseForRun(db: Db, runId: string): Promise<SessionLeaseRow | null> {
  const { sessionLeases } = schemaFor(db)
  const [row] = await db
    .select()
    .from(sessionLeases)
    .where(
      and(
        eq(sessionLeases.runId, runId),
        eq(sessionLeases.purpose, 'AUTH_WAIT'),
        eq(sessionLeases.status, 'ACTIVE'),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function findAuthWaitLeaseForOperation(
  db: Db,
  operationId: string,
): Promise<SessionLeaseRow | null> {
  const { sessionLeases } = schemaFor(db)
  const [row] = await db
    .select()
    .from(sessionLeases)
    .where(
      and(
        eq(sessionLeases.operationId, operationId),
        eq(sessionLeases.purpose, 'AUTH_WAIT'),
        eq(sessionLeases.status, 'ACTIVE'),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function getSessionOperation(db: Db, operationId: string): Promise<SessionOperationRow | null> {
  const { sessionOperations } = schemaFor(db)
  const [row] = await db
    .select()
    .from(sessionOperations)
    .where(eq(sessionOperations.id, operationId))
    .limit(1)
  return row ?? null
}

export function workerHasOccupancyProtocol(
  worker: Pick<WorkerRecord, 'id'> & { protocolCapabilities?: string[] },
): boolean {
  return Boolean(worker.protocolCapabilities?.includes(SESSION_OCCUPANCY_PROTOCOL))
}

export function workerHasMaintenanceProtocol(
  worker: Pick<WorkerRecord, 'id'> & { protocolCapabilities?: string[] },
): boolean {
  return Boolean(worker.protocolCapabilities?.includes(SESSION_MAINTENANCE_PROTOCOL))
}

export function toSessionOperationDto(row: SessionOperationRow) {
  return {
    id: row.id,
    targetId: row.targetId,
    targetAccountId: row.targetAccountId,
    kind: row.kind,
    origin: row.origin,
    status: row.status,
    expectedSessionId: row.expectedSessionId,
    expectedGeneration: row.expectedGeneration,
    ownerWorkerId: row.ownerWorkerId,
    attemptNo: row.attemptNo,
    queueDeadlineAt: row.queueDeadlineAt.toISOString(),
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }
}

/** 领取会新建会话的维护操作前才腾位；VERIFY / RENEW 不得先赶走保活会话。 */
export async function hasQueuedSessionCreateOperation(db: Db): Promise<boolean> {
  const { sessionOperations } = schemaFor(db)
  const [row] = await db
    .select({ id: sessionOperations.id })
    .from(sessionOperations)
    .where(
      and(
        eq(sessionOperations.status, 'QUEUED'),
        gt(sessionOperations.queueDeadlineAt, databaseNow(db)),
        inArray(sessionOperations.kind, [...SESSION_CREATE_OPERATION_KINDS]),
      ),
    )
    .limit(1)
  return row !== undefined
}
