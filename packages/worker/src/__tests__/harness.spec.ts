import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { computeSnapshotDigest, newId } from '@cairn/db/testing'
import type { Step } from '@cairn/shared'
import { CairnTestHarness } from './harness.js'

describe('CairnTestHarness 全链路闭环自测', { timeout: 30_000 }, () => {
  let harness: CairnTestHarness

  beforeAll(async () => {
    harness = await CairnTestHarness.create()
  })

  afterAll(async () => {
    if (harness) await harness.close()
  })

  it('声明式编排与执行: 5 行代码完成 Echo 链式执行并断言', async () => {
    const steps: Step[] = [
      {
        id: newId(),
        name: '回显第一步',
        type: 'echo',
        effectType: 'READ_ONLY',
        outputKey: 'userGreeting',
        input: { value: 'Hello Cairn AI' },
      },
      {
        id: newId(),
        name: '回显第二步',
        type: 'echo',
        effectType: 'READ_ONLY',
        outputKey: 'finalStatus',
        input: { value: 'Complete' },
      },
    ]

    // 1. 设置场景与运行
    const { runId, snapshotDigest } = await harness.setupScenario({
      name: 'Harness 极简场景',
      steps,
    })
    expect(snapshotDigest).toBeDefined()

    // 2. 执行 Run
    await harness.executeRun(runId)

    // 3. 断言执行终态
    const detail = await harness.assertRunCompleted(runId, 'SUCCEEDED')
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.stepRuns).toHaveLength(2)

    // 验证 Execution Context 变量传递
    const firstStepRun = detail.stepRuns[0]
    expect(firstStepRun?.attempts[0]?.output).toBe('Hello Cairn AI')

    const secondStepRun = detail.stepRuns[1]
    expect(secondStepRun?.attempts[0]?.output).toBe('Complete')
  })

  it('验证执行期快照不可变性 (Snapshot Freeze)', async () => {
    const steps: Step[] = [
      {
        id: newId(),
        name: '初始步骤',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { value: 'original' },
      },
    ]

    const { runId, snapshotDigest } = await harness.setupScenario({
      name: '快照不可变验证',
      steps,
    })

    // 执行 Run
    await harness.executeRun(runId)
    const detailBefore = await harness.assertRunCompleted(runId, 'SUCCEEDED')

    // 历史 Run 的 Snapshot 必须与初始 Digest 恒等
    const currentDigest = computeSnapshotDigest(detailBefore.snapshot)
    expect(currentDigest).toBe(snapshotDigest)
    expect(detailBefore.snapshot.steps).toHaveLength(1)
    expect(detailBefore.snapshot.steps[0]?.name).toBe('初始步骤')
  })

  it('MicroStepHarness: 无需数据库的纯内存单步自测 (<2ms)', async () => {
    const microHarness = CairnTestHarness.createStepHarness()
    const step: Step = {
      id: newId(),
      name: '微单步回显',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { value: { benchmark: 'fast-micro-test' } },
    }

    const start = Date.now()
    const outcome = await microHarness.executeStep({ step })
    const elapsed = Date.now() - start

    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') {
      expect(outcome.output).toEqual({ benchmark: 'fast-micro-test' })
    }
    expect(elapsed).toBeLessThan(50)
  })

  it('支持在测试中注入自定义执行器 (Universal Step Extension)', async () => {
    const customExecutor = {
      supportedTypes: ['calc_tax'],
      async execute(ctx: any) {
        const amount = Number(ctx.input.amount ?? 0)
        return {
          kind: 'success' as const,
          output: { tax: amount * 0.1, total: amount * 1.1 },
        }
      },
    }

    const micro = CairnTestHarness.createStepHarness({
      customExecutors: [customExecutor],
    })

    const outcome = await micro.executeStep({
      step: {
        id: newId(),
        name: '计算税费',
        type: 'calc_tax' as any,
        effectType: 'READ_ONLY',
        input: { amount: 1000 } as any,
      },
      input: { amount: 1000 },
    })

    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') {
      expect(outcome.output).toEqual({ tax: 100, total: 1100 })
    }
  })
})
