import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '@cairn/shared'
import {
  claimSessionUse,
  claimRun,
  closeWorkerSessions,
  computeRunPlacement,
  countFailedRecoveries,
  createRunWithSnapshot,
  createScenarioWithVersion,
  createSession,
  disposeStuckSession,
  failRunValidation,
  findEvictableSession,
  getRun,
  listRunEvidence,
  getSessionById,
  getWorkerById,
  newId,
  openIsolatedDb,
  requireCreatedSession,
  setSessionStatus,
  startAttempt,
  yieldClaimedRun,
  type DbHandle,
} from '../test-entry.js'
import { consoleAccounts } from '../schema/console.js'
import { targetAccounts, targets } from '../schema/targets.js'
import { enterAuthWaitForRun, forceGrantForRun, seedWorker, type SeededWorker } from './lease-harness.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_aff`
const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  outputKey: 'greeting',
  input: { value: 'hello' },
}

describe('P4 后半 Affinity / 容量 / 失联隔离（集成）', { timeout: 120_000 }, () => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let scenarioId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'aff-tester',
      email: `aff-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `aff-${SCHEMA.slice(-6)}`,
      name: '亲和夹具',
      entryUrl: 'https://example.com',
    })
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '亲和场景',
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
      username: `${label}-${id}`,
      status: 'active',
    })
    return id
  }

  async function queueBound(accountId?: string) {
    return createRunWithSnapshot(handle.db, {
      scenarioId,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
  }

  async function cancelOtherClaimable(keepRunId?: string) {
    await handle.pool.query(
      `UPDATE runs
          SET status = 'CANCELLED',
              finished_at = COALESCE(finished_at, now()),
              updated_at = now()
        WHERE status IN ('QUEUED', 'RECOVERING')
          AND ($1::uuid IS NULL OR id <> $1)`,
      [keepRunId ?? null],
    )
  }

  async function openOwnedSession(accountId: string, workerId: string, status: 'OPEN' | 'LOST' | 'CLOSING' | 'CREATING' = 'OPEN') {
    const worker = await getWorkerById(handle.db, workerId)
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: worker?.instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status,
    })
    return (await getSessionById(handle.db, session.id))!
  }

  function claimAs(worker: SeededWorker, excludeRunIds?: string[]) {
    return claimRun(handle, {
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      leaseTtlSeconds: 30,
      excludeRunIds,
    })
  }

  it('他人 OPEN 会话绑定的 Run，只有 owner 能领', async () => {
    const account = await makeAccount('A')
    const owner = await seedWorker(handle, 'aff-owner-a')
    const other = await seedWorker(handle, 'aff-other-a')
    await openOwnedSession(account, owner.workerId)
    const bound = await queueBound(account)
    await cancelOtherClaimable(bound.detail.id)

    expect(await claimAs(other)).toBeNull()
    const taken = await claimAs(owner)
    expect(taken?.runId).toBe(bound.detail.id)

    const free = await queueBound()
    await cancelOtherClaimable(free.detail.id)
    const freeGrant = await claimAs(other)
    expect(freeGrant?.runId).toBe(free.detail.id)
  })

  it('owner 未过期容量满时谁都领不走同账号第二份 Run', async () => {
    const account = await makeAccount('cap')
    const owner = await seedWorker(handle, 'aff-cap-owner')
    await handle.pool.query(`UPDATE workers SET capacity = 1 WHERE id = $1`, [owner.workerId])
    await openOwnedSession(account, owner.workerId)
    const first = await queueBound(account)
    const second = await queueBound(account)
    await forceGrantForRun(handle, first.detail.id, owner.workerId)
    await cancelOtherClaimable(second.detail.id)

    expect(await claimAs(owner)).toBeNull()
    const other = await seedWorker(handle, 'aff-cap-other')
    expect(await claimAs(other)).toBeNull()
    expect((await getRun(handle.db, second.detail.id)).status).toBe('QUEUED')
  })

  it('过期未回收的 ACTIVE 租约不占容量', async () => {
    const account = await makeAccount('expired-cap')
    const owner = await seedWorker(handle, 'aff-exp-owner')
    await handle.pool.query(`UPDATE workers SET capacity = 1 WHERE id = $1`, [owner.workerId])
    await openOwnedSession(account, owner.workerId)
    const stale = await queueBound(account)
    const next = await queueBound(account)
    const staleGrant = await forceGrantForRun(handle, stale.detail.id, owner.workerId)
    await handle.pool.query(`UPDATE run_leases SET expires_at = now() - interval '5 seconds' WHERE id = $1`, [
      staleGrant.leaseId,
    ])
    await cancelOtherClaimable(next.detail.id)

    const grant = await claimAs(owner)
    expect(grant?.runId).toBe(next.detail.id)
  })

  it('无活会话时任一 Worker 都能领绑定账号的 Run', async () => {
    const account = await makeAccount('free')
    const a = await seedWorker(handle, 'aff-free-a')
    const b = await seedWorker(handle, 'aff-free-b')
    const run = await queueBound(account)
    await cancelOtherClaimable(run.detail.id)
    const first = await claimAs(a)
    const secondTry = await claimAs(b)
    expect(first?.runId).toBe(run.detail.id)
    expect(secondTry).toBeNull()
  })

  it('LOST / CLOSING / CREATING 时谁都不领；dispose 后可领', async () => {
    const account = await makeAccount('lost')
    const owner = await seedWorker(handle, 'aff-lost-owner')
    const other = await seedWorker(handle, 'aff-lost-other')
    const session = await openOwnedSession(account, owner.workerId, 'LOST')
    const run = await queueBound(account)
    await cancelOtherClaimable(run.detail.id)
    expect(await claimAs(owner)).toBeNull()
    expect(await claimAs(other)).toBeNull()

    await disposeStuckSession(handle.db, { sessionId: session.id, actor: { id: actorId } })
    const after = await claimAs(other)
    expect(after?.runId).toBe(run.detail.id)

    for (const status of ['CLOSING', 'CREATING'] as const) {
      const blocked = await makeAccount(status.toLowerCase())
      const blockedOwner = await seedWorker(handle, `aff-${status.toLowerCase()}-owner`)
      const blockedOther = await seedWorker(handle, `aff-${status.toLowerCase()}-other`)
      await openOwnedSession(blocked, blockedOwner.workerId, status)
      const blockedRun = await queueBound(blocked)
      await cancelOtherClaimable(blockedRun.detail.id)
      expect(await claimAs(blockedOwner)).toBeNull()
      expect(await claimAs(blockedOther)).toBeNull()
    }
  })

  it('resume-auth 后只有会话 owner 能领；owner 已 LOST 则谁都不领', async () => {
    const account = await makeAccount('resume')
    const owner = await seedWorker(handle, 'aff-resume-owner')
    await openOwnedSession(account, owner.workerId)
    const created = await queueBound(account)
    await handle.pool.query(`UPDATE runs SET status = 'WAITING_FOR_AUTH', updated_at = now() WHERE id = $1`, [
      created.detail.id,
    ])
    await handle.pool.query(`UPDATE runs SET status = 'RECOVERING', updated_at = now() WHERE id = $1`, [
      created.detail.id,
    ])
    await cancelOtherClaimable(created.detail.id)
    const other = await seedWorker(handle, 'aff-resume-other')
    expect(await claimAs(other)).toBeNull()
    expect((await claimAs(owner))?.runId).toBe(created.detail.id)

    const lostAccount = await makeAccount('resume-lost')
    await openOwnedSession(lostAccount, owner.workerId, 'LOST')
    const lostRun = await queueBound(lostAccount)
    await handle.pool.query(`UPDATE runs SET status = 'WAITING_FOR_AUTH', updated_at = now() WHERE id = $1`, [
      lostRun.detail.id,
    ])
    await handle.pool.query(`UPDATE runs SET status = 'RECOVERING', updated_at = now() WHERE id = $1`, [
      lostRun.detail.id,
    ])
    await cancelOtherClaimable(lostRun.detail.id)
    expect(await claimAs(owner)).toBeNull()
    expect(await claimAs(other)).toBeNull()
  })

  it('placement_yield 不计恢复次数；已有 Attempt 不得回交', async () => {
    const worker = await seedWorker(handle, 'aff-yield')
    const run = await queueBound()
    const grant = await forceGrantForRun(handle, run.detail.id, worker.workerId)
    const first = await yieldClaimedRun(handle.db, grant, 'placement_yield')
    expect(first).toBe('yielded')
    expect((await getRun(handle.db, run.detail.id)).status).toBe('RECOVERING')
    expect(await countFailedRecoveries(handle.db, run.detail.id)).toBe(0)

    const again = await forceGrantForRun(handle, run.detail.id, worker.workerId)
    await yieldClaimedRun(handle.db, again, 'placement_yield')
    const thirdGrant = await forceGrantForRun(handle, run.detail.id, worker.workerId)
    await yieldClaimedRun(handle.db, thirdGrant, 'placement_yield')
    expect(await countFailedRecoveries(handle.db, run.detail.id)).toBe(0)
    expect((await getRun(handle.db, run.detail.id)).status).not.toBe('NEEDS_REVIEW')

    const blocked = await queueBound()
    const startedGrant = await forceGrantForRun(handle, blocked.detail.id, worker.workerId)
    const detail = await getRun(handle.db, blocked.detail.id)
    const started = await startAttempt(handle.db, {
      runId: blocked.detail.id,
      stepRunId: detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant: startedGrant,
    })
    expect(started).not.toBeNull()
    expect(await yieldClaimedRun(handle.db, startedGrant, 'placement_yield')).toBe('has_attempts')
    expect((await getRun(handle.db, blocked.detail.id)).status).toBe('RUNNING')
  })

  it('placement_yield 允许身上已有终态 Attempt 的恢复重领', async () => {
    const worker = await seedWorker(handle, 'aff-yield-done')
    const run = await queueBound()
    const grant = await forceGrantForRun(handle, run.detail.id, worker.workerId)
    const detail = await getRun(handle.db, run.detail.id)
    const started = await startAttempt(handle.db, {
      runId: run.detail.id,
      stepRunId: detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant,
    })
    expect(started).not.toBeNull()
    await handle.pool.query(
      `UPDATE attempts SET status = 'SUCCEEDED', finished_at = now() WHERE id = $1`,
      [started!.attemptId],
    )
    expect(await yieldClaimedRun(handle.db, grant, 'placement_yield')).toBe('yielded')
    expect((await getRun(handle.db, run.detail.id)).status).toBe('RECOVERING')
  })

  it('GET placement 与库派生一致', async () => {
    const account = await makeAccount('place')
    const owner = await seedWorker(handle, 'aff-place-owner')
    await handle.pool.query(`UPDATE workers SET capacity = 1 WHERE id = $1`, [owner.workerId])
    const session = await openOwnedSession(account, owner.workerId)
    const waiting = await queueBound(account)
    const claimed = await queueBound(account)
    await forceGrantForRun(handle, claimed.detail.id, owner.workerId)

    const waitingDetail = await getRun(handle.db, waiting.detail.id)
    expect(waitingDetail.placement).toMatchObject({
      state: 'owner_at_capacity',
      sessionId: session.id,
      ownerWorkerId: owner.workerId,
      sessionStatus: 'OPEN',
    })

    const claimedDetail = await getRun(handle.db, claimed.detail.id)
    expect(claimedDetail.placement.state).toBe('claimed')

    const free = await queueBound()
    expect((await getRun(handle.db, free.detail.id)).placement.state).toBe('not_applicable')

    const lostAccount = await makeAccount('place-lost')
    await openOwnedSession(lostAccount, owner.workerId, 'LOST')
    const lostRun = await queueBound(lostAccount)
    expect((await getRun(handle.db, lostRun.detail.id)).placement.state).toBe('session_lost')

    const computed = await computeRunPlacement(handle.db, {
      status: 'QUEUED',
      targetId,
      targetAccountId: lostAccount,
      hasActiveLease: false,
    })
    expect(computed.state).toBe('session_lost')
  })

  it('findEvictableSession 跳过 ACTIVE 租约与认证占用，挑最旧空闲', async () => {
    const worker = await seedWorker(handle, 'aff-evict')
    const idleOld = await makeAccount('evict-old')
    const idleNew = await makeAccount('evict-new')
    const busy = await makeAccount('evict-busy')
    const held = await makeAccount('evict-auth')
    const oldSession = await openOwnedSession(idleOld, worker.workerId)
    const newSession = await openOwnedSession(idleNew, worker.workerId)
    const busySession = await openOwnedSession(busy, worker.workerId)
    const authSession = await openOwnedSession(held, worker.workerId)
    await handle.pool.query(`UPDATE browser_sessions SET last_used_at = now() - interval '10 minutes' WHERE id = $1`, [
      oldSession.id,
    ])
    await handle.pool.query(`UPDATE browser_sessions SET last_used_at = now() - interval '1 minute' WHERE id = $1`, [
      newSession.id,
    ])
    const run = await queueBound(busy)
    const grant = await forceGrantForRun(handle, run.detail.id, worker.workerId)
    const claimed = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: busy },
      owner: { kind: 'RUN', runId: run.detail.id, runFencingToken: grant.fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: worker.workerId,
      holderInstanceId: worker.instanceId,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    if (!claimed.ok) throw new Error(claimed.message ?? claimed.code)
    const authRun = await queueBound(held)
    const authGrant = await forceGrantForRun(handle, authRun.detail.id, worker.workerId)
    const authWait = await enterAuthWaitForRun(handle, {
      targetId,
      targetAccountId: held,
      grant: authGrant,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      holdSeconds: 120,
    })
    expect(authWait.claimed.session.id).toBe(authSession.id)

    const evictable = await findEvictableSession(handle.db, worker.workerId)
    expect(evictable?.id).toBe(oldSession.id)
  })

  it('createSession 策略非法返回 SESSION_POLICY_INVALID，不抛、不写行', async () => {
    const account = await makeAccount('policy')
    const result = await createSession(handle.db, {
      key: { targetId, targetAccountId: account },
      ownerWorkerId: 'aff-policy',
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 600,
    })
    expect(result).toEqual({
      ok: false,
      code: 'SESSION_POLICY_INVALID',
      message: 'maxLifetimeSeconds 必须大于 idleTtlSeconds',
    })
    expect(await handle.pool.query(`SELECT count(*)::int AS n FROM browser_sessions WHERE target_account_id = $1`, [account])).toMatchObject({
      rows: [{ n: 0 }],
    })
  })

  it('新进程 reconcile 不关 LOST', async () => {
    const account = await makeAccount('restart-lost')
    const session = await openOwnedSession(account, 'dead-worker', 'LOST')
    const closed = await closeWorkerSessions(handle.db, 'dead-worker')
    expect(closed).toBe(0)
    expect((await getSessionById(handle.db, session.id))?.status).toBe('LOST')
  })

  it('claimRun 跳过 excludeRunIds；不传则可再领同一 Run', async () => {
    const worker = await seedWorker(handle, 'aff-backoff')
    const run = await queueBound()
    const grant = await forceGrantForRun(handle, run.detail.id, worker.workerId)
    await yieldClaimedRun(handle.db, grant, 'placement_yield')
    await cancelOtherClaimable(run.detail.id)
    expect(await claimAs(worker, [run.detail.id])).toBeNull()
    const before = await handle.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM run_leases WHERE run_id = $1`,
      [run.detail.id],
    )
    expect(await claimAs(worker, [run.detail.id])).toBeNull()
    const after = await handle.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM run_leases WHERE run_id = $1`,
      [run.detail.id],
    )
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n)
    expect((await claimAs(worker))?.runId).toBe(run.detail.id)
  })

  it('配置错误走 failRunValidation，不是回交', async () => {
    const worker = await seedWorker(handle, 'aff-fail-config')
    const run = await queueBound()
    const grant = await forceGrantForRun(handle, run.detail.id, worker.workerId)
    await failRunValidation(handle.db, run.detail.id, { grant }, {
      code: 'SESSION_ACCOUNT_REQUIRED',
      category: 'VALIDATION',
      retryable: false,
      safeMessage: '浏览器步骤未指定目标账号，无法建立会话',
    })
    expect((await getRun(handle.db, run.detail.id)).status).toBe('FAILED')
    expect(await countFailedRecoveries(handle.db, run.detail.id)).toBe(0)
    const evidence = (await listRunEvidence(handle.db, run.detail.id)).items.find((item) => item.type === 'error')
    expect(evidence?.attemptId).toBeUndefined()
    expect(evidence?.payload).toMatchObject({
      code: 'SESSION_ACCOUNT_REQUIRED',
      safeMessage: '浏览器步骤未指定目标账号，无法建立会话',
    })
  })
})
