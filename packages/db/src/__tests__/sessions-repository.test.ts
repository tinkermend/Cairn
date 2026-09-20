import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor, databaseNow, afterSeconds } from '../native.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '@cairn/shared'
import {
  claimSessionUse,
  closeWorkerSessions,
  createRunWithSnapshot,
  createScenarioWithVersion,
  requireCreatedSession,
  disposeStuckSession,
  eq,
  findLiveSession,
  finishAttempt,
  findAuthWaitLeaseForRun,
  forceLastUsedAt,
  forceLeaseExpiresAt,
  forceSessionGeneration,
  getLeaseById,
  getRun,
  getSessionById,
  listReapableSessions,
  listSessions,
  markSessionsClosing,
  registerWorker,
  requestRunCancel,
  openIsolatedDb,
  reapSessionLeases,
  releaseSessionUse,
  renewSessionUse,
  revokeWorkerLeases,
  setSessionProbe,
  setSessionStatus,
  sql,
  startAttempt,
  verifySessionLeaseForCommit,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { newId } from '../id.js'
import { enterAuthWaitForRun, forceGrantForRun } from './lease-harness.js'
import { consoleAccounts as pg_consoleAccounts } from '../schema/console.js'
let consoleAccounts = pg_consoleAccounts
import { runs as pg_runs } from '../schema/execution.js'
let runs = pg_runs
import { targetAccounts as pg_targetAccounts, targets as pg_targets } from '../schema/targets.js'
let targetAccounts = pg_targetAccounts
let targets = pg_targets

const SCHEMA = `cairn_test_${Date.now().toString(36)}_sess`

const echoStep: Step = {
  id: '00000000-0000-4000-8000-000000000091',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s BrowserSession / SessionLease Repository（集成）', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let accountId: string
  let accountId2: string
  let runId: string
  let runId2: string
  const workerA = 'worker-a'
  const workerB = 'worker-b'
  const workerAInstance = newId()

  beforeAll(async () => {
    handle = await openContractDb(driver, SCHEMA)
    ;({ consoleAccounts, runs, targetAccounts, targets } = schemaFor(handle.db))
    actorId = newId()
    targetId = newId()
    accountId = newId()
    accountId2 = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'sess-tester',
      email: `sess-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `sess-${SCHEMA.slice(-6)}`,
      name: '会话夹具',
      entryUrl: 'https://example.com',
    })
    await handle.db.insert(targetAccounts).values([
      {
        id: accountId,
        targetId,
        displayName: '账号甲',
        username: 'alice',
        status: 'active',
      },
      {
        id: accountId2,
        targetId,
        displayName: '账号乙',
        username: 'bob',
        status: 'active',
      },
    ])
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '会话账本',
      steps: [echoStep],
      actor: { id: actorId },
    })
    const run1 = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    runId = run1.detail.id
    const run2 = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    runId2 = run2.detail.id
    await registerWorker(handle.db, {
      workerId: workerA,
      instanceId: workerAInstance,
      capacity: 32,
      maxSessions: 32,
      lostAfterSeconds: 60,
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function openSession(opts?: {
    account?: string
    worker?: string
    idle?: number
    maxLife?: number
  }) {
    const key = { targetId, targetAccountId: opts?.account ?? accountId }
    const session = await requireCreatedSession(handle.db, {
      key,
      ownerWorkerId: opts?.worker ?? workerA,
      ownerWorkerInstanceId: workerAInstance,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: opts?.idle ?? 600,
      maxLifetimeSeconds: opts?.maxLife ?? 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
    })
    await setSessionProbe(handle.db, {
      sessionId: session.id,
      ownerWorkerId: opts?.worker ?? workerA,
      health: 'HEALTHY',
      authState: 'AUTHENTICATED',
    })
    return (await getSessionById(handle.db, session.id))!
  }

  async function claimExecution(opts?: { runId?: string; account?: string; fencingToken?: number }) {
    const claimed = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: opts?.account ?? accountId },
      owner: {
        kind: 'RUN',
        runId: opts?.runId ?? runId,
        runFencingToken: opts?.fencingToken ?? 1,
      },
      purpose: 'EXECUTION',
      holderWorkerId: workerA,
      holderInstanceId: workerAInstance,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    if (!claimed.ok) throw new Error(claimed.message ?? claimed.code)
    return claimed
  }

  it('同键并发创建只有一个成功；CLOSED 后可再建；LOST 阻塞新建', async () => {
    const key = { targetId, targetAccountId: accountId }
    const first = await requireCreatedSession(handle.db, {
      key,
      ownerWorkerId: workerA,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await expect(
      requireCreatedSession(handle.db, {
        key,
        ownerWorkerId: workerB,
        reusePolicy: 'NEW_PAGE',
        idleTtlSeconds: 600,
        maxLifetimeSeconds: 3600,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' })

    await setSessionStatus(handle.db, {
      sessionId: first.id,
      expectedVersion: first.version,
      status: 'LOST',
      closeReason: 'owner_lost',
    })
    await expect(
      requireCreatedSession(handle.db, {
        key,
        ownerWorkerId: workerA,
        reusePolicy: 'NEW_PAGE',
        idleTtlSeconds: 600,
        maxLifetimeSeconds: 3600,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' })

    const lost = (await getSessionById(handle.db, first.id))!
    await setSessionStatus(handle.db, {
      sessionId: lost.id,
      expectedVersion: lost.version,
      status: 'CLOSED',
      closeReason: 'manual',
    })
    const live = await findLiveSession(handle.db, key)
    expect(live).toBeNull()

    const second = await requireCreatedSession(handle.db, {
      key,
      ownerWorkerId: workerA,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    expect(second.generation).toBe(first.generation + 1)
    await setSessionStatus(handle.db, {
      sessionId: second.id,
      expectedVersion: second.version,
      status: 'CLOSED',
      closeReason: 'cleanup',
    })
  })

  it('同会话并发 claimSessionUse 只有一个 ACTIVE；同 Run 幂等返回同一租约', async () => {
    const session = await openSession()
    const [a, b] = await Promise.all([
      claimSessionUse(handle.db, {
        key: { targetId, targetAccountId: accountId },
        owner: { kind: 'RUN', runId, runFencingToken: 1 },
        purpose: 'EXECUTION',
        holderWorkerId: workerA,
        holderInstanceId: workerAInstance,
        leaseTtlSeconds: 30,
        reusePolicy: 'NEW_PAGE',
        idleTtlSeconds: 600,
        maxLifetimeSeconds: 3600,
      }),
      claimSessionUse(handle.db, {
        key: { targetId, targetAccountId: accountId },
        owner: { kind: 'RUN', runId: runId2, runFencingToken: 1 },
        purpose: 'EXECUTION',
        holderWorkerId: workerA,
        holderInstanceId: workerAInstance,
        leaseTtlSeconds: 30,
        reusePolicy: 'NEW_PAGE',
        idleTtlSeconds: 600,
        maxLifetimeSeconds: 3600,
      }),
    ])
    const wins = [a, b].filter((x) => x.ok)
    const loses = [a, b].filter((x) => !x.ok)
    expect(wins).toHaveLength(1)
    expect(loses).toHaveLength(1)
    const lost = loses[0]
    if (!lost || lost.ok) throw new Error('expected busy')
    expect(lost.code).toBe('SESSION_BUSY')

    const winner = wins[0]
    if (!winner || !winner.ok) throw new Error('expected win')
    const again = await claimExecution({ runId: winner.grant.runId ?? runId })
    expect(again.ok).toBe(true)
    if (again.ok) {
      expect(again.created).toBe(false)
      expect(again.grant.leaseId).toBe(winner.grant.leaseId)
      expect(again.grant.sessionFencingToken).toBe(winner.grant.sessionFencingToken)
    }

    await releaseSessionUse(handle.db, {
      leaseId: winner.grant.leaseId,
      holderWorkerId: workerA,
      reason: 'test',
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: (await getSessionById(handle.db, session.id))!.version,
      status: 'CLOSED',
      closeReason: 'cleanup',
      ownerWorkerId: workerA,
    })
  })

  it('双锁顺序：并发 claimSessionUse 在超时内结束，失败者没有残留 ACTIVE 租约', async () => {
    const session = await openSession()
    const started = Date.now()
    const [a, b] = await Promise.all([
      claimSessionUse(handle.db, {
        key: { targetId, targetAccountId: accountId },
        owner: { kind: 'RUN', runId, runFencingToken: 1 },
        purpose: 'EXECUTION',
        holderWorkerId: workerA,
        holderInstanceId: workerAInstance,
        leaseTtlSeconds: 30,
        reusePolicy: 'NEW_PAGE',
        idleTtlSeconds: 600,
        maxLifetimeSeconds: 3600,
      }),
      claimSessionUse(handle.db, {
        key: { targetId, targetAccountId: accountId },
        owner: { kind: 'RUN', runId: runId2, runFencingToken: 1 },
        purpose: 'EXECUTION',
        holderWorkerId: workerA,
        holderInstanceId: workerAInstance,
        leaseTtlSeconds: 30,
        reusePolicy: 'NEW_PAGE',
        idleTtlSeconds: 600,
        maxLifetimeSeconds: 3600,
      }),
    ])
    expect(Date.now() - started).toBeLessThan(8_000)
    const wins = [a, b].filter((item) => item.ok)
    const loses = [a, b].filter((item) => !item.ok)
    expect(wins).toHaveLength(1)
    expect(loses).toHaveLength(1)
    const lost = loses[0]
    if (!lost || lost.ok) throw new Error('expected busy')
    expect(lost.code).toBe('SESSION_BUSY')
    const loserRunId = a.ok ? runId2 : runId
    const leftover = await handle.db
      .select()
      .from(schemaFor(handle.db).sessionLeases)
      .where(eq(schemaFor(handle.db).sessionLeases.runId, loserRunId))
    expect(leftover.filter((row) => row.status === 'ACTIVE')).toHaveLength(0)
    if (wins[0]?.ok) {
      await releaseSessionUse(handle.db, {
        leaseId: wins[0].grant.leaseId,
        holderWorkerId: workerA,
        reason: 'test',
      })
    }
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: (await getSessionById(handle.db, session.id))!.version,
      status: 'CLOSED',
      closeReason: 'cleanup',
      ownerWorkerId: workerA,
    })
  })

  it('续租成功延长；过期 / 错 holder / 换代返回空', async () => {
    const session = await openSession()
    const got = await claimExecution()
    const leaseRow = (await getLeaseById(handle.db, got.grant.leaseId))!
    const before = leaseRow.expiresAt
    const renewed = await renewSessionUse(handle.db, {
      leaseId: got.grant.leaseId,
      holderWorkerId: workerA,
      leaseTtlSeconds: 60,
    })
    expect(renewed).not.toBeNull()
    expect(renewed!.expiresAt.getTime()).toBeGreaterThanOrEqual(before.getTime())

    expect(
      await renewSessionUse(handle.db, {
        leaseId: got.grant.leaseId,
        holderWorkerId: workerB,
        leaseTtlSeconds: 60,
      }),
    ).toBeNull()

    await forceSessionGeneration(handle.db, session.id, session.generation + 10)
    expect(
      await renewSessionUse(handle.db, {
        leaseId: got.grant.leaseId,
        holderWorkerId: workerA,
        leaseTtlSeconds: 60,
      }),
    ).toBeNull()
    await forceSessionGeneration(handle.db, session.id, got.grant.generation)

    await forceLeaseExpiresAt(handle.db, got.grant.leaseId, new Date(Date.now() - 1000))
    expect(
      await renewSessionUse(handle.db, {
        leaseId: got.grant.leaseId,
        holderWorkerId: workerA,
        leaseTtlSeconds: 60,
      }),
    ).toBeNull()

    await releaseSessionUse(handle.db, {
      leaseId: got.grant.leaseId,
      holderWorkerId: workerA,
      reason: 'done',
    })
    await reapSessionLeases(handle.db)
    const closed = await releaseSessionUse(handle.db, {
      leaseId: got.grant.leaseId,
      holderWorkerId: workerA,
      reason: 'again',
    })
    expect(closed === 'already' || closed === 'released').toBe(true)

    expect(
      await releaseSessionUse(handle.db, {
        leaseId: newId(),
        holderWorkerId: workerA,
        reason: 'ghost',
      }),
    ).toBe('unknown')

    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: (await getSessionById(handle.db, session.id))!.version,
      status: 'CLOSED',
      closeReason: 'cleanup',
      ownerWorkerId: workerA,
    })
  })

  it('WAITING_FOR_AUTH 与认证超时失败', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `auth-wait-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    const grant = await forceGrantForRun(handle, created.detail.id, workerA)
    const { claimed, waitGrant } = await enterAuthWaitForRun(handle, {
      targetId,
      targetAccountId: accountId,
      grant,
      workerId: workerA,
      instanceId: workerAInstance,
      holdSeconds: 1,
    })
    expect(waitGrant.purpose).toBe('AUTH_WAIT')
    expect((await getRun(handle.db, created.detail.id)).status).toBe('WAITING_FOR_AUTH')
    expect((await findAuthWaitLeaseForRun(handle.db, created.detail.id))?.id).toBe(waitGrant.leaseId)
    await handle.db
      .update(schemaFor(handle.db).sessionLeases)
      .set({ waitDeadlineAt: afterSeconds(handle.db, -1) })
      .where(eq(schemaFor(handle.db).sessionLeases.id, waitGrant.leaseId))
    expect((await reapSessionLeases(handle.db, { limit: 20 })).settled).toBeGreaterThanOrEqual(1)
    const afterHold = (await getSessionById(handle.db, claimed.session.id))!
    expect(afterHold.authState).toBe('UNKNOWN')
    expect(afterHold.status).toBe('OPEN')
    expect(await findAuthWaitLeaseForRun(handle.db, created.detail.id)).toBeNull()
    const failed = await getRun(handle.db, created.detail.id)
    expect(failed.status).toBe('FAILED')

    await setSessionStatus(handle.db, {
      sessionId: claimed.session.id,
      expectedVersion: (await getSessionById(handle.db, claimed.session.id))!.version,
      status: 'CLOSED',
      closeReason: 'cleanup',
      ownerWorkerId: workerA,
    })
  })

  it('过期扫描幂等；RELEASED 不被改成 EXPIRED', async () => {
    const session = await openSession()
    const got = await claimExecution()
    await forceLeaseExpiresAt(handle.db, got.grant.leaseId, new Date(Date.now() - 5000))
    const n1 = await reapSessionLeases(handle.db)
    expect(n1.settled).toBeGreaterThanOrEqual(1)
    const n2 = await reapSessionLeases(handle.db)
    expect(n2.settled).toBe(0)
    const lease = await getLeaseById(handle.db, got.grant.leaseId)
    expect(lease?.status).toBe('EXPIRED')

    const got2 = await claimExecution({ runId: runId2 })
    await releaseSessionUse(handle.db, {
      leaseId: got2.grant.leaseId,
      holderWorkerId: workerA,
      reason: 'done',
    })
    await forceLeaseExpiresAt(handle.db, got2.grant.leaseId, new Date(Date.now() - 5000)).catch(() => {})
    const n3 = await reapSessionLeases(handle.db)
    expect(n3.settled).toBe(0)
    expect((await getLeaseById(handle.db, got2.grant.leaseId))?.status).toBe('RELEASED')

    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: (await getSessionById(handle.db, session.id))!.version,
      status: 'CLOSED',
      closeReason: 'cleanup',
      ownerWorkerId: workerA,
    })
  })

  it('提交边界：租约有效则 true，过期后 false', async () => {
    const session = await openSession()
    const got = await claimExecution()
    expect(await verifySessionLeaseForCommit(handle.db, { ...got.grant, holderWorkerId: workerA })).toBe(true)
    await forceLeaseExpiresAt(handle.db, got.grant.leaseId, new Date(Date.now() - 1000))
    expect(await verifySessionLeaseForCommit(handle.db, { ...got.grant, holderWorkerId: workerA })).toBe(false)

    await reapSessionLeases(handle.db)
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: (await getSessionById(handle.db, session.id))!.version,
      status: 'CLOSED',
      closeReason: 'cleanup',
      ownerWorkerId: workerA,
    })
  })

  it('探针不延寿；有租约或认证占用时不回收；空闲 TTL 可回收', async () => {
    const session = await openSession({ idle: 60 })
    const before = session.lastUsedAt
    await setSessionProbe(handle.db, {
      sessionId: session.id,
      ownerWorkerId: workerA,
      health: 'HEALTHY',
    })
    const afterProbe = (await getSessionById(handle.db, session.id))!
    expect(afterProbe.lastUsedAt.getTime()).toBe(before.getTime())

    await forceLastUsedAt(handle.db, session.id, new Date(Date.now() - 120_000))
    const got = await claimExecution()
    await forceLastUsedAt(handle.db, session.id, new Date(Date.now() - 120_000))
    expect(await listReapableSessions(handle.db, workerA)).toHaveLength(0)

    await releaseSessionUse(handle.db, {
      leaseId: got.grant.leaseId,
      holderWorkerId: workerA,
      reason: 'done',
    })
    const wait = await enterAuthWaitForRun(handle, {
      targetId,
      targetAccountId: accountId,
      grant: await forceGrantForRun(handle, runId2, workerA),
      workerId: workerA,
      instanceId: workerAInstance,
      holdSeconds: 300,
    })
    await forceLastUsedAt(handle.db, wait.claimed.session.id, new Date(Date.now() - 120_000))
    expect(await listReapableSessions(handle.db, workerA)).toHaveLength(0)

    await releaseSessionUse(handle.db, {
      leaseId: wait.waitGrant.leaseId,
      holderWorkerId: workerA,
      reason: 'test_reap',
    })
    await forceLastUsedAt(handle.db, wait.claimed.session.id, new Date(Date.now() - 120_000))
    const heldId = wait.claimed.session.id
    const reapable = await listReapableSessions(handle.db, workerA)
    expect(reapable.map((s) => s.id)).toContain(heldId)

    const closing = await markSessionsClosing(handle.db, {
      workerId: workerA,
      sessionIds: [heldId],
      reason: 'idle_ttl',
    })
    expect(closing).toEqual([heldId])
    const mid = (await getSessionById(handle.db, heldId))!
    expect(mid.status).toBe('CLOSING')
    await setSessionStatus(handle.db, {
      sessionId: heldId,
      expectedVersion: mid.version,
      status: 'CLOSED',
      closeReason: 'idle_ttl',
      ownerWorkerId: workerA,
    })
  })

  it('重启自愈：名下租约 REVOKED、会话 CLOSED，键可再建', async () => {
    const session = await openSession({ worker: workerA })
    const got = await claimExecution()
    const revoked = await revokeWorkerLeases(handle.db, workerA)
    expect(revoked).toBeGreaterThanOrEqual(1)
    const closed = await closeWorkerSessions(handle.db, workerA)
    expect(closed).toBeGreaterThanOrEqual(1)
    expect((await getLeaseById(handle.db, got.grant.leaseId))?.status).toBe('REVOKED')
    expect((await getSessionById(handle.db, session.id))?.status).toBe('CLOSED')

    const again = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: workerA,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    expect(again.status).toBe('CREATING')
    await setSessionStatus(handle.db, {
      sessionId: again.id,
      expectedVersion: again.version,
      status: 'CLOSED',
      closeReason: 'cleanup',
    })
  })

  it('另一账号独立键可并存', async () => {
    const a = await openSession({ account: accountId })
    const b = await openSession({ account: accountId2 })
    expect(a.id).not.toBe(b.id)
    expect(a.profileKey).not.toBe(b.profileKey)
    for (const s of [a, b]) {
      await setSessionStatus(handle.db, {
        sessionId: s.id,
        expectedVersion: (await getSessionById(handle.db, s.id))!.version,
        status: 'CLOSED',
        closeReason: 'cleanup',
        ownerWorkerId: workerA,
      })
    }
  })

  it('createRun 快照写入解析后的 sessionPolicy', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `策略-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      sessionPolicy: { reuse: 'REUSE_PAGE' },
      actor: { id: actorId },
    })
    expect(created.detail.snapshot.sessionPolicy?.reuse).toBe('REUSE_PAGE')
    expect(created.detail.snapshot.sessionPolicy?.idleTtlSeconds).toBe(600)
  })

  it('提交边界：丢租后 SIDE_EFFECT→NEEDS_REVIEW，READ_ONLY→FAILED，无 SUCCEEDED', async () => {
    async function runWithEffect(effectType: 'READ_ONLY' | 'SIDE_EFFECT', cancel = false) {
      const step: Step = {
        id: newId(),
        name: `效-${effectType}`,
        type: 'echo',
        effectType,
        input: { value: 'x' },
      }
      const scenario = await createScenarioWithVersion(handle.db, {
        targetId,
        name: `边界-${effectType}-${newId()}`,
        steps: [step],
        actor: { id: actorId },
      })
      const created = await createRunWithSnapshot(handle.db, {
        scenarioId: scenario.id,
        targetAccountId: accountId,
        actor: { id: actorId },
      })
      const grant = await forceGrantForRun(handle, created.detail.id, workerA)
      const detail = await getRun(handle.db, created.detail.id)
      expect(detail.status).toBe('RUNNING')
      const stepRunId = detail.stepRuns[0]!.id
      const started = await startAttempt(handle.db, {
        runId: created.detail.id,
        stepRunId,
        inputPayload: 'x',
        grant: grant!,
      })
      expect(started).not.toBeNull()

      const session = await openSession()
      const lease = await claimExecution({
        runId: created.detail.id,
        fencingToken: grant!.fencingToken,
      })
      await forceLeaseExpiresAt(handle.db, lease.grant.leaseId, new Date(Date.now() - 1000))
      if (cancel) await requestRunCancel(handle.db, created.detail.id, { id: actorId })

      await finishAttempt(handle.db, {
        runId: created.detail.id,
        attemptId: started!.attemptId,
        attemptStatus: 'SUCCEEDED',
        output: { ok: true },
        stepRunStatus: 'SUCCEEDED',
        runStatus: 'SUCCEEDED',
        grant: grant!,
        sessionLease: {
          ...lease.grant,
          holderWorkerId: workerA,
          effectType,
        },
      })

      const after = await getRun(handle.db, created.detail.id)
      expect(after.stepRuns[0]?.attempts[0]?.status).toBe(cancel && effectType === 'READ_ONLY' ? 'CANCELLED' : 'FAILED')
      expect(after.stepRuns[0]?.attempts[0]?.status).not.toBe('SUCCEEDED')
      await setSessionStatus(handle.db, {
        sessionId: session.id,
        expectedVersion: (await getSessionById(handle.db, session.id))!.version,
        status: 'CLOSED',
        closeReason: 'cleanup',
        ownerWorkerId: workerA,
      })
      return after.status
    }

    expect(await runWithEffect('SIDE_EFFECT')).toBe('NEEDS_REVIEW')
    expect(await runWithEffect('READ_ONLY')).toBe('FAILED')
    expect(await runWithEffect('SIDE_EFFECT', true)).toBe('NEEDS_REVIEW')
    expect(await runWithEffect('READ_ONLY', true)).toBe('CANCELLED')
  })

  it('处置：LOST 释放键、撤租约、写审计；OPEN 被拒；重复处置幂等', async () => {
    const key = { targetId, targetAccountId: accountId }
    const session = await requireCreatedSession(handle.db, {
      key,
      ownerWorkerId: workerA,
      ownerWorkerInstanceId: workerAInstance,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
    })
    const opened = (await getSessionById(handle.db, session.id))!

    // 活会话：处置必须被拒，否则等于放行同账号双开
    await expect(
      disposeStuckSession(handle.db, { sessionId: opened.id, actor: { id: actorId } }),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_DISPOSABLE' })
    expect((await getSessionById(handle.db, opened.id))?.status).toBe('OPEN')

    // 真实卡死形态：租约已领取，owner 随后失联 → LOST 且租约仍 ACTIVE
    const lease = await claimExecution()
    await setSessionStatus(handle.db, {
      sessionId: opened.id,
      expectedVersion: opened.version,
      status: 'LOST',
      closeReason: 'owner_lost',
    })
    const lost = (await getSessionById(handle.db, opened.id))!
    expect(lost.status).toBe('LOST')
    await expect(
      requireCreatedSession(handle.db, {
        key,
        ownerWorkerId: workerA,
        reusePolicy: 'NEW_PAGE',
        idleTtlSeconds: 600,
        maxLifetimeSeconds: 3600,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' })

    // 人工确认旧浏览器已停 → 处置放行
    const dto = await disposeStuckSession(handle.db, {
      sessionId: lost.id,
      actor: { id: actorId },
      note: '已确认旧进程退出',
    })
    expect(dto.status).toBe('CLOSED')
    expect(dto.closeReason).toBe('operator_disposed')
    expect(dto.disposable).toBe(false)
    expect(dto.authHold).toBeNull()
    expect((await getLeaseById(handle.db, lease.grant.leaseId))?.status).toBe('REVOKED')
    expect(await findLiveSession(handle.db, key)).toBeNull()

    // 键已释放：同键可再建，且世代前进
    const rebuilt = await requireCreatedSession(handle.db, {
      key,
      ownerWorkerId: workerA,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    expect(rebuilt.generation).toBe(session.generation + 1)
    await setSessionStatus(handle.db, {
      sessionId: rebuilt.id,
      expectedVersion: rebuilt.version,
      status: 'CLOSED',
      closeReason: 'cleanup',
    })

    // 幂等：重复处置不报错，也不改写关闭原因
    const again = await disposeStuckSession(handle.db, { sessionId: lost.id, actor: { id: actorId } })
    expect(again.status).toBe('CLOSED')
    expect(again.closeReason).toBe('operator_disposed')

    // 审计与事实同事务落地
    const rows = await handle.db.select().from(schemaFor(handle.db).consoleAuditEvents).where(eq(schemaFor(handle.db).consoleAuditEvents.resourceId, lost.id))
    expect(rows).toHaveLength(1)
    expect(String((rows[0] as { summary: string }).summary)).toContain('已确认旧进程退出')

    await expect(
      disposeStuckSession(handle.db, { sessionId: newId(), actor: { id: actorId } }),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  it('会话列表只给活会话，并带当前 ACTIVE 租约与可处置标记', async () => {
    const key = { targetId, targetAccountId: accountId2 }
    const session = await requireCreatedSession(handle.db, {
      key,
      ownerWorkerId: workerA,
      ownerWorkerInstanceId: workerAInstance,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
    })
    const opened = (await getSessionById(handle.db, session.id))!
    const lease = await claimExecution({ account: accountId2 })

    const listed = await listSessions(handle.db)
    const row = listed.find((item) => item.id === opened.id)!
    expect(row.status).toBe('OPEN')
    expect(row.disposable).toBe(false)
    expect(row.ownerWorkerId).toBe(workerA)
    expect(row.profileKey).toBe(`${targetId}/${accountId2}`)
    expect(row.activeLease?.id).toBe(lease.grant.leaseId)
    expect(row.activeLease?.runId).toBe(runId)

    await disposeStuckSession(handle.db, { sessionId: opened.id, actor: { id: actorId } }).catch(
      () => undefined,
    )
    // OPEN 不允许直接处置，所以行仍在列表里
    expect((await listSessions(handle.db)).some((item) => item.id === opened.id)).toBe(true)

    // 落到 LOST 后即可处置，处置后从列表消失（CLOSED 不占键）
    await setSessionStatus(handle.db, {
      sessionId: opened.id,
      expectedVersion: (await getSessionById(handle.db, opened.id))!.version,
      status: 'LOST',
      closeReason: 'owner_lost',
    })
    expect((await listSessions(handle.db)).find((i) => i.id === opened.id)?.disposable).toBe(true)
    await disposeStuckSession(handle.db, { sessionId: opened.id, actor: { id: actorId } })
    expect((await listSessions(handle.db)).some((item) => item.id === opened.id)).toBe(false)
  })

  it('处置带完整认证占用绑定的 LOST 会话，不留下半截 hold', async () => {
    const account = newId()
    await handle.db.insert(targetAccounts).values({
      id: account,
      targetId,
      displayName: '占用处置',
      username: `hold-dispose-${account.slice(0, 8)}`,
      status: 'active',
    })
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `hold-dispose-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: account,
      actor: { id: actorId },
    })
    const grant = await forceGrantForRun(handle, created.detail.id, workerA)
    const { claimed, waitGrant } = await enterAuthWaitForRun(handle, {
      targetId,
      targetAccountId: account,
      grant,
      workerId: workerA,
      instanceId: workerAInstance,
      holdSeconds: 60,
    })
    expect(waitGrant.purpose).toBe('AUTH_WAIT')
    expect((await findAuthWaitLeaseForRun(handle.db, created.detail.id))?.id).toBe(waitGrant.leaseId)
    const held = (await getSessionById(handle.db, claimed.session.id))!

    await setSessionStatus(handle.db, {
      sessionId: held.id,
      expectedVersion: held.version,
      status: 'LOST',
      closeReason: 'owner_lost',
    })
    const dto = await disposeStuckSession(handle.db, {
      sessionId: held.id,
      actor: { id: actorId },
      note: '失联后处置等待认证会话',
    })
    expect(dto.status).toBe('CLOSED')
    expect(dto.authHold).toBeNull()
    expect(dto.activeLease).toBeNull()
    expect(await findAuthWaitLeaseForRun(handle.db, created.detail.id)).toBeNull()
    expect(await findLiveSession(handle.db, { targetId, targetAccountId: account })).toBeNull()
  })
})
