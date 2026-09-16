import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PLATFORM_CONFIG_SINGLETON_ID, SESSION_OCCUPANCY_PROTOCOL, type Step } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { afterSeconds, schemaFor } from '../native.js'
import { newId } from '../id.js'
import { claimExecutionForRun, forceGrantForRun, seedWorker } from './lease-harness.js'
import {
  claimRun,
  claimSessionUse,
  countFailedRecoveries,
  computeRunPlacement,
  createRunWithSnapshot,
  createScenarioWithVersion,
  DomainError,
  enterRunWaitingForAuth,
  findAuthWaitLeaseForRun,
  findLiveSession,
  getRun,
  getSessionById,
  getSessionProfile,
  invalidateSessionProfile,
  markWorkerDraining,
  reapSessionLeases,
  registerWorker,
  requestSessionOperation,
  resumeRunAfterAuth,
  setSessionStatus,
  upsertSessionProfile,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { getOrCreatePlatformConfig, updatePlatformConfig } from '../platform-config/store.js'

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000b1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s 会话占用与调度', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `occ_${Date.now().toString(36)}`)
    const { consoleAccounts, targets } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'occupancy',
      email: `occ-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `occ-${targetId.slice(0, 8)}`,
      name: '占用夹具',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle.close()
  })

  afterEach(async () => {
    if (!handle) return
    const { runs } = schemaFor(handle.db)
    await handle.db.update(runs).set({ status: 'CANCELLED', finishedAt: new Date() })
      .where(inArray(runs.status, ['QUEUED', 'RECOVERING']))
  })

  async function makeAccount(label: string): Promise<string> {
    const { targetAccounts } = schemaFor(handle.db)
    const id = newId()
    await handle.db.insert(targetAccounts).values({
      id,
      targetId,
      displayName: label,
      username: `u-${label}`,
      status: 'active',
    })
    return id
  }

  async function queueRun(accountId: string) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `occ-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    return createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
  }

  async function closeSession(sessionId: string, workerId: string) {
    const row = await getSessionById(handle.db, sessionId)
    if (!row || row.status === 'CLOSED') return
    await setSessionStatus(handle.db, {
      sessionId,
      expectedVersion: row.version,
      status: 'CLOSED',
      closeReason: 'cleanup',
      ownerWorkerId: workerId,
    })
  }

  it('EXECUTION 拒绝无效 Run fencing', async () => {
    const accountId = await makeAccount('fence0')
    const created = await queueRun(accountId)
    const worker = await seedWorker(handle, `fence0-${newId().slice(0, 8)}`)
    const rejected = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: accountId },
      owner: { kind: 'RUN', runId: created.detail.id, runFencingToken: 0 },
      purpose: 'EXECUTION',
      holderWorkerId: worker.workerId,
      holderInstanceId: worker.instanceId,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.code).toBe('SESSION_NOT_CLAIMABLE')
  })

  it('SM28 未声明 session-occupancy@2 的 Worker 不能 READY', async () => {
    await expect(
      registerWorker(handle.db, {
        workerId: `old-${newId().slice(0, 8)}`,
        instanceId: newId(),
        capacity: 2,
        lostAfterSeconds: 60,
        protocolCapabilities: [],
      }),
    ).rejects.toMatchObject({ code: 'WORKER_PROTOCOL_UNSUPPORTED' })
    const ready = await seedWorker(handle, `ready-${newId().slice(0, 8)}`)
    const { workers } = schemaFor(handle.db)
    const [row] = await handle.db.select().from(workers).where(eq(workers.id, ready.workerId))
    expect(row?.protocolCapabilities).toContain(SESSION_OCCUPANCY_PROTOCOL)
  })

  it('SM05 连续 20 轮同键并发领取至多一条 ACTIVE 租约', async () => {
    for (let round = 0; round < 20; round += 1) {
    const accountId = await makeAccount(`sm05-${round}`)
    const a = await seedWorker(handle, `sm05a-${newId().slice(-12)}`)
    const b = await seedWorker(handle, `sm05b-${newId().slice(-12)}`)
    const first = await queueRun(accountId)
    const second = await queueRun(accountId)
    const grantA = await forceGrantForRun(handle, first.detail.id, a.workerId)
    const grantB = await forceGrantForRun(handle, second.detail.id, b.workerId)
    const base = {
      key: { targetId, targetAccountId: accountId },
      purpose: 'EXECUTION' as const,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE' as const,
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    }
    const [left, right] = await Promise.all([
      claimSessionUse(handle.db, {
        ...base,
        owner: { kind: 'RUN', runId: grantA.runId, runFencingToken: grantA.fencingToken },
        holderWorkerId: a.workerId,
        holderInstanceId: a.instanceId,
      }),
      claimSessionUse(handle.db, {
        ...base,
        owner: { kind: 'RUN', runId: grantB.runId, runFencingToken: grantB.fencingToken },
        holderWorkerId: b.workerId,
        holderInstanceId: b.instanceId,
      }),
    ])
    expect([left, right].filter((item) => item.ok)).toHaveLength(1)
    expect([left, right].filter((item) => !item.ok)).toHaveLength(1)
    const live = await findLiveSession(handle.db, { targetId, targetAccountId: accountId })
    expect(live).not.toBeNull()
    const { sessionLeases } = schemaFor(handle.db)
    const active = await handle.db.select().from(sessionLeases).where(eq(sessionLeases.sessionId, live!.id))
    expect(active.filter((row) => row.status === 'ACTIVE')).toHaveLength(1)
    if (live) await closeSession(live.id, live.ownerWorkerId)
    }
  })

  it('SM31 占用中的会话不会被另一条 Run 领取，placement 给出等待原因', async () => {
    const accountId = await makeAccount('sm31')
    const worker = await seedWorker(handle, `sm31-${newId().slice(0, 8)}`)
    const first = await queueRun(accountId)
    const firstGrant = await forceGrantForRun(handle, first.detail.id, worker.workerId)
    const claimed = await claimExecutionForRun(handle, {
      targetId,
      targetAccountId: accountId,
      grant: firstGrant,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
    })
    expect(claimed.ok).toBe(true)
    const waiting = await queueRun(accountId)
    const placement = await computeRunPlacement(handle.db, {
      status: waiting.detail.status,
      createdAt: new Date(waiting.detail.createdAt),
      targetId,
      targetAccountId: accountId,
      hasActiveLease: false,
    })
    expect(placement.waitReason).toBe('SESSION_IN_USE_BY_RUN')
    expect(placement.occupyingRunId).toBe(first.detail.id)
    expect(
      await claimRun(handle, {
        workerId: worker.workerId,
        instanceId: worker.instanceId,
        leaseTtlSeconds: 30,
      }),
    ).toBeNull()
    if (claimed.ok) await closeSession(claimed.session.id, worker.workerId)
  })

  it.each([['UNKNOWN', 'UNVERIFIED'], ['EXPIRED', 'UNVERIFIED'], ['AUTHENTICATED', 'MISMATCH']] as const)('SM18A 等待与截止不改写认证观测 %s/%s，迟到恢复被拒绝', async (authState, identityState) => {
    const accountId = await makeAccount(`sm18-${authState}`)
    const worker = await seedWorker(handle, `sm18-${newId().slice(-12)}`)
    const created = await queueRun(accountId)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const claimed = await claimExecutionForRun(handle, {
      targetId,
      targetAccountId: accountId,
      grant,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
    })
    await setSessionStatus(handle.db, {
      sessionId: claimed.session.id,
      expectedVersion: claimed.session.version,
      status: 'OPEN',
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
    })
    const { browserSessions } = schemaFor(handle.db)
    await handle.db.update(browserSessions).set({ authState, identityState }).where(eq(browserSessions.id, claimed.session.id))
    const waitGrant = await enterRunWaitingForAuth(handle.db, {
      grant,
      sessionId: claimed.session.id,
      workerId: worker.workerId,
      workerInstanceId: worker.instanceId,
      holdSeconds: 1,
    })
    expect(waitGrant?.purpose).toBe('AUTH_WAIT')
    expect(await getSessionById(handle.db, claimed.session.id)).toMatchObject({ authState, identityState })
    const { sessionLeases } = schemaFor(handle.db)
    await handle.db
      .update(sessionLeases)
      .set({ waitDeadlineAt: afterSeconds(handle.db, -5) })
      .where(eq(sessionLeases.id, waitGrant!.leaseId))
    expect(await reapSessionLeases(handle.db, { limit: 20 })).toBeGreaterThanOrEqual(1)
    expect((await getRun(handle.db, created.detail.id)).status).toBe('FAILED')
    await expect(
      resumeRunAfterAuth(handle.db, {
        runId: created.detail.id,
        actor: { id: actorId },
        sessionId: claimed.session.id,
        workerId: worker.workerId,
        workerInstanceId: worker.instanceId,
        controlEpoch: 0,
      }),
    ).rejects.toBeInstanceOf(DomainError)
    expect((await getSessionById(handle.db, claimed.session.id))?.status).toBe('OPEN')
    expect(await getSessionById(handle.db, claimed.session.id)).toMatchObject({ authState, identityState })
    expect(await findAuthWaitLeaseForRun(handle.db, created.detail.id)).toBeNull()
    await closeSession(claimed.session.id, worker.workerId)
  })

  it('SM33 AUTH_WAIT 持有者失联：租约回收、Run 恢复计次、会话 LOST', async () => {
    const accountId = await makeAccount('sm33')
    const worker = await seedWorker(handle, `sm33-${newId().slice(0, 8)}`)
    const created = await queueRun(accountId)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const claimed = await claimExecutionForRun(handle, {
      targetId,
      targetAccountId: accountId,
      grant,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
    })
    await setSessionStatus(handle.db, {
      sessionId: claimed.session.id,
      expectedVersion: claimed.session.version,
      status: 'OPEN',
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
    })
    const waitGrant = await enterRunWaitingForAuth(handle.db, {
      grant,
      sessionId: claimed.session.id,
      workerId: worker.workerId,
      workerInstanceId: worker.instanceId,
      holdSeconds: 600,
    })
    const { sessionLeases } = schemaFor(handle.db)
    await handle.db
      .update(sessionLeases)
      .set({ expiresAt: afterSeconds(handle.db, -5) })
      .where(eq(sessionLeases.id, waitGrant!.leaseId))
    expect(await reapSessionLeases(handle.db, { maxRecoveries: 3 })).toBeGreaterThanOrEqual(1)
    expect((await getRun(handle.db, created.detail.id)).status).toBe('RECOVERING')
    expect(await countFailedRecoveries(handle.db, created.detail.id)).toBe(1)
    expect(await findAuthWaitLeaseForRun(handle.db, created.detail.id)).toBeNull()
    expect((await getSessionById(handle.db, claimed.session.id))?.authHoldRunId).toBeNull()
    expect((await getSessionById(handle.db, claimed.session.id))?.status).toBe('LOST')
    expect((await findLiveSession(handle.db, { targetId, targetAccountId: accountId }))?.status).toBe('LOST')
    await reapSessionLeases(handle.db, { maxRecoveries: 3 })
    expect(await countFailedRecoveries(handle.db, created.detail.id)).toBe(1)
    // After operator-confirmed isolation, another lost holder must hit the budget.
    await closeSession(claimed.session.id, worker.workerId)
    const nextGrant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const next = await claimExecutionForRun(handle, { targetId, targetAccountId: accountId, grant: nextGrant, ...worker })
    await setSessionStatus(handle.db, { sessionId: next.session.id, expectedVersion: next.session.version, status: 'OPEN', ownerWorkerId: worker.workerId, ownerWorkerInstanceId: worker.instanceId })
    const nextWait = await enterRunWaitingForAuth(handle.db, { grant: nextGrant, sessionId: next.session.id, workerId: worker.workerId, workerInstanceId: worker.instanceId, holdSeconds: 600 })
    await handle.db.update(sessionLeases).set({ expiresAt: afterSeconds(handle.db, -5) }).where(eq(sessionLeases.id, nextWait!.leaseId))
    await reapSessionLeases(handle.db, { maxRecoveries: 2 })
    expect(await countFailedRecoveries(handle.db, created.detail.id)).toBe(2)
    expect((await getRun(handle.db, created.detail.id)).status).toBe('NEEDS_REVIEW')
  })

  it('SM32 原节点 READY 时其他 Worker 不能领取；DRAINING 后可以接手', async () => {
    const accountId = await makeAccount('sm32')
    const origin = await seedWorker(handle, `sm32o-${newId().slice(0, 8)}`)
    const other = await seedWorker(handle, `sm32x-${newId().slice(0, 8)}`)
    await upsertSessionProfile(handle.db, {
      key: { targetId, targetAccountId: accountId },
      workerId: origin.workerId,
      revision: 1,
      state: 'PRESENT',
    })
    const created = await queueRun(accountId)
    expect(
      await claimRun(handle, {
        workerId: other.workerId,
        instanceId: other.instanceId,
        leaseTtlSeconds: 30,
      }),
    ).toBeNull()
    const originGrant = await claimRun(handle, {
      workerId: origin.workerId,
      instanceId: origin.instanceId,
      leaseTtlSeconds: 30,
    })
    expect(originGrant?.runId).toBe(created.detail.id)
    await markWorkerDraining(handle.db, origin.workerId, origin.instanceId)
    const next = await queueRun(accountId)
    const taken = await claimRun(handle, {
      workerId: other.workerId,
      instanceId: other.instanceId,
      leaseTtlSeconds: 30,
    })
    expect(taken?.runId).toBe(next.detail.id)
    const handed = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: accountId },
      owner: { kind: 'RUN', runId: taken!.runId, runFencingToken: taken!.fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: other.workerId,
      holderInstanceId: other.instanceId,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    expect(handed.ok).toBe(true)
    if (handed.ok) {
      expect(handed.profileFallback).toBe(true)
      const profile = await getSessionProfile(handle.db, { targetId, targetAccountId: accountId })
      expect(profile?.locationWorkerId).toBe(other.workerId)
      expect(profile?.revision).toBe(2)
      await closeSession(handed.session.id, other.workerId)
    }
  })

  it('SM44A 修改亲和等待立即生效；已排队操作期限冻结', async () => {
    const accountId = await makeAccount('sm44')
    const current = await getOrCreatePlatformConfig(handle.db)
    const queued = await requestSessionOperation(handle.db, {
      key: { targetId, targetAccountId: accountId },
      kind: 'VALIDATE_AUTH_PROFILE',
      origin: 'USER',
      idempotencyKey: `op-${newId().slice(0, 12)}`,
    })
    const frozenDeadline = queued.operation.queueDeadlineAt
    await updatePlatformConfig(handle.db, {
      expectedRevision: current.revision,
      actor: { id: actorId },
      reason: '缩短亲和等待',
      document: {
        ...current.document,
        sessionScheduling: {
          profileAffinityWaitSeconds: 1,
          operationQueueTimeoutSeconds: 30,
        },
      },
    })
    const after = await getOrCreatePlatformConfig(handle.db)
    expect(after.document.sessionScheduling.profileAffinityWaitSeconds).toBe(1)
    expect(after.revision).toBeGreaterThan(current.revision)
    const again = await requestSessionOperation(handle.db, {
      key: { targetId, targetAccountId: accountId },
      kind: 'VALIDATE_AUTH_PROFILE',
      origin: 'USER',
      idempotencyKey: queued.operation.idempotencyKey,
    })
    expect(again.created).toBe(false)
    expect(again.operation.queueDeadlineAt.getTime()).toBe(frozenDeadline.getTime())
  })

  it('SM44A 配置读取失败时拒绝领取', async () => {
    const accountId = await makeAccount('sm44bad')
    const worker = await seedWorker(handle, `sm44b-${newId().slice(0, 8)}`)
    await queueRun(accountId)
    const current = await getOrCreatePlatformConfig(handle.db)
    const { platformConfig } = schemaFor(handle.db)
    try {
      await handle.db
        .update(platformConfig)
        .set({
          document: {
            ...current.document,
            sessionScheduling: { profileAffinityWaitSeconds: -1, operationQueueTimeoutSeconds: 1 },
          },
        })
        .where(eq(platformConfig.id, PLATFORM_CONFIG_SINGLETON_ID))
      expect(
        await claimRun(handle, {
          workerId: worker.workerId,
          instanceId: worker.instanceId,
          leaseTtlSeconds: 30,
        }),
      ).toBeNull()
    } finally {
      await handle.db
        .update(platformConfig)
        .set({ document: current.document })
        .where(eq(platformConfig.id, PLATFORM_CONFIG_SINGLETON_ID))
    }
  })

  it('作废 Profile 递增修订并登记待清理', async () => {
    const accountId = await makeAccount('inv')
    const worker = await seedWorker(handle, `inv-${newId().slice(0, 8)}`)
    const key = { targetId, targetAccountId: accountId }
    await upsertSessionProfile(handle.db, { key, workerId: worker.workerId, revision: 3, state: 'PRESENT' })
    const next = await invalidateSessionProfile(handle.db, key)
    expect(next).not.toBeNull()
    expect(next!.revision).toBe(4)
    expect(next!.state).toBe('ABSENT')
    expect(next!.pendingCleanups.some((item) => item.workerId === worker.workerId && item.revision === 3)).toBe(true)
  })
})
