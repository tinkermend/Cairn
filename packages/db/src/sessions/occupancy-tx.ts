import { eq } from 'drizzle-orm'
import type { SessionGrant } from '@cairn/shared'
import type { Db } from '../client.js'
import { locked, schemaFor } from '../native.js'
import type { BrowserSessionRow, SessionLeaseRow, SessionOperationRow } from '../records.js'

export async function lockSession(tx: Db, sessionId: string): Promise<BrowserSessionRow | null> {
  const { browserSessions } = schemaFor(tx)
  const [row] = await locked(tx, tx.select().from(browserSessions).where(eq(browserSessions.id, sessionId)))
  return row ?? null
}

export async function lockWorkerRow(tx: Db, workerId: string) {
  const { workers } = schemaFor(tx)
  const [row] = await locked(tx, tx.select().from(workers).where(eq(workers.id, workerId)))
  return row ?? null
}

export async function lockOperationRow(tx: Db, operationId: string): Promise<SessionOperationRow | null> {
  const { sessionOperations } = schemaFor(tx)
  const [row] = await locked(
    tx,
    tx.select().from(sessionOperations).where(eq(sessionOperations.id, operationId)),
  )
  return row ?? null
}

export function toGrant(lease: SessionLeaseRow): SessionGrant {
  return {
    sessionId: lease.sessionId,
    leaseId: lease.id,
    generation: lease.sessionGeneration,
    sessionFencingToken: lease.sessionFencingToken,
    expiresAt: lease.expiresAt.toISOString(),
    purpose: lease.purpose,
    ownerKind: lease.ownerKind,
    runId: lease.runId,
    operationId: lease.operationId,
  }
}

export function occupancyGrantFromLease(lease: SessionLeaseRow): SessionGrant {
  return toGrant(lease)
}
