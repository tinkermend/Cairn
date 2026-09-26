import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SESSION_OCCUPANCY_PROTOCOL, type Step } from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import {
  CLAIM_EXCLUDE_LIMIT,
  CLAIM_SCAN_LIMIT,
  claimRun,
  claimRunWithCursor,
  closeWorkerSessions,
  createRunWithSnapshot,
  createScenarioWithVersion,
  registerWorker,
  requireCreatedSession,
  setSessionStatus,
  takeLastClaimDiagnostics,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { forceGrantForRun } from './lease-harness.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'

const echo: Step = {
  id: '00000000-0000-4000-8000-000000000061',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s 领取公平性与扫描上界', { timeout: 90_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `claim_${Date.now().toString(36)}`)
    const { consoleAccounts } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'claim',
      email: `claim-${actorId}@example.com`,
      status: 'active',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function cancelClaimable() {
    const { runs } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({ status: 'CANCELLED', cancelRequestedAt: new Date() })
      .where(inArray(runs.status, ['QUEUED', 'RECOVERING']))
  }

  async function freshSlot(name: string) {
    const { targets, targetAccounts } = schemaFor(handle.db)
    const targetId = newId()
    const accountId = newId()
    await handle.db.insert(targets).values({
      id: targetId,
      code: `claim-${targetId}`,
      name,
      entryUrl: 'https://shop.example/home',
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: name,
      username: `ops-${accountId}`,
      status: 'active',
    })
    return { targetId, accountId }
  }

  async function readyWorker(suffix: string, maxSessions = 8) {
    const instanceId = newId()
    const workerId = `claim-w-${suffix}`
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 8,
      maxSessions,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    return { workerId, instanceId }
  }

  async function queueRun(targetId: string, targetAccountId: string, name: string) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name,
      steps: [echo],
      actor: { kind: 'console', id: actorId },
    })
    return createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId,
      actor: { kind: 'console', id: actorId },
    })
  }

  async function occupyOtherWorker(targetId: string, accountId: string) {
    const other = await readyWorker(`occ-${accountId}`)
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: other.workerId,
      ownerWorkerInstanceId: other.instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
      ownerWorkerId: other.workerId,
      ownerWorkerInstanceId: other.instanceId,
    })
    return other
  }

  it('RJ-02/03 占用键被 SQL 过滤，另一目标不被队头阻塞，扫描有上界', async () => {
    await cancelClaimable()
    const blocked = await freshSlot('积压目标')
    const free = await freshSlot('空闲目标')
    const claimant = await readyWorker(`free-${free.targetId.slice(0, 6)}`)
    await occupyOtherWorker(blocked.targetId, blocked.accountId)
    for (let i = 0; i < 8; i += 1) {
      await queueRun(blocked.targetId, blocked.accountId, `积压-${blocked.targetId.slice(0, 6)}-${i}`)
    }
    const newer = await queueRun(free.targetId, free.accountId, `新-${free.targetId.slice(0, 6)}`)
    const grant = await claimRun(handle, {
      workerId: claimant.workerId,
      instanceId: claimant.instanceId,
      leaseTtlSeconds: 30,
    })
    const diag = takeLastClaimDiagnostics()
    expect(grant?.runId).toBe(newer.detail.id)
    expect(diag.scanned).toBeLessThanOrEqual(CLAIM_SCAN_LIMIT)
    expect(diag.excluded).toBeLessThanOrEqual(CLAIM_EXCLUDE_LIMIT)
    expect(diag.scanned).toBeLessThanOrEqual(2)
  })

  it('RJ-03 有在途 RUNNING 的目标排后，RECOVERING 仍优先', async () => {
    await cancelClaimable()
    const busy = await freshSlot('在途目标')
    const idle = await freshSlot('可领目标')
    const recoveringSlot = await freshSlot('恢复目标')
    const claimant = await readyWorker(`fair-${idle.targetId.slice(0, 6)}`)
    const busyQueued = await queueRun(busy.targetId, busy.accountId, `忙排队-${busy.targetId.slice(0, 6)}`)
    await forceGrantForRun(handle, busyQueued.detail.id, claimant.workerId)
    await queueRun(busy.targetId, busy.accountId, `忙更多-${busy.targetId.slice(0, 6)}`)
    const idleQueued = await queueRun(idle.targetId, idle.accountId, `闲-${idle.targetId.slice(0, 6)}`)
    const grant = await claimRun(handle, {
      workerId: claimant.workerId,
      instanceId: claimant.instanceId,
      leaseTtlSeconds: 30,
    })
    expect(grant?.runId).toBe(idleQueued.detail.id)

    const recovered = await queueRun(
      recoveringSlot.targetId,
      recoveringSlot.accountId,
      `恢复-${recoveringSlot.targetId.slice(0, 6)}`,
    )
    const { runs } = schemaFor(handle.db)
    const { eq } = await import('drizzle-orm')
    await handle.db.update(runs).set({ status: 'RECOVERING' }).where(eq(runs.id, recovered.detail.id))
    const later = await queueRun(idle.targetId, idle.accountId, `更晚闲-${idle.targetId.slice(0, 6)}`)
    const next = await claimRun(handle, {
      workerId: claimant.workerId,
      instanceId: claimant.instanceId,
      leaseTtlSeconds: 30,
    })
    expect(next?.runId).toBe(recovered.detail.id)
    expect(next?.runId).not.toBe(later.detail.id)
  })

  it('有界窗口续扫越过不可领队头，并在到达队尾后回绕', async () => {
    await cancelClaimable()
    const blocked = await freshSlot('续扫队头')
    const free = await freshSlot('续扫队尾')
    const claimant = await readyWorker(`cursor-${free.targetId.slice(0, 6)}`)
    const occupier = await occupyOtherWorker(blocked.targetId, blocked.accountId)
    const seed = await queueRun(blocked.targetId, blocked.accountId, '不可领种子')
    if (driver === 'postgres') {
      await handle.raw(`
        INSERT INTO cairn.runs (
          id, target_id, scenario_id, scenario_version_id, target_account_id,
          created_by_console_account_id, status, snapshot, snapshot_digest,
          context, created_at, updated_at
        )
        SELECT (
          substr(md5(g::text || seed.id::text), 1, 8) || '-' ||
          substr(md5(g::text || seed.id::text), 9, 4) || '-' ||
          '4' || substr(md5(g::text || seed.id::text), 14, 3) || '-' ||
          'a' || substr(md5(g::text || seed.id::text), 18, 3) || '-' ||
          substr(md5(g::text || seed.id::text), 21, 12)
        )::uuid, seed.target_id, seed.scenario_id, seed.scenario_version_id,
        seed.target_account_id, seed.created_by_console_account_id,
        seed.status, seed.snapshot, seed.snapshot_digest, seed.context,
        seed.created_at + g * interval '1 microsecond', seed.updated_at
        FROM cairn.runs seed CROSS JOIN generate_series(1, 999) g
        WHERE seed.id = $1
      `, [seed.detail.id])
    } else {
      for (let i = 0; i < CLAIM_SCAN_LIMIT + 1; i += 1) {
        await queueRun(blocked.targetId, blocked.accountId, `不可领-${i}`)
      }
    }
    const later = await queueRun(free.targetId, free.accountId, '可领队尾')
    let cursor: Parameters<typeof claimRunWithCursor>[1]['cursor']
    let grantId: string | undefined
    const startedAt = performance.now()
    for (let i = 0; i < (driver === 'postgres' ? 70 : 4) && !grantId; i += 1) {
      const claim = await claimRunWithCursor(handle, {
        workerId: claimant.workerId, instanceId: claimant.instanceId,
        leaseTtlSeconds: 30, cursor,
      })
      cursor = claim.cursor
      grantId = claim.grant?.runId
      expect(takeLastClaimDiagnostics().scanned).toBeLessThanOrEqual(CLAIM_SCAN_LIMIT)
      if (!grantId) expect(claim.reason).toBe('budget_exhausted')
    }
    expect(grantId).toBe(later.detail.id)
    if (driver === 'postgres') expect(performance.now() - startedAt).toBeLessThan(2_000)
    // The claim starts at the current tail. Crossing it resets the queued cursor.
    const wrap = await claimRunWithCursor(handle, {
      workerId: claimant.workerId, instanceId: claimant.instanceId,
      leaseTtlSeconds: 30, cursor,
    })
    expect(wrap.cursor.QUEUED).toBeNull()
    await closeWorkerSessions(handle.db, occupier.workerId)
    const revisited = await claimRunWithCursor(handle, {
      workerId: claimant.workerId, instanceId: claimant.instanceId,
      leaseTtlSeconds: 30, cursor: wrap.cursor,
    })
    expect(revisited.grant?.runId).toBe(seed.detail.id)
  })

  it('领取成功后重看窗口剩余 Run，可连续填满 Worker 的 8 个槽位', async () => {
    await cancelClaimable()
    const claimant = await readyWorker(`fill-${newId()}`)
    const ids: string[] = []
    for (let i = 0; i < 8; i += 1) {
      const slot = await freshSlot(`补位-${i}`)
      ids.push((await queueRun(slot.targetId, slot.accountId, `补位运行-${i}`)).detail.id)
    }
    let cursor: Parameters<typeof claimRunWithCursor>[1]['cursor']
    const claimed: string[] = []
    const startedAt = performance.now()
    for (let i = 0; i < 8; i += 1) {
      const result = await claimRunWithCursor(handle, {
        workerId: claimant.workerId, instanceId: claimant.instanceId,
        leaseTtlSeconds: 30, cursor,
      })
      cursor = result.cursor
      expect(result.reason).toBe('claimed')
      claimed.push(result.grant!.runId)
    }
    expect(claimed.sort()).toEqual(ids.sort())
    // The previous 1-second tick could claim only one Run per tick.
    expect(performance.now() - startedAt).toBeLessThan(2_667)
  })

  it('多个 Worker 竞争同一 Run 时只有一个 ACTIVE 领取', async () => {
    await cancelClaimable()
    const slot = await freshSlot('并发领取')
    const run = await queueRun(slot.targetId, slot.accountId, '唯一运行')
    const workers = await Promise.all(Array.from({ length: 4 }, (_, i) => readyWorker(`race-${i}-${newId()}`)))
    const claims = await Promise.all(workers.map((worker) => claimRunWithCursor(handle, {
      workerId: worker.workerId, instanceId: worker.instanceId, leaseTtlSeconds: 30,
    })))
    expect(claims.flatMap((claim) => claim.grant ? [claim.grant.runId] : [])).toEqual([run.detail.id])
  })

  it('Worker 自身会话容量已满时，排队目标不进扫描直接判空', async () => {
    await cancelClaimable()
    const claimant = await readyWorker(`cap-${newId().slice(0, 6)}`, 1)
    const held = await freshSlot('占满会话')
    const session = await requireCreatedSession(handle.db, {
      key: { targetId: held.targetId, targetAccountId: held.accountId },
      ownerWorkerId: claimant.workerId,
      ownerWorkerInstanceId: claimant.instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
      ownerWorkerId: claimant.workerId,
      ownerWorkerInstanceId: claimant.instanceId,
    })
    for (let i = 0; i < CLAIM_SCAN_LIMIT + 4; i += 1) {
      const slot = await freshSlot(`超额-${i}`)
      await queueRun(slot.targetId, slot.accountId, `超额跑-${i}-${slot.targetId.slice(0, 6)}`)
    }
    const grant = await claimRun(handle, {
      workerId: claimant.workerId,
      instanceId: claimant.instanceId,
      leaseTtlSeconds: 30,
    })
    const diag = takeLastClaimDiagnostics()
    expect(grant).toBeNull()
    // Worker 自身 maxSessions 已被 held 占满：claimRun 的候选 SQL 直接带上
    // COUNT(该 Worker 存活会话) < maxSessions 判断，容量已满时任何目标账号的排队
    // Run 都不会被选出，扫描在第一次取行就落空，不再逐行判定到 CLAIM_SCAN_LIMIT
    // 才止损。这比逐行扫描更高效，不再是扫描上界这条安全网覆盖的路径。
    expect(diag.scanned).toBe(0)
    expect(diag.excluded).toBe(0)
  })
})
