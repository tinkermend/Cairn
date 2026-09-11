import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  DEFAULT_BROWSER_MAX_SESSIONS,
  isFinishedRunStatus,
  runGrantSchema,
  type RunGrant,
  type RunLeaseErrorCode,
  type RunStatus,
  type WorkerStatus,
} from '@cairn/shared'
import { conflict } from '../runs/errors.js'
import type { Db, DbHandle } from '../client.js'
import { newId } from '../id.js'
import { runs } from '../schema/execution.js'
import { runLeases, workers, type RunLeaseRow, type WorkerRow } from '../schema/worker.js'

/** 用共享枚举标注，让"抛出的码"与"对外声明的码"由类型接住，而不是各写一遍字面量。 */
export const WORKER_ID_CONFLICT: RunLeaseErrorCode = 'WORKER_ID_CONFLICT'

export type WorkerRecord = {
  id: string
  instanceId: string
  status: WorkerStatus
  capacity: number
  maxSessions: number
  heartbeatAt: Date
}

export type RegisterWorkerResult = {
  worker: WorkerRecord
  revokedRunIds: string[]
}

function toWorker(row: WorkerRow): WorkerRecord {
  return {
    id: row.id,
    instanceId: row.instanceId,
    status: row.status,
    capacity: row.capacity,
    maxSessions: row.maxSessions,
    heartbeatAt: row.heartbeatAt,
  }
}

function toGrant(row: Pick<RunLeaseRow, 'id' | 'runId' | 'fencingToken' | 'holderWorkerId' | 'expiresAt'>): RunGrant {
  return runGrantSchema.parse({
    runId: row.runId,
    leaseId: row.id,
    fencingToken: row.fencingToken,
    holderWorkerId: row.holderWorkerId,
    expiresAt: row.expiresAt.toISOString(),
  })
}

export async function registerWorker(
  db: Db,
  input: {
    workerId: string
    instanceId: string
    capacity: number
    maxSessions?: number
    lostAfterSeconds: number
  },
): Promise<RegisterWorkerResult> {
  const now = new Date()
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT id, instance_id, status, capacity, max_sessions, heartbeat_at
        FROM ${workers}
       WHERE id = ${input.workerId}
       FOR UPDATE
    `)
    const existing = locked.rows[0] as
      | {
          id: string
          instance_id: string
          status: string
          capacity: number
          max_sessions: number
          heartbeat_at: Date
        }
      | undefined

    if (existing) {
      const ageSeconds = (now.getTime() - new Date(existing.heartbeat_at).getTime()) / 1000
      if (existing.instance_id !== input.instanceId && ageSeconds < input.lostAfterSeconds) {
        throw conflict(WORKER_ID_CONFLICT, `Worker ${input.workerId} 仍有新鲜心跳`)
      }
    }

    if (!existing) {
      await tx.insert(workers).values({
        id: input.workerId,
        instanceId: input.instanceId,
        status: 'READY',
        capacity: input.capacity,
        maxSessions: input.maxSessions ?? DEFAULT_BROWSER_MAX_SESSIONS,
        heartbeatAt: now,
        startedAt: now,
        updatedAt: now,
      })
    } else {
      await tx
        .update(workers)
        .set({
          instanceId: input.instanceId,
          status: 'READY',
          capacity: input.capacity,
          maxSessions: input.maxSessions ?? DEFAULT_BROWSER_MAX_SESSIONS,
          heartbeatAt: now,
          startedAt: now,
          updatedAt: now,
          stoppedAt: null,
        })
        .where(eq(workers.id, input.workerId))
    }

    const revoked = await tx
      .update(runLeases)
      .set({
        status: 'REVOKED',
        releasedAt: now,
        releaseReason: 'worker_restart',
      })
      .where(and(eq(runLeases.holderWorkerId, input.workerId), eq(runLeases.status, 'ACTIVE')))
      .returning({ runId: runLeases.runId })

    const [row] = await tx.select().from(workers).where(eq(workers.id, input.workerId)).limit(1)
    return { worker: toWorker(row!), revokedRunIds: revoked.map((item) => item.runId) }
  })
}

/**
 * 心跳结果。两种失败原因的处置完全不同，所以不能压成一个 boolean：
 *
 * - `lost`：行不在，或状态已不是 `READY`（被同伴判失联）。本实例仍是这个 ID 的登记者，
 *   允许用新的 `instance_id` 重新注册自愈。
 * - `instance_taken`：这个 Worker ID 已经属于另一个活实例。按 D4「同 ID 只能有一个活实例」，
 *   不得抢回，本进程只能退出。
 */
export type WorkerHeartbeatOutcome = 'ok' | 'lost' | 'instance_taken'

export async function heartbeatWorker(
  db: Db,
  workerId: string,
  instanceId: string,
): Promise<WorkerHeartbeatOutcome> {
  const now = new Date()
  const [row] = await db
    .update(workers)
    .set({ heartbeatAt: now, updatedAt: now })
    .where(and(eq(workers.id, workerId), eq(workers.instanceId, instanceId), eq(workers.status, 'READY')))
    .returning({ id: workers.id })
  if (row) return 'ok'
  const [current] = await db
    .select({ instanceId: workers.instanceId })
    .from(workers)
    .where(eq(workers.id, workerId))
    .limit(1)
  return current && current.instanceId !== instanceId ? 'instance_taken' : 'lost'
}

export async function markWorkerDraining(db: Db, workerId: string): Promise<void> {
  const now = new Date()
  await db
    .update(workers)
    .set({ status: 'DRAINING', updatedAt: now })
    .where(and(eq(workers.id, workerId), eq(workers.status, 'READY')))
}

export async function markWorkerStopped(db: Db, workerId: string): Promise<void> {
  const now = new Date()
  await db
    .update(workers)
    .set({ status: 'STOPPED', stoppedAt: now, updatedAt: now })
    .where(eq(workers.id, workerId))
}

export async function markLostWorkers(db: Db, lostAfterSeconds: number): Promise<string[]> {
  const now = new Date()
  const rows = await db
    .update(workers)
    .set({ status: 'LOST', updatedAt: now, stoppedAt: now })
    .where(
      sql`${workers.status} IN ('READY', 'DRAINING')
        AND ${workers.heartbeatAt} + make_interval(secs => ${lostAfterSeconds}) <= now()`,
    )
    .returning({ id: workers.id })
  return rows.map((row) => row.id)
}

export async function lockRunRow(tx: Db, runId: string) {
  const result = await tx.execute(sql`
    SELECT id, status, cancel_requested_at, updated_at
      FROM ${runs}
     WHERE id = ${runId}
     FOR UPDATE
  `)
  const row = result.rows[0] as
    | { id: string; status: RunStatus; cancel_requested_at: Date | null; updated_at: Date }
    | undefined
  if (!row) return null
  return {
    id: row.id,
    status: row.status,
    cancelRequestedAt: row.cancel_requested_at,
    updatedAt: row.updated_at,
  }
}

export async function verifyRunLeaseForWrite(tx: Db, grant: RunGrant): Promise<boolean> {
  const [row] = await tx
    .select({ id: runLeases.id })
    .from(runLeases)
    .where(
      and(
        eq(runLeases.id, grant.leaseId),
        eq(runLeases.runId, grant.runId),
        eq(runLeases.fencingToken, grant.fencingToken),
        eq(runLeases.holderWorkerId, grant.holderWorkerId),
        eq(runLeases.status, 'ACTIVE'),
        sql`${runLeases.expiresAt} > now()`,
      ),
    )
    .limit(1)
  return row !== undefined
}

async function claimOneStatus(
  client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: { id: string }[] }> },
  status: 'RECOVERING' | 'QUEUED',
  workerId: string,
  excludeRunIds: string[],
): Promise<string | null> {
  const recoveringFilter =
    status === 'RECOVERING'
      ? `AND NOT EXISTS (
           SELECT 1 FROM run_leases l
            WHERE l.run_id = r.id AND l.status = 'ACTIVE'
         )`
      : ''
  const excludeFilter = excludeRunIds.length > 0 ? `AND r.id <> ALL($3::uuid[])` : ''
  const values: unknown[] = excludeRunIds.length > 0 ? [status, workerId, excludeRunIds] : [status, workerId]
  const result = await client.query(
    `UPDATE runs
        SET status = 'RUNNING',
            started_at = COALESCE(started_at, now()),
            updated_at = now()
      WHERE id = (
        SELECT r.id
          FROM runs r
          LEFT JOIN browser_sessions s
            ON s.target_id = r.target_id
           AND s.target_account_id = r.target_account_id
           AND s.status IN ('CREATING', 'OPEN', 'CLOSING', 'LOST')
         WHERE r.status = $1
           AND r.cancel_requested_at IS NULL
           ${recoveringFilter}
           ${excludeFilter}
           AND (
             r.target_account_id IS NULL
             OR s.id IS NULL
             OR (s.status = 'OPEN' AND s.owner_worker_id = $2)
           )
         ORDER BY r.created_at, r.id
         LIMIT 1
         FOR UPDATE OF r SKIP LOCKED
      )
      RETURNING id`,
    values,
  )
  return result.rows[0]?.id ?? null
}

export async function claimRun(
  handle: DbHandle,
  input: {
    workerId: string
    instanceId: string
    leaseTtlSeconds: number
    excludeRunIds?: string[]
  },
): Promise<RunGrant | null> {
  const excludeRunIds = input.excludeRunIds ?? []
  const client = await handle.pool.connect()
  try {
    await client.query('BEGIN')
    // 失联 / 停机 / 错位实例不得再领：心跳失败后仍存活的进程会卡在这里，避免僵尸抢单烧恢复次数。
    const worker = await client.query<{ id: string; capacity: number }>(
      `SELECT id, capacity FROM workers
        WHERE id = $1 AND instance_id = $2 AND status = 'READY'
        FOR UPDATE`,
      [input.workerId, input.instanceId],
    )
    if (worker.rows.length === 0) {
      await client.query('ROLLBACK')
      return null
    }
    const held = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM run_leases
        WHERE holder_worker_id = $1
          AND status = 'ACTIVE'
          AND expires_at > now()`,
      [input.workerId],
    )
    if (Number(held.rows[0]?.n ?? 0) >= worker.rows[0]!.capacity) {
      await client.query('ROLLBACK')
      return null
    }
    const runId =
      (await claimOneStatus(client, 'RECOVERING', input.workerId, excludeRunIds)) ??
      (await claimOneStatus(client, 'QUEUED', input.workerId, excludeRunIds))
    if (!runId) {
      await client.query('ROLLBACK')
      return null
    }
    const tokenResult = await client.query<{ token: string }>(
      `SELECT COALESCE(MAX(fencing_token), 0) + 1 AS token FROM run_leases WHERE run_id = $1`,
      [runId],
    )
    const fencingToken = Number(tokenResult.rows[0]?.token ?? 1)
    const leaseId = newId()
    const inserted = await client.query<{
      id: string
      run_id: string
      fencing_token: number
      holder_worker_id: string
      expires_at: Date
    }>(
      `INSERT INTO run_leases
         (id, run_id, fencing_token, holder_worker_id, status, expires_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', now() + make_interval(secs => $5))
       RETURNING id, run_id, fencing_token, holder_worker_id, expires_at`,
      [leaseId, runId, fencingToken, input.workerId, input.leaseTtlSeconds],
    )
    await client.query('COMMIT')
    const row = inserted.rows[0]!
    return toGrant({
      id: row.id,
      runId: row.run_id,
      fencingToken: Number(row.fencing_token),
      holderWorkerId: row.holder_worker_id,
      expiresAt: new Date(row.expires_at),
    })
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* already closed */
    }
    throw error
  } finally {
    client.release()
  }
}

export async function renewRunLease(db: Db, grant: RunGrant, leaseTtlSeconds: number): Promise<Date | null> {
  const [row] = await db
    .update(runLeases)
    .set({
      expiresAt: sql`now() + make_interval(secs => ${leaseTtlSeconds})`,
      heartbeatAt: sql`now()`,
    })
    .where(
      and(
        eq(runLeases.id, grant.leaseId),
        eq(runLeases.runId, grant.runId),
        eq(runLeases.fencingToken, grant.fencingToken),
        eq(runLeases.holderWorkerId, grant.holderWorkerId),
        eq(runLeases.status, 'ACTIVE'),
        sql`${runLeases.expiresAt} > now()`,
      ),
    )
    .returning({ expiresAt: runLeases.expiresAt })
  return row?.expiresAt ?? null
}

/**
 * 释放租约。
 *
 * `'unknown'` = 这份租约已经不是本持有者的 ACTIVE 租约（被判过期、被撤销、或压根不存在），
 * 本次释放没有改动任何事实。之前这里把"行还在"也算成 `'released'`，等于把"我早就丢租了"
 * 报成"我正常交回了"——调用方再想区分也区分不出来。
 */
export async function releaseRunLeaseTx(
  tx: Db,
  grant: RunGrant,
  reason: string,
): Promise<'released' | 'unknown'> {
  const now = new Date()
  const [row] = await tx
    .update(runLeases)
    .set({ status: 'RELEASED', releasedAt: now, releaseReason: reason })
    .where(
      and(
        eq(runLeases.id, grant.leaseId),
        eq(runLeases.holderWorkerId, grant.holderWorkerId),
        eq(runLeases.status, 'ACTIVE'),
      ),
    )
    .returning({ id: runLeases.id })
  return row ? 'released' : 'unknown'
}

export async function findActiveLeaseForRun(db: Db, runId: string): Promise<RunGrant | null> {
  const [row] = await db
    .select()
    .from(runLeases)
    .where(and(eq(runLeases.runId, runId), eq(runLeases.status, 'ACTIVE')))
    .limit(1)
  return row ? toGrant(row) : null
}

export async function listActiveLeasesForWorker(db: Db, workerId: string): Promise<RunGrant[]> {
  const rows = await db
    .select()
    .from(runLeases)
    .where(and(eq(runLeases.holderWorkerId, workerId), eq(runLeases.status, 'ACTIVE')))
  return rows.map((row) => toGrant(row))
}

export async function listActiveLeasesByRunIds(db: Db, runIds: string[]): Promise<Map<string, RunGrant>> {
  const out = new Map<string, RunGrant>()
  if (runIds.length === 0) return out
  const rows = await db
    .select()
    .from(runLeases)
    .where(and(inArray(runLeases.runId, runIds), eq(runLeases.status, 'ACTIVE')))
  for (const row of rows) out.set(row.runId, toGrant(row))
  return out
}

export async function listExpiredActiveLeases(
  db: Db,
  limit: number,
): Promise<Array<{ leaseId: string; runId: string }>> {
  const rows = await db
    .select({ leaseId: runLeases.id, runId: runLeases.runId })
    .from(runLeases)
    .where(and(eq(runLeases.status, 'ACTIVE'), sql`${runLeases.expiresAt} <= now()`))
    .orderBy(runLeases.expiresAt)
    .limit(limit)
  return rows
}

export async function expireLeaseIfDue(tx: Db, leaseId: string): Promise<boolean> {
  const now = new Date()
  const [row] = await tx
    .update(runLeases)
    .set({ status: 'EXPIRED', releasedAt: now, releaseReason: 'lease_expired' })
    .where(
      and(eq(runLeases.id, leaseId), eq(runLeases.status, 'ACTIVE'), sql`${runLeases.expiresAt} <= now()`),
    )
    .returning({ id: runLeases.id })
  return row !== undefined
}

export async function countFailedRecoveries(tx: Db, runId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(runLeases)
    .where(and(eq(runLeases.runId, runId), sql`${runLeases.status} IN ('EXPIRED', 'REVOKED')`))
  return Number(row?.n ?? 0)
}

export async function listDriftedRunningIds(db: Db, leaseTtlSeconds: number, limit: number): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT r.id
      FROM ${runs} r
     WHERE r.status = 'RUNNING'
       AND r.updated_at < now() - make_interval(secs => ${leaseTtlSeconds})
       AND NOT EXISTS (
         SELECT 1 FROM ${runLeases} l
          WHERE l.run_id = r.id AND l.status = 'ACTIVE'
       )
     ORDER BY r.updated_at
     LIMIT ${limit}
  `)
  return (result.rows as { id: string }[]).map((row) => row.id)
}

export function isFinishedOrNeedsReview(status: RunStatus): boolean {
  return isFinishedRunStatus(status) || status === 'NEEDS_REVIEW'
}

export type { RunLeaseRow, WorkerRow }
