import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  and,
  claimRun,
  consoleAccounts,
  consoleRoles,
  consoleAccountRoles,
  createRunWithSnapshot,
  createScenarioWithVersion,
  eq,
  getRun,
  loadIterationDetail,
  loadLoopFrozenItems,
  loadRunIterations,
  loadRunStepStates,
  newId,
  openIsolatedDb,
  publishScenarioDraft,
  registerWorker,
  saveScenarioDraft,
  schemaFor,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import {
  type ScenarioAuthoringDocumentV2,
  type Step,
} from '@cairn/shared'
import { WORKER_TEST_PROTOCOLS } from '../__tests__/worker-protocols.js'
import { ExecutionEngine } from './engine.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_loop`

describe('ExecutionEngine Control Flow C 循环执行与迭代（集成）', { timeout: 45_000 }, () => {
  let handle: DbHandle
  let engine: ExecutionEngine
  let actorId: string
  let targetId: string
  let workerId: string
  let workerInstanceId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    engine = new ExecutionEngine(handle)
    actorId = newId()
    targetId = newId()

    const { consoleAccounts: ca, consoleRoles: cr, consoleAccountRoles: car, targets: tg } = schemaFor(handle.db)
    await handle.db.insert(ca).values({
      id: actorId,
      displayName: 'loop-engine-tester',
      email: `loop-${actorId}@example.com`,
      status: 'active',
    })
    const [admin] = await handle.db.select().from(cr).where(eq(cr.key, 'admin'))
    if (admin) {
      await handle.db.insert(car).values({
        consoleAccountId: actorId,
        consoleRoleId: admin.id,
        targetScopeMode: 'all',
      })
    }
    await handle.db.insert(tg).values({
      id: targetId,
      code: `loop-${SCHEMA.slice(-8)}`,
      name: '循环执行测试目标',
      entryUrl: 'https://example.com',
    })
    workerId = `loop-worker-${SCHEMA.slice(-8)}`
    workerInstanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 8,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

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

  async function claimThis(runId: string) {
    await cancelOtherClaimable(runId)
    const grant = await claimRun(handle, {
      workerId,
      instanceId: workerInstanceId,
      leaseTtlSeconds: 30,
    })
    expect(grant?.runId).toBe(runId)
    return grant!
  }

  async function createPublishAndRun(
    name: string,
    doc: ScenarioAuthoringDocumentV2,
    initialInput?: Record<string, any>,
    options?: { evidencePolicy?: any },
  ) {
    const dummyInitStep: Step = {
      id: newId(),
      name: '初始化',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { value: 'init' },
    }
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name,
      steps: [dummyInitStep],
      actor: { id: actorId },
    })

    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: doc,
      actor: { id: actorId },
    })

    let published
    try {
      published = await publishScenarioDraft(handle.db, scenario.id, {
        revision: 2,
        actor: { id: actorId },
      })
    } catch (err: any) {
      console.error('PUBLISH FAILED:', JSON.stringify(err.details ?? err, null, 2))
      throw err
    }

    const runResult = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      scenarioVersionId: published.published!.versionId,
      input: initialInput,
      evidencePolicy: options?.evidencePolicy,
      actor: { id: actorId },
      idempotencyKey: newId(),
    })

    const runId = runResult.detail.id
    const grant = await claimThis(runId)
    await engine.execute(runId, { grant })

    return {
      run: await getRun(handle.db, runId),
      runId,
    }
  }

  // CFC-02: 逐项处理 5 项
  it('CFC-02: for_each 5 项依次推进，scope_path 隔离且汇集结果有序一致', async () => {
    const initStepId = newId()
    const blockId = newId()
    const bodyStepId = newId()

    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: {
            id: initStepId,
            name: '准备列表',
            type: 'echo',
            effectType: 'READ_ONLY',
            outputKey: 'rawList',
            input: { value: ['item-1', 'item-2', 'item-3', 'item-4', 'item-5'] },
          },
        },
        {
          kind: 'block',
          blockId,
          name: '逐项迭代',
          control: {
            type: 'for_each',
            over: { from: 'rawList' },
            as: 'curr',
            indexAs: 'i',
            maxItems: 10,
          },
          body: [
            {
              kind: 'step',
              step: {
                id: bodyStepId,
                name: '处理单项',
                type: 'echo',
                effectType: 'READ_ONLY',
                outputKey: 'outVal',
                input: { from: 'curr' },
              },
            },
          ],
          collect: [{ from: 'outVal', into: 'collectedItems' }],
        },
      ],
    }

    const { run, runId } = await createPublishAndRun('CFC-02-5-items', doc)

    expect(run.status).toBe('SUCCEEDED')
    expect(run.context.collectedItems).toEqual([
      'item-1',
      'item-2',
      'item-3',
      'item-4',
      'item-5',
    ])

    const { iterations } = await loadRunIterations(handle.db, runId, { blockId })
    expect(iterations).toHaveLength(5)
    expect(iterations.every((it) => it.status === 'SUCCEEDED')).toBe(true)

    for (let i = 0; i < 5; i++) {
      const iter = iterations.find((it) => it.iterationIndex === i)!
      expect(iter).toBeDefined()
      expect(iter.item).toBe(`item-${i + 1}`)
      expect(iter.scopePath).toBe(`L2#${i}`)

      const detail = await loadIterationDetail(handle.db, runId, iter.id)
      expect(detail).toBeDefined()
      expect(detail?.stepRuns).toHaveLength(1)
      expect(detail?.stepRuns[0]?.scopePath).toBe(`L2#${i}`)
      expect(detail?.stepRuns[0]?.status).toBe('SUCCEEDED')
      expect(detail?.stepRuns[0]?.attempts[0]?.output).toBe(`item-${i + 1}`)
    }
  })

  // CFC-03: 空集合
  it('CFC-03: 空集合直接令循环头 SUCCEEDED，汇集初始化为 []', async () => {
    const initStepId = newId()
    const blockId = newId()
    const bodyStepId = newId()

    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: {
            id: initStepId,
            name: '准备空列表',
            type: 'echo',
            effectType: 'READ_ONLY',
            outputKey: 'emptyList',
            input: { value: [] },
          },
        },
        {
          kind: 'block',
          blockId,
          name: '空集合遍历',
          control: {
            type: 'for_each',
            over: { from: 'emptyList' },
            as: 'curr',
            maxItems: 10,
          },
          body: [
            {
              kind: 'step',
              step: {
                id: bodyStepId,
                name: '处理项',
                type: 'echo',
                effectType: 'READ_ONLY',
                outputKey: 'outVal',
                input: { from: 'curr' },
              },
            },
          ],
          collect: [{ from: 'outVal', into: 'res' }],
        },
      ],
    }

    const { run, runId } = await createPublishAndRun('CFC-03-empty-list', doc)

    expect(run.status).toBe('SUCCEEDED')
    expect(run.context.res).toEqual([])

    const { iterations } = await loadRunIterations(handle.db, runId, { blockId })
    expect(iterations).toHaveLength(0)
  })

  // CFC-04: 集合异常校验
  it('CFC-04: 非列表类型输入报 LOOP_INPUT_INVALID', async () => {
    const initStepId = newId()
    const blockId = newId()
    const bodyStepId = newId()

    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: {
            id: initStepId,
            name: '准备非法非列表',
            type: 'echo',
            effectType: 'READ_ONLY',
            outputKey: 'notAList',
            input: { value: 'not-an-array' },
          },
        },
        {
          kind: 'block',
          blockId,
          name: '逐项遍历',
          control: {
            type: 'for_each',
            over: { from: 'notAList' },
            as: 'curr',
            maxItems: 10,
          },
          body: [
            {
              kind: 'step',
              step: {
                id: bodyStepId,
                name: '处理',
                type: 'echo',
                effectType: 'READ_ONLY',
                input: { from: 'curr' },
              },
            },
          ],
        },
      ],
    }

    const { run } = await createPublishAndRun('CFC-04-invalid-input', doc)

    expect(run.status).toBe('FAILED')
    const loopHeaderStep = run.stepRuns.find((s) => s.stepId !== initStepId)
    expect(loopHeaderStep?.status).toBe('FAILED')
    expect(loopHeaderStep?.attempts[0]?.error?.code).toBe('LOOP_INPUT_INVALID')
  })

  it('CFC-04: 集合项数超过上限报 LOOP_TOO_MANY_ITEMS', async () => {
    const initStepId = newId()
    const blockId = newId()
    const bodyStepId = newId()

    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: {
            id: initStepId,
            name: '准备超量列表',
            type: 'echo',
            effectType: 'READ_ONLY',
            outputKey: 'tooManyList',
            input: { value: [1, 2, 3, 4] },
          },
        },
        {
          kind: 'block',
          blockId,
          name: '限额2项的循环',
          control: {
            type: 'for_each',
            over: { from: 'tooManyList' },
            as: 'curr',
            maxItems: 2,
          },
          body: [
            {
              kind: 'step',
              step: {
                id: bodyStepId,
                name: '处理',
                type: 'echo',
                effectType: 'READ_ONLY',
                input: { from: 'curr' },
              },
            },
          ],
        },
      ],
    }

    const { run } = await createPublishAndRun('CFC-04-too-many-items', doc)

    expect(run.status).toBe('FAILED')
    const loopHeaderStep = run.stepRuns.find((s) => s.stepId !== initStepId)
    expect(loopHeaderStep?.status).toBe('FAILED')
    expect(loopHeaderStep?.attempts[0]?.error?.code).toBe('LOOP_TOO_MANY_ITEMS')
  })

  // CFC-05: stopWhen 提前结束
  it('CFC-05: stopWhen 在满足条件时提前结束，其余项不创建', async () => {
    const initStepId = newId()
    const blockId = newId()
    const bodyStepId = newId()

    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: {
            id: initStepId,
            name: '准备5项',
            type: 'echo',
            effectType: 'READ_ONLY',
            outputKey: 'fullList',
            input: { value: ['alpha', 'beta', 'stop-here', 'delta', 'epsilon'] },
          },
        },
        {
          kind: 'block',
          blockId,
          name: '可提前退出循环',
          control: {
            type: 'for_each',
            over: { from: 'fullList' },
            as: 'curr',
            maxItems: 10,
            stopWhen: {
              kind: 'compare',
              op: 'eq',
              left: { kind: 'ref', key: 'curr' },
              right: { kind: 'literal', value: 'stop-here' },
            },
          },
          body: [
            {
              kind: 'step',
              step: {
                id: bodyStepId,
                name: '执行单步',
                type: 'echo',
                effectType: 'READ_ONLY',
                outputKey: 'v',
                input: { from: 'curr' },
              },
            },
          ],
          collect: [{ from: 'v', into: 'stoppedCollect' }],
        },
      ],
    }

    const { run, runId } = await createPublishAndRun('CFC-05-stop-when', doc)

    expect(run.status).toBe('SUCCEEDED')
    expect(run.context.stoppedCollect).toEqual(['alpha', 'beta', 'stop-here'])

    const { iterations } = await loadRunIterations(handle.db, runId, { blockId })
    expect(iterations).toHaveLength(3)
    expect(iterations[2]?.status).toBe('SUCCEEDED')
    expect((iterations[2]?.stopDecision as any)?.stoppedEarly).toBe(true)
  })

  // CFC-07: 第 k 项失败
  it('CFC-07: 第 k 项失败时循环头与 Run 标记为 FAILED，其余项不再执行', async () => {
    const initStepId = newId()
    const blockId = newId()
    const ifBlockId = newId()
    const failStepId = newId()
    const okStepId = newId()

    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: {
            id: initStepId,
            name: '准备列表',
            type: 'echo',
            effectType: 'READ_ONLY',
            outputKey: 'listWithFail',
            input: { value: ['first-ok', 'fail-target', 'third-never'] },
          },
        },
        {
          kind: 'block',
          blockId,
          name: '含失败循环',
          control: {
            type: 'for_each',
            over: { from: 'listWithFail' },
            as: 'curr',
            maxItems: 10,
          },
          body: [
            {
              kind: 'block',
              blockId: ifBlockId,
              name: '失败判定',
              control: {
                type: 'if',
                condition: {
                  kind: 'compare',
                  op: 'eq',
                  left: { kind: 'ref', key: 'curr' },
                  right: { kind: 'literal', value: 'fail-target' },
                },
              },
              then: [
                {
                  kind: 'step',
                  step: {
                    id: failStepId,
                    name: '目标失败',
                    type: 'fail',
                    effectType: 'READ_ONLY',
                    input: { message: '第2项故意失败' },
                  },
                },
              ],
              else: [
                {
                  kind: 'step',
                  step: {
                    id: okStepId,
                    name: '正常通过',
                    type: 'echo',
                    effectType: 'READ_ONLY',
                    outputKey: 'out',
                    input: { from: 'curr' },
                  },
                },
              ],
            },
          ],
        },
      ],
    }

    const { run, runId } = await createPublishAndRun('CFC-07-item-failed', doc)

    expect(run.status).toBe('FAILED')

    const { iterations } = await loadRunIterations(handle.db, runId, { blockId })
    expect(iterations).toHaveLength(2)
    expect(iterations[0]?.status).toBe('SUCCEEDED')
    expect(iterations[1]?.status).toBe('FAILED')
  })

  // CFC-11: repeat 块满足 until 退出
  it('CFC-11: repeat 块循环执行直到 until 条件成立', async () => {
    const blockId = newId()
    const bodyStepId = newId()

    let pollCount = 0
    const originalRunExecutor = engine.runExecutor.bind(engine)
    engine.runExecutor = async (params) => {
      if (params.step.id === bodyStepId) {
        pollCount++
        return {
          kind: 'success',
          output: pollCount >= 3 ? 'DONE' : 'PENDING',
        }
      }
      return originalRunExecutor(params)
    }

    try {
      const doc: ScenarioAuthoringDocumentV2 = {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'block',
            blockId,
            name: '轮询重复块',
            control: {
              type: 'repeat',
              until: {
                kind: 'compare',
                op: 'eq',
                left: { kind: 'ref', key: 'pollStatus' },
                right: { kind: 'literal', value: 'DONE' },
              },
              maxIterations: 10,
            },
            body: [
              {
                kind: 'step',
                step: {
                  id: bodyStepId,
                  name: '检查状态',
                  type: 'echo',
                  effectType: 'READ_ONLY',
                  outputKey: 'pollStatus',
                  input: { value: 'check' },
                },
              },
            ],
            collect: [{ from: 'pollStatus', into: 'statusHistory' }],
          },
        ],
      }

      const { run, runId } = await createPublishAndRun('CFC-11-repeat-until', doc)

      expect(run.status).toBe('SUCCEEDED')
      expect(run.context.statusHistory).toEqual(['PENDING', 'PENDING', 'DONE'])

      const { iterations } = await loadRunIterations(handle.db, runId, { blockId })
      expect(iterations).toHaveLength(3)
      expect(iterations[2]?.status).toBe('SUCCEEDED')
      expect((iterations[2]?.stopDecision as any)?.untilMet).toBe(true)
    } finally {
      engine.runExecutor = originalRunExecutor
    }
  })

  // CFC-12: repeat 达到上限策略
  it('CFC-12: repeat 达到上限且 onLimit 为 fail 时报错失败', async () => {
    const blockId = newId()
    const bodyStepId = newId()

    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'block',
          blockId,
          name: '永不满足的重复块',
          control: {
            type: 'repeat',
            until: {
              kind: 'literal',
              value: false,
            },
            maxIterations: 3,
            onLimit: 'fail',
          },
          body: [
            {
              kind: 'step',
              step: {
                id: bodyStepId,
                name: '空步骤',
                type: 'echo',
                effectType: 'READ_ONLY',
                input: { value: 'noop' },
              },
            },
          ],
        },
      ],
    }

    const { run } = await createPublishAndRun('CFC-12-repeat-limit-fail', doc)

    expect(run.status).toBe('FAILED')
    const loopHeaderStep = run.stepRuns.find((s) => s.type === 'loop')
    expect(loopHeaderStep?.status).toBe('FAILED')
    // 失败原因落在循环头上，不能出现「尝试全部成功、Run 却失败」
    expect(loopHeaderStep?.attempts.at(-1)?.status).toBe('FAILED')
    expect(loopHeaderStep?.attempts.at(-1)?.error?.code).toBe('LOOP_LIMIT_REACHED')
  })

  it('CFC-12: repeat 达到上限且 onLimit 为 stop 时成功并标记达到上限', async () => {
    const blockId = newId()
    const bodyStepId = newId()

    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'block',
          blockId,
          name: '上限停机重复块',
          control: {
            type: 'repeat',
            until: {
              kind: 'literal',
              value: false,
            },
            maxIterations: 3,
            onLimit: 'stop',
          },
          body: [
            {
              kind: 'step',
              step: {
                id: bodyStepId,
                name: '空步骤',
                type: 'echo',
                effectType: 'READ_ONLY',
                input: { value: 'step' },
              },
            },
          ],
        },
      ],
    }

    const { run, runId } = await createPublishAndRun('CFC-12-repeat-limit-stop', doc)

    expect(run.status).toBe('SUCCEEDED')
    const { iterations } = await loadRunIterations(handle.db, runId, { blockId })
    expect(iterations).toHaveLength(3)
    expect((iterations[2]?.stopDecision as any)?.limitReached).toBe(true)
  })

  // CFC-08: loadLoopFrozenItems 冻结集合恢复
  it('CFC-08: 冻结集合成功落库并在断点恢复时完整读取', async () => {
    const initStepId = newId()
    const blockId = newId()
    const bodyStepId = newId()

    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: {
            id: initStepId,
            name: '生成集合',
            type: 'echo',
            effectType: 'READ_ONLY',
            outputKey: 'frozenSource',
            input: { value: ['alpha', 'beta'] },
          },
        },
        {
          kind: 'block',
          blockId,
          name: '逐项迭代',
          control: {
            type: 'for_each',
            over: { from: 'frozenSource' },
            as: 'elem',
            maxItems: 10,
          },
          body: [
            {
              kind: 'step',
              step: {
                id: bodyStepId,
                name: '单项操作',
                type: 'echo',
                effectType: 'READ_ONLY',
                input: { from: 'elem' },
              },
            },
          ],
        },
      ],
    }

    const { run, runId } = await createPublishAndRun('CFC-08-frozen-items', doc)

    expect(run.status).toBe('SUCCEEDED')
    const loopHeaderStep = run.stepRuns.find((s) => s.type === 'loop')!
    expect(loopHeaderStep).toBeDefined()

    const recovered = await loadLoopFrozenItems(handle.db, runId, loopHeaderStep.stepId)
    expect(recovered).toEqual(['alpha', 'beta'])
  })

  // CFC-15: 证据口径 bounded 时，中间正常项抑制多媒体证据
  it('CFC-15: 证据策略 bounded 时首项和末项采集多媒体，中间正常项抑制', async () => {
    const initStepId = newId()
    const blockId = newId()
    const bodyStepId = newId()

    const originalCompleteAttempt = engine.completeAttempt.bind(engine)
    const mediaSuppressionRecords: boolean[] = []
    engine.completeAttempt = async (params) => {
      if (params.step.id === bodyStepId) {
        mediaSuppressionRecords.push(Boolean(params.suppressMediaEvidence))
      }
      return originalCompleteAttempt(params)
    }

    try {
      const doc: ScenarioAuthoringDocumentV2 = {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'step',
            step: {
              id: initStepId,
              name: '生成集合',
              type: 'echo',
              effectType: 'READ_ONLY',
              outputKey: 'items',
              input: { value: ['a', 'b', 'c'] },
            },
          },
          {
            kind: 'block',
            blockId,
            name: '逐项迭代',
            control: {
              type: 'for_each',
              over: { from: 'items' },
              as: 'x',
              maxItems: 10,
            },
            body: [
              {
                kind: 'step',
                step: {
                  id: bodyStepId,
                  name: '单项操作',
                  type: 'echo',
                  effectType: 'READ_ONLY',
                  input: { from: 'x' },
                },
              },
            ],
          },
        ],
      }

      const { runId } = await createPublishAndRun('CFC-15-bounded-evidence', doc, {}, {
        evidencePolicy: { iterationEvidence: 'bounded' },
      })

      const { iterations } = await loadRunIterations(handle.db, runId, { blockId })
      expect(iterations).toHaveLength(3)
      expect(mediaSuppressionRecords).toEqual([false, true, false])
    } finally {
      engine.completeAttempt = originalCompleteAttempt
    }
  })

  const echoStep = (id: string, name: string, extra: Partial<Step> = {}): Step =>
    ({ id, name, type: 'echo', effectType: 'READ_ONLY', input: { value: name }, ...extra }) as Step
  const neverTrue = {
    kind: 'compare' as const,
    op: 'eq' as const,
    left: { kind: 'ref' as const, key: 'curr' },
    right: { kind: 'literal' as const, value: '__never__' },
  }
  function loopWithIfTail(blockId: string, trailing: ScenarioAuthoringDocumentV2['nodes']): ScenarioAuthoringDocumentV2 {
    return {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        echoStep(newId(), '列表', { outputKey: 'rawList', input: { value: ['a', 'b', 'c'] } } as Partial<Step>),
        {
          kind: 'block',
          blockId,
          name: '逐项',
          control: { type: 'for_each', over: { from: 'rawList' }, as: 'curr', maxItems: 10 },
          body: [
            { kind: 'step', step: echoStep(newId(), '处理', { outputKey: 'outVal', input: { from: 'curr' } } as Partial<Step>) },
            { kind: 'block', blockId: newId(), control: { type: 'if', condition: neverTrue }, then: [{ kind: 'step', step: echoStep(newId(), '仅满足时') }] },
          ],
          collect: [{ from: 'outVal', into: 'results' }],
        },
        ...trailing,
      ].map((node) => ('kind' in node ? node : { kind: 'step', step: node })) as ScenarioAuthoringDocumentV2['nodes'],
    }
  }

  it('复查修复：循环体末尾条件块不成立时，每一项都收尾，循环后步骤照常执行', async () => {
    const blockId = newId()
    const afterId = newId()
    const { run, runId } = await createPublishAndRun(
      'CFC-FIX-if-tail',
      loopWithIfTail(blockId, [{ kind: 'step', step: echoStep(afterId, '循环后') }]),
    )
    const { iterations } = await loadRunIterations(handle.db, runId, { blockId })
    expect(iterations.map((it) => it.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED'])
    expect(run.context.results).toEqual(['a', 'b', 'c'])
    expect(run.stepRuns.find((s) => s.type === 'loop')?.status).toBe('SUCCEEDED')
    expect(run.stepRuns.find((s) => s.stepId === afterId)?.status).toBe('SUCCEEDED')
    expect(run.status).toBe('SUCCEEDED')
  })

  it('复查修复：循环位于末尾且最后一项以条件块跳过收尾时，Run 同事务收尾成功', async () => {
    const blockId = newId()
    const { run, runId } = await createPublishAndRun('CFC-FIX-if-tail-last', loopWithIfTail(blockId, []))
    const { iterations } = await loadRunIterations(handle.db, runId, { blockId })
    expect(iterations).toHaveLength(3)
    expect(iterations.every((it) => it.status === 'SUCCEEDED')).toBe(true)
    expect(run.stepRuns.find((s) => s.type === 'loop')?.status).toBe('SUCCEEDED')
    expect(run.status).toBe('SUCCEEDED')
  })

  it('复查修复：循环体末尾步骤停用时走兜底收尾，循环照常完成', async () => {
    const blockId = newId()
    const afterId = newId()
    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        { kind: 'step', step: echoStep(newId(), '列表', { outputKey: 'rawList', input: { value: ['x', 'y'] } } as Partial<Step>) },
        {
          kind: 'block',
          blockId,
          name: '逐项',
          control: { type: 'for_each', over: { from: 'rawList' }, as: 'curr', maxItems: 10 },
          body: [
            { kind: 'step', step: echoStep(newId(), '处理', { outputKey: 'outVal', input: { from: 'curr' } } as Partial<Step>) },
            { kind: 'step', step: echoStep(newId(), '停用尾步', { disabled: true }) },
          ],
          collect: [{ from: 'outVal', into: 'results' }],
        },
        { kind: 'step', step: echoStep(afterId, '循环后') },
      ],
    }
    const { run, runId } = await createPublishAndRun('CFC-FIX-disabled-tail', doc)
    const { iterations } = await loadRunIterations(handle.db, runId, { blockId })
    expect(iterations.map((it) => it.status)).toEqual(['SUCCEEDED', 'SUCCEEDED'])
    expect(run.context.results).toEqual(['x', 'y'])
    expect(run.stepRuns.find((s) => s.stepId === afterId)?.status).toBe('SUCCEEDED')
    expect(run.status).toBe('SUCCEEDED')
  })

  it('复查修复：repeat 结束条件引用缺失值时失败并写明原因，不跑到上限', async () => {
    const blockId = newId()
    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'block',
          blockId,
          name: '重复',
          control: {
            type: 'repeat',
            maxIterations: 3,
            onLimit: 'stop',
            until: { kind: 'compare', op: 'eq', left: { kind: 'ref', key: 'maybe', field: 'x' }, right: { kind: 'literal', value: 1 } },
          },
          body: [{ kind: 'step', step: echoStep(newId(), '取值', { outputKey: 'maybe', input: { value: { y: 1 } } } as Partial<Step>) }],
        },
      ],
    }
    const { run, runId } = await createPublishAndRun('CFC-FIX-until-missing', doc)
    expect(run.status).toBe('FAILED')
    const header = run.stepRuns.find((s) => s.type === 'loop')
    expect(header?.status).toBe('FAILED')
    expect(header?.attempts.at(-1)?.error?.code).toBe('LOOP_CONDITION_INVALID')
    const { iterations } = await loadRunIterations(handle.db, runId, { blockId })
    expect(iterations).toHaveLength(1)
    expect(iterations[0]?.status).toBe('FAILED')
  })

  it('复查修复：未满足结束条件的每一项也记录判定依据', async () => {
    const blockId = newId()
    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        { kind: 'step', step: echoStep(newId(), '列表', { outputKey: 'rawList', input: { value: ['a', 'b', 'c', 'd'] } } as Partial<Step>) },
        {
          kind: 'block',
          blockId,
          name: '逐项',
          control: {
            type: 'for_each',
            over: { from: 'rawList' },
            as: 'curr',
            maxItems: 10,
            stopWhen: { kind: 'compare', op: 'eq', left: { kind: 'ref', key: 'curr' }, right: { kind: 'literal', value: 'c' } },
          },
          body: [{ kind: 'step', step: echoStep(newId(), '处理', { input: { from: 'curr' } } as Partial<Step>) }],
        },
      ],
    }
    const { run, runId } = await createPublishAndRun('CFC-FIX-stop-decision', doc)
    expect(run.status).toBe('SUCCEEDED')
    const { iterations } = await loadRunIterations(handle.db, runId, { blockId })
    expect(iterations.map((it) => (it.stopDecision as any)?.value)).toEqual([false, false, true])
    expect((iterations[2]?.stopDecision as any)?.stoppedEarly).toBe(true)
  })
})
