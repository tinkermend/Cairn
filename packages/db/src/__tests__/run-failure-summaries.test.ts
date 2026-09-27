import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  eq,
  loadRunFailureSummaries,
  schemaFor,
} from '../test-entry.js'
import { newId } from '../id.js'

const step1: Step = {
  id: '00000000-0000-4000-8000-000000000071',
  name: '步骤一',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: '1' },
}

const step2: Step = {
  id: '00000000-0000-4000-8000-000000000072',
  name: '步骤二',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: '2' },
}

describe.each(DRIVERS)('%s 运行失败提取 loadRunFailureSummaries', { timeout: 30_000 }, (driver) => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `fail_sum_${driver}`)
    actorId = newId()
    targetId = newId()
    const { consoleAccounts, targets } = schemaFor(handle.db)
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'tester',
      email: `fail-summary-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `fail-${driver}-${actorId.slice(0, 8)}`,
      name: 'Test Target',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('空 runIds 数组返回空列表', async () => {
    const res = await loadRunFailureSummaries(handle.db, [])
    expect(res).toEqual([])
  })

  it('批量提取包含步骤失败和取消原因的运行', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '失败摘要测试场景',
      steps: [step1, step2],
      actor: { id: actorId },
    })

    // 运行 1: 第二步失败
    const run1 = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })

    const { runs, stepRuns, attempts } = schemaFor(handle.db)
    const stepRun = run1.detail.stepRuns.find((s) => s.stepId === step2.id)!
    await handle.db
      .update(stepRuns)
      .set({ status: 'FAILED' })
      .where(eq(stepRuns.id, stepRun.id))

    await handle.db.insert(attempts).values({
      id: newId(),
      stepRunId: stepRun.id,
      attemptNo: 1,
      status: 'FAILED',
      startedAt: new Date(),
      finishedAt: new Date(),
      error: {
        code: 'ELEMENT_NOT_FOUND',
        category: 'LOCATOR',
        safeMessage: '未找到指定元素 #submit-btn',
        message: 'Timeout 5000ms waiting for #submit-btn',
      },
    })

    // 运行 2: 未执行步骤即取消
    const run2 = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    await handle.db
      .update(runs)
      .set({ status: 'FAILED', cancelReason: '环境配置缺失无法启动' })
      .where(eq(runs.id, run2.detail.id))

    const summaries = await loadRunFailureSummaries(handle.db, [run1.detail.id, run2.detail.id])
    expect(summaries).toHaveLength(2)

    const sum1 = summaries.find((s) => s.runId === run1.detail.id)
    expect(sum1).toBeDefined()
    expect(sum1?.stepId).toBe(step2.id)
    expect(sum1?.stepName).toBe(step2.name)
    expect(sum1?.errorCode).toBe('ELEMENT_NOT_FOUND')
    expect(sum1?.errorCategory).toBe('LOCATOR')
    expect(sum1?.errorSafeMessage).toBe('未找到指定元素 #submit-btn')

    const sum2 = summaries.find((s) => s.runId === run2.detail.id)
    expect(sum2).toBeDefined()
    expect(sum2?.stepId).toBeUndefined()
    expect(sum2?.cancelReason).toBe('环境配置缺失无法启动')
  })
})
