import { describe, expect, it } from 'vitest'
import {
  authoringBlockNodeSchema,
  authoringHasControlBlocks,
  authoringNodeId,
  authoringSteps,
  insertNodeAfter,
  isNodeOutputPossiblyAbsent,
  locateNode,
  moveNodeWithin,
  nodesBefore,
  removeNode,
  replaceNode,
  scenarioAuthoringDocumentV2Schema,
  walkAuthoringNodes,
  CONTROL_FLOW_PROTOCOL,
  controlFlowManifestSchema,
  runSnapshotSchema,
  stepSchema,
  probeStepSchema,
  decideStepSchema,
  computeStepSchema,
  type AuthoringBlockNode,
  type AuthoringStepNode,
  type Step,
} from '../index.js'

describe('Control Flow B: Schemas & AST', () => {
  const step1: AuthoringStepNode = {
    kind: 'step',
    step: {
      id: '10000000-0000-4000-8000-000000000001',
      name: '导航首页',
      type: 'navigate',
      effectType: 'READ_ONLY',
      input: { url: 'https://example.com' },
    },
  }

  const step2Then: AuthoringStepNode = {
    kind: 'step',
    step: {
      id: '10000000-0000-4000-8000-000000000002',
      name: '点击详情',
      type: 'click',
      effectType: 'IDEMPOTENT',
      input: { target: { framePath: [], candidates: [{ by: 'css', value: '#btn-detail' }] } },
      outputKey: 'detailResult',
    },
  }

  const step3Else: AuthoringStepNode = {
    kind: 'step',
    step: {
      id: '10000000-0000-4000-8000-000000000003',
      name: '打印日志',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { value: '未进入分支' },
      outputKey: 'elseLog',
    },
  }

  const step4After: AuthoringStepNode = {
    kind: 'step',
    step: {
      id: '10000000-0000-4000-8000-000000000004',
      name: '等待结束',
      type: 'delay',
      effectType: 'READ_ONLY',
      input: { durationMs: 100 },
    },
  }

  const block1: AuthoringBlockNode = {
    kind: 'block',
    blockId: '20000000-0000-4000-8000-000000000001',
    name: '满足条件时执行',
    control: {
      type: 'if',
      condition: {
        kind: 'compare',
        op: 'eq',
        left: { kind: 'ref', key: 'role' },
        right: { kind: 'literal', value: 'admin' },
      },
    },
    then: [step2Then],
    else: [step3Else],
  }

  it('authoringBlockNodeSchema 正确解析条件块', () => {
    const parsed = authoringBlockNodeSchema.parse(block1)
    expect(parsed.kind).toBe('block')
    expect(parsed.blockId).toBe(block1.blockId)
    expect(parsed.control.type).toBe('if')
    expect(parsed.then).toHaveLength(1)
    expect(parsed.else).toHaveLength(1)
  })

  it('scenarioAuthoringDocumentV2Schema 能校验包含条件块的场景', () => {
    const doc = {
      authoringSchemaVersion: 2 as const,
      schemaVersion: 1,
      inputs: [{ key: 'role', label: '角色' }],
      nodes: [step1, block1, step4After],
    }

    const validated = scenarioAuthoringDocumentV2Schema.parse(doc)
    expect(authoringHasControlBlocks(validated)).toBe(true)
    expect(authoringSteps(validated)).toHaveLength(4)
  })

  it('嵌套层级超过 2 层时校验失败', () => {
    const nestedLevel2: AuthoringBlockNode = {
      kind: 'block',
      blockId: '20000000-0000-4000-8000-000000000002',
      control: { type: 'if', condition: { kind: 'literal', value: true } },
      then: [step2Then],
    }
    const nestedLevel3: AuthoringBlockNode = {
      kind: 'block',
      blockId: '20000000-0000-4000-8000-000000000003',
      control: { type: 'if', condition: { kind: 'literal', value: true } },
      then: [nestedLevel2],
    }
    const topBlock: AuthoringBlockNode = {
      kind: 'block',
      blockId: '20000000-0000-4000-8000-000000000004',
      control: { type: 'if', condition: { kind: 'literal', value: true } },
      then: [nestedLevel3],
    }

    const doc = {
      authoringSchemaVersion: 2 as const,
      schemaVersion: 1,
      inputs: [],
      nodes: [topBlock],
    }
    expect(() => scenarioAuthoringDocumentV2Schema.parse(doc)).toThrow(/嵌套层级不能超过 2 层/)
  })

  it('walkAuthoringNodes 深度优先先序遍历带 ancestry 与 branchKey', () => {
    const doc = {
      authoringSchemaVersion: 2 as const,
      schemaVersion: 1,
      inputs: [],
      nodes: [step1, block1, step4After],
    }

    const walked = walkAuthoringNodes(doc)
    expect(walked).toHaveLength(5) // step1, block1, step2Then, step3Else, step4After
    expect(walked.map((w) => w.id)).toEqual([
      step1.step.id,
      block1.blockId,
      step2Then.step.id,
      step3Else.step.id,
      step4After.step.id,
    ])

    const step2Walk = walked.find((w) => w.id === step2Then.step.id)!
    expect(step2Walk.parentId).toBe(block1.blockId)
    expect(step2Walk.branchKey).toBe('then')
    expect(step2Walk.depth).toBe(1)
    expect(step2Walk.ancestry).toEqual([{ blockId: block1.blockId, branchKey: 'then' }])

    const step3Walk = walked.find((w) => w.id === step3Else.step.id)!
    expect(step3Walk.parentId).toBe(block1.blockId)
    expect(step3Walk.branchKey).toBe('else')
    expect(step3Walk.ancestry).toEqual([{ blockId: block1.blockId, branchKey: 'else' }])
  })

  it('nodesBefore 隔离互斥分支变量', () => {
    const doc = {
      authoringSchemaVersion: 2 as const,
      schemaVersion: 1,
      inputs: [],
      nodes: [step1, block1, step4After],
    }

    // 在 then 分支内看：可见 step1 和 block1，不可见 else 分支
    const beforeThen = nodesBefore(doc, step2Then.step.id).map(authoringNodeId)
    expect(beforeThen).toEqual([step1.step.id, block1.blockId])

    // 在 else 分支内看：可见 step1 和 block1，不可见 then 分支（step2Then 被隔离）
    const beforeElse = nodesBefore(doc, step3Else.step.id).map(authoringNodeId)
    expect(beforeElse).toEqual([step1.step.id, block1.blockId])
    expect(beforeElse).not.toContain(step2Then.step.id)

    // 在块之后看：可见 step1, block1, step2Then, step3Else
    const beforeAfter = nodesBefore(doc, step4After.step.id).map(authoringNodeId)
    expect(beforeAfter).toEqual([
      step1.step.id,
      block1.blockId,
      step2Then.step.id,
      step3Else.step.id,
    ])
  })

  it('isNodeOutputPossiblyAbsent 正确识别可能缺失的输出', () => {
    const doc = {
      authoringSchemaVersion: 2 as const,
      schemaVersion: 1,
      inputs: [],
      nodes: [step1, block1, step4After],
    }

    // 在块内看自身分支的输出：确定存在 (false)
    expect(isNodeOutputPossiblyAbsent(doc, step2Then.step.id, step2Then.step.id)).toBe(false)

    // 在块后引用分支内的输出：可能缺失 (true)
    expect(isNodeOutputPossiblyAbsent(doc, step2Then.step.id, step4After.step.id)).toBe(true)

    // 顶级非分支普通步骤：确定存在 (false)
    expect(isNodeOutputPossiblyAbsent(doc, step1.step.id, step4After.step.id)).toBe(false)
  })

  it('AST 树级修改函数可以在分支内增删改移', () => {
    const doc = {
      authoringSchemaVersion: 2 as const,
      schemaVersion: 1,
      inputs: [],
      nodes: [step1, block1, step4After],
    }

    // 1. 在 step2Then 后插入新步骤
    const newStepInThen: AuthoringStepNode = {
      kind: 'step',
      step: {
        id: '10000000-0000-4000-8000-000000000009',
        name: '分支插入步',
        type: 'delay',
        effectType: 'READ_ONLY',
        input: { durationMs: 50 },
      },
    }
    const inserted = insertNodeAfter(doc, step2Then.step.id, newStepInThen)
    const blockThen = (inserted.nodes[1] as AuthoringBlockNode).then
    expect(blockThen).toHaveLength(2)
    expect(blockThen[1]?.kind === 'step' && blockThen[1].step.id).toBe(newStepInThen.step.id)

    // 2. 替换分支内的步骤
    const replaced = replaceNode(inserted, newStepInThen.step.id, {
      ...newStepInThen,
      step: { ...newStepInThen.step, name: '已更名' },
    })
    const replacedStep = (replaced.nodes[1] as AuthoringBlockNode).then[1] as AuthoringStepNode
    expect(replacedStep.step.name).toBe('已更名')

    // 3. 在分支内移动步骤
    const moved = moveNodeWithin(inserted, newStepInThen.step.id, -1)
    const movedThen = (moved.nodes[1] as AuthoringBlockNode).then
    expect(authoringNodeId(movedThen[0]!)).toBe(newStepInThen.step.id)

    // 4. 从分支中删除步骤
    const removed = removeNode(moved, newStepInThen.step.id)
    expect((removed.nodes[1] as AuthoringBlockNode).then).toHaveLength(1)
  })

  it('页面检查步骤 (probe) 校验规则', () => {
    const validProbe = probeStepSchema.parse({
      id: '30000000-0000-4000-8000-000000000001',
      name: '检查弹窗',
      type: 'probe',
      effectType: 'READ_ONLY',
      input: {
        kind: 'element',
        target: { framePath: [], candidates: [{ by: 'css', value: '.modal' }] },
        state: 'visible',
        waitMs: 3000,
      },
      policy: {
        timeoutMs: 5000,
      },
      outputKey: 'modalExists',
    })
    expect(validProbe.type).toBe('probe')

    // timeoutMs <= waitMs 必须报错
    expect(() =>
      stepSchema.parse({
        id: '30000000-0000-4000-8000-000000000002',
        name: '检查超时不合理',
        type: 'probe',
        effectType: 'READ_ONLY',
        input: {
          kind: 'text',
          text: 'hello',
          waitMs: 5000,
        },
        policy: {
          timeoutMs: 4000,
        },
      }),
    ).toThrow(/必须大于等待上限/)
  })

  it('单步可选 (optional) 仅允许特定步骤类型', () => {
    // click 允许 optional
    const clickOptional = stepSchema.parse({
      id: '40000000-0000-4000-8000-000000000001',
      name: '可选关闭弹窗',
      type: 'click',
      effectType: 'IDEMPOTENT',
      optional: true,
      input: { target: { framePath: [], candidates: [{ by: 'css', value: '.close' }] } },
    })
    expect(clickOptional.optional).toBe(true)

    // navigate 不允许 optional
    expect(() =>
      stepSchema.parse({
        id: '40000000-0000-4000-8000-000000000002',
        name: '可选导航',
        type: 'navigate',
        effectType: 'READ_ONLY',
        optional: true,
        input: { url: 'https://example.com' },
      }),
    ).toThrow(/单步可选 \(optional\) 仅允许用于/)
  })

  it('计算值步骤 (compute) 校验', () => {
    const computeStep = computeStepSchema.parse({
      id: '50000000-0000-4000-8000-000000000001',
      name: '计算折后价',
      type: 'compute',
      effectType: 'READ_ONLY',
      input: {
        expression: {
          kind: 'call',
          fn: 'toNumber',
          args: [{ kind: 'ref', key: 'rawPrice' }],
        },
      },
      outputKey: 'priceNum',
    })
    expect(computeStep.type).toBe('compute')
    expect(computeStep.outputKey).toBe('priceNum')
  })

  it('Run 快照对 controlFlow 的连续性与判定步骤校验', () => {
    const decideStep: Step = {
      id: '60000000-0000-4000-8000-000000000001',
      name: '判定分支',
      type: 'decide',
      effectType: 'READ_ONLY',
      input: {
        blockId: '20000000-0000-4000-8000-000000000001',
        condition: { kind: 'literal', value: true },
      },
    }

    const thenStep1: Step = {
      id: '60000000-0000-4000-8000-000000000002',
      name: '成立步1',
      type: 'delay',
      effectType: 'READ_ONLY',
      input: { durationMs: 10 },
    }

    const thenStep2: Step = {
      id: '60000000-0000-4000-8000-000000000003',
      name: '成立步2',
      type: 'delay',
      effectType: 'READ_ONLY',
      input: { durationMs: 20 },
    }

    const validSnapshot = {
      schemaVersion: 1,
      runId: '70000000-0000-4000-8000-000000000001',
      targetId: '70000000-0000-4000-8000-000000000002',
      scenarioId: '70000000-0000-4000-8000-000000000003',
      scenarioVersionId: '70000000-0000-4000-8000-000000000004',
      steps: [decideStep, thenStep1, thenStep2],
      input: {},
      createdAt: '2026-09-24T12:00:00.000Z',
      controlFlow: {
        protocol: CONTROL_FLOW_PROTOCOL,
        blocks: [
          {
            blockId: '20000000-0000-4000-8000-000000000001',
            kind: 'if' as const,
            decideStepId: decideStep.id,
            branches: [
              {
                key: 'then' as const,
                stepIds: [thenStep1.id, thenStep2.id],
              },
            ],
          },
        ],
      },
    }

    const parsed = runSnapshotSchema.parse(validSnapshot)
    expect(parsed.controlFlow?.protocol).toBe(CONTROL_FLOW_PROTOCOL)
    expect(parsed.controlFlow?.blocks).toHaveLength(1)

    // 不连续的步骤报异常
    const nonContiguousSnapshot = {
      ...validSnapshot,
      controlFlow: {
        protocol: CONTROL_FLOW_PROTOCOL,
        blocks: [
          {
            blockId: '20000000-0000-4000-8000-000000000001',
            kind: 'if' as const,
            decideStepId: decideStep.id,
            branches: [
              {
                key: 'then' as const,
                stepIds: [thenStep2.id, thenStep1.id], // 倒序不连续
              },
            ],
          },
        ],
      },
    }
    expect(() => runSnapshotSchema.parse(nonContiguousSnapshot)).toThrow(/必须连续/)
  })

  describe('Control Flow C: Loops & Iterations', () => {
    const loopBodyStep1: AuthoringStepNode = {
      kind: 'step',
      step: {
        id: '10000000-0000-4000-8000-000000000011',
        name: '处理告警项',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { value: 'item processed' },
        outputKey: 'itemResult',
      },
    }

    const forEachBlock: AuthoringBlockNode = {
      kind: 'block',
      blockId: '20000000-0000-4000-8000-000000000010',
      name: '逐项处理告警',
      control: {
        type: 'for_each',
        over: { from: 'alertList' },
        as: 'currentAlert',
        indexAs: 'alertIdx',
        maxItems: 50,
      },
      body: [loopBodyStep1],
      collect: [
        {
          from: 'itemResult',
          into: 'collectedResults',
        },
      ],
    }

    const repeatBlock: AuthoringBlockNode = {
      kind: 'block',
      blockId: '20000000-0000-4000-8000-000000000020',
      name: '重复直到成功',
      control: {
        type: 'repeat',
        until: {
          kind: 'compare',
          op: 'eq',
          left: { kind: 'ref', key: 'status' },
          right: { kind: 'literal', value: 'DONE' },
        },
        maxIterations: 20,
        intervalMs: 1000,
        onLimit: 'fail',
      },
      body: [loopBodyStep1],
    }

    it('authoringBlockNodeSchema 正确解析 for_each 和 repeat 循环块', () => {
      const parsedForEach = authoringBlockNodeSchema.parse(forEachBlock)
      expect(parsedForEach.kind).toBe('block')
      expect(parsedForEach.control.type).toBe('for_each')
      if (parsedForEach.control.type === 'for_each') {
        expect(parsedForEach.control.as).toBe('currentAlert')
        expect(parsedForEach.body).toHaveLength(1)
        expect(parsedForEach.collect).toHaveLength(1)
      }

      const parsedRepeat = authoringBlockNodeSchema.parse(repeatBlock)
      expect(parsedRepeat.kind).toBe('block')
      expect(parsedRepeat.control.type).toBe('repeat')
      if (parsedRepeat.control.type === 'repeat') {
        expect(parsedRepeat.control.maxIterations).toBe(20)
        expect(parsedRepeat.control.onLimit).toBe('fail')
        expect(parsedRepeat.body).toHaveLength(1)
      }
    })

    it('walkAuthoringNodes 遍历循环块并记录 branchKey: body', () => {
      const doc = scenarioAuthoringDocumentV2Schema.parse({
        authoringSchemaVersion: 2,
        nodes: [forEachBlock],
      })
      const items = walkAuthoringNodes(doc)
      expect(items).toHaveLength(2)
      expect(items[0]!.id).toBe(forEachBlock.blockId)
      expect(items[1]!.id).toBe(loopBodyStep1.step.id)
      expect(items[1]!.branchKey).toBe('body')
      expect(items[1]!.ancestry).toEqual([{ blockId: forEachBlock.blockId, branchKey: 'body' }])
    })

    it('runSnapshotSchema 校验 loop 步骤及 controlFlow@2 循环块', () => {
      const loopHeaderStep: Step = {
        id: '10000000-0000-4000-8000-000000000090',
        name: '循环头',
        type: 'loop',
        effectType: 'READ_ONLY',
        input: {
          blockId: '20000000-0000-4000-8000-000000000010',
          control: {
            type: 'for_each',
            over: { from: 'alertList' },
            as: 'currentAlert',
            maxItems: 50,
          },
        },
      }

      const bodyStep: Step = {
        id: '10000000-0000-4000-8000-000000000091',
        name: '处理项',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { value: 'item' },
      }

      const validSnapshot = {
        schemaVersion: 1,
        runId: '90000000-0000-4000-8000-000000000001',
        targetId: '90000000-0000-4000-8000-000000000002',
        targetAccountId: '90000000-0000-4000-8000-000000000003',
        scenarioId: '90000000-0000-4000-8000-000000000004',
        scenarioVersionId: '90000000-0000-4000-8000-000000000005',
        steps: [loopHeaderStep, bodyStep],
        input: {},
        createdAt: new Date().toISOString(),
        controlFlow: {
          protocol: 'snapshot.controlFlow@2' as const,
          blocks: [
            {
              blockId: '20000000-0000-4000-8000-000000000010',
              kind: 'for_each' as const,
              headerStepId: loopHeaderStep.id,
              bodyStepIds: [bodyStep.id],
              limits: { maxItems: 50 },
            },
          ],
        },
      }

      const parsed = runSnapshotSchema.parse(validSnapshot)
      expect(parsed.controlFlow?.protocol).toBe('snapshot.controlFlow@2')
      expect(parsed.controlFlow?.blocks[0]?.kind).toBe('for_each')

      // 若含循环块但 protocol 声明为 @1，应报错
      const invalidProtocolSnapshot = {
        ...validSnapshot,
        controlFlow: {
          ...validSnapshot.controlFlow,
          protocol: 'snapshot.controlFlow@1',
        },
      }
      expect(() => runSnapshotSchema.parse(invalidProtocolSnapshot)).toThrow(/snapshot\.controlFlow@2/)
    })
  })
})
