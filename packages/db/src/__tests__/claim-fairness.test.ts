import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SESSION_OCCUPANCY_PROTOCOL, type Step } from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import {
  CLAIM_EXCLUDE_LIMIT,
  CLAIM_SCAN_LIMIT,
  claimRun,
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
    const other = await readyWorker(`occ-${accountId.slice(0, 6)}`)
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

  it('JS 仍不合格时单次领取扫描不超过上界', async () => {
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
    expect(diag.scanned).toBe(CLAIM_SCAN_LIMIT)
    expect(diag.excluded).toBeLessThanOrEqual(CLAIM_EXCLUDE_LIMIT)
  })
})
