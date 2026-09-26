import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { DRIVERS, grantAdminScope, openContractDb } from './contract-fixture.js'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { readTargetOverview } from '../console/target-overview.js'
import { createRunWithSnapshot, createScenarioWithVersion } from '../runs/index.js'

describe.each(DRIVERS)('%s 目标系统首屏聚合', { timeout: 60_000 }, (driver) => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let adminId: string
  let viewerId: string
  let sessionOnlyId: string
  let targetIds: string[]

  beforeAll(async () => {
    handle = await openContractDb(driver, 'target_overview')
    const { consoleAccounts, consoleRoles, consoleRolePermissions, consoleAccountRoles, targets, targetAccounts,
      browserSessions, runs } = schemaFor(handle.db)
    adminId = newId()
    viewerId = newId()
    sessionOnlyId = newId()
    await handle.db.insert(consoleAccounts).values([
      { id: adminId, displayName: '管理员', email: `${adminId}@test.invalid`, status: 'active' },
      { id: viewerId, displayName: '受限成员', email: `${viewerId}@test.invalid`, status: 'active' },
      { id: sessionOnlyId, displayName: '只读会话成员', email: `${sessionOnlyId}@test.invalid`, status: 'active' },
    ])
    await grantAdminScope(handle.db, adminId)
    targetIds = Array.from({ length: 22 }, () => newId())
    await handle.db.insert(targets).values(targetIds.map((id, index) => ({
      id, code: `overview-${index + 1}`, name: `目标${String(index + 1).padStart(2, '0')}`,
      entryUrl: 'https://example.com',
    })))
    const roleValues = [
      { key: 'target_reader', permission: 'target:read', mode: 'all' as const, ids: [] as string[] },
      { key: 'session_reader', permission: 'session:read', mode: 'selected' as const, ids: [targetIds[0]!] },
      { key: 'workflow_reader', permission: 'workflow:read', mode: 'selected' as const, ids: [targetIds[0]!] },
      { key: 'map_reader', permission: 'map:read', mode: 'selected' as const, ids: [targetIds[0]!] },
      { key: 'run_reader', permission: 'run:read', mode: 'all' as const, ids: [] as string[] },
    ]
    for (const role of roleValues) {
      const id = newId()
      await handle.db.insert(consoleRoles).values({ id, key: `${role.key}_${id}`, name: role.key, kind: 'custom' })
      await handle.db.insert(consoleRolePermissions).values({ consoleRoleId: id, permission: role.permission })
      await handle.db.insert(consoleAccountRoles).values({ consoleAccountId: viewerId, consoleRoleId: id,
        targetScopeMode: role.mode, targetScopeIds: role.ids })
      if (role.permission === 'target:read' || role.permission === 'session:read') {
        await handle.db.insert(consoleAccountRoles).values({ consoleAccountId: sessionOnlyId, consoleRoleId: id,
          targetScopeMode: role.mode, targetScopeIds: role.ids })
      }
    }
    const accountA = newId(), accountB = newId()
    await handle.db.insert(targetAccounts).values([
      { id: accountA, targetId: targetIds[0]!, displayName: '主业务账号', username: 'biz-a', status: 'active', usage: 'business' },
      { id: newId(), targetId: targetIds[0]!, displayName: '采集账号', username: 'map-a', status: 'active', usage: 'map' },
      { id: newId(), targetId: targetIds[0]!, displayName: '停用账号', username: 'off-a', status: 'disabled', usage: 'business' },
      { id: accountB, targetId: targetIds[1]!, displayName: '登录过期账号', username: 'biz-b', status: 'active', usage: 'business' },
    ])
    const now = new Date()
    await handle.db.insert(browserSessions).values([
      { id: newId(), targetId: targetIds[0]!, targetAccountId: accountA, status: 'OPEN', health: 'HEALTHY',
        authState: 'AUTHENTICATED', ownerWorkerId: 'worker-overview', generation: 1, profileKey: `p-${accountA}`,
        reusePolicy: 'NEW_PAGE', idleTtlSeconds: 600, maxLifetimeSeconds: 3600,
        expiresAt: new Date(now.getTime() + 3_600_000), lastAuthGeneration: 1 },
      { id: newId(), targetId: targetIds[1]!, targetAccountId: accountB, status: 'OPEN', health: 'HEALTHY',
        authState: 'EXPIRED', ownerWorkerId: 'worker-overview', generation: 1, profileKey: `p-${accountB}`,
        reusePolicy: 'NEW_PAGE', idleTtlSeconds: 600, maxLifetimeSeconds: 3600,
        expiresAt: new Date(now.getTime() + 3_600_000) },
    ])
    for (const targetId of targetIds.slice(0, 2)) {
      const scenario = await createScenarioWithVersion(handle.db, {
        targetId, name: `业务场景-${targetId.slice(0, 5)}`, actor: { id: adminId },
        steps: [{ id: newId(), name: '回声', type: 'echo', effectType: 'READ_ONLY', input: { value: 'ok' } }],
      })
      const run = await createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: { id: adminId } })
      await handle.db.update(runs).set({ status: 'RUNNING', startedAt: now }).where(eq(runs.id, run.detail.id))
    }
  })

  afterAll(async () => { await handle?.close() })

  it('顶部跨 20+ 系统准确统计，筛选不改变概览，账号分母只计启用业务账号', async () => {
    const all = await readTargetOverview(handle.db, {}, adminId)
    expect(all.summary.totalTargets).toBe(22)
    expect(all.filteredTotal).toBe(22)
    expect(all.summary.readyTargets).toMatchObject({ value: 1, coverage: 'complete', coveredTargets: 22 })
    expect(all.summary.needLoginTargets.value).toBe(1)
    expect(all.summary.runningTargets.value).toBe(2)
    const first = all.items.find((item) => item.target.id === targetIds[0])!
    expect(first.accounts).toMatchObject({ state: 'available', value: {
      configuredTotal: 3, eligibleBusinessTotal: 1, readyAccounts: 1,
    } })
    expect(first.readiness).toMatchObject({ state: 'available', value: { nextAction: { kind: 'manage_sessions' } } })
    expect(first.activities.state).toBe('available')
    expect(first.knowledge).toEqual({ state: 'available' })
    if (first.activities.state === 'available') expect(first.activities.value.items[0]?.source).toBe('run')
    const filtered = await readTargetOverview(handle.db, { filter: 'ready', search: '主业务账号' }, adminId)
    expect(filtered.filteredTotal).toBe(1)
    expect(filtered.items[0]?.target.id).toBe(targetIds[0])
    expect(filtered.summary.totalTargets).toBe(22)
  })

  it('逐领域目标范围隔离，受限系统值为 forbidden 而非 0', async () => {
    const overview = await readTargetOverview(handle.db, {}, viewerId)
    expect(overview.summary.totalTargets).toBe(22)
    expect(overview.summary.readyTargets).toMatchObject({ value: 1, coverage: 'partial', coveredTargets: 1 })
    expect(overview.summary.needLoginTargets).toMatchObject({ value: 0, coverage: 'partial', coveredTargets: 1 })
    expect(overview.summary.runningTargets).toMatchObject({ value: 2, coverage: 'complete', coveredTargets: 22 })
    const b = overview.items.find((item) => item.target.id === targetIds[1])!
    expect(b.accounts).toEqual({ state: 'forbidden' })
    expect(b.readiness).toEqual({ state: 'forbidden' })
    expect(b.scenarios).toEqual({ state: 'forbidden' })
    expect(b.knowledge).toEqual({ state: 'forbidden' })
    expect(b.runs).toMatchObject({ state: 'available', value: { running: 1 } })
    expect((await readTargetOverview(handle.db, { filter: 'need_login' }, viewerId)).filteredTotal).toBe(0)
    expect((await readTargetOverview(handle.db, { targetId: targetIds[0] }, viewerId)).filteredTotal).toBe(1)
  })

  it('关联场景超过 100 条仍返回精确总数，排除内部地图场景', async () => {
    const { scenarios } = schemaFor(handle.db)
    await handle.db.insert(scenarios).values([
      ...Array.from({ length: 101 }, (_, index) => ({
        id: newId(), targetId: targetIds[0]!, name: `额外业务场景-${index}`,
        status: index === 100 ? 'disabled' as const : 'active' as const,
        purpose: 'user' as const, createdByConsoleAccountId: adminId,
      })),
      { id: newId(), targetId: targetIds[0]!, name: '内部地图场景', status: 'active' as const,
        purpose: 'map_job' as const, createdByConsoleAccountId: adminId },
    ])
    const overview = await readTargetOverview(handle.db, { targetId: targetIds[0] }, adminId)
    expect(overview.items).toHaveLength(1)
    expect(overview.items[0]?.scenarios).toMatchObject({ state: 'available', value: { total: 102, active: 101 } })
  })

  it('最近活动只读持久化事实，缺少 run:read 时不暴露关联 Run ID', async () => {
    const { runs, runEvents, sessionEvents, targetAccounts } = schemaFor(handle.db)
    const [run] = await handle.db.select({ id: runs.id }).from(runs).where(eq(runs.targetId, targetIds[0]!))
    const [account] = await handle.db.select({ id: targetAccounts.id }).from(targetAccounts)
      .where(eq(targetAccounts.targetId, targetIds[0]!))
    expect(run).toBeDefined()
    expect(account).toBeDefined()
    const finishedAt = new Date(Date.now() + 1000)
    await handle.db.insert(sessionEvents).values({
      id: newId(), seq: 1, targetId: targetIds[0]!, targetAccountId: account!.id,
      runId: run!.id, type: 'operation.waiting_for_auth', createdAt: finishedAt,
    })
    const sessionOnly = await readTargetOverview(handle.db, { targetId: targetIds[0] }, sessionOnlyId)
    expect(sessionOnly.items[0]?.readiness).toMatchObject({ state: 'available', value: { nextAction: { kind: 'view_sessions' } } })
    const activity = sessionOnly.items[0]?.activities
    expect(activity?.state).toBe('available')
    if (activity?.state === 'available') {
      expect(activity.value.sources).toEqual(['session'])
      expect(activity.value.items[0]).toMatchObject({ source: 'session', kind: 'auth_wait' })
      expect(activity.value.items[0]).not.toHaveProperty('runId')
    }

    await handle.db.delete(runEvents).where(eq(runEvents.runId, run!.id))
    await handle.db.update(runs).set({ status: 'SUCCEEDED', finishedAt }).where(eq(runs.id, run!.id))
    const admin = await readTargetOverview(handle.db, { targetId: targetIds[0] }, adminId)
    const recovered = admin.items[0]?.activities
    expect(recovered?.state).toBe('available')
    if (recovered?.state === 'available') {
      expect(recovered.value.items.some((item) => item.source === 'run' && item.kind === 'run_finished' && item.runId === run!.id)).toBe(true)
    }
  })

  it('同系统可同时空闲已登录和需要登录，主操作优先处理异常账号', async () => {
    const { targetAccounts, browserSessions } = schemaFor(handle.db)
    const readyAccountId = newId(), expiredAccountId = newId()
    const targetId = targetIds[2]!
    const now = new Date()
    await handle.db.insert(targetAccounts).values([
      { id: readyAccountId, targetId, displayName: '可用业务账号', username: 'ready', status: 'active', usage: 'business' },
      { id: expiredAccountId, targetId, displayName: '待重新登录账号', username: 'expired', status: 'active', usage: 'business' },
    ])
    await handle.db.insert(browserSessions).values([
      { id: newId(), targetId, targetAccountId: readyAccountId, status: 'OPEN', health: 'HEALTHY',
        authState: 'AUTHENTICATED', ownerWorkerId: 'worker-overview', generation: 1,
        profileKey: `p-${readyAccountId}`, reusePolicy: 'NEW_PAGE', idleTtlSeconds: 600,
        maxLifetimeSeconds: 3600, expiresAt: new Date(now.getTime() + 3_600_000), lastAuthGeneration: 1 },
      { id: newId(), targetId, targetAccountId: expiredAccountId, status: 'OPEN', health: 'HEALTHY',
        authState: 'EXPIRED', ownerWorkerId: 'worker-overview', generation: 1,
        profileKey: `p-${expiredAccountId}`, reusePolicy: 'NEW_PAGE', idleTtlSeconds: 600,
        maxLifetimeSeconds: 3600, expiresAt: new Date(now.getTime() + 3_600_000) },
    ])
    const all = await readTargetOverview(handle.db, {}, adminId)
    expect(all.summary.readyTargets.value).toBe(2)
    expect(all.summary.needLoginTargets.value).toBe(2)
    const item = all.items.find((candidate) => candidate.target.id === targetId)!
    expect(item.readiness).toMatchObject({ state: 'available', value: {
      state: 'ready', nextAction: { kind: 'handle_login', targetAccountId: expiredAccountId },
    } })
    expect(item.accounts).toMatchObject({ state: 'available', value: {
      eligibleBusinessTotal: 2, readyAccounts: 1, needLoginAccounts: 1,
    } })
    expect((await readTargetOverview(handle.db, { filter: 'ready' }, adminId)).items.some((candidate) => candidate.target.id === targetId)).toBe(true)
    expect((await readTargetOverview(handle.db, { filter: 'need_login' }, adminId)).items.some((candidate) => candidate.target.id === targetId)).toBe(true)
  })

  it('快照标识仅随可见结果变化，不受刷新、等价查询或账号登录名影响', async () => {
    const { targets, targetAccounts } = schemaFor(handle.db)
    const targetId = targetIds[0]!
    const first = await readTargetOverview(handle.db, { targetId }, adminId)
    const refreshed = await readTargetOverview(handle.db, { targetId, search: '目标01', sort: 'name' }, adminId)
    expect(refreshed.snapshotToken).toBe(first.snapshotToken)
    expect(refreshed.summary).toEqual(first.summary)
    expect(refreshed.items).toEqual(first.items)

    await handle.db.update(targetAccounts).set({ username: 'biz-a-updated' })
      .where(eq(targetAccounts.displayName, '主业务账号'))
    const credentialOnlyChange = await readTargetOverview(handle.db, { targetId }, adminId)
    expect(credentialOnlyChange.snapshotToken).toBe(first.snapshotToken)

    await handle.db.update(targets).set({ name: '目标01（已更新）' }).where(eq(targets.id, targetId))
    const visibleChange = await readTargetOverview(handle.db, { targetId }, adminId)
    expect(visibleChange.snapshotToken).not.toBe(first.snapshotToken)
  })

  it('当前认证规则有修订时，缺失或过旧的会话修订须核验，不计入空闲已登录', async () => {
    const { targets, targetAccounts, browserSessions } = schemaFor(handle.db)
    const targetId = targetIds[3]!
    const accountId = newId(), sessionId = newId()
    const baseline = await readTargetOverview(handle.db, {}, adminId)
    await handle.db.update(targets).set({ currentAuthProfileRevision: 2 }).where(eq(targets.id, targetId))
    await handle.db.insert(targetAccounts).values({
      id: accountId, targetId, displayName: '规则版本待核验', username: 'revision-check',
      status: 'active', usage: 'business',
    })
    await handle.db.insert(browserSessions).values({
      id: sessionId, targetId, targetAccountId: accountId, status: 'OPEN', health: 'HEALTHY',
      authState: 'AUTHENTICATED', ownerWorkerId: 'worker-overview', generation: 1,
      profileKey: `p-${accountId}`, reusePolicy: 'NEW_PAGE', idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600, expiresAt: new Date(Date.now() + 3_600_000),
      lastAuthGeneration: 1, authProfileRevision: null,
    })

    const assertNeedsCheck = async () => {
      const overview = await readTargetOverview(handle.db, { targetId }, adminId)
      expect(overview.summary.readyTargets.value).toBe(baseline.summary.readyTargets.value)
      expect(overview.items[0]?.readiness).toMatchObject({ state: 'available', value: {
        state: 'needs_check', nextAction: { kind: 'check_login', targetAccountId: accountId },
      } })
      expect(overview.items[0]?.accounts).toMatchObject({ state: 'available', value: {
        readyAccounts: 0, needsCheckAccounts: 1,
      } })
    }
    await assertNeedsCheck()
    await handle.db.update(browserSessions).set({ authProfileRevision: 1 }).where(eq(browserSessions.id, sessionId))
    await assertNeedsCheck()

    await handle.db.update(browserSessions).set({ authProfileRevision: 2 }).where(eq(browserSessions.id, sessionId))
    const verified = await readTargetOverview(handle.db, { targetId }, adminId)
    expect(verified.summary.readyTargets.value).toBe((baseline.summary.readyTargets.value ?? 0) + 1)
    expect(verified.items[0]?.readiness).toMatchObject({ state: 'available', value: { state: 'ready' } })
  })
})
