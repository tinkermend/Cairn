import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  readOverviewAnalytics,
  schemaFor,
  clockNow,
  newId,
  eq,
} from '../test-entry.js'

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
    const res = await readOverviewAnalytics(handle.db, { range: '7d' })
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
      targetId,
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
      targetId,
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
      targetId,
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

    const res = await readOverviewAnalytics(handle.db, { range: '24h' })
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
})
