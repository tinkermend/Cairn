import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  MODULE_MANIFEST_PROTOCOL,
  OBJECT_MISSING_REASONS,
  SESSION_OCCUPANCY_PROTOCOL,
  unknownMetric,
  type MonitorMetricNumber,
  type Step,
} from '@cairn/shared'
import { and, eq } from 'drizzle-orm'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { enterAuthWaitForRun, forceGrantForRun } from './lease-harness.js'
import { expose } from '../database.js'
import { newId } from '../id.js'
import { afterSeconds, clockNow, schemaFor } from '../native.js'
import {
  claimSessionUse,
  createRunWithSnapshot,
  createScenarioWithVersion,
  latestLogicalVersion,
  latestLogicalVersionForDriver,
  collectPlatformSamples,
  heartbeatApiInstance,
  heartbeatWorker,
  insertMonitorSamples,
  listApiInstanceCard,
  listMonitorProfiles,
  listWorkers,
  markLostApiInstances,
  purgeMonitorSamples,
  readMonitorSeries,
  recordManualObjectStoreProbe,
  summarizeAi,
  markLostWorkers,
  markWorkerDraining,
  markWorkerStopped,
  readSchemaVersion,
  findAuthWaitLeaseForRun,
  getWorkerById,
  registerWorker,
  requireCreatedSession,
  reserveStoredObject,
  setSessionStatus,
  summarizeAnomalies,
  summarizeFleet,
  summarizeQueues,
  touchRuntimeWatermark,
  upsertObjectStoreProbe,
  upsertSessionProfile,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { consoleAccounts as pg_consoleAccounts } from '../schema/console.js'
import { targetAccounts as pg_targetAccounts, targets as pg_targets } from '../schema/targets.js'

const here = dirname(fileURLToPath(import.meta.url))
const monitoringDir = resolve(here, '../monitoring')

let consoleAccounts = pg_consoleAccounts
let targetAccounts = pg_targetAccounts
let targets = pg_targets

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

const fleetOptions = {
  networkMode: 'local' as const,
  envEndpoints: {} as Record<string, string>,
  canSeeEndpoint: false,
}

function known(metric: MonitorMetricNumber): number {
  expect(metric.availability).toBe('known')
  if (metric.availability !== 'known') throw new Error('expected known metric')
  return metric.value
}

describe('监控聚合实现约束', () => {
  it('RMC02/RMC05 登记与采样不进路由或 WorkerRecord', () => {
    const leases = readFileSync(resolve(here, '../leases/leases.ts'), 'utf8')
    expect(leases).toMatch(/export type WorkerRecord/)
    expect(leases).not.toMatch(/sampledRssBytes: row\./)
    const workersApi = readFileSync(resolve(here, '../../../api/src/workers/workers.service.ts'), 'utf8')
    expect(workersApi).not.toMatch(/apiInstances|listApiInstanceCard/)
    const client = readFileSync(resolve(here, '../../../api/src/runs/worker-internal.client.ts'), 'utf8')
    expect(client).not.toMatch(/apiInstances|listApiInstanceCard/)
    const ai = readFileSync(resolve(monitoringDir, 'ai.ts'), 'utf8')
    expect(ai).toMatch(/sql`count\(\*\)`/)
    expect(ai).toMatch(/limit\(MONITOR_AI_P95_SAMPLE_LIMIT\)/)
    expect(ai.indexOf('sql`count(*)`')).toBeLessThan(ai.indexOf('limit(MONITOR_AI_P95_SAMPLE_LIMIT)'))
    const frames = readFileSync(resolve(here, '../../../api/src/runs/browser.service.ts'), 'utf8')
    expect(frames).not.toMatch(/trackSseConnection/)
  })

  it('RMA01/RMA07 只读且不走 listRuns', () => {
    for (const file of ['fleet.ts', 'queues.ts', 'anomalies.ts', 'profiles.ts', 'schema-version.ts', 'util.ts']) {
      const src = readFileSync(resolve(monitoringDir, file), 'utf8')
      expect(src).not.toMatch(/listRuns/)
      expect(src).not.toMatch(/\.(update|insert|delete)\(/)
    }
    const queues = readFileSync(resolve(monitoringDir, 'queues.ts'), 'utf8')
    expect(queues).toMatch(/eq\(sessionOperations\.status, 'QUEUED'\)/)
    expect(queues).toMatch(/RUNNING/)
    expect(queues).toMatch(/WAITING_FOR_AUTH/)
  })
})

describe.each(DRIVERS)('%s 监控只读聚合', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let accountId: string
  let scenarioId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `mon_${Date.now().toString(36)}`)
    ;({ consoleAccounts, targetAccounts, targets } = schemaFor(handle.db))
    actorId = newId()
    targetId = newId()
    accountId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'mon-tester',
      email: `mon-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `mon-${targetId.slice(0, 8)}`,
      name: '监控夹具',
      entryUrl: 'https://example.com',
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: '监控账号',
      username: 'mon',
      status: 'active',
    })
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '监控账本',
      steps: [echoStep],
      actor: { id: actorId },
    })
    scenarioId = scenario.id
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function makeAccount(label: string) {
    const id = newId()
    await handle.db.insert(targetAccounts).values({
      id,
      targetId,
      displayName: label,
      username: label,
      status: 'active',
    })
    return id
  }

  async function openSession(workerId: string, instanceId: string, account = accountId) {
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: account },
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
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
    })
    return session
  }

  it('RMA02/RMA03 舰队汇总与逐节点口径一致，重复租约不倍增', async () => {
    const stamp = `fleet-${newId().slice(0, 8)}`
    const readyId = `ready-${stamp}`
    const drainId = `drain-${stamp}`
    const stopId = `stop-${stamp}`
    const lostId = `lost-${stamp}`
    const readyInstance = newId()
    await registerWorker(handle.db, {
      workerId: readyId,
      instanceId: readyInstance,
      capacity: 8,
      maxSessions: 8,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    for (const workerId of [drainId, stopId, lostId]) {
      await registerWorker(handle.db, {
        workerId,
        instanceId: newId(),
        capacity: 1,
        maxSessions: 2,
        lostAfterSeconds: 60,
        protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
      })
    }
    expect(await markWorkerDraining(handle.db, drainId, (await getWorkerById(handle.db, drainId))!.instanceId)).toBe(true)
    expect(await markWorkerStopped(handle.db, stopId, (await getWorkerById(handle.db, stopId))!.instanceId)).toBe(true)
    const { workers } = schemaFor(handle.db)
    await handle.db.update(workers).set({ heartbeatExpiresAt: afterSeconds(handle.db, -1) }).where(eq(workers.id, lostId))
    expect(await markLostWorkers(handle.db)).toContain(lostId)

    const slotAccount = await makeAccount(`slot-${stamp}`)
    const session = await openSession(readyId, readyInstance, slotAccount)
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId,
      targetAccountId: slotAccount,
      actor: { id: actorId },
    })
    const grant = await forceGrantForRun(handle, created.detail.id, readyId)
    const claimed = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: slotAccount },
      owner: { kind: 'RUN', runId: created.detail.id, runFencingToken: grant.fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: readyId,
      holderInstanceId: readyInstance,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    if (!claimed.ok) throw new Error(claimed.message ?? claimed.code)

    const { sessionLeases, runLeases } = schemaFor(handle.db)
    await handle.db.insert(sessionLeases).values({
      id: newId(),
      sessionId: session.id,
      sessionGeneration: claimed.session.generation,
      sessionFencingToken: claimed.session.fencingToken,
      runId: created.detail.id,
      runFencingToken: grant.fencingToken,
      purpose: 'EXECUTION',
      ownerKind: 'RUN',
      holderWorkerId: readyId,
      status: 'RELEASED',
      expiresAt: afterSeconds(handle.db, -10),
      releasedAt: new Date(),
    })
    await handle.db.insert(runLeases).values({
      id: newId(),
      runId: created.detail.id,
      fencingToken: grant.fencingToken + 10,
      holderWorkerId: readyId,
      status: 'EXPIRED',
      expiresAt: afterSeconds(handle.db, -10),
      releasedAt: new Date(),
    })

    const lostAccount = await makeAccount(`lost-${stamp}`)
    const lostSession = await openSession(readyId, readyInstance, lostAccount)
    expect(
      await setSessionStatus(handle.db, {
        sessionId: lostSession.id,
        expectedVersion: lostSession.version + 1,
        status: 'LOST',
        ownerWorkerId: readyId,
        ownerWorkerInstanceId: readyInstance,
      }),
    ).toBe(true)

    const waitAccount = await makeAccount(`wait-${stamp}`)
    const waitRun = await createRunWithSnapshot(handle.db, {
      scenarioId,
      targetAccountId: waitAccount,
      actor: { id: actorId },
      idempotencyKey: newId(),
    })
    const waitGrant = await forceGrantForRun(handle, waitRun.detail.id, readyId)
    await enterAuthWaitForRun(handle, {
      targetId,
      targetAccountId: waitAccount,
      grant: waitGrant,
      workerId: readyId,
      instanceId: readyInstance,
      holdSeconds: 120,
    })

    const leftoverAccount = await makeAccount(`left-${stamp}`)
    const leftoverRun = await createRunWithSnapshot(handle.db, {
      scenarioId,
      targetAccountId: leftoverAccount,
      actor: { id: actorId },
      idempotencyKey: newId(),
    })
    const leftoverGrant = await forceGrantForRun(handle, leftoverRun.detail.id, readyId)
    await enterAuthWaitForRun(handle, {
      targetId,
      targetAccountId: leftoverAccount,
      grant: leftoverGrant,
      workerId: readyId,
      instanceId: readyInstance,
      holdSeconds: 120,
    })
    const leftoverLease = await findAuthWaitLeaseForRun(handle.db, leftoverRun.detail.id)
    if (!leftoverLease) throw new Error('missing leftover AUTH_WAIT')
    await handle.db
      .update(sessionLeases)
      .set({ waitDeadlineAt: afterSeconds(handle.db, -30) })
      .where(eq(sessionLeases.id, leftoverLease.id))

    const residueAccount = await makeAccount(`res-${stamp}`)
    const residueSession = await openSession(readyId, readyInstance, residueAccount)
    const residueRun = await createRunWithSnapshot(handle.db, {
      scenarioId,
      targetAccountId: residueAccount,
      actor: { id: actorId },
      idempotencyKey: newId(),
    })
    const residueGrant = await forceGrantForRun(handle, residueRun.detail.id, readyId)
    const residueClaimed = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: residueAccount },
      owner: { kind: 'RUN', runId: residueRun.detail.id, runFencingToken: residueGrant.fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: readyId,
      holderInstanceId: readyInstance,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    if (!residueClaimed.ok) throw new Error(residueClaimed.message ?? residueClaimed.code)
    await handle.db
      .update(sessionLeases)
      .set({ expiresAt: afterSeconds(handle.db, -10) })
      .where(and(eq(sessionLeases.sessionId, residueClaimed.session.id), eq(sessionLeases.status, 'ACTIVE')))

    const listed = await listWorkers(handle.db, { limit: 100 }, fleetOptions)
    const fleet = await summarizeFleet(handle.db, new Date(listed.asOf))
    const items = listed.items
    expect(known(fleet.data.workers.ready)).toBe(items.filter((item) => item.status === 'READY').length)
    expect(known(fleet.data.workers.draining)).toBe(items.filter((item) => item.status === 'DRAINING').length)
    expect(known(fleet.data.workers.stopped)).toBe(items.filter((item) => item.status === 'STOPPED').length)
    expect(known(fleet.data.workers.lost)).toBe(items.filter((item) => item.status === 'LOST').length)
    expect(known(fleet.data.workers.heartbeatFresh)).toBe(items.filter((item) => item.heartbeatFresh).length)
    expect(known(fleet.data.workers.heartbeatStale)).toBe(items.filter((item) => !item.heartbeatFresh).length)
    expect(fleet.liveHeartbeatStale).toBe(
      items.filter((item) => (item.status === 'READY' || item.status === 'DRAINING') && !item.heartbeatFresh)
        .length,
    )
    expect(known(fleet.data.capacity.total)).toBe(items.reduce((sum, item) => sum + item.capacity, 0))
    expect(known(fleet.data.sessions.total)).toBe(items.reduce((sum, item) => sum + item.maxSessions, 0))
    expect(known(fleet.data.slots.occupied)).toBe(items.reduce((sum, item) => sum + item.counts.occupiedSlots, 0))
    expect(known(fleet.data.slots.lostOccupied)).toBe(items.reduce((sum, item) => sum + item.counts.lostOccupied, 0))
    expect(known(fleet.data.slots.executing)).toBe(items.reduce((sum, item) => sum + item.counts.executingSlots, 0))
    expect(known(fleet.data.slots.running)).toBe(items.reduce((sum, item) => sum + item.counts.running, 0))
    expect(known(fleet.data.slots.holding)).toBe(items.reduce((sum, item) => sum + item.counts.holding, 0))
    expect(known(fleet.data.slots.waitingForAuth)).toBe(items.reduce((sum, item) => sum + item.counts.waitingForAuth, 0))
    expect(known(fleet.data.slots.leftoverAuthHolds)).toBe(items.reduce((sum, item) => sum + item.counts.leftoverAuthHolds, 0))
    expect(known(fleet.data.slots.expiredLeaseResidue)).toBe(
      items.reduce((sum, item) => sum + item.counts.expiredLeaseResidue, 0),
    )
    expect(known(fleet.data.slots.runCapacityUsed)).toBe(items.reduce((sum, item) => sum + item.counts.runCapacityUsed, 0))
    expect(known(fleet.data.sessions.used)).toBe(known(fleet.data.slots.occupied))
    const ready = items.find((item) => item.workerId === readyId)!
    expect(ready.counts.occupiedSlots).toBe(4)
    expect(ready.counts.executingSlots).toBe(1)
    expect(ready.counts.lostOccupied).toBe(1)
    expect(ready.counts.waitingForAuth).toBe(1)
    expect(ready.counts.leftoverAuthHolds).toBe(1)
    expect(ready.counts.expiredLeaseResidue).toBe(1)
    expect(known(fleet.data.slots.lostOccupied)).toBeGreaterThanOrEqual(1)
    expect(known(fleet.data.slots.waitingForAuth)).toBeGreaterThanOrEqual(1)
    expect(known(fleet.data.slots.leftoverAuthHolds)).toBeGreaterThanOrEqual(1)
    expect(known(fleet.data.slots.expiredLeaseResidue)).toBeGreaterThanOrEqual(1)
    expect(items.find((item) => item.status === 'STOPPED')?.heartbeatFresh).toBe(true)
    expect(known(fleet.data.workers.ready)).toBeGreaterThanOrEqual(1)
  })

  it('RMA12 待领取口径与 claimRun 谓词 1–3 一致，无人可领可解释', async () => {
    const { runs } = schemaFor(handle.db)
    const before = await summarizeQueues(handle.db)
    const makeQueued = () =>
      createRunWithSnapshot(handle.db, {
        scenarioId,
        targetAccountId: accountId,
        actor: { id: actorId },
        idempotencyKey: newId(),
      })
    const cancelled = await makeQueued()
    const deleted = await makeQueued()
    const expired = await createRunWithSnapshot(handle.db, {
      scenarioId,
      targetAccountId: accountId,
      actor: { id: actorId },
      idempotencyKey: newId(),
      deadlineAt: new Date(Date.now() - 60_000),
    })
    const live = await makeQueued()
    await handle.db.update(runs).set({ cancelRequestedAt: new Date() }).where(eq(runs.id, cancelled.detail.id))
    await handle.db
      .update(runs)
      .set({
        deletedAt: new Date(),
        deletedBy: { id: actorId, displayName: 'mon-tester', kind: 'console' },
      })
      .where(eq(runs.id, deleted.detail.id))
    const [template] = await handle.db.select().from(runs).where(eq(runs.id, live.detail.id))
    await handle.db.insert(runs).values({
      id: newId(),
      targetId: template!.targetId,
      scenarioId: template!.scenarioId,
      scenarioVersionId: template!.scenarioVersionId,
      targetAccountId: template!.targetAccountId,
      createdByConsoleAccountId: template!.createdByConsoleAccountId,
      status: template!.status,
      snapshot: { ...live.detail.snapshot, moduleManifest: { entries: [] } },
      snapshotDigest: `gated-${newId()}`,
      context: template!.context,
      idempotencyKey: newId(),
      idempotencyDigest: `gated-${newId()}`,
    })

    const workerId = `gate-${newId().slice(0, 8)}`
    await registerWorker(handle.db, {
      workerId,
      instanceId: newId(),
      capacity: 2,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    const afterGate = await summarizeQueues(handle.db)
    expect(known(afterGate.data.claimableRuns)).toBe(known(before.data.claimableRuns) + 2)
    expect(known(afterGate.data.unclaimableRuns)).toBeGreaterThanOrEqual(1)

    await registerWorker(handle.db, {
      workerId: `cover-${newId().slice(0, 8)}`,
      instanceId: newId(),
      capacity: 2,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, MODULE_MANIFEST_PROTOCOL],
    })
    const afterCover = await summarizeQueues(handle.db)
    expect(known(afterCover.data.claimableRuns)).toBe(known(afterGate.data.claimableRuns))
    expect(known(afterCover.data.unclaimableRuns)).toBe(known(afterGate.data.unclaimableRuns) - 1)
    expect(expired.detail.id).toBeTruthy()
    expect(live.detail.id).toBeTruthy()
  })

  it('恢复中与待核查按状态计数，不受待领取谓词收窄', async () => {
    const { runs } = schemaFor(handle.db)
    const before = await summarizeQueues(handle.db)
    const makeQueued = () =>
      createRunWithSnapshot(handle.db, {
        scenarioId,
        targetAccountId: accountId,
        actor: { id: actorId },
        idempotencyKey: newId(),
      })
    const recovering = await makeQueued()
    const cancelledRecovering = await makeQueued()
    const review = await makeQueued()
    await handle.db.update(runs).set({ status: 'RECOVERING' }).where(eq(runs.id, recovering.detail.id))
    await handle.db
      .update(runs)
      .set({ status: 'RECOVERING', cancelRequestedAt: new Date() })
      .where(eq(runs.id, cancelledRecovering.detail.id))
    await handle.db.update(runs).set({ status: 'NEEDS_REVIEW' }).where(eq(runs.id, review.detail.id))
    const after = await summarizeQueues(handle.db)
    expect(known(after.data.recovering)).toBe(known(before.data.recovering) + 2)
    expect(known(after.data.claimableRuns)).toBe(known(before.data.claimableRuns) + 1)
    expect(known(after.data.needsReview)).toBe(known(before.data.needsReview) + 1)
  })

  it('RMA07 session_operations 分查且执行计划可取', async () => {
    const { sessionOperations } = schemaFor(handle.db)
    const account = await makeAccount(`ops-${newId().slice(0, 6)}`)
    const base = {
      targetId,
      targetAccountId: account,
      kind: 'PREPARE' as const,
      origin: 'USER' as const,
      kindParams: {},
      secretRefs: [],
      idempotencyKey: newId(),
      contentDigest: 'digest',
      platformConfigRevision: 1,
      queueDeadlineAt: afterSeconds(handle.db, 300),
    }
    await handle.db.insert(sessionOperations).values([
      { ...base, id: newId(), status: 'QUEUED', idempotencyKey: newId() },
      { ...base, id: newId(), status: 'RUNNING', idempotencyKey: newId() },
      { ...base, id: newId(), status: 'WAITING_FOR_AUTH', idempotencyKey: newId() },
    ])
    const queues = await summarizeQueues(handle.db)
    expect(known(queues.data.sessionOperations)).toBeGreaterThanOrEqual(3)

    if (driver === 'postgres') {
      const indexes = await handle.raw(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'cairn' AND indexname = 'session_operations_claim_idx'`,
      )
      expect(JSON.stringify(indexes)).toMatch(/WHERE.*status = 'QUEUED'/)
      await handle.raw('SET enable_seqscan = off')
      const queuedPlan = await handle.raw(
        `EXPLAIN (FORMAT JSON) SELECT count(*) FROM cairn.session_operations WHERE status = 'QUEUED'`,
      )
      const activePlan = await handle.raw(
        `EXPLAIN (FORMAT JSON) SELECT count(*) FROM cairn.session_operations WHERE status IN ('RUNNING', 'WAITING_FOR_AUTH')`,
      )
      await handle.raw('SET enable_seqscan = on')
      expect(JSON.stringify(queuedPlan)).toMatch(/session_operations_claim_idx/)
      expect(JSON.stringify(activePlan).toLowerCase()).not.toMatch(/listRuns/)
      expect(JSON.stringify(activePlan)).not.toMatch(/session_operations_claim_idx/)
    } else {
      const queuedPlan = await handle.raw(`EXPLAIN SELECT count(*) FROM session_operations WHERE status = 'QUEUED'`)
      const activePlan = await handle.raw(
        `EXPLAIN SELECT count(*) FROM session_operations WHERE status IN ('RUNNING', 'WAITING_FOR_AUTH')`,
      )
      const queuedKey = JSON.stringify(queuedPlan)
      expect(queuedKey).toMatch(/session_operations_claim_idx/)
      expect(JSON.stringify(activePlan)).not.toMatch(/listRuns/)
    }
  })

  it('RMA11/RMA13 池水位与两个 schema 版本', async () => {
    const schema = await readSchemaVersion(handle)
    expect(schema.expectedLogicalVersion).toBe(latestLogicalVersion())
    expect(schema.expectedPrefix).toBe(latestLogicalVersionForDriver(driver))
    expect(schema.appliedPrefix).toBe(schema.expectedPrefix)
    expect(schema.schemaConsistency).toBe('consistent')
    if (schema.expectedPrefix !== schema.expectedLogicalVersion) {
      expect(schema.schemaConsistency).not.toBe('mismatch')
    }
    await handle.raw(
      driver === 'mysql'
        ? "INSERT INTO _migrations (prefix, filename, checksum, state) VALUES ('zzzz', 'zzzz.sql', 'x', 'complete')"
        : "INSERT INTO _migrations (prefix, filename) VALUES ('zzzz', 'zzzz.sql')",
    )
    const mismatch = await readSchemaVersion(handle)
    expect(mismatch.appliedPrefix).toBe('zzzz')
    expect(mismatch.expectedPrefix).toBe(latestLogicalVersionForDriver(driver))
    expect(mismatch.schemaConsistency).toBe('mismatch')
    await handle.raw("DELETE FROM _migrations WHERE prefix = 'zzzz'")

    const stats = expose(handle).poolStats()
    if (driver === 'postgres') {
      expect(stats).toEqual({
        totalCount: expect.any(Number),
        idleCount: expect.any(Number),
        waitingCount: expect.any(Number),
      })
    } else {
      expect(stats).toBeNull()
    }
  })

  it('RMA06 Profile 分页与未知磁盘占用', async () => {
    const workerId = `prof-${newId().slice(0, 8)}`
    const accounts = await Promise.all([
      makeAccount('p1'),
      makeAccount('p2'),
      makeAccount('p3'),
    ])
    const { sessionProfiles } = schemaFor(handle.db)
    for (const [index, account] of accounts.entries()) {
      await upsertSessionProfile(handle.db, {
        key: { targetId, targetAccountId: account },
        workerId,
        state: index === 2 ? 'ABSENT' : 'PRESENT',
      })
    }
    await handle.db
      .update(sessionProfiles)
      .set({ pendingCleanups: [{ workerId, revision: 1 }] })
      .where(eq(sessionProfiles.targetAccountId, accounts[0]!))
    const page = await listMonitorProfiles(handle.db, { limit: 2 })
    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).toBeTruthy()
    expect(page.items.every((item) => item.profileKey === `${item.targetId}/${item.targetAccountId}`)).toBe(true)
    expect(page.items.every((item) => item.diskUsageBytes.availability === 'unknown')).toBe(true)
    const rest = await listMonitorProfiles(handle.db, { limit: 10, cursor: page.nextCursor })
    const all = [...page.items, ...rest.items]
    expect(all.some((item) => item.pendingCleanups === 1)).toBe(true)
    expect(all.some((item) => item.state === 'ABSENT')).toBe(true)
    expect(JSON.stringify(page)).not.toMatch(/\/Users\//)
    await expect(listMonitorProfiles(handle.db, { cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    })
  })

  it('异常分区：遗留认证、孤儿 Attempt、证据与清理债务', async () => {
    const workerId = `anom-${newId().slice(0, 8)}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 2,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    const holdAccount = await makeAccount(`hold-${workerId}`)
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId,
      targetAccountId: holdAccount,
      actor: { id: actorId },
      idempotencyKey: newId(),
    })
    const grant = await forceGrantForRun(handle, created.detail.id, workerId)
    await enterAuthWaitForRun(handle, {
      targetId,
      targetAccountId: holdAccount,
      grant,
      workerId,
      instanceId,
      holdSeconds: 30,
    })
    const { sessionLeases, attempts, runLeases, evidences } = schemaFor(handle.db)
    const authWait = await findAuthWaitLeaseForRun(handle.db, created.detail.id)
    if (!authWait) throw new Error('missing AUTH_WAIT lease')
    await handle.db
      .update(sessionLeases)
      .set({ waitDeadlineAt: afterSeconds(handle.db, -30) })
      .where(eq(sessionLeases.id, authWait.id))

    const orphanRun = await createRunWithSnapshot(handle.db, {
      scenarioId,
      targetAccountId: holdAccount,
      actor: { id: actorId },
      idempotencyKey: newId(),
    })
    await handle.db.insert(attempts).values({
      id: newId(),
      stepRunId: orphanRun.detail.stepRuns[0]!.id,
      attemptNo: 1,
      status: 'RUNNING',
      startedAt: new Date(),
    })
    const releasedAt = new Date()
    await handle.db.insert(runLeases).values([
      {
        id: newId(),
        runId: orphanRun.detail.id,
        fencingToken: 1,
        holderWorkerId: workerId,
        status: 'EXPIRED',
        expiresAt: afterSeconds(handle.db, -10),
        releasedAt,
      },
      {
        id: newId(),
        runId: orphanRun.detail.id,
        fencingToken: 2,
        holderWorkerId: workerId,
        status: 'EXPIRED',
        expiresAt: afterSeconds(handle.db, -9),
        releasedAt,
      },
      {
        id: newId(),
        runId: orphanRun.detail.id,
        fencingToken: 3,
        holderWorkerId: workerId,
        status: 'REVOKED',
        expiresAt: afterSeconds(handle.db, -8),
        releasedAt,
      },
    ])
    await handle.db.insert(evidences).values([
      {
        id: newId(),
        runId: orphanRun.detail.id,
        type: 'log',
        status: 'pending',
        uploadAttempts: 2,
      },
      {
        id: newId(),
        runId: orphanRun.detail.id,
        type: 'screenshot',
        status: 'missing',
        missingReason: OBJECT_MISSING_REASONS.uploadIncomplete,
        uploadAttempts: 5,
      },
      {
        id: newId(),
        runId: orphanRun.detail.id,
        type: 'trace',
        status: 'missing',
        missingReason: OBJECT_MISSING_REASONS.purged,
        uploadAttempts: 1,
      },
    ])
    const reserved = await reserveStoredObject(handle.db, {
      runId: orphanRun.detail.id,
      retainUntil: new Date(Date.now() - 1000),
    })
    const { storedObjects } = schemaFor(handle.db)
    await handle.db
      .update(storedObjects)
      .set({ status: 'available', lastPurgeErrorAt: new Date() })
      .where(eq(storedObjects.id, reserved.id))

    const asOf = await clockNow(handle.db)
    const anomalies = await summarizeAnomalies(handle.db, asOf)
    expect(known(anomalies.data.leases.leftoverAuthHolds)).toBeGreaterThanOrEqual(1)
    expect(known(anomalies.data.leases.orphanAttempts)).toBeGreaterThanOrEqual(1)
    expect(known(anomalies.data.leases.recoveryCappedRuns)).toBeGreaterThanOrEqual(1)
    expect(known(anomalies.data.evidence.pendingUpload)).toBeGreaterThanOrEqual(1)
    expect(known(anomalies.data.evidence.uploadFailed)).toBeGreaterThanOrEqual(1)
    expect(known(anomalies.data.evidence.maxUploadAttempts)).toBeGreaterThanOrEqual(5)
    expect(
      anomalies.data.evidence.missingReasons.some((row) => row.reason === OBJECT_MISSING_REASONS.uploadIncomplete),
    ).toBe(true)
    expect(anomalies.data.evidence.missingReasons.some((row) => row.reason === OBJECT_MISSING_REASONS.purged)).toBe(true)
    const failedBeforePurgedOnly = known(anomalies.data.evidence.uploadFailed)
    expect(failedBeforePurgedOnly).toBe(
      anomalies.data.evidence.missingReasons
        .filter((row) => row.reason === OBJECT_MISSING_REASONS.uploadIncomplete || row.reason === OBJECT_MISSING_REASONS.storeUnavailable)
        .reduce((sum, row) => sum + row.count, 0),
    )
    expect(known(anomalies.data.evidence.purgeBacklog)).toBeGreaterThanOrEqual(1)
    expect(known(anomalies.data.evidence.purgeFailed)).toBeGreaterThanOrEqual(1)
  })

  it('A4 未回收时水位未知，回收后给出年龄', async () => {
    const before = await summarizeQueues(handle.db)
    expect(before.data.lastGlobalReclaimAgeMs.availability).toBe('unknown')
    await touchRuntimeWatermark(handle.db, 'global_reclaim')
    const after = await summarizeQueues(handle.db)
    expect(after.data.lastGlobalReclaimAgeMs.availability).toBe('known')
    expect(known(after.data.lastGlobalReclaimAgeMs)).toBeGreaterThanOrEqual(0)
    expect(known(after.data.maxTargetBacklog)).toBeGreaterThanOrEqual(0)
    expect(known(after.data.targetsWithBacklog)).toBeGreaterThanOrEqual(0)
    expect(known(after.data.targetBacklogP95)).toBeGreaterThanOrEqual(0)
    expect(after.data.lastClaimScanCount.availability).toBe('unknown')
    expect(known(after.data.mapJobsQueued) + known(after.data.mapJobsRunning)).toBe(known(after.data.mapJobsActive))
    await insertMonitorSamples(handle.db, [
      { key: 'queue.lastClaimScanCount', scope: 'worker', scopeId: 'claim-scan', value: 7 },
    ])
    const scanned = await summarizeQueues(handle.db)
    expect(known(scanned.data.lastClaimScanCount)).toBe(7)
  })

  it('RMC03/RMC10/RMC11/RMC16 登记代次、采样去重与降采样', async () => {
    const first = await heartbeatApiInstance(handle.db, {
      id: 'api-a',
      instanceId: '11111111-1111-4111-8111-111111111111',
      idSource: 'configured',
      lostAfterSeconds: 45,
      version: '1.0.0',
      schemaLogicalVersion: latestLogicalVersion(),
      rssBytes: 12,
    })
    expect(first).toBe('ok')
    const late = await heartbeatApiInstance(handle.db, {
      id: 'api-a',
      instanceId: '22222222-2222-4222-8222-222222222222',
      idSource: 'configured',
      lostAfterSeconds: 45,
      version: '9.9.9',
      schemaLogicalVersion: latestLogicalVersion(),
      rssBytes: 99,
    })
    expect(late).toBe('lost')
    const card = await listApiInstanceCard(handle.db, await clockNow(handle.db))
    expect(card.items[0]?.instanceId).toBe('11111111-1111-4111-8111-111111111111')
    expect(known(card.items[0]!.rssBytes)).toBe(12)
    await markLostApiInstances(handle.db)

    const firstWrite = await insertMonitorSamples(
      handle.db,
      [{ key: 'queue.claimableRuns', scope: 'platform', value: 3 }],
      60_000,
    )
    const secondWrite = await insertMonitorSamples(
      handle.db,
      [{ key: 'queue.claimableRuns', scope: 'platform', value: 9 }],
      60_000,
    )
    expect(firstWrite).toBe(1)
    expect(secondWrite).toBe(0)
    const series = await readMonitorSeries(handle.db, { keys: ['queue.claimableRuns'] })
    expect(series.items[0]?.points).toHaveLength(1)
    expect(series.items[0]?.points[0]?.value).toBe(3)

    const purged = await purgeMonitorSamples(handle.db, 0)
    expect(purged).toBeGreaterThanOrEqual(1)
  })

  it('RMC03/RMC12/RMC16 过期不计入就绪、时钟差与库时间桶', async () => {
    const expiredId = `api-expired-${newId().slice(0, 8)}`
    expect(
      await heartbeatApiInstance(handle.db, {
        id: expiredId,
        instanceId: newId(),
        idSource: 'derived',
        lostAfterSeconds: 45,
        version: '1.0.0',
        schemaLogicalVersion: latestLogicalVersion(),
        rssBytes: 8,
      }),
    ).toBe('ok')
    const { apiInstances, workers } = schemaFor(handle.db)
    const beforeCard = await listApiInstanceCard(handle.db, await clockNow(handle.db))
    await handle.db
      .update(apiInstances)
      .set({ heartbeatExpiresAt: new Date(0) })
      .where(eq(apiInstances.id, expiredId))
    const asOf = await clockNow(handle.db)
    const card = await listApiInstanceCard(handle.db, asOf)
    expect(card.items.some((item) => item.id === expiredId)).toBe(true)
    expect(known(card.ready)).toBe(Math.max(0, known(beforeCard.ready) - 1))
    expect(known(card.lost)).toBe(known(beforeCard.lost) + 1)

    await upsertObjectStoreProbe(handle.db, {
      status: 'ok',
      latencyMs: 9,
      errorClass: null,
      probedBy: 'worker:test',
      probedAt: new Date(asOf.getTime() - 10 * 60_000),
    })
    const samples = await collectPlatformSamples(handle.db, { objectStoreStaleAfterMs: 120_000 })
    expect(samples.some((row) => row.key === 'objectStore.up')).toBe(false)

    const workerId = `clk-${newId().slice(0, 8)}`
    const instanceId = newId()
    await registerWorker(handle.db, { workerId, instanceId, capacity: 1, lostAfterSeconds: 60 })
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(asOf.getTime() + 15_000)
    expect(await heartbeatWorker(handle.db, workerId, instanceId, { liveHandleCount: 0, rssBytes: 42 })).toBe('ok')
    const [workerRow] = await handle.db.select().from(workers).where(eq(workers.id, workerId))
    expect(workerRow?.processClockSkewMs).toBeGreaterThan(10_000)
    nowSpy.mockReturnValue(asOf.getTime() + 40 * 86_400_000)
    await insertMonitorSamples(handle.db, [{ key: 'queue.recovering', scope: 'platform', value: 2 }], 60_000)
    const series = await readMonitorSeries(handle.db, { keys: ['queue.recovering'] })
    const bucket = Date.parse(series.items[0]?.points[0]?.bucketAt ?? '')
    expect(Number.isFinite(bucket)).toBe(true)
    expect(Math.abs(bucket - asOf.getTime())).toBeLessThan(60_000)
    nowSpy.mockRestore()

    const taken = newId()
    await handle.db.update(workers).set({ heartbeatExpiresAt: new Date(0) }).where(eq(workers.id, workerId))
    await registerWorker(handle.db, { workerId, instanceId: taken, capacity: 1, lostAfterSeconds: 60 })
    const [cleared] = await handle.db.select().from(workers).where(eq(workers.id, workerId))
    expect(cleared?.sampledRssBytes).toBeNull()
    expect(cleared?.processClockSkewMs).toBeNull()

    await expect(
      readMonitorSeries(handle.db, {
        keys: ['queue.claimableRuns'],
        from: new Date(asOf.getTime() - 40 * 86_400_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'MONITOR_SERIES_WINDOW' })
  })

  it('RMC08/RMC13/RMC17 探测、AI 成本 unknown、节点磁盘≠逐 Profile', async () => {
    const probed = await recordManualObjectStoreProbe(handle.db, {
      status: 'failed',
      latencyMs: 12,
      errorClass: 'UNAVAILABLE',
      probedBy: 'api:test',
      actor: { id: actorId },
    })
    expect(known(probed.status)).toBe(0)
    expect(probed.errorClass).toBe('UNAVAILABLE')
    const ai = await summarizeAi(handle.db, await clockNow(handle.db))
    expect(ai.cost).toEqual(unknownMetric('not_collected'))
    const profiles = await listMonitorProfiles(handle.db, { limit: 20 })
    for (const item of profiles.items) {
      expect(item.diskUsageBytes).toEqual(unknownMetric('not_collected'))
    }
    expect(Array.isArray(profiles.nodes)).toBe(true)

    const frozen = Date.parse('2099-01-01T00:00:00.000Z')
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(frozen)
    await upsertObjectStoreProbe(handle.db, {
      status: 'ok',
      latencyMs: 3,
      errorClass: null,
      probedBy: 'clock-test',
    })
    nowSpy.mockRestore()
    const dbNow = await clockNow(handle.db)
    const { objectStoreProbes, scenarioAiCalls } = schemaFor(handle.db)
    const [probe] = await handle.db.select().from(objectStoreProbes)
    expect(probe?.probedAt.getUTCFullYear()).not.toBe(2099)
    expect(Math.abs(probe!.probedAt.getTime() - dbNow.getTime())).toBeLessThan(5_000)

    await handle.db.insert(scenarioAiCalls).values({
      id: newId(),
      evidenceId: newId(),
      runId: newId(),
      stepRunId: newId(),
      purpose: 'scenario',
      phase: 'completed',
      inputTokens: null,
      outputTokens: null,
    })
    const tokens = await summarizeAi(handle.db, await clockNow(handle.db))
    expect(tokens.inputTokens).toEqual(unknownMetric('not_reported'))
    expect(tokens.outputTokens).toEqual(unknownMetric('not_reported'))
  })
})
