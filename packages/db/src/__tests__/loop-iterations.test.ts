import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ScenarioAuthoringDocumentV2,
  type Step,
} from '@cairn/shared'
import { deterministicStepId } from '@cairn/authoring'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  finishIterationTx,
  formatScopePath,
  loadIterationDetail,
  loadRunDetail,
  loadRunIterations,
  loadRunStepStates,
  publishScenarioDraft,
  saveScenarioDraft,
  schemaFor,
  startIterationTx,
} from '../test-entry.js'
import { newId } from '../id.js'
import { eq } from 'drizzle-orm'

describe.each(DRIVERS)('%s 控制流 C 循环与迭代持久化（集成）', { timeout: 30_000 }, (driver) => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let actorId: string
  let targetId: string

  const initStepId = '00000000-0000-4000-8000-000000000080'
  const bodyStepId = '00000000-0000-4000-8000-000000000082'
  const blockId = '00000000-0000-4000-8000-000000000099'
  const loopHeaderId = deterministicStepId(blockId, 'loop')

  const initStep: Step = {
    id: initStepId,
    name: '生成列表',
    type: 'echo',
    effectType: 'READ_ONLY',
    outputKey: 'items',
    input: { value: ['a', 'b'] },
  }

  const bodyStep: Step = {
    id: bodyStepId,
    name: '打印单项',
    type: 'echo',
    effectType: 'READ_ONLY',
    input: { value: 'test' },
  }

  beforeAll(async () => {
    handle = await openContractDb(driver, `loop_${driver}`)
    actorId = newId()
    targetId = newId()
    const { consoleAccounts, targets } = schemaFor(handle.db)
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'loop_tester',
      email: `loop-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `loop-${targetId.slice(-6)}`,
      name: '循环测试目标',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function createLoopScenario(name: string) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name,
      steps: [initStep],
      actor: { id: actorId },
    })

    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: initStep,
        },
        {
          kind: 'block',
          blockId,
          name: '逐项处理',
          control: {
            type: 'for_each',
            over: { from: 'items' },
            as: 'item',
            indexAs: 'i',
            maxItems: 10,
          },
          body: [
            {
              kind: 'step',
              step: bodyStep,
            },
          ],
        },
      ],
    }

    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: doc,
      actor: { id: actorId },
    })

    await publishScenarioDraft(handle.db, scenario.id, {
      revision: 2,
      actor: { id: actorId },
    })

    return scenario
  }

  it('writeRunWithSnapshot 只初始化根作用域步骤，循环体步骤不预置', async () => {
    const scenario = await createLoopScenario('循环场景')

    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
      idempotencyKey: newId(),
    })

    const { stepRuns } = schemaFor(handle.db)
    const allStepRuns = await handle.db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.runId, run.detail.id))

    // 只有 2 个根步骤 (initStep 和 loopStep)，bodyStep 不应预创建
    expect(allStepRuns).toHaveLength(2)
    expect(allStepRuns.every((s) => s.scopePath === '')).toBe(true)
    expect(allStepRuns.map((s) => s.stepId)).toEqual([initStepId, loopHeaderId])

    // loadRunStepStates 默认返回根步骤
    const rootStates = await loadRunStepStates(handle.db, run.detail.id)
    expect(rootStates).toHaveLength(2)
    expect(rootStates.map((s) => s.stepId)).toEqual([initStepId, loopHeaderId])
  })

  it('startIterationTx 动态创建迭代记录与项内步骤，finishIterationTx 正常收尾', async () => {
    const scenario = await createLoopScenario('循环执行测试')

    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
      idempotencyKey: newId(),
    })

    const headerOrdinal = 1
    const iterationIndex = 0
    const expectedScope = formatScopePath(headerOrdinal, iterationIndex)
    expect(expectedScope).toBe('L1#0')

    const stepIndices = new Map([[bodyStepId, 2]])

    // 1. 启动迭代 0
    const startResult = await handle.db.transaction(async (tx) =>
      startIterationTx(tx as any, {
        runId: run.detail.id,
        blockId,
        headerStepId: loopHeaderId,
        headerOrdinal,
        iterationIndex: 0,
        item: 'a',
        frame: { i: 0, item: 'a' },
        bodySteps: [bodyStep],
        stepIndices,
      }),
    )

    expect(startResult.iteration.status).toBe('RUNNING')
    expect(startResult.iteration.scopePath).toBe('L1#0')
    expect(startResult.stepRuns).toHaveLength(1)
    expect(startResult.stepRuns[0]!.stepId).toBe(bodyStepId)
    expect(startResult.stepRuns[0]!.scopePath).toBe('L1#0')
    expect(startResult.stepRuns[0]!.status).toBe('PENDING')

    // 2. 查询该项作用域下的步骤状态
    const iterStepStates = await loadRunStepStates(handle.db, run.detail.id, 'L1#0')
    expect(iterStepStates).toHaveLength(1)
    expect(iterStepStates[0]!.stepId).toBe(bodyStepId)
    expect(iterStepStates[0]!.scopePath).toBe('L1#0')

    // 3. 幂等再次调用 startIterationTx
    const duplicate = await handle.db.transaction(async (tx) =>
      startIterationTx(tx as any, {
        runId: run.detail.id,
        blockId,
        headerStepId: loopHeaderId,
        headerOrdinal,
        iterationIndex: 0,
        item: 'a',
        frame: { i: 0, item: 'a' },
        bodySteps: [bodyStep],
        stepIndices,
      }),
    )
    expect(duplicate.alreadyStarted).toBe(true)
    expect(duplicate.iteration.id).toBe(startResult.iteration.id)

    // 4. 收尾迭代 0
    await handle.db.transaction(async (tx) =>
      finishIterationTx(tx as any, {
        iterationId: startResult.iteration.id,
        status: 'SUCCEEDED',
        frame: { i: 0, item: 'a', result: 'ok' },
        stopDecision: { matched: false },
      }),
    )

    // 5. 启动并收尾迭代 1
    const startResult1 = await handle.db.transaction(async (tx) =>
      startIterationTx(tx as any, {
        runId: run.detail.id,
        blockId,
        headerStepId: loopHeaderId,
        headerOrdinal,
        iterationIndex: 1,
        item: 'b',
        frame: { i: 1, item: 'b' },
        bodySteps: [bodyStep],
        stepIndices,
      }),
    )
    await handle.db.transaction(async (tx) =>
      finishIterationTx(tx as any, {
        iterationId: startResult1.iteration.id,
        status: 'SUCCEEDED',
        frame: { i: 1, item: 'b' },
        stopDecision: { matched: true, stoppedEarly: true },
      }),
    )

    // 6. loadRunIterations 列表查询
    const list = await loadRunIterations(handle.db, run.detail.id)
    expect(list.total).toBe(2)
    expect(list.iterations).toHaveLength(2)
    expect(list.iterations[0]!.iterationIndex).toBe(0)
    expect(list.iterations[1]!.iterationIndex).toBe(1)

    // 7. loadIterationDetail 单项详情
    const detail0 = await loadIterationDetail(handle.db, run.detail.id, startResult.iteration.id)
    expect(detail0).not.toBeNull()
    expect(detail0!.iteration.scopePath).toBe('L1#0')
    expect(detail0!.stepRuns).toHaveLength(1)
    expect(detail0!.stepRuns[0]!.stepId).toBe(bodyStepId)

    // 8. loadRunDetail 聚合 iterationsSummary
    const runDetail = await loadRunDetail(handle.db, run.detail.id)
    expect(runDetail).not.toBeNull()
    expect(runDetail!.stepRuns).toHaveLength(2) // 只有根步骤
    expect(runDetail!.iterationsSummary).toBeDefined()
    expect(runDetail!.iterationsSummary![blockId]).toEqual({
      blockId,
      kind: 'for_each',
      total: 2,
      succeeded: 2,
      failed: 0,
      skipped: 0,
      running: 0,
      stoppedEarly: true,
    })
  })
})
