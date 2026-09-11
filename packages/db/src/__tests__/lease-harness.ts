import { registerWorker, claimRun, type DbHandle } from '../index.js'
import { newId } from '../id.js'
import { runGrantSchema, type RunGrant } from '@cairn/shared'

export type SeededWorker = { workerId: string; instanceId: string }

export async function seedWorker(
  handle: DbHandle,
  workerId = `worker-${newId()}`,
): Promise<SeededWorker> {
  const instanceId = newId()
  await registerWorker(handle.db, {
    workerId,
    instanceId,
    capacity: 8,
    lostAfterSeconds: 60,
  })
  return { workerId, instanceId }
}

export async function claimNext(
  handle: DbHandle,
  worker: SeededWorker,
  leaseTtlSeconds = 30,
): Promise<RunGrant> {
  const grant = await claimRun(handle, {
    workerId: worker.workerId,
    instanceId: worker.instanceId,
    leaseTtlSeconds,
  })
  if (!grant) throw new Error('claimRun 未领到任务')
  return grant
}

/** 给指定 Run 挂上 ACTIVE 租约。同库有其它 QUEUED 时不能用 claimRun。 */
export async function forceGrantForRun(
  handle: DbHandle,
  runId: string,
  workerId: string,
  leaseTtlSeconds = 30,
): Promise<RunGrant> {
  await handle.pool.query(
    `UPDATE runs SET status = 'RUNNING', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1`,
    [runId],
  )
  const token = await handle.pool.query<{ t: string }>(
    `SELECT COALESCE(MAX(fencing_token), 0) + 1 AS t FROM run_leases WHERE run_id = $1`,
    [runId],
  )
  const fencingToken = Number(token.rows[0]?.t ?? 1)
  const leaseId = newId()
  const inserted = await handle.pool.query<{ expires_at: Date }>(
    `INSERT INTO run_leases (id, run_id, fencing_token, holder_worker_id, status, expires_at)
     VALUES ($1, $2, $3, $4, 'ACTIVE', now() + make_interval(secs => $5))
     RETURNING expires_at`,
    [leaseId, runId, fencingToken, workerId, leaseTtlSeconds],
  )
  return runGrantSchema.parse({
    runId,
    leaseId,
    fencingToken,
    holderWorkerId: workerId,
    expiresAt: new Date(inserted.rows[0]!.expires_at).toISOString(),
  })
}
