import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { isSessionMaintenanceKind } from '@cairn/shared'
import { appendSessionEvent } from './session-events.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, clockNow, databaseNow, insertRows, locked, schemaFor, updateRows } from '../native.js'
import { appendRunEvents } from '../observe/events.js'
import { countFailedRecoveries, lockRunRow, releaseRunLeaseTx } from '../leases/leases.js'
import { skipRemainingStepRunsTx } from '../runs/step-status.js'
import type { SessionLeaseRow } from '../records.js'
import { lockOperationRow, lockSession } from './occupancy-tx.js'
import { getSessionOperation } from './occupancy-read.js'
import { recoverSessionOperations } from './occupancy-operations.js'
import type { ScanBatchResult } from '../runtime/scan-batch.js'

export async function reapSessionLeases(
  db: Db,
  input: { limit?: number; maxRecoveries?: number } = {},
): Promise<ScanBatchResult> {
  await recoverSessionOperations(db)
  const limit = input.limit ?? 100
  const maxRecoveries = input.maxRecoveries ?? 3
  const expiredOperations: string[] = []
  const { sessionLeases } = schemaFor(db)
  // Read candidates without locks, then serialize the account before taking
  // owner → Session → SessionLease, as cancellation and auth completion do.
  const candidates = await db.select().from(sessionLeases).where(and(
    eq(sessionLeases.status, 'ACTIVE'),
    or(sql`${sessionLeases.expiresAt} <= ${databaseNow(db)}`,
      and(eq(sessionLeases.purpose, 'AUTH_WAIT'), sql`${sessionLeases.waitDeadlineAt} <= ${databaseNow(db)}`)),
  )).orderBy(sessionLeases.expiresAt, sessionLeases.id).limit(limit)
  let count = 0
  for (const candidate of candidates) {
    const settled = await atomic(db, async (tx) => {
      const { sessionLeases, browserSessions, sessionOperations, targetAccounts } = schemaFor(tx)
      const [scope] = await tx.select({ accountId: browserSessions.targetAccountId }).from(browserSessions).where(eq(browserSessions.id, candidate.sessionId))
      if (scope) await locked(tx, tx.select({ id: targetAccounts.id }).from(targetAccounts).where(eq(targetAccounts.id, scope.accountId)))
      if (candidate.runId) await lockRunRow(tx, candidate.runId)
      if (candidate.operationId) await lockOperationRow(tx, candidate.operationId)
      await lockSession(tx, candidate.sessionId)
      const [lease] = await locked(tx, tx.select().from(sessionLeases).where(eq(sessionLeases.id, candidate.id)))
      if (!lease || lease.status !== 'ACTIVE') return false
      const now = await clockNow(tx)
      const holderExpired = lease.expiresAt.getTime() <= now.getTime()
      const deadlineExpired = lease.purpose === 'AUTH_WAIT' && lease.waitDeadlineAt && lease.waitDeadlineAt.getTime() <= now.getTime()
      if (!holderExpired && !deadlineExpired) return false
      if (lease.purpose === 'AUTH_WAIT' && holderExpired) {
        await expireAuthWaitHolderLost(tx, lease, now, maxRecoveries)
      } else if (lease.purpose === 'AUTH_WAIT' && deadlineExpired) {
        await expireAuthWaitDeadline(tx, lease, now)
      } else {
        await updateRows(
          tx,
          sessionLeases,
          { status: 'EXPIRED', releasedAt: now, releaseReason: 'lease_expired' },
          and(eq(sessionLeases.id, lease.id), eq(sessionLeases.status, 'ACTIVE')),
        )
        if (lease.purpose === 'MAINTENANCE' && lease.operationId) {
          const op = await getSessionOperation(tx, lease.operationId)
          const unknown = op?.kindParams?.loginSubmitted === true
          if (unknown)
            await updateRows(
              tx,
              browserSessions,
              { authState: 'UNKNOWN', updatedAt: now },
              eq(browserSessions.id, lease.sessionId),
            )
          await updateRows(
            tx,
            sessionOperations,
            {
              status: 'FAILED',
              errorCode: unknown ? 'OUTCOME_UNKNOWN' : 'OPERATION_INTERRUPTED',
              finishedAt: now,
              updatedAt: now,
            },
            and(
              eq(sessionOperations.id, lease.operationId),
              inArray(sessionOperations.status, ['RUNNING', 'WAITING_FOR_AUTH']),
            ),
          )
        }
      }
      return true
    })
    if (settled) {
      count += 1
      if (candidate.operationId) expiredOperations.push(candidate.operationId)
    }
  }
  for (const id of expiredOperations) {
    const op = await getSessionOperation(db, id)
    if (op && isSessionMaintenanceKind(op.kind) && op.status === 'FAILED')
      await appendSessionEvent(db, {
        key: op,
        type: 'operation.finished',
        operationId: id,
        sessionId: op.expectedSessionId,
        payload: { status: op.status, errorCode: op.errorCode, attemptId: `${op.id}:${op.attemptNo}` },
      })
  }
  return { settled: count, scanned: candidates.length }
}

export async function expireAuthWaitHolderLost(
  tx: Db,
  lease: SessionLeaseRow,
  now: Date,
  maxRecoveries: number,
): Promise<void> {
  const { sessionLeases, browserSessions, runs, sessionOperations, workers, runLeases } = schemaFor(tx)
  await updateRows(
    tx,
    sessionLeases,
    { status: 'EXPIRED', releasedAt: now, releaseReason: 'auth_wait_holder_lost' },
    and(eq(sessionLeases.id, lease.id), eq(sessionLeases.status, 'ACTIVE')),
  )
  await updateRows(
    tx,
    browserSessions,
    {
      authControlEpoch: sql`${browserSessions.authControlEpoch} + 1`,
      authControlActorId: null,
      authControlTokenHash: null,
      authControlExpiresAt: null,
      authControlPageId: null,
      updatedAt: now,
      version: sql`${browserSessions.version} + 1`,
    },
    eq(browserSessions.id, lease.sessionId),
  )
  // The Worker heartbeat reaper may already have isolated this session as LOST.
  // Control cleanup above still applies; never turn a CLOSED instance back into LOST.
  await updateRows(tx, browserSessions, { status: 'LOST', closeReason: 'auth_wait_holder_lost' },
    and(eq(browserSessions.id, lease.sessionId), inArray(browserSessions.status, ['OPEN', 'CREATING', 'CLOSING'])))
  if (lease.ownerKind === 'RUN' && lease.runId) {
    await lockRunRow(tx, lease.runId)
    const [counted] = await tx
      .select({ id: runLeases.id })
      .from(runLeases)
      .where(
        and(
          eq(runLeases.runId, lease.runId),
          or(
            eq(runLeases.status, 'ACTIVE'),
            and(eq(runLeases.status, 'RELEASED'), eq(runLeases.releaseReason, 'waiting_for_auth')),
          ),
        ),
      )
      .orderBy(desc(runLeases.fencingToken))
      .limit(1)
    if (counted) {
      await updateRows(
        tx,
        runLeases,
        { status: 'EXPIRED', releasedAt: now, releaseReason: 'auth_wait_holder_lost' },
        eq(runLeases.id, counted.id),
      )
    } else {
      const [token] = await tx
        .select({ t: sql<number>`COALESCE(MAX(${runLeases.fencingToken}), 0) + 1` })
        .from(runLeases)
        .where(eq(runLeases.runId, lease.runId))
      await insertRows(tx, runLeases, {
        id: newId(),
        runId: lease.runId,
        fencingToken: Number(token?.t ?? 1),
        holderWorkerId: lease.holderWorkerId,
        status: 'EXPIRED',
        expiresAt: now,
        releasedAt: now,
        releaseReason: 'auth_wait_holder_lost',
      })
    }
    const failed = await countFailedRecoveries(tx, lease.runId)
    if (failed >= maxRecoveries) {
      await updateRows(
        tx,
        runs,
        { status: 'NEEDS_REVIEW', updatedAt: now },
        and(eq(runs.id, lease.runId), eq(runs.status, 'WAITING_FOR_AUTH')),
      )
      await appendRunEvents(tx, lease.runId, [
        { type: 'run.status_changed', payload: { status: 'NEEDS_REVIEW', reason: 'auth_wait_holder_lost' } },
      ])
    } else {
      await updateRows(
        tx,
        runs,
        { status: 'RECOVERING', updatedAt: now },
        and(eq(runs.id, lease.runId), eq(runs.status, 'WAITING_FOR_AUTH')),
      )
      await appendRunEvents(tx, lease.runId, [
        { type: 'run.status_changed', payload: { status: 'RECOVERING', reason: 'auth_wait_holder_lost' } },
      ])
    }
  }
  if (lease.ownerKind === 'SESSION_OPERATION' && lease.operationId) {
    await updateRows(
      tx,
      sessionOperations,
      { status: 'FAILED', errorCode: 'auth_wait_holder_lost', finishedAt: now, updatedAt: now },
      and(
        eq(sessionOperations.id, lease.operationId),
        inArray(sessionOperations.status, ['RUNNING', 'WAITING_FOR_AUTH']),
      ),
    )
  }
  void workers
}

export async function expireAuthWaitDeadline(tx: Db, lease: SessionLeaseRow, now: Date): Promise<void> {
  const { sessionLeases, browserSessions, runs, sessionOperations, evidences } = schemaFor(tx)
  await updateRows(
    tx,
    sessionLeases,
    { status: 'EXPIRED', releasedAt: now, releaseReason: 'auth_wait_deadline' },
    and(eq(sessionLeases.id, lease.id), eq(sessionLeases.status, 'ACTIVE')),
  )
  await updateRows(
    tx,
    browserSessions,
    {
      // A human-control deadline says nothing about the target's login state.
      authControlEpoch: sql`${browserSessions.authControlEpoch} + 1`,
      authControlActorId: null,
      authControlTokenHash: null,
      authControlExpiresAt: null,
      authControlPageId: null,
      updatedAt: now,
    },
    eq(browserSessions.id, lease.sessionId),
  )
  if (lease.ownerKind === 'RUN' && lease.runId) {
    const run = await lockRunRow(tx, lease.runId)
    if (run?.status === 'WAITING_FOR_AUTH') {
      const [moved] = await updateRows(
        tx,
        runs,
        { status: 'FAILED', finishedAt: now, updatedAt: now },
        and(eq(runs.id, lease.runId), eq(runs.status, 'WAITING_FOR_AUTH')),
      )
      if (moved) {
        await tx.insert(evidences).values({
          id: newId(),
          runId: lease.runId,
          type: 'error',
          schemaVersion: 1,
          payload: {
            code: 'SESSION_AUTH_TIMEOUT',
            category: 'INFRASTRUCTURE',
            retryable: false,
            safeMessage: '等待人工认证超时',
          },
          createdAt: now,
        })
        await skipRemainingStepRunsTx(tx, lease.runId, now)
        await appendRunEvents(tx, lease.runId, [
          { type: 'run.status_changed', payload: { status: 'FAILED' } },
          { type: 'evidence.recorded', payload: { type: 'error', status: 'available' } },
        ])
      }
    }
  }
  if (lease.ownerKind === 'SESSION_OPERATION' && lease.operationId) {
    await updateRows(
      tx,
      sessionOperations,
      { status: 'FAILED', errorCode: 'SESSION_AUTH_TIMEOUT', finishedAt: now, updatedAt: now },
      and(
        eq(sessionOperations.id, lease.operationId),
        inArray(sessionOperations.status, ['RUNNING', 'WAITING_FOR_AUTH']),
      ),
    )
  }
}
