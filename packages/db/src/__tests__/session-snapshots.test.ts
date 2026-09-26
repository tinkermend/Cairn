import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  claimSessionUse,
  clearSessionStateSnapshot,
  createRunWithSnapshot,
  createScenarioWithVersion,
  createSession,
  evaluateRunSessionEligibility,
  grantAdminScope,
  newId,
  openIsolatedDb,
  pruneSnapshotsExceedingCap,
  readSessionStateSnapshotContent,
  readSessionStateSnapshotSummary,
  releaseSessionUse,
  setSessionStatus,
  upsertSessionProfile,
  writeSessionStateSnapshot,
  type DbHandle,
} from '../test-entry.js'
import { consoleAccounts } from '../schema/console.js'
import { targets, targetAccounts } from '../schema/targets.js'
import { forceGrantForRun, seedWorker } from './lease-harness.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_snap`

describe('登录态快照与击剑存储 (session-snapshots.test)', { timeout: 60_000 }, () => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let targetAccountId: string
  let scenarioId: string
  let workerId: string
  let instanceId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    targetId = newId()
    targetAccountId = newId()

    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'snap-tester',
      email: `snap-${actorId}@example.com`,
      status: 'active',
    })
    await grantAdminScope(handle.db, actorId)

    await handle.db.insert(targets).values({
      id: targetId,
      code: 'tgt_snap',
      name: 'Snapshot Target',
      entryUrl: 'https://example.com',
      authMethod: 'password',
      status: 'active',
      sessionPolicy: { browserIsolation: 'SHARED' },
    })

    await handle.db.insert(targetAccounts).values({
      id: targetAccountId,
      targetId,
      displayName: 'testuser',
      username: 'testuser',
      status: 'active',
      maxConcurrentSessions: 1,
    })

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: 'Snapshot Scenario',
      steps: [
        {
          id: '00000000-0000-4000-8000-0000000000a1',
          name: '回显',
          type: 'echo',
          effectType: 'READ_ONLY',
          outputKey: 'out',
          input: { value: 'val' },
        },
      ],
      actor: { id: actorId },
    })
    scenarioId = scenario.id

    const seeded = await seedWorker(handle, 'worker-test-1')
    workerId = seeded.workerId
    instanceId = seeded.instanceId
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function createRunAndClaimSession() {
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId,
      targetAccountId,
      actor: { id: actorId },
    })
    const runGrant = await forceGrantForRun(handle, run.detail.id, workerId)
    const claimResult = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId },
      owner: { kind: 'RUN', runId: run.detail.id, runFencingToken: runGrant.fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: workerId,
      holderInstanceId: instanceId,
      leaseTtlSeconds: 60,
      reusePolicy: 'REUSE_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
      isolation: 'SHARED',
    })
    return { run, runGrant, claimResult }
  }

  let activeSessionId: string
  let activeSessionGen: number
  let activeSessionFence: number
  let activeLeaseId: string

  const stateData = {
    cookies: [{ name: 'auth_token', value: 'secret123', domain: 'example.com' }],
    origins: [{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 'xyz' }] }],
  }

  it('以活跃租约权限写入快照，并能读出摘要与全文', async () => {
    const { claimResult } = await createRunAndClaimSession()
    expect(claimResult.ok).toBe(true)
    if (!claimResult.ok) return

    const { session, grant } = claimResult
    activeSessionId = session.id
    activeSessionGen = session.generation
    activeSessionFence = grant.sessionFencingToken
    activeLeaseId = grant.leaseId

    // 确认状态为 OPEN
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
    })

    // 写入快照
    const writeResult = await writeSessionStateSnapshot(handle.db, {
      targetId,
      targetAccountId,
      accountSlot: 1,
      state: stateData,
      formatVersion: 1,
      cookieCount: 1,
      originCount: 1,
      hasIndexedDb: false,
      identity: 'testuser',
      sessionId: session.id,
      sessionGeneration: session.generation,
      sessionFencingToken: grant.sessionFencingToken,
      authority: { kind: 'lease', leaseId: grant.leaseId, workerId },
    })

    expect(writeResult.ok).toBe(true)
    if (!writeResult.ok) return
    expect(writeResult.action).toBe('written')
    expect(writeResult.byteSize).toBeGreaterThan(0)

    // 读取摘要（不含 state）
    const summary = await readSessionStateSnapshotSummary(handle.db, {
      targetId,
      targetAccountId,
      accountSlot: 1,
    })
    expect(summary.hasSnapshot).toBe(true)
    expect(summary.cookieCount).toBe(1)
    expect(summary.identity).toBe('testuser')
    expect(summary.stale).toBe(false)
    expect((summary as any).state).toBeUndefined()

    // 读取全文
    const content = await readSessionStateSnapshotContent(handle.db, {
      targetId,
      targetAccountId,
      accountSlot: 1,
    })
    expect(content).not.toBeNull()
    expect(content?.state).toEqual(stateData)
    expect(content?.sessionId).toBe(session.id)
  })

  it('内容不变时重复采集自动去重 (deduplicated)', async () => {
    const writeResult = await writeSessionStateSnapshot(handle.db, {
      targetId,
      targetAccountId,
      accountSlot: 1,
      state: stateData,
      sessionId: activeSessionId,
      sessionGeneration: activeSessionGen,
      sessionFencingToken: activeSessionFence,
      authority: { kind: 'lease', leaseId: activeLeaseId, workerId },
    })

    expect(writeResult.ok).toBe(true)
    if (writeResult.ok) {
      expect(writeResult.action).toBe('deduplicated')
    }
  })

  it('击剑保护：租约不匹配或已过期时拒绝写入 (stale_holder)', async () => {
    const badResult = await writeSessionStateSnapshot(handle.db, {
      targetId,
      targetAccountId,
      accountSlot: 1,
      state: { key: 'val' },
      sessionId: activeSessionId,
      sessionGeneration: activeSessionGen,
      sessionFencingToken: activeSessionFence,
      authority: { kind: 'lease', leaseId: newId(), workerId },
    })

    expect(badResult.ok).toBe(false)
    if (!badResult.ok) {
      expect(badResult.code).toBe('stale_holder')
    }
  })

  it('超过大小上限时拒绝写入 (too_large)', async () => {
    const hugeState = { largeData: 'a'.repeat(2500) }

    const writeResult = await writeSessionStateSnapshot(handle.db, {
      targetId,
      targetAccountId,
      accountSlot: 1,
      state: hugeState,
      sessionId: activeSessionId,
      sessionGeneration: activeSessionGen,
      sessionFencingToken: activeSessionFence,
      authority: { kind: 'lease', leaseId: activeLeaseId, workerId },
      maxByteSize: 1000, // 限制 1KB
    })

    expect(writeResult.ok).toBe(false)
    if (!writeResult.ok) {
      expect(writeResult.code).toBe('too_large')
    }
  })

  it('以会话所有者身份（无租约）正常关闭前采集', async () => {
    // 创建一个 OPEN 状态但无活跃租约的会话（使用 slot 2）
    const created = await createSession(handle.db, {
      key: { targetId, targetAccountId },
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
      accountSlot: 2,
      isolation: 'SHARED',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    await setSessionStatus(handle.db, {
      sessionId: created.session.id,
      expectedVersion: created.session.version,
      status: 'OPEN',
      ownerWorkerId: workerId,
    })

    const writeResult = await writeSessionStateSnapshot(handle.db, {
      targetId,
      targetAccountId,
      accountSlot: 2,
      state: { slot2: true },
      sessionId: created.session.id,
      sessionGeneration: created.session.generation,
      authority: { kind: 'owner', workerId, instanceId },
    })

    expect(writeResult.ok).toBe(true)
    if (writeResult.ok) {
      expect(writeResult.action).toBe('written')
    }
  })

  it('pruneSnapshotsExceedingCap 清理超过上限的快照槽位', async () => {
    const pruned = await pruneSnapshotsExceedingCap(handle.db, {
      targetId,
      targetAccountId,
      maxSlots: 1,
    })
    expect(pruned).toBe(1) // slot 2 was pruned

    const slot2Summary = await readSessionStateSnapshotSummary(handle.db, {
      targetId,
      targetAccountId,
      accountSlot: 2,
    })
    expect(slot2Summary.hasSnapshot).toBe(false)
  })

  it('清除登录态：置空快照、写墓碑并请求关闭活会话', async () => {
    const clearResult = await clearSessionStateSnapshot(handle.db, {
      targetId,
      targetAccountId,
    })
    expect(clearResult.clearedSlots).toBeGreaterThanOrEqual(1)

    const summary = await readSessionStateSnapshotSummary(handle.db, {
      targetId,
      targetAccountId,
      accountSlot: 1,
    })
    expect(summary.hasSnapshot).toBe(false)
    expect(summary.clearedAt).not.toBeNull()

    const content = await readSessionStateSnapshotContent(handle.db, {
      targetId,
      targetAccountId,
      accountSlot: 1,
    })
    expect(content).toBeNull()
  })

  it('SHARED 隔离模式下绕过 Profile 亲和与位置转移', async () => {
    const otherWorker = await seedWorker(handle, 'worker-other')
    const affAccountId = newId()
    await handle.db.insert(targetAccounts).values({
      id: affAccountId,
      targetId,
      displayName: 'affuser',
      username: 'affuser',
      status: 'active',
      maxConcurrentSessions: 1,
    })

    // 在 worker-test-1 上建一个本地 profile
    await upsertSessionProfile(handle.db, {
      key: { targetId, targetAccountId: affAccountId, accountSlot: 1 },
      workerId,
      revision: 1,
      state: 'PRESENT',
    })

    // 1. DEDICATED 模式下，otherWorker 受 Profile 亲和阻拦
    const dedicatedEligibility = await evaluateRunSessionEligibility(handle.db, {
      run: {
        id: newId(),
        createdAt: new Date(),
        targetId,
        targetAccountId: affAccountId,
        isolation: 'DEDICATED',
      },
      workerId: otherWorker.workerId,
      instanceId: otherWorker.instanceId,
      maxSessions: 10,
      scheduling: {
        maxExecutionWorkers: 5,
        targetConcurrencyLimit: 2,
        claimScanLimit: 10,
        workerRunCapacityBuffer: 1,
        profileAffinityWaitSeconds: 60,
        maintenanceLeaseTtlSeconds: 30,
        autoLoginBudgetPerHour: 10,
        autoLoginCooldownSeconds: 60,
        unattendedAuthTimeoutSeconds: 120,
      },
    })
    expect(dedicatedEligibility.eligible).toBe(false)
    expect(dedicatedEligibility.facts.waitReason).toBe('PROFILE_AFFINITY_WAIT')

    // 2. SHARED 模式下，绕过 profile affinity，允许调度
    const sharedEligibility = await evaluateRunSessionEligibility(handle.db, {
      run: {
        id: newId(),
        createdAt: new Date(),
        targetId,
        targetAccountId: affAccountId,
        isolation: 'SHARED',
      },
      workerId: otherWorker.workerId,
      instanceId: otherWorker.instanceId,
      maxSessions: 10,
      scheduling: {
        maxExecutionWorkers: 5,
        targetConcurrencyLimit: 2,
        claimScanLimit: 10,
        workerRunCapacityBuffer: 1,
        profileAffinityWaitSeconds: 60,
        maintenanceLeaseTtlSeconds: 30,
        autoLoginBudgetPerHour: 10,
        autoLoginCooldownSeconds: 60,
        unattendedAuthTimeoutSeconds: 120,
      },
    })
    expect(sharedEligibility.eligible).toBe(true)
    expect(sharedEligibility.facts.waitReason).toBeNull()
  })
})
