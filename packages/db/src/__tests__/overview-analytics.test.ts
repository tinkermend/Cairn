import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { runReadScope } from '../console/target-authorization.js'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  readOverviewAnalytics,
  schemaFor,
  clockNow,
  newId,
  eq,
} from '../test-entry.js'

const fleetScope = { all: true, ids: [] as string[] }

const testStep: Step = {
  id: '00000000-0000-4000-8000-000000000099',
  name: '测试步骤',
  type: 'echo',
  effectType: 'READ_ONLY',
  outputKey: 'test',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s 总览多维分析聚合', { timeout: 30_000 }, (driver) => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `overview_${driver}`)
    actorId = newId()
    targetId = newId()
    const { consoleAccounts, targets } = schemaFor(handle.db)

    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'Analytics Tester',
      email: `analytics-${actorId}@example.com`,
      status: 'active',
    })

    await handle.db.insert(targets).values({
      id: targetId,
      code: `target-${driver}-${actorId.slice(0, 6)}`,
      name: '分析目标系统',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('空数据下返回合规的 0 值与连续时序桶', async () => {
    const res = await readOverviewAnalytics(handle.db, { range: '7d' }, fleetScope)
    expect(res.range).toBe('7d')
    expect(res.summary.totalRuns).toBe(0)
    expect(res.summary.succeededRuns).toBe(0)
    expect(res.summary.successRate).toBe(1.0)
    expect(res.summary.runsDeltaPercentage).toBeNull()
    expect(res.timeline.length).toBeGreaterThanOrEqual(7)
    expect(res.topScenarios).toEqual([])
    expect(res.troubledScenarios).toEqual([])
  })

  it('存在不同状态与成果的运行记录时，精确聚合各项指标', async () => {
    const { runs } = schemaFor(handle.db)

    // 创建测试场景
    const scenarioA = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `场景A-${newId().slice(0, 6)}`,
      steps: [testStep],
      actor: { id: actorId },
    })

    const scenarioB = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `场景B-${newId().slice(0, 6)}`,
      steps: [testStep],
      actor: { id: actorId },
    })

    // 创建运行记录
    const now = await clockNow(handle.db)
    const run1 = await createRunWithSnapshot(handle.db, {
      scenarioId: scenarioA.id,
      scenarioVersionId: scenarioA.versionId,
      actor: { id: actorId },
    })

    // 将 run1 标记为成功，并填写 startedAt / finishedAt
    await handle.db
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        outcomeStatus: 'PASS',
        startedAt: new Date(now.getTime() - 10_000),
        finishedAt: now,
      })
      .where(eq(runs.id, run1.detail.id))

    // 创建 run2（失败）
    const run2 = await createRunWithSnapshot(handle.db, {
      scenarioId: scenarioA.id,
      scenarioVersionId: scenarioA.versionId,
      actor: { id: actorId },
    })

    await handle.db
      .update(runs)
      .set({
        status: 'FAILED',
        outcomeStatus: 'WARN',
        startedAt: new Date(now.getTime() - 8_000),
        finishedAt: now,
      })
      .where(eq(runs.id, run2.detail.id))

    // 创建 run3（场景B，成功）
    const run3 = await createRunWithSnapshot(handle.db, {
      scenarioId: scenarioB.id,
      scenarioVersionId: scenarioB.versionId,
      actor: { id: actorId },
    })

    await handle.db
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        outcomeStatus: 'PASS',
        startedAt: new Date(now.getTime() - 5_000),
        finishedAt: now,
      })
      .where(eq(runs.id, run3.detail.id))

    const res = await readOverviewAnalytics(handle.db, { range: '24h' }, fleetScope)
    expect(res.range).toBe('24h')
    expect(res.summary.totalRuns).toBeGreaterThanOrEqual(3)
    expect(res.summary.succeededRuns).toBeGreaterThanOrEqual(2)
    expect(res.summary.failedRuns).toBeGreaterThanOrEqual(1)
    expect(res.outcomes.passed).toBeGreaterThanOrEqual(2)
    expect(res.outcomes.violation).toBeGreaterThanOrEqual(1)
    expect(res.timeline.length).toBeGreaterThanOrEqual(24)

    // 排行榜
    expect(res.topScenarios.length).toBeGreaterThanOrEqual(1)
    const topA = res.topScenarios.find((s) => s.scenarioId === scenarioA.id)
    expect(topA).toBeDefined()
    expect(topA?.runCount).toBeGreaterThanOrEqual(2)
    expect(topA?.targetName).toBe('分析目标系统')

    const troubledA = res.troubledScenarios.find((s) => s.scenarioId === scenarioA.id)
    expect(troubledA).toBeDefined()
    expect(troubledA?.failCount).toBeGreaterThanOrEqual(1)
  })

  it('省略 targetId 时只聚合 target:read 与 run:read 的交集', async () => {
    const visibleTarget = newId()
    const hiddenTarget = newId()
    const { consoleAccounts, targets, consoleRoles, consoleRolePermissions, consoleAccountRoles } = schemaFor(handle.db)

    async function account(name: string) {
      const id = newId()
      await handle.db.insert(consoleAccounts).values({
        id,
        displayName: name,
        email: `${name}-${id}@example.com`,
        status: 'active',
      })
      return id
    }

    async function grant(accountId: string, permission: string, mode: 'selected' | 'all', ids: string[]) {
      const roleId = newId()
      await handle.db.insert(consoleRoles).values({ id: roleId, key: `overview-${roleId}`, name: permission })
      await handle.db.insert(consoleRolePermissions).values({ consoleRoleId: roleId, permission })
      await handle.db.insert(consoleAccountRoles).values({
        consoleAccountId: accountId,
        consoleRoleId: roleId,
        targetScopeMode: mode,
        targetScopeIds: ids,
      })
    }

    await handle.db.insert(targets).values([
      { id: visibleTarget, code: `visible-${visibleTarget.slice(0, 8)}`, name: '可见目标', entryUrl: 'https://visible.example' },
      { id: hiddenTarget, code: `hidden-${hiddenTarget.slice(0, 8)}`, name: '隐藏目标', entryUrl: 'https://hidden.example' },
    ])
    const before = await readOverviewAnalytics(handle.db, { range: '24h' }, fleetScope)

    const visibleScenario = await createScenarioWithVersion(handle.db, {
      targetId: visibleTarget,
      name: `可见场景-${visibleTarget.slice(0, 8)}`,
      steps: [testStep],
      actor: { id: actorId },
    })
    const hiddenScenario = await createScenarioWithVersion(handle.db, {
      targetId: hiddenTarget,
      name: `隐藏场景-${hiddenTarget.slice(0, 8)}`,
      steps: [testStep],
      actor: { id: actorId },
    })
    await createRunWithSnapshot(handle.db, {
      scenarioId: visibleScenario.id,
      scenarioVersionId: visibleScenario.versionId,
      actor: { id: actorId },
    })
    await createRunWithSnapshot(handle.db, {
      scenarioId: hiddenScenario.id,
      scenarioVersionId: hiddenScenario.versionId,
      actor: { id: actorId },
    })

    const reader = await account('reader')
    await grant(reader, 'target:read', 'selected', [visibleTarget])
    await grant(reader, 'run:read', 'selected', [visibleTarget, hiddenTarget])
    const scope = await runReadScope(handle.db, reader)
    expect(scope.all).toBe(false)
    expect([...scope.ids].sort()).toEqual([visibleTarget].sort())

    const scoped = await readOverviewAnalytics(handle.db, { range: '24h' }, scope)
    expect(scoped.summary.totalRuns).toBe(1)
    expect(scoped.topScenarios.map((item) => item.scenarioId)).toEqual([visibleScenario.id])
    expect(JSON.stringify(scoped)).not.toContain(hiddenTarget)
    expect(JSON.stringify(scoped)).not.toContain(hiddenScenario.id)

    const peeked = await readOverviewAnalytics(handle.db, { range: '24h', targetId: hiddenTarget }, scope)
    expect(peeked.summary.totalRuns).toBe(0)
    expect(peeked.topScenarios).toEqual([])

    const stranger = await account('stranger')
    const empty = await runReadScope(handle.db, stranger)
    expect(empty).toEqual({ all: false, ids: [] })
    const none = await readOverviewAnalytics(handle.db, { range: '24h' }, empty)
    expect(none.summary.totalRuns).toBe(0)
    expect(none.topScenarios).toEqual([])

    const fleet = await readOverviewAnalytics(handle.db, { range: '24h' }, fleetScope)
    expect(fleet.summary.totalRuns).toBe(before.summary.totalRuns + 2)
    expect(JSON.stringify(fleet)).toContain(hiddenScenario.id)
  })
})
