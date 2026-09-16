import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAP_JOBS_PROTOCOL, SESSION_OCCUPANCY_PROTOCOL, type Step } from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { getOrCreatePlatformConfig, updatePlatformConfig } from '../platform-config/store.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  admitScheduleOccurrence,
  claimRun,
  createMapSafeEntry,
  createRunWithSnapshot,
  createScenarioWithVersion,
  expireClosedScheduleWindows,
  expireScheduledMapJobs,
  getMapJob,
  listScheduleOccurrences,
  materializeDueSchedules,
  previewScheduleDefinition,
  registerWorker,
  requireCreatedSession,
  setScheduleEnabled,
  setSessionProbe,
  setSessionStatus,
  updateMapJobPolicy,
  writeSchedule,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

function probeSteps(): Step[] {
  return [
    {
      id: newId(),
      name: '打开入口',
      type: 'navigate',
      effectType: 'READ_ONLY',
      policy: { timeoutMs: 8_000, retryLimit: 0 },
      input: { url: 'https://shop.example/orders' },
    },
    {
      id: newId(),
      name: '到达标题',
      type: 'assert',
      effectType: 'READ_ONLY',
      policy: { timeoutMs: 8_000, retryLimit: 0 },
      input: { target: { framePath: [], candidates: [{ by: 'role', value: 'heading', name: '订单' }] }, expect: { kind: 'visible' } },
    },
  ]
}

describe.each(DRIVERS)('%s 调度账本', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `omh_${Date.now().toString(36)}`)
    const { consoleAccounts, consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'omh',
      email: `omh-${actorId}@example.com`,
      status: 'active',
    })
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db.insert(consoleAccountRoles).values({ consoleAccountId: actorId, consoleRoleId: admin.id })
  })

  afterAll(async () => {
    await handle?.close()
  })

  function actor() {
    return { kind: 'console' as const, id: actorId }
  }

  async function freshTarget() {
    const { targets, targetAccounts } = schemaFor(handle.db)
    const targetId = newId()
    const accountId = newId()
    await handle.db.insert(targets).values({
      id: targetId,
      code: `omh-${targetId}`,
      name: '调度夹具',
      entryUrl: 'https://shop.example/home',
      loginUrl: 'https://idp.example/login',
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: '值班账号',
      username: `ops-${accountId}`,
      status: 'active',
    })
    return { targetId, accountId }
  }

  async function readyWorker(suffix: string) {
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId: `omh-w-${suffix}`,
      instanceId,
      capacity: 2,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, MAP_JOBS_PROTOCOL],
    })
    return { workerId: `omh-w-${suffix}`, instanceId }
  }

  async function prepareSession(targetId: string, accountId: string, workerId: string, instanceId: string) {
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
    })
    await setSessionProbe(handle.db, {
      sessionId: session.id,
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
      health: 'HEALTHY',
      authState: 'AUTHENTICATED',
    })
    const { browserSessions } = schemaFor(handle.db)
    await handle.db.update(browserSessions).set({ observedTier: 'LOGIN_VERIFIED' }).where(eq(browserSessions.id, session.id))
    return session
  }

  async function enableJobs(targetId: string) {
    return updateMapJobPolicy(
      handle.db,
      targetId,
      {
        expectedRevision: 0,
        idempotencyKey: `enable:${targetId}`.slice(0, 128),
        manualJobsEnabled: true,
        reason: '夹具开放',
      },
      actor(),
    )
  }

  async function addEntry(targetId: string) {
    return createMapSafeEntry(
      handle.db,
      targetId,
      {
        idempotencyKey: `entry:${targetId}`.slice(0, 128),
        name: '订单入口',
        url: 'https://shop.example/orders',
        arrivalName: '订单标题',
        arrivalTarget: { framePath: [], candidates: [{ by: 'role', value: 'heading', name: '订单' }] },
        safetyBasisKind: 'confirmed_path',
        summary: '只读复查已确认路径',
        jobKinds: ['map_probe', 'map_refresh'],
      },
      actor(),
    )
  }

  async function enableFactory() {
    const current = await getOrCreatePlatformConfig(handle.db)
    if (current.document.mapScheduledRefreshEnabled) return
    await updatePlatformConfig(handle.db, {
      expectedRevision: current.revision,
      reason: '夹具开放自动复查',
      document: { ...current.document, mapScheduledRefreshEnabled: true },
      actor: { id: actorId },
    })
  }

  async function disableFactory() {
    const current = await getOrCreatePlatformConfig(handle.db)
    if (!current.document.mapScheduledRefreshEnabled) return
    await updatePlatformConfig(handle.db, {
      expectedRevision: current.revision,
      reason: '夹具关闭自动复查',
      document: { ...current.document, mapScheduledRefreshEnabled: false },
      actor: { id: actorId },
    })
  }

  function definition(targetId: string, accountId: string, entryId: string, overrides: Partial<{ timezone: string; weekdays: number[]; windowStart: string; windowEnd: string }> = {}) {
    return {
      timezone: overrides.timezone ?? 'Asia/Shanghai',
      weekdays: overrides.weekdays ?? [1, 2, 3, 4, 5, 6, 7],
      windowStart: overrides.windowStart ?? '00:00',
      windowEnd: overrides.windowEnd ?? '23:59',
      misfire: 'skip' as const,
      consumer: {
        type: 'map_refresh' as const,
        targetId,
        targetAccountId: accountId,
        entryId,
      },
    }
  }

  async function openSchedule(targetId: string, accountId: string, entryId: string) {
    const created = await writeSchedule(
      handle.db,
      {
        expectedRevision: 0,
        idempotencyKey: `create:${newId()}`,
        definition: definition(targetId, accountId, entryId),
      },
      actor(),
    )
    return setScheduleEnabled(
      handle.db,
      created.schedule.scheduleId,
      { expectedRevision: created.schedule.revision, idempotencyKey: `on:${newId()}`, enabled: true },
      actor(),
    )
  }

  it('OMH11 工厂关闭不物化新窗口', async () => {
    await disableFactory()
    const { targetId, accountId } = await freshTarget()
    const entry = await addEntry(targetId)
    const schedule = await openSchedule(targetId, accountId, entry.entryId)
    const tick = await materializeDueSchedules(handle.db)
    expect(tick.pending).toEqual([])
    expect(tick.outcome.materialized).toBe(0)
    const occurrences = await listScheduleOccurrences(handle.db, schedule.scheduleId, { limit: 20 })
    expect(occurrences.items).toEqual([])
  })

  it('OMH03/04 预览固定 asOf：DST 跳过、跨午夜、与进程时区无关', async () => {
    const dst = await previewScheduleDefinition(
      handle.db,
      definition('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', {
        timezone: 'America/New_York',
        windowStart: '02:30',
        windowEnd: '03:30',
      }),
      new Date('2026-03-08T06:00:00.000Z'),
    )
    expect(dst.windows.some((window) => window.kind === 'skipped' && window.reason === 'DST_NONEXISTENT')).toBe(true)
    const overnight = await previewScheduleDefinition(
      handle.db,
      definition('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', {
        windowStart: '23:00',
        windowEnd: '01:00',
      }),
      new Date('2026-06-15T00:00:00.000Z'),
    )
    const first = overnight.windows.find((window) => window.kind === 'ok')
    expect(first && first.kind === 'ok' ? first.localStartDate : null).toBe('2026-06-15')
    const again = await previewScheduleDefinition(
      handle.db,
      definition('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', {
        timezone: 'America/New_York',
        windowStart: '02:30',
        windowEnd: '03:30',
      }),
      new Date('2026-03-08T06:00:00.000Z'),
    )
    expect(again.windows.map((window) => window.localSlotKey)).toEqual(dst.windows.map((window) => window.localSlotKey))
  })

  it('OMH01/06 双 tick 同窗只准入一次作业和一首片', async () => {
    await enableFactory()
    const { targetId, accountId } = await freshTarget()
    const worker = await readyWorker(targetId.slice(0, 8))
    await prepareSession(targetId, accountId, worker.workerId, worker.instanceId)
    await enableJobs(targetId)
    const entry = await addEntry(targetId)
    const schedule = await openSchedule(targetId, accountId, entry.entryId)
    const [left, right] = await Promise.all([materializeDueSchedules(handle.db), materializeDueSchedules(handle.db)])
    const pending = [...left.pending, ...right.pending].filter((item) => item.occurrence.scheduleId === schedule.scheduleId)
    const occurrenceIds = [...new Set(pending.map((item) => item.occurrence.occurrenceId))]
    expect(occurrenceIds).toHaveLength(1)
    const [first, second] = await Promise.all(
      occurrenceIds.flatMap((occurrenceId) => [
        admitScheduleOccurrence(handle.db, occurrenceId, { steps: probeSteps(), includedCount: 2 }, actor()),
        admitScheduleOccurrence(handle.db, occurrenceId, { steps: probeSteps(), includedCount: 2 }, actor()),
      ]),
    )
    expect(first.admissionStatus).toBe('ADMITTED')
    expect(second.admissionStatus).toBe('ADMITTED')
    expect(second.jobId).toBe(first.jobId)
    const { mapJobs, mapJobSlices, runs } = schemaFor(handle.db)
    const jobs = await handle.db.select().from(mapJobs).where(eq(mapJobs.targetId, targetId))
    expect(jobs).toHaveLength(1)
    const slices = await handle.db.select().from(mapJobSlices).where(eq(mapJobSlices.jobId, jobs[0]!.id))
    expect(slices).toHaveLength(1)
    const jobRuns = await handle.db.select().from(runs).where(eq(runs.id, slices[0]!.runId))
    expect(jobRuns).toHaveLength(1)
  })

  it('OMH02 双账号同 Target 第二份保持 PENDING', async () => {
    await enableFactory()
    const { targetId, accountId } = await freshTarget()
    const otherAccount = newId()
    const { targetAccounts } = schemaFor(handle.db)
    await handle.db.insert(targetAccounts).values({
      id: otherAccount,
      targetId,
      displayName: '第二账号',
      username: `ops-${otherAccount}`,
      status: 'active',
    })
    const worker = await readyWorker(`b${targetId.slice(0, 6)}`)
    await prepareSession(targetId, accountId, worker.workerId, worker.instanceId)
    await prepareSession(targetId, otherAccount, worker.workerId, worker.instanceId)
    await enableJobs(targetId)
    const entry = await addEntry(targetId)
    const firstSchedule = await openSchedule(targetId, accountId, entry.entryId)
    const secondSchedule = await openSchedule(targetId, otherAccount, entry.entryId)
    await materializeDueSchedules(handle.db)
    const firstOcc = (await listScheduleOccurrences(handle.db, firstSchedule.scheduleId, { limit: 5 })).items[0]
    const secondOcc = (await listScheduleOccurrences(handle.db, secondSchedule.scheduleId, { limit: 5 })).items[0]
    expect(firstOcc?.admissionStatus).toBe('PENDING')
    expect(secondOcc?.admissionStatus).toBe('PENDING')
    const admitted = await admitScheduleOccurrence(handle.db, firstOcc!.occurrenceId, { steps: probeSteps(), includedCount: 2 }, actor())
    const waiting = await admitScheduleOccurrence(handle.db, secondOcc!.occurrenceId, { steps: probeSteps(), includedCount: 2 }, actor())
    expect(admitted.admissionStatus).toBe('ADMITTED')
    expect(admitted.jobId).toBeTruthy()
    expect(waiting.admissionStatus).toBe('PENDING')
    expect(waiting.jobId).toBeNull()
    const { mapJobs } = schemaFor(handle.db)
    const jobs = await handle.db.select().from(mapJobs).where(eq(mapJobs.targetId, targetId))
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.targetAccountId).toBe(accountId)
  })

  it('OMH05 错过多个窗只跳过，不集中补跑', async () => {
    await enableFactory()
    const { targetId, accountId } = await freshTarget()
    const entry = await addEntry(targetId)
    const schedule = await openSchedule(targetId, accountId, entry.entryId)
    const { schedules } = schemaFor(handle.db)
    const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    await handle.db.update(schedules).set({ nextDueAt: past }).where(eq(schedules.id, schedule.scheduleId))
    await materializeDueSchedules(handle.db)
    const occurrences = await listScheduleOccurrences(handle.db, schedule.scheduleId, { limit: 40 })
    const skipped = occurrences.items.filter((item) => item.admissionStatus === 'SKIPPED' && item.reason === 'WINDOW_CLOSED')
    const pending = occurrences.items.filter((item) => item.admissionStatus === 'PENDING')
    const admitted = occurrences.items.filter((item) => item.admissionStatus === 'ADMITTED')
    expect(skipped.length).toBeGreaterThan(0)
    expect(pending.length).toBeLessThanOrEqual(1)
    expect(admitted).toHaveLength(0)
    const { mapJobs } = schemaFor(handle.db)
    const jobs = await handle.db.select().from(mapJobs).where(eq(mapJobs.targetId, targetId))
    expect(jobs).toHaveLength(0)
  })

  it('OMH07 已物化窗不因新修订重建', async () => {
    await enableFactory()
    const { targetId, accountId } = await freshTarget()
    const entry = await addEntry(targetId)
    const schedule = await openSchedule(targetId, accountId, entry.entryId)
    await materializeDueSchedules(handle.db)
    const before = (await listScheduleOccurrences(handle.db, schedule.scheduleId, { limit: 5 })).items[0]
    expect(before).toBeTruthy()
    const revised = await writeSchedule(
      handle.db,
      {
        expectedRevision: schedule.revision,
        idempotencyKey: `rev:${newId()}`,
        definition: definition(targetId, accountId, entry.entryId, { windowStart: '04:00', windowEnd: '05:00' }),
      },
      actor(),
      schedule.scheduleId,
    )
    expect(revised.schedule.revision).toBeGreaterThan(schedule.revision)
    const after = (await listScheduleOccurrences(handle.db, schedule.scheduleId, { limit: 5 })).items[0]
    expect(after?.occurrenceId).toBe(before!.occurrenceId)
    expect(after?.scheduleVersionId).toBe(before!.scheduleVersionId)
    expect(after?.scheduleVersionId).not.toBe(revised.schedule.currentVersionId)
  })

  it('OMH08/09 窗截止拒领，用户 Run 让位', async () => {
    await enableFactory()
    const { targetId, accountId } = await freshTarget()
    const worker = await readyWorker(`c${targetId.slice(0, 6)}`)
    await prepareSession(targetId, accountId, worker.workerId, worker.instanceId)
    await enableJobs(targetId)
    const entry = await addEntry(targetId)
    const schedule = await openSchedule(targetId, accountId, entry.entryId)
    await materializeDueSchedules(handle.db)
    const occurrence = (await listScheduleOccurrences(handle.db, schedule.scheduleId, { limit: 5 })).items[0]
    const admitted = await admitScheduleOccurrence(handle.db, occurrence!.occurrenceId, { steps: probeSteps(), includedCount: 2 }, actor())
    expect(admitted.jobId).toBeTruthy()
    const { scheduleOccurrences } = schemaFor(handle.db)
    await handle.db
      .update(scheduleOccurrences)
      .set({ windowEndUtc: new Date(Date.now() - 1000) })
      .where(eq(scheduleOccurrences.id, occurrence!.occurrenceId))
    expect(await expireScheduledMapJobs(handle.db)).toBeGreaterThan(0)
    const job = await getMapJob(handle.db, admitted.jobId!)
    expect(job.jobStatus).toBe('cancelled')
    expect(job.stopReason).toBe('window_closed')
    const userScenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `用户-${newId().slice(0, 8)}`,
      actor: actor(),
      steps: probeSteps(),
    })
    const userRun = await createRunWithSnapshot(handle.db, {
      scenarioId: userScenario.id,
      targetAccountId: accountId,
      actor: actor(),
    })
    const grant = await claimRun(handle, {
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      leaseTtlSeconds: 60,
    })
    expect(grant?.runId).toBe(userRun.detail.id)
    expect(grant?.runId).not.toBe(admitted.firstRunId)
  })

  it('OMH10 无纳入资产跳过且不建空作业', async () => {
    await enableFactory()
    const { targetId, accountId } = await freshTarget()
    const worker = await readyWorker(`d${targetId.slice(0, 6)}`)
    await prepareSession(targetId, accountId, worker.workerId, worker.instanceId)
    await enableJobs(targetId)
    const entry = await addEntry(targetId)
    const schedule = await openSchedule(targetId, accountId, entry.entryId)
    await materializeDueSchedules(handle.db)
    const occurrence = (await listScheduleOccurrences(handle.db, schedule.scheduleId, { limit: 5 })).items[0]
    const skipped = await admitScheduleOccurrence(handle.db, occurrence!.occurrenceId, { steps: [], includedCount: 0 }, actor())
    expect(skipped.admissionStatus).toBe('SKIPPED')
    expect(skipped.reason).toBe('NO_ELIGIBLE_ASSETS')
    const { mapJobs } = schemaFor(handle.db)
    const jobs = await handle.db.select().from(mapJobs).where(eq(mapJobs.targetId, targetId))
    expect(jobs).toHaveLength(0)
  })

  it('OMH11 撤权后不再准入，过期窗可收束', async () => {
    await enableFactory()
    const { targetId, accountId } = await freshTarget()
    const worker = await readyWorker(`e${targetId.slice(0, 6)}`)
    await prepareSession(targetId, accountId, worker.workerId, worker.instanceId)
    await enableJobs(targetId)
    const entry = await addEntry(targetId)
    const schedule = await openSchedule(targetId, accountId, entry.entryId)
    await materializeDueSchedules(handle.db)
    const occurrence = (await listScheduleOccurrences(handle.db, schedule.scheduleId, { limit: 5 })).items[0]
    const { consoleAccountRoles, consoleRoles } = schemaFor(handle.db)
    await handle.db.delete(consoleAccountRoles).where(eq(consoleAccountRoles.consoleAccountId, actorId))
    const skipped = await admitScheduleOccurrence(handle.db, occurrence!.occurrenceId, { steps: probeSteps(), includedCount: 2 }, actor())
    expect(skipped.admissionStatus).toBe('SKIPPED')
    expect(skipped.reason).toBe('PERMISSION_REVOKED')
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db.insert(consoleAccountRoles).values({ consoleAccountId: actorId, consoleRoleId: admin.id })
    const { scheduleOccurrences } = schemaFor(handle.db)
    await handle.db
      .update(scheduleOccurrences)
      .set({ windowEndUtc: new Date(Date.now() - 1000), admissionStatus: 'PENDING', reason: null })
      .where(eq(scheduleOccurrences.id, occurrence!.occurrenceId))
    expect(await expireClosedScheduleWindows(handle.db)).toBeGreaterThan(0)
  })
})
