import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import {
  SESSION_MAINTENANCE_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  canonicalJson,
  isSessionIdleOnlyKind,
  isSessionLeaseClaimKind,
  isSessionMaintenanceKind,
  type SessionOperationKind,
  type SessionOperationOrigin,
  type SessionGrant,
  type SessionAcquireReason,
} from '@cairn/shared'
import { assertMaintenanceAuthorized, assertSessionActorPermission } from './access.js'
import { appendSessionEvent } from './session-events.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, clockNow, deleteRows, insertRows, locked, schemaFor, updateRows } from '../native.js'
import { conflict } from '../runs/errors.js'
import { sha256Hex } from '../runs/digest.js'
import { lockRunRow } from '../leases/leases.js'
import type { SessionOperationRow } from '../records.js'
import {
  concurrencyProtocolRequired,
  loadLiveAccountSessions,
  profileKeyFrom,
  readAccountSessionCap,
  workerHasConcurrencyProtocol,
  type SessionClaimOperationWait,
} from './account-session-concurrency.js'
import { expireQueuedSessionOperations, recordOperationWait } from './operation-queue.js'
import { createSession, findLiveSessions, getSessionById, type SessionKey, type SessionRecord } from './sessions.js'
import { adoptSessionRetention, applyPendingRetentionIntent } from './session-retention-intent.js'
import { lockOperationRow, lockSession, lockWorkerRow, toGrant } from './occupancy-tx.js'
import {
  findActiveLeaseRow,
  getSessionOperation,
  readSessionScheduling,
} from './occupancy-read.js'
import { occupancyGrantFromLease } from './occupancy-tx.js'
import { claimSessionUse, type OccupancyOwner } from './occupancy-lease.js'
import {
  loadResolvedSessionPolicyForTarget,
  sessionLifecycleFieldsFromPolicy,
} from './session-policy.js'

export async function markSessionOperationWaitingForAuth(
  db: Db,
  input: { operationId: string; workerId: string },
): Promise<boolean> {
  const { sessionOperations } = schemaFor(db)
  const now = new Date()
  const [row] = await updateRows(
    db,
    sessionOperations,
    { status: 'WAITING_FOR_AUTH', updatedAt: now },
    and(
      eq(sessionOperations.id, input.operationId),
      eq(sessionOperations.ownerWorkerId, input.workerId),
      inArray(sessionOperations.status, ['RUNNING', 'WAITING_FOR_AUTH']),
    ),
    { id: sessionOperations.id },
  )
  return row !== undefined
}

export async function recoverSessionOperations(db: Db): Promise<number> {
  return atomic(db, async (tx) => {
    const { sessionOperations, workers, browserSessions, runs } = schemaFor(tx)
    const now = await clockNow(tx)
    const active = await tx
      .select()
      .from(sessionOperations)
      .where(inArray(sessionOperations.status, ['RUNNING', 'WAITING_FOR_AUTH']))
    let recovered = 0
    for (const op of active) {
      if (!isSessionMaintenanceKind(op.kind)) continue
      if (typeof op.kindParams?.reusedRunId === 'string' && op.kind !== 'REFRESH_LOGIN_PAGE') {
        const [run] = await tx.select().from(runs).where(eq(runs.id, op.kindParams.reusedRunId)).limit(1)
        if (run && run.status !== 'WAITING_FOR_AUTH') {
          const success = ['QUEUED', 'RUNNING', 'HOLDING', 'SUCCEEDED'].includes(run.status)
          const status = success ? 'SUCCEEDED' : 'FAILED'
          if (
            await finishSessionOperation(tx, {
              operationId: op.id,
              workerId: op.ownerWorkerId ?? '',
              status,
              errorCode: success ? undefined : 'OPERATION_INTERRUPTED',
            })
          ) {
            await appendSessionEvent(tx, {
              key: op,
              type: 'operation.finished',
              operationId: op.id,
              runId: run.id,
              payload: { status },
            })
            recovered += 1
          }
          continue
        }
      }
      const [worker] = await tx
        .select()
        .from(workers)
        .where(eq(workers.id, op.ownerWorkerId ?? ''))
        .limit(1)
      if (
        worker &&
        worker.instanceId === op.ownerWorkerInstanceId &&
        ['READY', 'DRAINING'].includes(worker.status) &&
        worker.heartbeatExpiresAt &&
        worker.heartbeatExpiresAt > now
      )
        continue
      const unknown = op.kindParams?.loginSubmitted === true
      const errorCode = unknown ? 'OUTCOME_UNKNOWN' : 'OPERATION_INTERRUPTED'
      if (
        !(await finishSessionOperation(tx, {
          operationId: op.id,
          workerId: op.ownerWorkerId ?? '',
          status: 'FAILED',
          errorCode,
        }))
      )
        continue
      if (unknown && op.expectedSessionId)
        await updateRows(
          tx,
          browserSessions,
          { authState: 'UNKNOWN', updatedAt: now },
          eq(browserSessions.id, op.expectedSessionId),
        )
      await appendSessionEvent(tx, {
        key: op,
        type: 'operation.finished',
        sessionId: op.expectedSessionId,
        operationId: op.id,
        payload: { status: 'FAILED', errorCode, attemptId: `${op.id}:${op.attemptNo}` },
      })
      recovered += 1
    }
    return recovered
  })
}

export async function markMaintenanceLoginSubmitted(
  db: Db,
  operationId: string,
  workerInstanceId: string,
  submitted = true,
): Promise<void> {
  const { sessionOperations } = schemaFor(db)
  const op = await getSessionOperation(db, operationId)
  if (!op || op.ownerWorkerInstanceId !== workerInstanceId || op.status !== 'RUNNING')
    throw conflict('OPERATION_INTERRUPTED', '操作已失效')
  await updateRows(
    db,
    sessionOperations,
    { kindParams: { ...op.kindParams, loginSubmitted: submitted }, updatedAt: new Date() },
    and(
      eq(sessionOperations.id, operationId),
      eq(sessionOperations.ownerWorkerInstanceId, workerInstanceId),
      eq(sessionOperations.status, 'RUNNING'),
    ),
  )
}

export async function requestSessionOperation(
  db: Db,
  input: {
    key: SessionKey
    kind: SessionOperationKind
    kindParams?: Record<string, unknown>
    origin: SessionOperationOrigin
    idempotencyKey: string
    expectedSessionId?: string | null
    expectedGeneration?: number | null
  },
): Promise<{ operation: SessionOperationRow; created: boolean }> {
  const { scheduling, revision } = await readSessionScheduling(db)
  const digest = sha256Hex(
    canonicalJson({
      kind: input.kind,
      kindParams: input.kindParams ?? {},
      origin: input.origin,
      expectedSessionId: input.expectedSessionId ?? null,
      expectedGeneration: input.expectedGeneration ?? null,
    }),
  )
  return atomic(db, async (tx) => {
    const { sessionOperations } = schemaFor(tx)
    const now = await clockNow(tx)
    const [existing] = await tx
      .select()
      .from(sessionOperations)
      .where(
        and(
          eq(sessionOperations.targetId, input.key.targetId),
          eq(sessionOperations.targetAccountId, input.key.targetAccountId),
          eq(sessionOperations.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1)
    if (existing) {
      if (existing.contentDigest !== digest) {
        throw conflict('OPERATION_IDEMPOTENCY_CONFLICT', '同幂等键内容不一致')
      }
      return { operation: existing, created: false }
    }
    if (input.kindParams?.force) {
      await updateRows(
        tx,
        sessionOperations,
        { status: 'CANCELLED', errorCode: 'OPERATION_INTERRUPTED', finishedAt: now, updatedAt: now },
        and(
          eq(sessionOperations.targetId, input.key.targetId),
          eq(sessionOperations.targetAccountId, input.key.targetAccountId),
          eq(sessionOperations.status, 'QUEUED'),
        ),
      )
    }
    const [row] = await insertRows(tx, sessionOperations, {
      id: newId(),
      targetId: input.key.targetId,
      targetAccountId: input.key.targetAccountId,
      kind: input.kind,
      kindParams: input.kindParams ?? {},
      origin: input.origin,
      status: 'QUEUED',
      expectedSessionId: input.expectedSessionId ?? null,
      expectedGeneration: input.expectedGeneration ?? null,
      idempotencyKey: input.idempotencyKey,
      contentDigest: digest,
      secretRefs: [],
      platformConfigRevision: revision,
      queueDeadlineAt: new Date(now.getTime() + scheduling.operationQueueTimeoutSeconds * 1000),
      attemptNo: 0,
      createdAt: now,
      updatedAt: now,
    })
    return { operation: row!, created: true }
  })
}

export type ClaimedSessionOperation = {
  operation: SessionOperationRow
  grant: SessionGrant | null
  session: SessionRecord | null
  reusedRunId: string | null
  /** 本次领取如何拿到会话；只在走占用领取（PREPARE / LOGIN / VERIFY 等）时有值。 */
  acquire?: {
    reason: SessionAcquireReason
    profileFallback: boolean
    accountSlot: number
  } | null
}

export async function claimSessionOperation(
  db: Db,
  input: { workerId: string; instanceId: string; leaseTtlSeconds: number },
): Promise<ClaimedSessionOperation | null> {
  return atomic(db, async (tx) => {
    const worker = await lockWorkerRow(tx, input.workerId)
    if (!worker || worker.instanceId !== input.instanceId || worker.status !== 'READY') return null
    if (!worker.protocolCapabilities?.includes(SESSION_OCCUPANCY_PROTOCOL)) return null
    const hasMaintenance = Boolean(worker.protocolCapabilities?.includes(SESSION_MAINTENANCE_PROTOCOL))
    const { sessionOperations, runs } = schemaFor(tx)
    const now = await clockNow(tx)
    await expireQueuedSessionOperations(tx, { now })
    const candidates = await tx
      .select()
      .from(sessionOperations)
      .where(and(eq(sessionOperations.status, 'QUEUED'), gt(sessionOperations.queueDeadlineAt, now)))
      .orderBy(asc(sessionOperations.createdAt), asc(sessionOperations.id))
      .limit(20)
    for (const snapshot of candidates) {
      if (isSessionMaintenanceKind(snapshot.kind) && !hasMaintenance) continue
      const { targetAccounts } = schemaFor(tx)
      await locked(
        tx,
        tx
          .select({ id: targetAccounts.id })
          .from(targetAccounts)
          .where(eq(targetAccounts.id, snapshot.targetAccountId)),
      )
      const candidate = await lockOperationRow(tx, snapshot.id)
      if (!candidate || candidate.status !== 'QUEUED' || candidate.queueDeadlineAt <= now) continue
      if (isSessionMaintenanceKind(candidate.kind)) {
        try {
          await assertMaintenanceAuthorized(tx, candidate)
        } catch {
          await updateRows(
            tx,
            sessionOperations,
            { status: 'FAILED', errorCode: 'AUTH_CONFIGURATION_REVOKED', finishedAt: now, updatedAt: now },
            eq(sessionOperations.id, candidate.id),
          )
          await appendSessionEvent(tx, {
            key: candidate,
            type: 'operation.finished',
            operationId: candidate.id,
            payload: { status: 'FAILED', errorCode: 'AUTH_CONFIGURATION_REVOKED' },
          })
          continue
        }
      }

      const keyPreview = { targetId: candidate.targetId, targetAccountId: candidate.targetAccountId }
      const livePreview = await findLiveSessions(tx, keyPreview)
      const capPreview = await readAccountSessionCap(tx, keyPreview)
      if (
        concurrencyProtocolRequired(capPreview.effectiveCap, livePreview.length) &&
        !workerHasConcurrencyProtocol(worker.protocolCapabilities)
      ) {
        continue
      }
      if (candidate.origin === 'BACKGROUND') {
        const targetSessionId = candidate.expectedSessionId ?? (livePreview.length === 1 ? livePreview[0]?.id : null)
        const busy = targetSessionId ? await findActiveLeaseRow(tx, targetSessionId) : null
        if (busy) {
          await recordOperationWait(tx, candidate, now, 'SESSION_BUSY', {
            sessionId: targetSessionId,
            purpose: busy.purpose,
            occupyingRunId: busy.runId,
            occupyingOperationId: busy.operationId,
          })
          continue
        }
      }
      if (candidate.expectedSessionId) {
        const live = await getSessionById(tx, candidate.expectedSessionId)
        if (
          !live ||
          live.targetId !== candidate.targetId ||
          live.targetAccountId !== candidate.targetAccountId ||
          !['CREATING', 'OPEN', 'CLOSING', 'LOST'].includes(live.status) ||
          (candidate.expectedGeneration != null && live.generation !== candidate.expectedGeneration)
        ) {
          await updateRows(
            tx,
            sessionOperations,
            { status: 'FAILED', errorCode: 'SESSION_GENERATION_CHANGED', finishedAt: now, updatedAt: now },
            and(eq(sessionOperations.id, candidate.id), eq(sessionOperations.status, 'QUEUED')),
          )
          await appendSessionEvent(tx, {
            key: candidate,
            type: 'operation.finished',
            operationId: candidate.id,
            payload: { status: 'FAILED', errorCode: 'SESSION_GENERATION_CHANGED' },
          })
          continue
        }
      }
      const [moved] = await updateRows(
        tx,
        sessionOperations,
        {
          status: 'RUNNING',
          ownerWorkerId: input.workerId,
          ownerWorkerInstanceId: input.instanceId,
          claimToken: randomBytes(16).toString('hex'),
          attemptNo: candidate.attemptNo + 1,
          updatedAt: now,
        },
        and(eq(sessionOperations.id, candidate.id), eq(sessionOperations.status, 'QUEUED')),
      )
      if (!moved) continue

      const key = { targetId: candidate.targetId, targetAccountId: candidate.targetAccountId }
      if (candidate.kind === 'LOGIN' || candidate.kind === 'REFRESH_LOGIN_PAGE') {
        const { lives, leases } = await loadLiveAccountSessions(tx, key)
        const live =
          (candidate.expectedSessionId
            ? lives.find((row) => row.id === candidate.expectedSessionId)
            : lives.find((row) => leases.get(row.id)?.purpose === 'AUTH_WAIT')) ?? null
        const existing = live ? leases.get(live.id) ?? null : null
        if (existing?.purpose === 'AUTH_WAIT' && live) {
          if (live.ownerWorkerId !== input.workerId || live.ownerWorkerInstanceId !== input.instanceId) {
            await rollbackClaim(tx, candidate, now, {
              reason: 'SESSION_ON_OTHER_WORKER',
              detail: { sessionId: live.id, workerId: live.ownerWorkerId },
            })
            continue
          }
          if (candidate.kind === 'REFRESH_LOGIN_PAGE') {
            return { operation: moved, grant: toGrant(existing), session: live, reusedRunId: existing.runId }
          }
          if (!existing.runId) {
            await rollbackClaim(tx, candidate, now, {
              reason: 'SESSION_BUSY',
              detail: { sessionId: live.id, purpose: existing.purpose, occupyingOperationId: existing.operationId },
            })
            continue
          }
          await updateRows(
            tx,
            sessionOperations,
            {
              status: 'WAITING_FOR_AUTH',
              kindParams: { ...candidate.kindParams, reusedRunId: existing.runId },
              updatedAt: now,
            },
            eq(sessionOperations.id, candidate.id),
          )
          const waiting = await getSessionOperation(tx, candidate.id)
          return {
            operation: waiting ?? moved,
            grant: toGrant(existing),
            session: live,
            reusedRunId: existing.runId,
          }
        }
      }

      if (isSessionIdleOnlyKind(candidate.kind)) {
        const lives = await findLiveSessions(tx, key)
        const live =
          (candidate.expectedSessionId
            ? lives.find((row) => row.id === candidate.expectedSessionId)
            : lives.length === 1
              ? lives[0]
              : null) ?? null
        if (candidate.kind !== 'RESET_PROFILE' && (!live || live.status !== 'OPEN')) {
          await updateRows(
            tx,
            sessionOperations,
            {
              status: 'FAILED',
              errorCode: 'SESSION_NOT_CLAIMABLE',
              finishedAt: now,
              updatedAt: now,
            },
            eq(sessionOperations.id, candidate.id),
          )
          await appendSessionEvent(tx, {
            key: candidate,
            type: 'operation.finished',
            operationId: candidate.id,
            sessionId: live?.id ?? null,
            payload: { status: 'FAILED', errorCode: 'SESSION_NOT_CLAIMABLE' },
          })
          continue
        }
        if (
          live &&
          (live.ownerWorkerId !== input.workerId || live.ownerWorkerInstanceId !== input.instanceId)
        ) {
          await rollbackClaim(tx, candidate, now, {
            reason: 'SESSION_ON_OTHER_WORKER',
            detail: { sessionId: live.id, workerId: live.ownerWorkerId },
          })
          continue
        }
        if (live) {
          await lockSession(tx, live.id)
          const existing = await findActiveLeaseRow(tx, live.id)
          if (existing) {
            const isNonExecution = !existing.runId && (existing.purpose === 'MAINTENANCE' || existing.purpose === 'AUTH_WAIT')
            // 本操作首次尝试（attemptNo 还未被本次领取自增）时，不可能存在自己留下的残留占用；
            // 若此时已挂着指向本操作 id 的非执行占用，只能是异常状态（例如绕过 claimSessionUse
            // 的非法直插），必须判失败，不能当作"上次尝试的残留"直接清掉继续关闭。
            const isIllegalSelfOccupancy = existing.operationId === candidate.id && candidate.attemptNo === 0
            if (isNonExecution && !isIllegalSelfOccupancy && (candidate.kind === 'CLOSE' || candidate.kind === 'RESTART')) {
              const { sessionLeases } = schemaFor(tx)
              await deleteRows(tx, sessionLeases, eq(sessionLeases.sessionId, live.id))
              if (existing.operationId) {
                const [interrupted] = await updateRows(
                  tx,
                  sessionOperations,
                  { status: 'CANCELLED', errorCode: 'OPERATION_INTERRUPTED', finishedAt: now, updatedAt: now },
                  and(
                    eq(sessionOperations.id, existing.operationId),
                    inArray(sessionOperations.status, ['QUEUED', 'RUNNING', 'WAITING_FOR_AUTH']),
                  ),
                )
                if (interrupted)
                  await appendSessionEvent(tx, {
                    key: interrupted,
                    type: 'operation.finished',
                    operationId: interrupted.id,
                    sessionId: live.id,
                    payload: { status: 'CANCELLED', errorCode: 'OPERATION_INTERRUPTED', interruptedBy: candidate.id },
                  })
              }
            } else {
              await updateRows(
                tx,
                sessionOperations,
                { status: 'FAILED', errorCode: 'SESSION_OPERATION_CONFLICT', finishedAt: now, updatedAt: now },
                eq(sessionOperations.id, candidate.id),
              )
              await appendSessionEvent(tx, {
                key: candidate,
                type: 'operation.finished',
                operationId: candidate.id,
                payload: {
                  status: 'FAILED',
                  errorCode: 'SESSION_OPERATION_CONFLICT',
                  occupyingRunId: existing.runId,
                },
              })
              continue
            }
          }
          if (live.status === 'OPEN') {
            const { browserSessions } = schemaFor(tx)
            await updateRows(
              tx,
              browserSessions,
              {
                status: 'CLOSING',
                closeReason: 'session_operation',
                version: sql`${browserSessions.version} + 1`,
                updatedAt: now,
              },
              eq(browserSessions.id, live.id),
            )
          }
        }
        return { operation: moved, grant: null, session: live, reusedRunId: null }
      }

      if (
        ['VERIFY_AUTH', 'RENEW_AUTH', 'REFRESH_LOGIN_PAGE', 'SETTLE_LANDING'].includes(candidate.kind) &&
        !candidate.expectedSessionId
      ) {
        await updateRows(
          tx,
          sessionOperations,
          { status: 'FAILED', errorCode: 'SESSION_NOT_CLAIMABLE', finishedAt: now, updatedAt: now },
          eq(sessionOperations.id, candidate.id),
        )
        await appendSessionEvent(tx, {
          key: candidate,
          type: 'operation.finished',
          operationId: candidate.id,
          payload: { status: 'FAILED', errorCode: 'SESSION_NOT_CLAIMABLE' },
        })
        continue
      }
      if (candidate.kind === 'VALIDATE_AUTH_PROFILE' || isSessionLeaseClaimKind(candidate.kind)) {
        const policy = await loadResolvedSessionPolicyForTarget(tx, key.targetId)
        const lifecycle = sessionLifecycleFieldsFromPolicy(policy)
        const claimed = await claimSessionUse(tx, {
          key,
          owner: { kind: 'SESSION_OPERATION', operationId: candidate.id },
          purpose: 'MAINTENANCE',
          sessionId: candidate.expectedSessionId,
          pickIdle: 'worst',
          holderWorkerId: input.workerId,
          holderInstanceId: input.instanceId,
          leaseTtlSeconds: input.leaseTtlSeconds,
          reusePolicy: lifecycle.reusePolicy,
          idleTtlSeconds: lifecycle.idleTtlSeconds,
          maxLifetimeSeconds: lifecycle.maxLifetimeSeconds,
          reclaimMode: lifecycle.reclaimMode,
          keepAliveSeconds: lifecycle.keepAliveSeconds,
          authProbeIntervalSeconds: lifecycle.authProbeIntervalSeconds,
          evictionPriority: lifecycle.evictionPriority,
          touchLastUsed: !['VERIFY_AUTH', 'RENEW_AUTH', 'SETTLE_LANDING'].includes(candidate.kind),
        })
        if (!claimed.ok) {
          await rollbackClaim(tx, candidate, now, claimFailureWait(claimed))
          continue
        }
        await bindOperationSession(tx, moved.id, claimed.session.id, claimed.session.generation)
        return {
          operation: {
            ...moved,
            expectedSessionId: claimed.session.id,
            expectedGeneration: claimed.session.generation,
          },
          grant: claimed.grant,
          session: claimed.session,
          reusedRunId: null,
          acquire: {
            reason: claimed.acquireReason,
            profileFallback: claimed.profileFallback,
            accountSlot: claimed.session.accountSlot ?? 1,
          },
        }
      }

      await rollbackClaim(tx, candidate, now)
    }
    return null
  })
}

/** 退回 QUEUED；带上本次没领到的原因，排队界面才说得清在等什么。 */
export async function rollbackClaim(
  tx: Db,
  candidate: SessionOperationRow,
  now: Date,
  wait?: SessionClaimOperationWait,
): Promise<void> {
  const { sessionOperations } = schemaFor(tx)
  await updateRows(
    tx,
    sessionOperations,
    {
      status: 'QUEUED',
      ownerWorkerId: null,
      ownerWorkerInstanceId: null,
      claimToken: null,
      attemptNo: candidate.attemptNo,
      updatedAt: now,
    },
    eq(sessionOperations.id, candidate.id),
  )
  if (wait) await recordOperationWait(tx, candidate, now, wait.reason, wait.detail ?? null)
}

function claimFailureWait(
  failed: Extract<Awaited<ReturnType<typeof claimSessionUse>>, { ok: false }>,
): SessionClaimOperationWait {
  if (failed.operationWait) return failed.operationWait
  if (failed.code === 'SESSION_CAPACITY_EXCEEDED') return { reason: 'WORKER_SESSION_CAPACITY' }
  if (failed.code === 'SESSION_ACCOUNT_CAP_EXCEEDED') return { reason: 'SESSION_ACCOUNT_AT_CAPACITY' }
  return { reason: 'SESSION_BUSY', detail: { code: failed.code, ...(failed.message ? { message: failed.message } : {}) } }
}

export async function finishSessionOperation(
  db: Db,
  input: {
    operationId: string
    workerId: string
    status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
    workerInstanceId?: string
    claimToken?: string
    authControl?: { sessionId: string; token: string; actorId: string; generation: number; epoch: number }
    errorCode?: string
  },
): Promise<boolean> {
  return atomic(db, async (tx) => {
    const initial = await getSessionOperation(tx, input.operationId)
    if (!initial) return false
    const { targetAccounts } = schemaFor(tx)
    await locked(
      tx,
      tx
        .select({ id: targetAccounts.id })
        .from(targetAccounts)
        .where(eq(targetAccounts.id, initial.targetAccountId)),
    )
    const operation = await lockOperationRow(tx, input.operationId)
    if (!operation) return false
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(operation.status)) return false
    if (operation.ownerWorkerId && operation.ownerWorkerId !== input.workerId) return false
    if (input.workerInstanceId && operation.ownerWorkerInstanceId !== input.workerInstanceId) return false
    if (input.claimToken && operation.claimToken !== input.claimToken) return false
    if (input.authControl) {
      const c = input.authControl
      await assertSessionActorPermission(tx, c.actorId, 'session:control')
      const session = await lockSession(tx, c.sessionId)
      if (
        !session ||
        session.generation !== c.generation ||
        session.authControlEpoch !== c.epoch ||
        session.authControlActorId !== c.actorId ||
        session.authControlTokenHash !== createHash('sha256').update(c.token).digest('hex') ||
        !session.authControlExpiresAt ||
        session.authControlExpiresAt.getTime() <= (await clockNow(tx)).getTime()
      )
        return false
      const lease = await findActiveLeaseRow(tx, session.id)
      if (lease?.operationId !== input.operationId || lease.purpose !== 'AUTH_WAIT') return false
      const checkedAt = await clockNow(tx)
      if (lease.expiresAt <= checkedAt || (lease.waitDeadlineAt && lease.waitDeadlineAt <= checkedAt)) return false
    }
    const now = await clockNow(tx)
    const { sessionOperations, sessionLeases } = schemaFor(tx)
    const [moved] = await updateRows(
      tx,
      sessionOperations,
      {
        status: input.status,
        errorCode: input.errorCode ?? null,
        finishedAt: now,
        updatedAt: now,
      },
      and(
        eq(sessionOperations.id, input.operationId),
        inArray(sessionOperations.status, ['QUEUED', 'RUNNING', 'WAITING_FOR_AUTH']),
      ),
    )
    if (!moved) return false
    const [lease] = await tx
      .select()
      .from(sessionLeases)
      .where(and(eq(sessionLeases.operationId, input.operationId), eq(sessionLeases.status, 'ACTIVE')))
      .limit(1)
    if (lease) {
      await updateRows(
        tx,
        sessionLeases,
        { status: 'RELEASED', releasedAt: now, releaseReason: `operation_${input.status.toLowerCase()}` },
        eq(sessionLeases.id, lease.id),
      )
    }
    if (input.authControl) {
      const { browserSessions } = schemaFor(tx)
      await updateRows(
        tx,
        browserSessions,
        {
          authControlActorId: null,
          authControlTokenHash: null,
          authControlExpiresAt: null,
          authControlPageId: null,
        },
        eq(browserSessions.id, input.authControl.sessionId),
      )
    }
    return true
  })
}

export function contentDigestFor(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : canonicalJson(value))
    .digest('hex')
}

export async function bindOperationSession(
  db: Db,
  operationId: string,
  sessionId: string,
  generation: number,
): Promise<void> {
  const { sessionOperations } = schemaFor(db)
  await updateRows(
    db,
    sessionOperations,
    { expectedSessionId: sessionId, expectedGeneration: generation },
    and(eq(sessionOperations.id, operationId), eq(sessionOperations.status, 'RUNNING')),
  )
}

/** Restart owns an idle reservation. It must not acquire a MAINTENANCE lease. */
export async function recreateSessionForOperation(
  db: Db,
  input: { operationId: string; workerId: string; instanceId: string },
) {
  return atomic(db, async (tx) => {
    const worker = await lockWorkerRow(tx, input.workerId)
    const op = await getSessionOperation(tx, input.operationId)
    if (
      !worker ||
      worker.status !== 'READY' ||
      worker.instanceId !== input.instanceId ||
      !op ||
      op.status !== 'RUNNING' ||
      op.kind !== 'RESTART' ||
      op.ownerWorkerInstanceId !== input.instanceId ||
      !op.expectedSessionId
    )
      throw conflict('OPERATION_INTERRUPTED', '重启操作已失效')
    const { targetAccounts, browserSessions } = schemaFor(tx)
    await locked(
      tx,
      tx
        .select({ id: targetAccounts.id })
        .from(targetAccounts)
        .where(eq(targetAccounts.id, op.targetAccountId)),
    )
    await assertMaintenanceAuthorized(tx, op)
    const previous = await lockSession(tx, op.expectedSessionId)
    if (!previous || previous.status !== 'CLOSED' || previous.generation !== op.expectedGeneration)
      throw conflict('SESSION_GENERATION_CHANGED', '旧实例未确认停止')
    const occupied = await tx
      .select({ id: browserSessions.id })
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.ownerWorkerId, worker.id),
          inArray(browserSessions.status, ['CREATING', 'OPEN', 'CLOSING']),
        ),
      )
    if (occupied.length >= worker.maxSessions) throw conflict('SESSION_CAPACITY_EXCEEDED', '节点会话容量已满')
    const created = await createSession(tx, {
      key: op,
      ownerWorkerId: worker.id,
      ownerWorkerInstanceId: input.instanceId,
      reusePolicy: previous.reusePolicy,
      idleTtlSeconds: previous.idleTtlSeconds,
      maxLifetimeSeconds: previous.maxLifetimeSeconds,
      reclaimMode: previous.reclaimMode,
      keepAliveSeconds: previous.keepAliveSeconds,
      authProbeIntervalSeconds: previous.authProbeIntervalSeconds,
      evictionPriority: previous.evictionPriority,
      accountSlot: previous.accountSlot,
      profileKey: previous.profileKey,
      predecessorSessionId: previous.id,
    })
    if (created.ok) {
      await adoptSessionRetention(tx, { fromSessionId: previous.id, toSessionId: created.session.id })
      await applyPendingRetentionIntent(tx, created.session.id)
      await bindOperationSession(tx, op.id, created.session.id, created.session.generation)
    }
    return created
  })
}
