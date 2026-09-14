import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor, databaseNow, afterSeconds } from '../native.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '@cairn/shared'
import {
  acquireSessionLease,
  claimAuthHold,
  closeWorkerSessions,
  createRunWithSnapshot,
  createScenarioWithVersion,
  requireCreatedSession,
  disposeStuckSession,
  eq,
  expireStaleLeases,
  findLiveSession,
  finishAttempt,
  expireAuthHold,
  failRunAuthTimeout,
  forceLastUsedAt,
  forceLeaseExpiresAt,
  forceSessionGeneration,
  getLeaseById,
  getRun,
  getSessionById,
  listExpiredAuthHolds,
  listReapableSessions,
  listSessions,
  listRunsWaitingForAuthByAccount,
  enterRunWaitingForAuth,
  markSessionsClosing,
  registerWorker,
  requestRunCancel,
  openIsolatedDb,
  releaseAuthHold,
  releaseSessionLease,
  renewSessionLease,
  revokeWorkerLeases,
  setSessionProbe,
  setSessionStatus,
  sql,
  startAttempt,
  verifySessionLeaseForCommit,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { newId } from '../id.js'
import { forceGrantForRun } from './lease-harness.js'
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
      capacity: 8,
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

  it('同会话并发获取只有一个 ACTIVE；幂等返回同一租约', async () => {
    const session = await openSession()
    const [a, b] = await Promise.all([
      acquireSessionLease(handle.db, {
        sessionId: session.id,
        runId,
        holderWorkerId: workerA,
        leaseTtlSeconds: 30,
        runFencingToken: 1,
      }),
      acquireSessionLease(handle.db, {
        sessionId: session.id,
        runId: runId2,
        holderWorkerId: workerB,
        leaseTtlSeconds: 30,
        runFencingToken: 1,
      }),
    ])
    const wins = [a, b].filter((x) => x.ok)
    const loses = [a, b].filter((x) => !x.ok)
    expect(wins).toHaveLength(1)
    expect(loses).toHaveLength(1)
    const lost = loses[0]
    expect(lost).toBeDefined()
    if (lost && !lost.ok) {
      expect(lost.code).toBe('SESSION_BUSY')
      if (lost.code === 'SESSION_BUSY') {
        expect(lost.busy.holderWorkerId).toBeTruthy()
        expect(lost.busy.expiresAt).toBeInstanceOf(Date)
      }
    }

    const winner = wins[0]!
    if (!winner.ok) throw new Error('expected win')
    const again = await acquireSessionLease(handle.db, {
      sessionId: session.id,
      runId: winner.lease.runId,
      holderWorkerId: winner.lease.holderWorkerId,
      leaseTtlSeconds: 30,
      runFencingToken: 1,
    })
    expect(again.ok).toBe(true)
    if (again.ok) {
      expect(again.created).toBe(false)
      expect(again.lease.id).toBe(winner.lease.id)
      expect(again.lease.sessionFencingToken).toBe(winner.lease.sessionFencingToken)
    }

    await releaseSessionLease(handle.db, {
      leaseId: winner.lease.id,
      holderWorkerId: winner.lease.holderWorkerId,
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

  it('双锁顺序：并发 acquire 在超时内结束，失败者没有残留 ACTIVE 租约', async () => {
    const session = await openSession()
    const started = Date.now()
    const [a, b] = await Promise.all([
      acquireSessionLease(handle.db, {
        sessionId: session.id,
        runId,
        holderWorkerId: workerA,
        leaseTtlSeconds: 30,
        runFencingToken: 1,
      }),
      acquireSessionLease(handle.db, {
        sessionId: session.id,
        runId: runId2,
        holderWorkerId: workerB,
        leaseTtlSeconds: 30,
        runFencingToken: 1,
      }),
    ])
    expect(Date.now() - started).toBeLessThan(8_000)
    const wins = [a, b].filter((item) => item.ok)
    const loses = [a, b].filter((item) => !item.ok)
    expect(wins).toHaveLength(1)
    expect(loses).toHaveLength(1)
    if (loses[0] && !loses[0].ok) expect(loses[0].code).toBe('SESSION_BUSY')
    const loserRunId = a.ok ? runId2 : runId
    const leftover = await handle.db.select().from(schemaFor(handle.db).sessionLeases).where(eq(schemaFor(handle.db).sessionLeases.runId, loserRunId))
    expect(leftover.filter(row => row.status === 'ACTIVE')).toHaveLength(0)
    if (wins[0]?.ok) {
      await releaseSessionLease(handle.db, {
        leaseId: wins[0].lease.id,
        holderWorkerId: wins[0].lease.holderWorkerId,
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
    const got = await acquireSessionLease(handle.db, {
      sessionId: session.id,
      runId,
      holderWorkerId: workerA,
      leaseTtlSeconds: 30,
      runFencingToken: 1,
    })
    expect(got.ok).toBe(true)
    if (!got.ok) throw new Error('lease')
    const before = got.lease.expiresAt
    const renewed = await renewSessionLease(handle.db, {
      leaseId: got.lease.id,
      holderWorkerId: workerA,
      leaseTtlSeconds: 60,
    })
    expect(renewed).not.toBeNull()
    expect(renewed!.expiresAt.getTime()).toBeGreaterThanOrEqual(before.getTime())

    expect(
      await renewSessionLease(handle.db, {
        leaseId: got.lease.id,
        holderWorkerId: workerB,
        leaseTtlSeconds: 60,
      }),
    ).toBeNull()

    // 换代：generation 变化后续租 0 行
    await forceSessionGeneration(handle.db, session.id, session.generation + 10)
    expect(
      await renewSessionLease(handle.db, {
        leaseId: got.lease.id,
        holderWorkerId: workerA,
        leaseTtlSeconds: 60,
      }),
    ).toBeNull()
    // 恢复 generation 以便后续过期路径
    await forceSessionGeneration(handle.db, session.id, got.lease.sessionGeneration)

    await forceLeaseExpiresAt(handle.db, got.lease.id, new Date(Date.now() - 1000))
    expect(
      await renewSessionLease(handle.db, {
        leaseId: got.lease.id,
        holderWorkerId: workerA,
        leaseTtlSeconds: 60,
      }),
    ).toBeNull()

    await releaseSessionLease(handle.db, {
      leaseId: got.lease.id,
      holderWorkerId: workerA,
      reason: 'done',
    })
    await expireStaleLeases(handle.db)
    const closed = await releaseSessionLease(handle.db, {
      leaseId: got.lease.id,
      holderWorkerId: workerA,
      reason: 'again',
    })
    expect(closed === 'already' || closed === 'released').toBe(true)

    // 行不存在 → unknown
    expect(
      await releaseSessionLease(handle.db, {
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
    const session = await openSession()
    expect(
      await enterRunWaitingForAuth(handle.db, {
        grant,
        sessionId: session.id,
        workerId: workerA,
        workerInstanceId: workerAInstance,
        holdSeconds: 1,
      }),
    ).toBe(true)
    expect((await getRun(handle.db, created.detail.id)).status).toBe('WAITING_FOR_AUTH')
    expect((await getSessionById(handle.db, session.id))?.authHoldRunId).toBe(created.detail.id)
    // 拨占用到期
    await handle.db.update(schemaFor(handle.db).browserSessions).set({ authHoldExpiresAt: afterSeconds(handle.db, -1) }).where(eq(schemaFor(handle.db).browserSessions.id, session.id))
    const expired = await listExpiredAuthHolds(handle.db, workerA)
    expect(expired.map((s) => s.id)).toContain(session.id)

    await expireAuthHold(handle.db, { sessionId: session.id, workerId: workerA })
    const afterHold = (await getSessionById(handle.db, session.id))!
    expect(afterHold.authHoldWorkerId).toBeNull()
    expect(afterHold.authState).toBe('EXPIRED')
    expect(afterHold.status).toBe('OPEN')

    const waiting = await listRunsWaitingForAuthByAccount(handle.db, accountId)
    expect(waiting).toContain(created.detail.id)
    expect(await failRunAuthTimeout(handle.db, created.detail.id)).toBe(true)
    const failed = await getRun(handle.db, created.detail.id)
    expect(failed.status).toBe('FAILED')

    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: (await getSessionById(handle.db, session.id))!.version,
      status: 'CLOSED',
      closeReason: 'cleanup',
      ownerWorkerId: workerA,
    })
  })

  it('过期扫描幂等；RELEASED 不被改成 EXPIRED', async () => {
    const session = await openSession()
    const got = await acquireSessionLease(handle.db, {
      sessionId: session.id,
      runId,
      holderWorkerId: workerA,
      leaseTtlSeconds: 30,
      runFencingToken: 1,
    })
    if (!got.ok) throw new Error('lease')
    await forceLeaseExpiresAt(handle.db, got.lease.id, new Date(Date.now() - 5000))
    const n1 = await expireStaleLeases(handle.db)
    expect(n1).toBeGreaterThanOrEqual(1)
    const n2 = await expireStaleLeases(handle.db)
    expect(n2).toBe(0)
    const lease = await getLeaseById(handle.db, got.lease.id)
    expect(lease?.status).toBe('EXPIRED')

    const got2 = await acquireSessionLease(handle.db, {
      sessionId: session.id,
      runId: runId2,
      holderWorkerId: workerA,
      leaseTtlSeconds: 30,
      runFencingToken: 1,
    })
    if (!got2.ok) throw new Error('lease2')
    await releaseSessionLease(handle.db, {
      leaseId: got2.lease.id,
      holderWorkerId: workerA,
      reason: 'done',
    })
    await forceLeaseExpiresAt(handle.db, got2.lease.id, new Date(Date.now() - 5000)).catch(() => {})
    const n3 = await expireStaleLeases(handle.db)
    expect(n3).toBe(0)
    expect((await getLeaseById(handle.db, got2.lease.id))?.status).toBe('RELEASED')

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
    const got = await acquireSessionLease(handle.db, {
      sessionId: session.id,
      runId,
      holderWorkerId: workerA,
      leaseTtlSeconds: 30,
      runFencingToken: 1,
    })
    if (!got.ok) throw new Error('lease')
    const grant = {
      sessionId: session.id,
      leaseId: got.lease.id,
      generation: got.lease.sessionGeneration,
      sessionFencingToken: got.lease.sessionFencingToken,
      expiresAt: got.lease.expiresAt.toISOString(),
      holderWorkerId: workerA,
    }
    expect(await verifySessionLeaseForCommit(handle.db, grant)).toBe(true)
    await forceLeaseExpiresAt(handle.db, got.lease.id, new Date(Date.now() - 1000))
    expect(await verifySessionLeaseForCommit(handle.db, grant)).toBe(false)

    await expireStaleLeases(handle.db)
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: (await getSessionById(handle.db, session.id))!.version,
      status: 'CLOSED',
      closeReason: 'cleanup',
      ownerWorkerId: workerA,
    })
  })

  it('claimAuthHold 拒绝未绑定 Run / 代次 / 进程的占用', async () => {
    const session = await openSession()
    await expect(
      claimAuthHold(handle.db, {
        sessionId: session.id,
        workerId: workerA,
        holdSeconds: 30,
        runId: '',
        sessionGeneration: session.generation,
        workerInstanceId: workerAInstance,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_HOLD_UNBOUND' })
    expect((await getSessionById(handle.db, session.id))?.authHoldWorkerId).toBeNull()
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
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
    const got = await acquireSessionLease(handle.db, {
      sessionId: session.id,
      runId,
      holderWorkerId: workerA,
      leaseTtlSeconds: 30,
      runFencingToken: 1,
    })
    if (!got.ok) throw new Error('lease')
    // 获取会 touch last_used；拨回过去后有租约仍不可收
    await forceLastUsedAt(handle.db, session.id, new Date(Date.now() - 120_000))
    expect(await listReapableSessions(handle.db, workerA)).toHaveLength(0)

    await releaseSessionLease(handle.db, {
      leaseId: got.lease.id,
      holderWorkerId: workerA,
      reason: 'done',
    })
    await forceLastUsedAt(handle.db, session.id, new Date(Date.now() - 120_000))
    await claimAuthHold(handle.db, {
      sessionId: session.id,
      workerId: workerA,
      holdSeconds: 300,
      runId,
      sessionGeneration: session.generation,
      workerInstanceId: workerAInstance,
    })
    expect(await listReapableSessions(handle.db, workerA)).toHaveLength(0)

    await releaseAuthHold(handle.db, { sessionId: session.id, workerId: workerA })
    await forceLastUsedAt(handle.db, session.id, new Date(Date.now() - 120_000))
    const reapable = await listReapableSessions(handle.db, workerA)
    expect(reapable.map((s) => s.id)).toContain(session.id)

    const closing = await markSessionsClosing(handle.db, {
      workerId: workerA,
      sessionIds: [session.id],
      reason: 'idle_ttl',
    })
    expect(closing).toEqual([session.id])
    const mid = (await getSessionById(handle.db, session.id))!
    expect(mid.status).toBe('CLOSING')
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: mid.version,
      status: 'CLOSED',
      closeReason: 'idle_ttl',
      ownerWorkerId: workerA,
    })
  })

  it('重启自愈：名下租约 REVOKED、会话 CLOSED，键可再建', async () => {
    const session = await openSession({ worker: workerA })
    const got = await acquireSessionLease(handle.db, {
      sessionId: session.id,
      runId,
      holderWorkerId: workerA,
      leaseTtlSeconds: 30,
      runFencingToken: 1,
    })
    if (!got.ok) throw new Error('lease')
    const revoked = await revokeWorkerLeases(handle.db, workerA)
    expect(revoked).toBeGreaterThanOrEqual(1)
    const closed = await closeWorkerSessions(handle.db, workerA)
    expect(closed).toBeGreaterThanOrEqual(1)
    expect((await getLeaseById(handle.db, got.lease.id))?.status).toBe('REVOKED')
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
      const lease = await acquireSessionLease(handle.db, {
        sessionId: session.id,
        runId: created.detail.id,
        holderWorkerId: workerA,
        leaseTtlSeconds: 30,
        runFencingToken: grant!.fencingToken,
      })
      expect(lease.ok).toBe(true)
      if (!lease.ok) throw new Error('lease')
      await forceLeaseExpiresAt(handle.db, lease.lease.id, new Date(Date.now() - 1000))
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
          sessionId: session.id,
          leaseId: lease.lease.id,
          generation: lease.lease.sessionGeneration,
          sessionFencingToken: lease.lease.sessionFencingToken,
          expiresAt: lease.lease.expiresAt.toISOString(),
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
    const lease = await acquireSessionLease(handle.db, {
      sessionId: opened.id,
      runId,
      holderWorkerId: workerA,
      leaseTtlSeconds: 30,
      runFencingToken: 1,
    })
    expect(lease.ok).toBe(true)
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
    if (lease.ok) {
      expect((await getLeaseById(handle.db, lease.lease.id))?.status).toBe('REVOKED')
    }
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
    const lease = await acquireSessionLease(handle.db, {
      sessionId: opened.id,
      runId,
      holderWorkerId: workerA,
      leaseTtlSeconds: 30,
      runFencingToken: 1,
    })
    expect(lease.ok).toBe(true)

    const listed = await listSessions(handle.db)
    const row = listed.find((item) => item.id === opened.id)!
    expect(row.status).toBe('OPEN')
    expect(row.disposable).toBe(false)
    expect(row.ownerWorkerId).toBe(workerA)
    // 只给元数据：不带 profile 绝对路径之外的任何句柄信息
    expect(row.profileKey).toBe(`${targetId}/${accountId2}`)
    if (lease.ok) {
      expect(row.activeLease?.id).toBe(lease.lease.id)
      expect(row.activeLease?.runId).toBe(runId)
    }

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
})
