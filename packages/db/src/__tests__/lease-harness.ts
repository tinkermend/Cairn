import { eq, sql } from 'drizzle-orm'
import { schemaFor, afterSeconds, databaseNow, insertRows } from '../native.js'
import { registerWorker, claimRun, type NativeHandle as DbHandle } from '../test-entry.js'
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
  const { runs, runLeases } = schemaFor(handle.db)
  await handle.db.update(runs).set({ status: 'RUNNING', startedAt: databaseNow(handle.db), updatedAt: databaseNow(handle.db) }).where(eq(runs.id, runId))
  const [token] = await handle.db.select({ t: sql<number>`COALESCE(MAX(${runLeases.fencingToken}), 0) + 1` }).from(runLeases).where(eq(runLeases.runId, runId))
  const fencingToken = Number(token!.t)
  const leaseId = newId()
  const [inserted] = await insertRows(handle.db, runLeases, { id: leaseId, runId, fencingToken, holderWorkerId: workerId,
    status: 'ACTIVE', expiresAt: afterSeconds(handle.db, leaseTtlSeconds) })
  return runGrantSchema.parse({
    runId,
    leaseId,
    fencingToken,
    holderWorkerId: workerId,
    expiresAt: inserted!.expiresAt.toISOString(),
  })
}
