import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '@cairn/shared'
import {
  DomainError,
  acquireSessionLease,
  claimRun,
  countFailedRecoveries,
  createRunWithSnapshot,
  createScenarioWithVersion,
  requireCreatedSession,
  expireStaleRunLeases,
  findActiveLeaseForRun,
  finishAttempt,
  getRun,
  listRuns,
  markLostWorkers,
  markSessionsLostForWorkers,
  openIsolatedDb,
  registerWorker,
  renewRunLease,
  requestRunCancel,
  reviewRun,
  setSessionStatus,
  settleLeaselessRun,
  settleRevokedRuns,
  startAttempt,
  sweepDriftedRuns,
  yieldUnfinishedRun,
  type DbHandle,
} from '../test-entry.js'
import { newId } from '../id.js'
import { consoleAccounts } from '../schema/console.js'
import { targetAccounts, targets } from '../schema/targets.js'
import { browserSessions } from '../schema/session.js'
import { forceGrantForRun, seedWorker, type SeededWorker } from './lease-harness.js'
import { eq } from 'drizzle-orm'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_lease`
const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  outputKey: 'greeting',
  input: { value: 'hello' },
}

const RF06_FULL = process.env.CAIRN_RF06_FULL === '1'
const RF06_RUNS = RF06_FULL ? 100 : 20
const RF06_ROUNDS = RF06_FULL ? 10 : 2

describe('RunLease / fencing（集成）', { timeout: RF06_FULL ? 180_000 : 120_000 }, () => {
  let handle: DbHandle
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'lease-tester',
      email: `lease-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `lease-${SCHEMA.slice(-6)}`,
      name: '租约夹具',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function queueEcho(name: string) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name,
      steps: [echoStep],
      actor: { id: actorId },
    })
    return createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: { id: actorId } })
  }

  /** 清掉其它可领取 Run，避免 claimRun 领到夹具残留。不碰控制台账号、目标账号、浏览器会话。 */
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

  async function claimThisRun(worker: SeededWorker, runId: string) {
    await cancelOtherClaimable(runId)
    const grant = await claimRun(handle, {
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      leaseTtlSeconds: 30,
    })
    expect(grant?.runId).toBe(runId)
    return grant!
  }

  function claimAs(worker: SeededWorker) {
    return claimRun(handle, {
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      leaseTtlSeconds: 30,
    })
  }

  async function leaseRowsFor(runId: string) {
    const { rows } = await handle.pool.query<{ status: string; fencing_token: number }>(
      `SELECT status, fencing_token FROM run_leases WHERE run_id = $1 ORDER BY fencing_token`,
      [runId],
    )
    return rows.map((row) => ({ status: row.status, fencing_token: Number(row.fencing_token) }))
  }

  it('同 Run 并发 claim 只有一个 ACTIVE', async () => {
    const created = await queueEcho(`并发-${newId().slice(0, 8)}`)
    await cancelOtherClaimable(created.detail.id)
    const a = await seedWorker(handle, 'w-a')
    const b = await seedWorker(handle, 'w-b')
    const [one, two] = await Promise.all([claimAs(a), claimAs(b)])
    const hits = [one, two].filter((item) => item?.runId === created.detail.id)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.fencingToken).toBe(1)
  })

  it('领取不做幂等：连续两次 claim 不会回到同一 ACTIVE', async () => {
    await cancelOtherClaimable()
    await queueEcho(`幂等甲-${newId().slice(0, 8)}`)
    await queueEcho(`幂等乙-${newId().slice(0, 8)}`)
    const worker = await seedWorker(handle)
    const first = await claimAs(worker)
    const second = await claimAs(worker)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second?.leaseId).not.toBe(first?.leaseId)
    await expect(
      handle.pool.query(
        `INSERT INTO run_leases (id, run_id, fencing_token, holder_worker_id, status, expires_at)
         VALUES ($1, $2, 99, $3, 'ACTIVE', now() + interval '30 seconds')`,
        [newId(), first!.runId, worker.workerId],
      ),
    ).rejects.toThrow()
  })

  it('过期后原 token 续租与成功提交均拒绝', async () => {
    const created = await queueEcho(`过期-${newId().slice(0, 8)}`)
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    await handle.pool.query(`UPDATE run_leases SET expires_at = now() - interval '5 seconds' WHERE id = $1`, [
      grant.leaseId,
    ])
    expect(await renewRunLease(handle.db, grant, 30)).toBeNull()
    const started = await startAttempt(handle.db, {
      runId: grant.runId,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant,
    })
    expect(started).toBeNull()
    expect(await findActiveLeaseForRun(handle.db, grant.runId)).not.toBeNull()
  })

  it('旧 fencing 在新 owner 领取后不能写成功', async () => {
    const created = await queueEcho(`换代-${newId().slice(0, 8)}`)
    const oldWorker = await seedWorker(handle, 'old-owner')
    const oldGrant = await forceGrantForRun(handle, created.detail.id, oldWorker.workerId)
    await handle.pool.query(`UPDATE run_leases SET expires_at = now() - interval '2 seconds' WHERE id = $1`, [
      oldGrant.leaseId,
    ])
    await expireStaleRunLeases(handle.db, { limit: 10, maxRecoveries: 3 })
    expect((await getRun(handle.db, created.detail.id)).status).toBe('RECOVERING')
    const newWorker = await seedWorker(handle, 'new-owner')
    const newGrant = await claimThisRun(newWorker, created.detail.id)
    expect(newGrant.fencingToken).toBeGreaterThan(oldGrant.fencingToken)
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant: oldGrant,
    })
    expect(started).toBeNull()
    const ok = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant: newGrant,
    })
    expect(ok).not.toBeNull()
    const late = await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: ok!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: 'hello',
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant: oldGrant,
    })
    expect(late.updated).toBe(false)
    const done = await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: ok!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: 'hello',
      context: { greeting: 'hello' },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant: newGrant,
    })
    expect(done.updated).toBe(true)
    expect((await getRun(handle.db, created.detail.id)).status).toBe('SUCCEEDED')
  })

  it('漂移扫描把无租约的 RUNNING 拉回 RECOVERING', async () => {
    const created = await queueEcho(`漂移-${newId().slice(0, 8)}`)
    await handle.pool.query(
      `UPDATE runs SET status = 'RUNNING', started_at = now(), updated_at = now() - interval '2 minutes' WHERE id = $1`,
      [created.detail.id],
    )
    const n = await sweepDriftedRuns(handle.db, { limit: 10, leaseTtlSeconds: 30, maxRecoveries: 3 })
    expect(n).toBeGreaterThanOrEqual(1)
    expect((await getRun(handle.db, created.detail.id)).status).toBe('RECOVERING')
  })

  it('恢复上限耗尽后进 NEEDS_REVIEW，RELEASED 不计入', async () => {
    const created = await queueEcho(`上限-${newId().slice(0, 8)}`)
    const worker = await seedWorker(handle)
    // 一次正常释放不得计入恢复次数
    const released = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    await handle.pool.query(
      `UPDATE run_leases SET status = 'RELEASED', released_at = now(), release_reason = 'run_halted' WHERE id = $1`,
      [released.leaseId],
    )
    for (let i = 0; i < 3; i += 1) {
      const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
      await handle.pool.query(`UPDATE run_leases SET expires_at = now() - interval '2 seconds' WHERE id = $1`, [
        grant.leaseId,
      ])
      await expireStaleRunLeases(handle.db, { limit: 10, maxRecoveries: 3 })
    }
    const after = await getRun(handle.db, created.detail.id)
    expect(after.status).toBe('NEEDS_REVIEW')
    // 待核查还没有结论：完成时间要等 reviewRun 才写，否则耗时统计会把它算成已完成
    expect(after.finishedAt).toBeNull()
    await cancelOtherClaimable()
    const stolen = await claimAs(worker)
    expect(stolen?.runId).not.toBe(created.detail.id)
    await reviewRun(handle.db, { runId: created.detail.id, actor: { id: actorId }, conclusion: 'fail' })
    const concluded = await getRun(handle.db, created.detail.id)
    expect(concluded.status).toBe('FAILED')
    expect(concluded.finishedAt).not.toBeNull()
  })

  it('无租约状态取消直接终态；RUNNING 只写请求；NEEDS_REVIEW 原样', async () => {
    const queued = await queueEcho(`取消排队-${newId().slice(0, 8)}`)
    const cancelled = await requestRunCancel(handle.db, queued.detail.id, { id: actorId })
    expect(cancelled.status).toBe('CANCELLED')
    const again = await requestRunCancel(handle.db, queued.detail.id, { id: actorId })
    expect(again.status).toBe('CANCELLED')

    const running = await queueEcho(`取消运行-${newId().slice(0, 8)}`)
    const worker = await seedWorker(handle)
    await forceGrantForRun(handle, running.detail.id, worker.workerId)
    const requested = await requestRunCancel(handle.db, running.detail.id, { id: actorId })
    expect(requested.status).toBe('RUNNING')
    expect(requested.cancelRequested).toBe(true)

    const review = await queueEcho(`核查取消-${newId().slice(0, 8)}`)
    await handle.pool.query(`UPDATE runs SET status = 'NEEDS_REVIEW', finished_at = now() WHERE id = $1`, [
      review.detail.id,
    ])
    const kept = await requestRunCancel(handle.db, review.detail.id, { id: actorId })
    expect(kept.status).toBe('NEEDS_REVIEW')
  })

  it('WAITING_FOR_AUTH 取消是 CANCELLED；resume-auth 后可再领且 token 增代', async () => {
    const cancellable = await queueEcho(`认证取消-${newId().slice(0, 8)}`)
    await handle.pool.query(`UPDATE runs SET status = 'WAITING_FOR_AUTH', updated_at = now() WHERE id = $1`, [
      cancellable.detail.id,
    ])
    const cancelled = await requestRunCancel(handle.db, cancellable.detail.id, { id: actorId })
    expect(cancelled.status).toBe('CANCELLED')

    const created = await queueEcho(`认证恢复-${newId().slice(0, 8)}`)
    const worker = await seedWorker(handle)
    const first = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    await handle.pool.query(
      `UPDATE runs SET status = 'WAITING_FOR_AUTH', updated_at = now() WHERE id = $1`,
      [created.detail.id],
    )
    await handle.pool.query(
      `UPDATE run_leases SET status = 'RELEASED', released_at = now(), release_reason = 'waiting_for_auth' WHERE id = $1`,
      [first.leaseId],
    )
    await handle.pool.query(
      `UPDATE runs SET status = 'RECOVERING', updated_at = now() WHERE id = $1`,
      [created.detail.id],
    )
    const next = await claimThisRun(worker, created.detail.id)
    expect(next.fencingToken).toBeGreaterThan(first.fencingToken)
  })

  it('GET 列表/详情带 lease；无 ACTIVE 为 null', async () => {
    const created = await queueEcho(`观察-${newId().slice(0, 8)}`)
    const listed = await listRuns(handle.db)
    const queued = listed.items.find((item) => item.id === created.detail.id)
    expect(queued?.lease).toBeNull()
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.lease).toMatchObject({
      holderWorkerId: worker.workerId,
      fencingToken: grant.fencingToken,
    })
    expect(detail.lease).not.toHaveProperty('profileKey')
    expect(detail.lease).not.toHaveProperty('targetAccountId')
  })

  it('新 ACTIVE 会话租约缺 runFencingToken 被拒', async () => {
    const accountId = newId()
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: '目标账号',
      username: `u-${accountId.slice(0, 8)}`,
    })
    const created = await queueEcho(`会话fencing-${newId().slice(0, 8)}`)
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: 'sess-worker',
      reusePolicy: 'REUSE_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
    })
    const rejected = await acquireSessionLease(handle.db, {
      sessionId: session.id,
      runId: created.detail.id,
      holderWorkerId: 'sess-worker',
      leaseTtlSeconds: 30,
      runFencingToken: 0,
    })
    expect(rejected.ok).toBe(false)
  })

  it('失联 Worker 只把未关闭浏览器会话标 LOST，不动控制台账号', async () => {
    const accountId = newId()
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: '失联账号',
      username: `lost-${accountId.slice(0, 8)}`,
    })
    await registerWorker(handle.db, {
      workerId: 'lost-worker',
      instanceId: newId(),
      capacity: 1,
      lostAfterSeconds: 1,
    })
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: 'lost-worker',
      reusePolicy: 'REUSE_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
    })
    await handle.pool.query(`UPDATE workers SET heartbeat_at = now() - interval '2 minutes' WHERE id = 'lost-worker'`)
    const lost = await markLostWorkers(handle.db, 1)
    expect(lost).toContain('lost-worker')
    expect(await markSessionsLostForWorkers(handle.db, lost)).toBeGreaterThanOrEqual(1)
    const [row] = await handle.db.select().from(browserSessions).where(eq(browserSessions.id, session.id))
    expect(row?.status).toBe('LOST')
  })

  it('LOST / 错位实例不能再 claimRun', async () => {
    await cancelOtherClaimable()
    await queueEcho(`僵尸-${newId().slice(0, 8)}`)
    const worker = await seedWorker(handle, 'zombie-worker')
    await handle.pool.query(`UPDATE workers SET status = 'LOST', stopped_at = now() WHERE id = $1`, [
      worker.workerId,
    ])
    expect(await claimAs(worker)).toBeNull()

    const ready = await seedWorker(handle, 'ready-worker')
    expect(
      await claimRun(handle, {
        workerId: ready.workerId,
        instanceId: newId(),
        leaseTtlSeconds: 30,
      }),
    ).toBeNull()
  })

  /**
   * 验收 15：租约过期与 Run 状态迁移必须同生共死。
   * 只落一半的后果是 Run 从恢复扫描里消失——要么租约没了但 Run 还挂在 RUNNING，
   * 要么 Run 进了 RECOVERING 却还背着一份 ACTIVE 租约，谁都不敢领。
   */
  it('过期与状态迁移同事务：提交前注入故障则整体回滚', async () => {
    const created = await queueEcho(`同事务-${newId().slice(0, 8)}`)
    const worker = await seedWorker(handle, 'atomic')
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    await handle.pool.query(`UPDATE run_leases SET expires_at = now() - interval '2 seconds' WHERE id = $1`, [
      grant.leaseId,
    ])

    const boom = new Error('注入：提交前失败')
    await expect(
      settleLeaselessRun(handle.db, {
        runId: created.detail.id,
        leaseId: grant.leaseId,
        maxRecoveries: 3,
        injectFailure: boom,
      }),
    ).rejects.toBe(boom)

    // 两边都必须回到原样
    expect((await getRun(handle.db, created.detail.id)).status).toBe('RUNNING')
    const stillHeld = await findActiveLeaseForRun(handle.db, created.detail.id)
    expect(stillHeld?.leaseId).toBe(grant.leaseId)

    // 不注入就正常收敛，说明回滚没有留下坏状态
    expect(
      await settleLeaselessRun(handle.db, {
        runId: created.detail.id,
        leaseId: grant.leaseId,
        maxRecoveries: 3,
      }),
    ).toBe('recovering')
    expect(await findActiveLeaseForRun(handle.db, created.detail.id)).toBeNull()
  })

  /** 验收 14：回收是定时任务，必须可以反复跑。 */
  it('过期回收幂等：同一条租约第二轮不再产生变化', async () => {
    const created = await queueEcho(`幂等-${newId().slice(0, 8)}`)
    const worker = await seedWorker(handle, 'idem')
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    await handle.pool.query(`UPDATE run_leases SET expires_at = now() - interval '2 seconds' WHERE id = $1`, [
      grant.leaseId,
    ])

    const first = await expireStaleRunLeases(handle.db, { limit: 10, maxRecoveries: 3 })
    expect(first.outcomes).toContain('recovering')
    const snapshot = await leaseRowsFor(created.detail.id)
    expect(snapshot).toEqual([{ status: 'EXPIRED', fencing_token: grant.fencingToken }])
    expect((await getRun(handle.db, created.detail.id)).status).toBe('RECOVERING')

    // 第二轮：这条租约已不是 ACTIVE，既不该被再处理，也不该改任何东西
    await expireStaleRunLeases(handle.db, { limit: 10, maxRecoveries: 3 })
    expect(
      await settleLeaselessRun(handle.db, {
        runId: created.detail.id,
        leaseId: grant.leaseId,
        maxRecoveries: 3,
      }),
    ).toBe('skipped')
    expect(await leaseRowsFor(created.detail.id)).toEqual(snapshot)
    expect((await getRun(handle.db, created.detail.id)).status).toBe('RECOVERING')
  })

  /**
   * 验收 18 与恢复次数口径（M11）。
   *
   * 恢复次数用来识别"反复把 Worker 拖死"的毒丸 Run，不该把正常停机也算进去：
   * 默认上限就是 3，一旦优雅停机也计数，滚动发布三次就能把好端端的 Run 推进待核查。
   */
  it('启动自愈撤销残留租约算一次恢复，优雅停机释放的不算', async () => {
    const created = await queueEcho(`自愈-${newId().slice(0, 8)}`)
    const runId = created.detail.id
    const worker = await seedWorker(handle, `heal-${newId().slice(0, 6)}`)

    // 优雅停机：租约 RELEASED，Run 交回 RECOVERING
    const graceful = await forceGrantForRun(handle, runId, worker.workerId)
    await yieldUnfinishedRun(handle.db, graceful)
    expect((await getRun(handle.db, runId)).status).toBe('RECOVERING')
    expect(await countFailedRecoveries(handle.db, runId)).toBe(0)

    // 被 kill：没人释放，心跳停了；超过 LOST_AFTER 之后同 ID 重启
    const killed = await forceGrantForRun(handle, runId, worker.workerId)
    await handle.pool.query(`UPDATE workers SET heartbeat_at = now() - interval '120 seconds' WHERE id = $1`, [
      worker.workerId,
    ])
    const restarted = await registerWorker(handle.db, {
      workerId: worker.workerId,
      instanceId: newId(),
      capacity: 8,
      lostAfterSeconds: 60,
    })
    expect(restarted.revokedRunIds).toContain(runId)
    await settleRevokedRuns(handle.db, restarted.revokedRunIds, 3)

    expect((await getRun(handle.db, runId)).status).toBe('RECOVERING')
    expect(await countFailedRecoveries(handle.db, runId)).toBe(1)
    // 旧持有者的 grant 从此写不进任何东西
    expect(await renewRunLease(handle.db, killed, 30)).toBeNull()
  })

  /** 验收 19：同 ID 双开必须硬失败，且错误里不得夹带连接密钥。 */
  it('同 ID 且心跳新鲜的第二实例注册失败，报错不含密钥', async () => {
    const worker = await seedWorker(handle, `dup-${newId().slice(0, 6)}`)
    const error = await registerWorker(handle.db, {
      workerId: worker.workerId,
      instanceId: newId(),
      capacity: 1,
      lostAfterSeconds: 60,
    }).then(
      () => undefined,
      (err: unknown) => err,
    )

    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe('WORKER_ID_CONFLICT')
    const text = `${(error as Error).message}\n${(error as Error).stack ?? ''}`
    const password = process.env.CAIRN_DB_PASSWORD
    expect(password && password.length > 0).toBe(true)
    expect(text).not.toContain(password!)
  })

  it('先过期再提交：旧 token 的成功写不进', async () => {
    const created = await queueEcho(`过期提交-${newId().slice(0, 8)}`)
    const oldWorker = await seedWorker(handle, 'stale-old')
    const oldGrant = await forceGrantForRun(handle, created.detail.id, oldWorker.workerId)
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant: oldGrant,
    })
    expect(started).not.toBeNull()

    await handle.pool.query(`UPDATE run_leases SET expires_at = now() - interval '2 seconds' WHERE id = $1`, [
      oldGrant.leaseId,
    ])
    await expireStaleRunLeases(handle.db, { limit: 10, maxRecoveries: 3 })
    const newWorker = await seedWorker(handle, 'stale-new')

    const [claimResult, finishResult] = await Promise.all([
      claimThisRun(newWorker, created.detail.id),
      finishAttempt(handle.db, {
        runId: created.detail.id,
        attemptId: started!.attemptId,
        attemptStatus: 'SUCCEEDED',
        output: 'hello',
        context: { greeting: 'hello' },
        stepRunStatus: 'SUCCEEDED',
        runStatus: 'SUCCEEDED',
        grant: oldGrant,
      }),
    ])
    expect(claimResult.fencingToken).toBeGreaterThan(oldGrant.fencingToken)
    expect(finishResult.updated).toBe(false)
    expect((await getRun(handle.db, created.detail.id)).status).toBe('RUNNING')
  })

  /**
   * D5 的提交边界（验收第 8 条）。
   *
   * 上一条用例里租约在 finishAttempt 开始前就已失效，验证的只是谓词会拒绝——
   * 把 `lockRunRow` 从 finishAttemptTx 删掉，它照样通过。这一条才是真屏障：
   * A 在「锁了 Run 行、验完租约、还没写任何事实」处停住，回收与接管同时闯进来。
   *
   * 有 Run 行锁 → 回收与领取排在 A 之后，只出现一种合法次序；
   * 没有 Run 行锁 → 回收把 Run 翻成 RECOVERING、B 领到新 token，A 仍然提交 SUCCEEDED，
   * 于是同一个 Run 既有新 owner 又被旧 owner 判成成功。
   */
  it('屏障并发：A 验完租约后停住，接管挤不进提交窗口', async () => {
    const created = await queueEcho(`屏障-${newId().slice(0, 8)}`)
    const oldWorker = await seedWorker(handle, 'barrier-old')
    const newWorker = await seedWorker(handle, 'barrier-new')
    const grant = await forceGrantForRun(handle, created.detail.id, oldWorker.workerId)
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      inputPayload: 'hello',
      grant,
    })
    expect(started).not.toBeNull()
    await cancelOtherClaimable(created.detail.id)

    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const finishing = finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: started!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: 'hello',
      context: { greeting: 'hello' },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
      barrierAfterVerify: async () => {
        reached.resolve()
        await release.promise
      },
    })

    // 屏障必须在任何路径上都被放开：否则 A 的事务会一直占着连接，整份用例卡到 hook 超时。
    let midwayStatus: string | undefined
    let reaping: Promise<unknown> | undefined
    try {
      // A 此刻持有 Run 行锁、租约已验过、事实一行未写。
      await reached.promise
      // 让租约在 A 的事务外过期：回收有充分理由收掉它并把 Run 交出去。
      await handle.pool.query(`UPDATE run_leases SET expires_at = now() - interval '2 seconds' WHERE id = $1`, [
        grant.leaseId,
      ])
      // 不 await：回收要抢同一把 Run 行锁，必须排在 A 之后。
      reaping = expireStaleRunLeases(handle.db, { limit: 10, maxRecoveries: 3 })
      await new Promise((resolve) => setTimeout(resolve, 150))
      const { rows } = await handle.pool.query<{ status: string }>(
        `SELECT status FROM runs WHERE id = $1`,
        [created.detail.id],
      )
      midwayStatus = rows[0]?.status
    } finally {
      release.resolve()
    }
    const finishResult = await finishing
    await reaping

    // 关键判据：A 还在事务里，回收就不可能已经把 Run 交出去。
    // 去掉 lockRunRow，这里会读到 RECOVERING——回收已提交，而 A 之后仍然写出 SUCCEEDED。
    expect(midwayStatus).toBe('RUNNING')

    // A 是合法持有者，它的提交成立；接管没能插进验证与提交之间。
    expect(finishResult.updated).toBe(true)
    expect(finishResult.cancelled).toBe(false)
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('SUCCEEDED')
    expect(await claimAs(newWorker)).toBeNull()

    // 全程只有一份租约，且由 A 的提交正常释放（不是被回收判过期）——没有第二代 owner。
    const { rows } = await handle.pool.query<{ status: string; fencing_token: number }>(
      `SELECT status, fencing_token FROM run_leases WHERE run_id = $1 ORDER BY fencing_token`,
      [created.detail.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('RELEASED')

    const succeeded = detail.stepRuns[0]?.attempts.filter((attempt) => attempt.status === 'SUCCEEDED')
    expect(succeeded).toHaveLength(1)
  })

  it(`缩小版竞争领取 ${RF06_RUNS}×${RF06_ROUNDS}（全量 RF06 用 CAIRN_RF06_FULL=1）`, { timeout: RF06_FULL ? 180_000 : 120_000 }, async () => {
    const workers = await Promise.all([
      seedWorker(handle, 'rf06-a'),
      seedWorker(handle, 'rf06-b'),
      seedWorker(handle, 'rf06-c'),
    ])
    for (let round = 0; round < RF06_ROUNDS; round += 1) {
      await cancelOtherClaimable()
      const created = await Promise.all(
        Array.from({ length: RF06_RUNS }, (_, i) => queueEcho(`rf06-${round}-${i}-${newId().slice(0, 6)}`)),
      )
      const ids = new Set(created.map((item) => item.detail.id))
      const claimed = new Set<string>()
      await Promise.all(
        workers.map(async (worker) => {
          while (true) {
            const grant = await claimAs(worker)
            if (!grant || !ids.has(grant.runId)) break
            if (claimed.has(grant.runId)) throw new Error('同一 Run 被领两次')
            claimed.add(grant.runId)
            const detail = await getRun(handle.db, grant.runId)
            const started = await startAttempt(handle.db, {
              runId: grant.runId,
              stepRunId: detail.stepRuns[0]!.id,
              inputPayload: 'hello',
              grant,
            })
            expect(started).not.toBeNull()
            await finishAttempt(handle.db, {
              runId: grant.runId,
              attemptId: started!.attemptId,
              attemptStatus: 'SUCCEEDED',
              output: 'hello',
              context: { greeting: 'hello' },
              stepRunStatus: 'SUCCEEDED',
              runStatus: 'SUCCEEDED',
              grant,
            })
          }
        }),
      )
      for (const item of created) {
        expect((await getRun(handle.db, item.detail.id)).status).toBe('SUCCEEDED')
      }
    }
  })
})
