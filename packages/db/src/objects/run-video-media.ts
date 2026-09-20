import { and, asc, eq, lte, or } from 'drizzle-orm'
import {
  VIDEO_MEDIA_LEASE_MS,
  VIDEO_MEDIA_MAX_ATTEMPTS,
  writeRunVideoManifest,
  type RunVideoManifest,
  type VideoMediaJobStatus,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { lockRunRow } from '../leases/leases.js'
import { atomic, clockNow, locked, schemaFor } from '../native.js'
import { isUniqueViolation } from '../runs/errors.js'

export type RunVideoMediaJob = {
  id: string
  runId: string
  status: VideoMediaJobStatus
  fencingToken: number
  claimOwner: string | null
  claimInstance: string | null
  claimExpiresAt: Date | null
  spoolDir: string
  manifest: RunVideoManifest
  attemptCount: number
  lastError: string | null
  sealedAt: Date
}

export type RunVideoMediaClaim = RunVideoMediaJob & {
  workerId: string
  instanceId: string
}

function toJob(row: {
  id: string
  runId: string
  status: VideoMediaJobStatus
  fencingToken: number
  claimOwner: string | null
  claimInstance: string | null
  claimExpiresAt: Date | null
  spoolDir: string
  manifest: RunVideoManifest
  attemptCount: number
  lastError: string | null
  sealedAt: Date
}): RunVideoMediaJob {
  return {
    id: row.id,
    runId: row.runId,
    status: row.status,
    fencingToken: row.fencingToken,
    claimOwner: row.claimOwner,
    claimInstance: row.claimInstance,
    claimExpiresAt: row.claimExpiresAt,
    spoolDir: row.spoolDir,
    manifest: writeRunVideoManifest(row.manifest),
    attemptCount: row.attemptCount,
    lastError: row.lastError,
    sealedAt: row.sealedAt,
  }
}

async function liveWorker(db: Db, workerId: string, instanceId: string, now: Date): Promise<boolean> {
  const { workers } = schemaFor(db)
  const [row] = await db
    .select()
    .from(workers)
    .where(and(eq(workers.id, workerId), eq(workers.instanceId, instanceId)))
  return Boolean(row && row.status === 'READY' && (!row.heartbeatExpiresAt || row.heartbeatExpiresAt > now))
}

export async function enqueueRunVideoMediaJob(
  db: Db,
  input: { runId: string; spoolDir: string; manifest: RunVideoManifest; sealedAt: Date },
): Promise<RunVideoMediaJob> {
  const manifest = writeRunVideoManifest(input.manifest)
  return atomic(db, async (tx) => {
    if (!(await lockRunRow(tx, input.runId))) {
      throw new Error('运行不存在')
    }
    const { runVideoMediaJobs: jobs } = schemaFor(tx)
    const [existing] = await tx.select().from(jobs).where(eq(jobs.runId, input.runId)).limit(1)
    if (existing) {
      if (existing.status === 'succeeded') return toJob(existing)
      const now = await clockNow(tx)
      const nextStatus = existing.status === 'failed' ? 'pending' : existing.status
      await tx
        .update(jobs)
        .set({
          spoolDir: input.spoolDir,
          manifest,
          sealedAt: input.sealedAt,
          status: nextStatus,
          lastError: existing.status === 'failed' ? null : existing.lastError,
          updatedAt: now,
        })
        .where(eq(jobs.id, existing.id))
      return toJob({
        ...existing,
        spoolDir: input.spoolDir,
        manifest,
        sealedAt: input.sealedAt,
        status: nextStatus,
        lastError: existing.status === 'failed' ? null : existing.lastError,
      })
    }
    const now = await clockNow(tx)
    const row = {
      id: newId(),
      runId: input.runId,
      status: 'pending' as const,
      fencingToken: 0,
      claimOwner: null,
      claimInstance: null,
      claimExpiresAt: null,
      spoolDir: input.spoolDir,
      manifest,
      attemptCount: 0,
      lastError: null,
      sealedAt: input.sealedAt,
      createdAt: now,
      updatedAt: now,
    }
    try {
      await tx.insert(jobs).values(row)
      return toJob(row)
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      const [again] = await tx.select().from(jobs).where(eq(jobs.runId, input.runId)).limit(1)
      if (!again) throw error
      return toJob(again)
    }
  })
}

export async function claimRunVideoMediaJobs(
  db: Db,
  input: { workerId: string; instanceId: string; limit?: number; now?: Date; jobId?: string },
): Promise<RunVideoMediaClaim[]> {
  return atomic(db, async (tx) => {
    const now = input.now ?? (await clockNow(tx))
    if (!(await liveWorker(tx, input.workerId, input.instanceId, now))) return []
    const { runVideoMediaJobs: jobs } = schemaFor(tx)
    const due = or(eq(jobs.status, 'pending'), and(eq(jobs.status, 'claimed'), lte(jobs.claimExpiresAt, now)))
    const where = input.jobId ? and(eq(jobs.id, input.jobId), due) : due
    const candidates = await tx
      .select()
      .from(jobs)
      .where(where)
      .orderBy(asc(jobs.createdAt), asc(jobs.id))
      .limit(20)
    const claimed: RunVideoMediaClaim[] = []
    for (const row of candidates) {
      if (claimed.length >= Math.min(input.limit ?? 2, 4)) break
      if (!(await lockRunRow(tx, row.runId))) continue
      const [fresh] = await locked(tx, tx.select().from(jobs).where(eq(jobs.id, row.id)))
      if (!fresh) continue
      const expired = fresh.status === 'claimed' && fresh.claimExpiresAt && fresh.claimExpiresAt <= now
      if (fresh.status !== 'pending' && !expired) continue
      const fencingToken = fresh.fencingToken + 1
      const attemptCount = fresh.attemptCount + 1
      const updates = {
        status: 'claimed' as const,
        fencingToken,
        claimOwner: input.workerId,
        claimInstance: input.instanceId,
        claimExpiresAt: new Date(now.getTime() + VIDEO_MEDIA_LEASE_MS),
        attemptCount,
        updatedAt: now,
      }
      await tx.update(jobs).set(updates).where(eq(jobs.id, fresh.id))
      claimed.push({
        ...toJob({ ...fresh, ...updates }),
        workerId: input.workerId,
        instanceId: input.instanceId,
      })
    }
    return claimed
  })
}

export async function finishRunVideoMediaJob(
  db: Db,
  input: {
    jobId: string
    workerId: string
    instanceId: string
    fencingToken: number
    outcome: 'succeeded' | 'retry' | 'failed'
    error?: string
    manifest?: RunVideoManifest
  },
): Promise<{ ok: boolean; reason?: 'stale_fencing' | 'not_found' }> {
  return atomic(db, async (tx) => {
    const { runVideoMediaJobs: jobs } = schemaFor(tx)
    const [row] = await locked(tx, tx.select().from(jobs).where(eq(jobs.id, input.jobId)))
    if (!row) return { ok: false, reason: 'not_found' as const }
    if (
      row.status !== 'claimed' ||
      row.fencingToken !== input.fencingToken ||
      row.claimOwner !== input.workerId ||
      row.claimInstance !== input.instanceId
    ) {
      return { ok: false, reason: 'stale_fencing' as const }
    }
    const now = await clockNow(tx)
    if (row.claimExpiresAt && row.claimExpiresAt <= now) {
      return { ok: false, reason: 'stale_fencing' as const }
    }
    const exhausted = row.attemptCount >= VIDEO_MEDIA_MAX_ATTEMPTS
    const status: VideoMediaJobStatus =
      input.outcome === 'succeeded'
        ? 'succeeded'
        : input.outcome === 'failed' || exhausted
          ? 'failed'
          : 'pending'
    await tx
      .update(jobs)
      .set({
        status,
        claimOwner: null,
        claimInstance: null,
        claimExpiresAt: null,
        lastError: input.error?.slice(0, 256) ?? null,
        manifest: input.manifest ? writeRunVideoManifest(input.manifest) : row.manifest,
        updatedAt: now,
      })
      .where(eq(jobs.id, row.id))
    return { ok: true }
  })
}

export async function getRunVideoMediaJob(db: Db, runId: string): Promise<RunVideoMediaJob | null> {
  const { runVideoMediaJobs: jobs } = schemaFor(db)
  const [row] = await db.select().from(jobs).where(eq(jobs.runId, runId)).limit(1)
  return row ? toJob(row) : null
}

export async function listDueRunVideoMediaJobIds(db: Db, now: Date): Promise<string[]> {
  const { runVideoMediaJobs: jobs } = schemaFor(db)
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(or(eq(jobs.status, 'pending'), and(eq(jobs.status, 'claimed'), lte(jobs.claimExpiresAt, now))))
    .orderBy(asc(jobs.createdAt), asc(jobs.id))
    .limit(20)
  return rows.map((row) => row.id)
}
