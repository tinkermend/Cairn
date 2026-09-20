import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { VIDEO_MEDIA_LEASE_MS, writeRunVideoManifest, type Step } from '@cairn/shared'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import {
  claimRunVideoMediaJobs,
  createRunWithSnapshot,
  createScenarioWithVersion,
  enqueueRunVideoMediaJob,
  finishRunVideoMediaJob,
} from '../test-entry.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { seedWorker } from './lease-harness.js'
import { consoleAccounts as pg_consoleAccounts } from '../schema/console.js'
let consoleAccounts = pg_consoleAccounts
import { targets as pg_targets } from '../schema/targets.js'
let targets = pg_targets

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000c1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  outputKey: 'greeting',
  input: { value: 'hello' },
}

function manifestFor(runId: string) {
  return writeRunVideoManifest({
    contractVersion: 1,
    runId,
    sealed: true,
    sealedTMs: 8_000,
    framesWritten: 4,
    persistWatermark: 4,
    segments: [
      {
        seq: 0,
        fromMs: 0,
        toMs: 8_000,
        frameCount: 4,
        persistWatermark: 4,
        status: 'local',
      },
    ],
  })
}

describe.each(DRIVERS)('%s 录像媒体任务领取与 fencing', { timeout: 30_000 }, (driver) => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let actorId: string
  let scenarioId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `cairn_test_${Date.now().toString(36)}_vmedia`)
    ;({ consoleAccounts, targets } = schemaFor(handle.db))
    actorId = newId()
    const targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'vmedia',
      email: `vmedia-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `vm-${targetId.slice(0, 8)}`,
      name: '录像媒体',
      entryUrl: 'https://example.com',
    })
    scenarioId = (
      await createScenarioWithVersion(handle.db, {
        targetId,
        name: '录像媒体',
        steps: [echoStep],
        actor: { id: actorId },
      })
    ).id
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function newRun() {
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId,
      actor: { id: actorId },
    })
    return created.detail.id
  }

  it('同一 Run 重复入队只保留一行', async () => {
    const runId = await newRun()
    const first = await enqueueRunVideoMediaJob(handle.db, {
      runId,
      spoolDir: `/tmp/cairn-video-${runId}`,
      manifest: manifestFor(runId),
      sealedAt: new Date(),
    })
    const second = await enqueueRunVideoMediaJob(handle.db, {
      runId,
      spoolDir: `/tmp/cairn-video-${runId}-b`,
      manifest: manifestFor(runId),
      sealedAt: new Date(),
    })
    expect(second.id).toBe(first.id)
    expect(second.spoolDir).toBe(`/tmp/cairn-video-${runId}-b`)
  })

  it('并发领取只有一个所有者；旧 fencing 不能收尾', async () => {
    const runId = await newRun()
    await enqueueRunVideoMediaJob(handle.db, {
      runId,
      spoolDir: `/tmp/cairn-video-${runId}`,
      manifest: manifestFor(runId),
      sealedAt: new Date(),
    })
    const a = await seedWorker(handle, `vm-a-${newId().slice(0, 8)}`)
    const b = await seedWorker(handle, `vm-b-${newId().slice(0, 8)}`)
    const [first, second] = await Promise.all([
      claimRunVideoMediaJobs(handle.db, { workerId: a.workerId, instanceId: a.instanceId, limit: 1 }),
      claimRunVideoMediaJobs(handle.db, { workerId: b.workerId, instanceId: b.instanceId, limit: 1 }),
    ])
    const owned = [...first, ...second].filter((job) => job.runId === runId)
    expect(owned).toHaveLength(1)
    const job = owned[0]!
    const stale = await finishRunVideoMediaJob(handle.db, {
      jobId: job.id,
      workerId: job.workerId,
      instanceId: job.instanceId,
      fencingToken: job.fencingToken - 1,
      outcome: 'succeeded',
    })
    expect(stale).toEqual({ ok: false, reason: 'stale_fencing' })
    const ok = await finishRunVideoMediaJob(handle.db, {
      jobId: job.id,
      workerId: job.workerId,
      instanceId: job.instanceId,
      fencingToken: job.fencingToken,
      outcome: 'succeeded',
    })
    expect(ok).toEqual({ ok: true })
    const late = await finishRunVideoMediaJob(handle.db, {
      jobId: job.id,
      workerId: job.workerId,
      instanceId: job.instanceId,
      fencingToken: job.fencingToken,
      outcome: 'succeeded',
    })
    expect(late.ok).toBe(false)
  })

  it('租约过期后可被下一 Worker 领取', async () => {
    const runId = await newRun()
    const enqueued = await enqueueRunVideoMediaJob(handle.db, {
      runId,
      spoolDir: `/tmp/cairn-video-${runId}`,
      manifest: manifestFor(runId),
      sealedAt: new Date(),
    })
    const a = await seedWorker(handle, `vm-exp-${newId().slice(0, 8)}`)
    const [claimed] = await claimRunVideoMediaJobs(handle.db, {
      workerId: a.workerId,
      instanceId: a.instanceId,
      jobId: enqueued.id,
    })
    expect(claimed?.fencingToken).toBeGreaterThan(0)
    const { runVideoMediaJobs } = schemaFor(handle.db)
    const { eq } = await import('drizzle-orm')
    await handle.db
      .update(runVideoMediaJobs)
      .set({ claimExpiresAt: new Date(Date.now() - VIDEO_MEDIA_LEASE_MS) })
      .where(eq(runVideoMediaJobs.id, claimed!.id))
    const b = await seedWorker(handle, `vm-exp2-${newId().slice(0, 8)}`)
    const [reclaimed] = await claimRunVideoMediaJobs(handle.db, {
      workerId: b.workerId,
      instanceId: b.instanceId,
      jobId: claimed!.id,
    })
    expect(reclaimed?.fencingToken).toBeGreaterThan(claimed!.fencingToken)
    const rejected = await finishRunVideoMediaJob(handle.db, {
      jobId: claimed!.id,
      workerId: a.workerId,
      instanceId: a.instanceId,
      fencingToken: claimed!.fencingToken,
      outcome: 'succeeded',
    })
    expect(rejected).toEqual({ ok: false, reason: 'stale_fencing' })
  })
})
