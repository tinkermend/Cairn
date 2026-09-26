import { describe, expect, it } from 'vitest'
import {
  expandAuthoringDocument,
  deriveControlFlowManifest,
  type ExpansionContext,
} from '../expand.js'
import {
  CONTROL_FLOW_PROTOCOL,
  CONTROL_FLOW_PROTOCOL_V2,
  type ScenarioAuthoringDocumentV2,
  type Step,
} from '@cairn/shared'

const baseContext: ExpansionContext = {
  targetId: '00000000-0000-4000-8000-000000000001',
  mode: 'save',
  loadedModules: new Map(),
}

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('CF-B: Control Flow Expansion and Diagnostics', () => {
  it('expands if-else block with decide step and contiguous branches', () => {
    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [{ key: 'status', label: '状态', type: 'string' }],
      nodes: [
        {
          kind: 'block',
          blockId: ID(10),
          name: '检查状态',
          control: {
            type: 'if',
            condition: {
              kind: 'compare',
              op: 'eq',
              left: { kind: 'ref', key: 'status' },
              right: { kind: 'literal', value: 'active' },
            },
          },
          then: [
            {
              kind: 'step',
              step: {
                id: ID(11),
                name: '执行正常逻辑',
                type: 'click',
                effectType: 'SIDE_EFFECT',
                input: { target: { candidates: [{ by: 'css', value: '#submit' }] } },
              },
            },
          ],
          else: [
            {
              kind: 'step',
              step: {
                id: ID(12),
                name: '执行备选逻辑',
                type: 'click',
                effectType: 'SIDE_EFFECT',
                input: { target: { candidates: [{ by: 'css', value: '#cancel' }] } },
              },
            },
          ],
        },
      ],
    }

    const res = expandAuthoringDocument(doc, baseContext)
    expect(res.ok).toBe(true)
    expect(res.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(res.definition).toBeDefined()
    expect(res.definition?.steps).toHaveLength(3)

    const steps = res.definition!.steps
    expect(steps[0]!.type).toBe('decide')
    expect(steps[1]!.id).toBe(ID(11))
    expect(steps[2]!.id).toBe(ID(12))

    expect(res.controlFlow).toBeDefined()
    expect(res.controlFlow?.protocol).toBe(CONTROL_FLOW_PROTOCOL)
    expect(res.controlFlow?.blocks).toHaveLength(1)

    const block = res.controlFlow!.blocks[0]!
    expect(block.blockId).toBe(ID(10))
    expect(block.decideStepId).toBe(steps[0]!.id)
    expect(block.branches).toHaveLength(2)
    expect(block.branches[0]).toEqual({ key: 'then', stepIds: [ID(11)] })
    expect(block.branches[1]).toEqual({ key: 'else', stepIds: [ID(12)] })
  })

  it('rejects authored decide steps with DECIDE_STEP_NOT_AUTHORABLE', () => {
    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: {
            id: ID(20),
            name: '手动判定',
            type: 'decide' as any,
            effectType: 'READ_ONLY',
            input: {
              blockId: ID(21),
              condition: { kind: 'literal', value: true },
            },
          },
        },
      ],
    }

    const res = expandAuthoringDocument(doc, baseContext)
    expect(res.ok).toBe(false)
    expect(res.diagnostics.some((d) => d.code === 'DECIDE_STEP_NOT_AUTHORABLE')).toBe(true)
  })

  it('rejects a non-boolean condition with EXPR_TYPE_MISMATCH', () => {
    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [{ key: 'status', label: '状态', type: 'string' }],
      nodes: [
        {
          kind: 'block',
          blockId: ID(22),
          control: { type: 'if', condition: { kind: 'ref', key: 'status' } },
          then: [
            {
              kind: 'step',
              step: {
                id: ID(23),
                name: '点击',
                type: 'click',
                effectType: 'SIDE_EFFECT',
                input: { target: { candidates: [{ by: 'css', value: '#go' }] } },
              },
            },
          ],
        },
      ],
    }
    const res = expandAuthoringDocument(doc, baseContext)
    expect(res.diagnostics.some((d) => d.code === 'EXPR_TYPE_MISMATCH')).toBe(true)
  })

  it('rejects unsupported optional step types with STEP_OPTIONAL_TYPE_UNSUPPORTED', () => {
    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: {
            id: ID(30),
            name: '可选导航',
            type: 'navigate',
            effectType: 'SIDE_EFFECT',
            optional: true,
            input: { url: 'https://example.com' },
          },
        },
      ],
    }

    const res = expandAuthoringDocument(doc, baseContext)
    expect(res.ok).toBe(false)
    expect(res.diagnostics.some((d) => d.message.includes('单步可选'))).toBe(true)
  })

  it('validates probe timeout constraint and auto-defaults timeoutMs', () => {
    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: {
            id: ID(40),
            name: '检查元素',
            type: 'probe',
            effectType: 'READ_ONLY',
            policy: { timeoutMs: 1000 },
            input: {
              kind: 'element',
              target: { candidates: [{ by: 'css', value: '#banner' }] },
              waitMs: 2000,
            },
          },
        },
      ],
    }

    const res = expandAuthoringDocument(doc, baseContext)
    expect(res.ok).toBe(false)
    expect(res.diagnostics.some((d) => d.message.includes('超时上限'))).toBe(true)
  })

  it('rejects probe with AI positioning candidate', () => {
    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: {
            id: ID(50),
            name: 'AI检查元素',
            type: 'probe',
            effectType: 'READ_ONLY',
            input: {
              kind: 'element',
              target: {
                candidates: [{ by: 'css', value: '#btn' }],
                semantic: 'AI语义描述',
              },
              waitMs: 2000,
            },
          },
        },
      ],
    }

    const res = expandAuthoringDocument(doc, baseContext)
    expect(res.ok).toBe(false)
    expect(res.diagnostics.some((d) => d.code === 'PROBE_AI_TIER_FORBIDDEN')).toBe(true)
  })

  it('warns / errors on unprotected conditional output references', () => {
    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'block',
          blockId: ID(60),
          name: '条件块',
          control: {
            type: 'if',
            condition: { kind: 'literal', value: true },
          },
          then: [
            {
              kind: 'step',
              step: {
                id: ID(61),
                name: '提取数据',
                type: 'extract',
                effectType: 'READ_ONLY',
                outputKey: 'data_in_branch',
                input: { target: { candidates: [{ by: 'css', value: '#info' }] }, as: 'text' },
              },
            },
          ],
        },
        {
          kind: 'step',
          step: {
            id: ID(62),
            name: '计算',
            type: 'compute',
            effectType: 'READ_ONLY',
            outputKey: 'computed_result',
            input: {
              expression: {
                kind: 'ref',
                key: 'data_in_branch',
              },
            },
          },
        },
      ],
    }

    // save mode: warning
    const resSave = expandAuthoringDocument(doc, baseContext)
    expect(resSave.diagnostics.some((d) => d.code === 'SCENARIO_CONDITIONAL_OUTPUT_REFERENCED' && d.severity === 'warning')).toBe(true)

    // publish mode: error
    const resPublish = expandAuthoringDocument(doc, { ...baseContext, mode: 'publish' })
    expect(resPublish.diagnostics.some((d) => d.code === 'SCENARIO_CONDITIONAL_OUTPUT_REFERENCED' && d.severity === 'error')).toBe(true)

    // With exists() / coalesce() protection: should pass without warning/error
    const protectedDoc: ScenarioAuthoringDocumentV2 = JSON.parse(JSON.stringify(doc))
    ;(protectedDoc.nodes[1] as any).step.input.expression = {
      kind: 'call',
      fn: 'coalesce',
      args: [
        { kind: 'ref', key: 'data_in_branch' },
        { kind: 'literal', value: 'default_value' },
      ],
    }
    const resProtected = expandAuthoringDocument(protectedDoc, { ...baseContext, mode: 'publish' })
    expect(resProtected.diagnostics.some((d) => d.code === 'SCENARIO_CONDITIONAL_OUTPUT_REFERENCED')).toBe(false)
  })

  it('warns SCENARIO_OUTCOME_ONLY_IN_BRANCHES when all MUST outcomes are inside branches', () => {
    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'block',
          blockId: ID(70),
          name: '条件块',
          control: {
            type: 'if',
            condition: { kind: 'literal', value: true },
          },
          then: [
            {
              kind: 'step',
              step: {
                id: ID(71),
                name: '分支内断言',
                type: 'assert',
                effectType: 'READ_ONLY',
                input: {
                  expect: { kind: 'number_compare', op: 'eq', value: 1 },
                },
              },
            },
          ],
        },
      ],
    }

    const res = expandAuthoringDocument(doc, baseContext)
    expect(res.diagnostics.some((d) => d.code === 'SCENARIO_OUTCOME_ONLY_IN_BRANCHES' && d.severity === 'warning')).toBe(true)
  })

  it('deriveControlFlowManifest returns manifest with blocks or empty blocks protocol', () => {
    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'block',
          blockId: ID(80),
          control: { type: 'if', condition: { kind: 'literal', value: true } },
          then: [
            {
              kind: 'step',
              step: {
                id: ID(81),
                name: '步骤1',
                type: 'click',
                effectType: 'SIDE_EFFECT',
                input: { target: { candidates: [{ by: 'css', value: 'b' }] } },
              },
            },
          ],
        },
      ],
    }

    const manifest = deriveControlFlowManifest(doc)
    expect(manifest).toBeDefined()
    expect(manifest?.protocol).toBe(CONTROL_FLOW_PROTOCOL)
    expect(manifest?.blocks).toHaveLength(1)
    expect(manifest?.blocks[0]!.branches[0]!.stepIds).toEqual([ID(81)])

    // No blocks, but probe step present:
    const probeSteps: Step[] = [
      {
        id: ID(90),
        name: '探针',
        type: 'probe',
        effectType: 'READ_ONLY',
        input: { kind: 'url', urlPattern: '.*', waitMs: 1000 },
      },
    ]
    const probeManifest = deriveControlFlowManifest(null, probeSteps)
    expect(probeManifest).toBeDefined()
    expect(probeManifest?.blocks).toHaveLength(0)
  })

  describe('CF-C: Loop Blocks (for_each / repeat)', () => {
    it('expands for_each loop block and derives CONTROL_FLOW_PROTOCOL_V2', () => {
      const doc: ScenarioAuthoringDocumentV2 = {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [{ key: 'items', label: '列表', type: 'json' as any }],
        nodes: [
          {
            kind: 'block',
            blockId: ID(100),
            name: '遍历项目',
            control: {
              type: 'for_each',
              over: { from: 'items' },
              as: 'item',
              indexAs: 'idx',
              maxItems: 10,
            },
            body: [
              {
                kind: 'step',
                step: {
                  id: ID(101),
                  name: '点击当前项',
                  type: 'click',
                  effectType: 'SIDE_EFFECT',
                  input: { target: { candidates: [{ by: 'css', value: '.item' }] } },
                },
              },
            ],
            collect: [
              { from: 'item', into: 'collectedItems' },
            ],
          },
        ],
      }

      const res = expandAuthoringDocument(doc, baseContext)
      expect(res.ok).toBe(true)
      expect(res.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
      expect(res.definition).toBeDefined()
      expect(res.definition?.steps).toHaveLength(2)

      const [headerStep, bodyStep] = res.definition!.steps
      expect(headerStep!.type).toBe('loop')
      expect(bodyStep!.id).toBe(ID(101))

      expect(res.controlFlow).toBeDefined()
      expect(res.controlFlow?.protocol).toBe(CONTROL_FLOW_PROTOCOL_V2)
      expect(res.controlFlow?.blocks).toHaveLength(1)

      const block = res.controlFlow!.blocks[0]!
      expect(block.kind).toBe('for_each')
      expect(block.blockId).toBe(ID(100))
      expect((block as any).headerStepId).toBe(headerStep!.id)
      expect((block as any).bodyStepIds).toEqual([ID(101)])
      expect((block as any).limits?.maxItems).toBe(10)
      expect((block as any).collect).toEqual([{ from: 'item', into: 'collectedItems' }])
    })

    it('rejects authored loop step with LOOP_STEP_NOT_AUTHORABLE', () => {
      const doc: ScenarioAuthoringDocumentV2 = {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'step',
            step: {
              id: ID(110),
              name: '手动 loop 步骤',
              type: 'loop',
              effectType: 'READ_ONLY',
              input: {
                blockId: ID(110),
                control: { type: 'repeat', until: { kind: 'literal', value: true }, maxIterations: 5 },
              },
            },
          },
        ],
      }

      const res = expandAuthoringDocument(doc, baseContext)
      expect(res.ok).toBe(false)
      expect(res.diagnostics.some((d) => d.code === 'LOOP_STEP_NOT_AUTHORABLE')).toBe(true)
    })

    it('rejects variable conflict for loop variable as and indexAs', () => {
      const doc: ScenarioAuthoringDocumentV2 = {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [{ key: 'item', label: '现有输入', type: 'string' }],
        nodes: [
          {
            kind: 'block',
            blockId: ID(120),
            control: {
              type: 'for_each',
              over: { from: 'item' },
              as: 'item', // 冲突！
              maxItems: 5,
            },
            body: [
              {
                kind: 'step',
                step: {
                  id: ID(121),
                  name: '步骤1',
                  type: 'click',
                  effectType: 'SIDE_EFFECT',
                  input: { target: { candidates: [{ by: 'css', value: '.x' }] } },
                },
              },
            ],
          },
        ],
      }

      const res = expandAuthoringDocument(doc, baseContext)
      expect(res.ok).toBe(false)
      expect(res.diagnostics.some((d) => d.code === 'SCENARIO_VARIABLE_NAME_CONFLICT')).toBe(true)
    })

    it('rejects nested loop with SCENARIO_LOOP_NESTING_UNSUPPORTED', () => {
      const doc: ScenarioAuthoringDocumentV2 = {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [{ key: 'list1', label: '列表1', type: 'json' }, { key: 'list2', label: '列表2', type: 'json' }],
        nodes: [
          {
            kind: 'block',
            blockId: ID(130),
            control: { type: 'for_each', over: { from: 'list1' }, as: 'x', maxItems: 5 },
            body: [
              {
                kind: 'block',
                blockId: ID(131),
                control: { type: 'for_each', over: { from: 'list2' }, as: 'y', maxItems: 5 },
                body: [
                  {
                    kind: 'step',
                    step: {
                      id: ID(132),
                      name: '内部步骤',
                      type: 'click',
                      effectType: 'SIDE_EFFECT',
                      input: { target: { candidates: [{ by: 'css', value: '.y' }] } },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }

      const res = expandAuthoringDocument(doc, baseContext)
      expect(res.ok).toBe(false)
      expect(res.diagnostics.some((d) => d.code === 'SCENARIO_LOOP_NESTING_UNSUPPORTED')).toBe(true)
    })

    it('rejects out of scope reference without collect', () => {
      const doc: ScenarioAuthoringDocumentV2 = {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [{ key: 'items', label: '列表', type: 'json' }],
        nodes: [
          {
            kind: 'block',
            blockId: ID(140),
            control: { type: 'for_each', over: { from: 'items' }, as: 'item', maxItems: 5 },
            body: [
              {
                kind: 'step',
                step: {
                  id: ID(141),
                  name: '提取文本',
                  type: 'extract',
                  effectType: 'READ_ONLY',
                  input: { target: { candidates: [{ by: 'css', value: '.text' }] }, as: 'text' },
                  outputKey: 'itemText',
                },
              },
            ],
          },
          {
            kind: 'step',
            step: {
              id: ID(142),
              name: '循环外非法引用 itemText',
              type: 'echo',
              effectType: 'READ_ONLY',
              input: { from: 'itemText' },
            },
          },
        ],
      }

      const res = expandAuthoringDocument(doc, baseContext)
      expect(res.ok).toBe(false)
      expect(res.diagnostics.some((d) => d.code === 'SCENARIO_LOOP_OUTPUT_OUT_OF_SCOPE')).toBe(true)
    })

    it('allows referencing collected output outside the loop', () => {
      const doc: ScenarioAuthoringDocumentV2 = {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [{ key: 'items', label: '列表', type: 'json' }],
        nodes: [
          {
            kind: 'block',
            blockId: ID(150),
            control: { type: 'for_each', over: { from: 'items' }, as: 'item', maxItems: 5 },
            body: [
              {
                kind: 'step',
                step: {
                  id: ID(151),
                  name: '提取文本',
                  type: 'extract',
                  effectType: 'READ_ONLY',
                  input: { target: { candidates: [{ by: 'css', value: '.text' }] }, as: 'text' },
                  outputKey: 'itemText',
                },
              },
            ],
            collect: [{ from: 'itemText', into: 'allTexts' }],
          },
          {
            kind: 'step',
            step: {
              id: ID(152),
              name: '循环外引用 allTexts',
              type: 'verify_context',
              effectType: 'READ_ONLY',
              input: { keys: ['allTexts'] },
            },
          },
        ],
      }

      const res = expandAuthoringDocument(doc, baseContext)
      expect(res.ok).toBe(true)
      expect(res.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    })

    it('rejects action module invocation inside loop with SCENARIO_LOOP_MODULE_UNSUPPORTED', () => {
      const doc: ScenarioAuthoringDocumentV2 = {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [{ key: 'items', label: '列表', type: 'json' }],
        nodes: [
          {
            kind: 'block',
            blockId: ID(160),
            control: { type: 'for_each', over: { from: 'items' }, as: 'item', maxItems: 5 },
            body: [
              {
                kind: 'module',
                invocationId: ID(161),
                moduleId: ID(162),
                moduleVersionId: ID(163),
                inputBindings: {},
                outputBindings: {},
              },
            ],
          },
        ],
      }

      const res = expandAuthoringDocument(doc, baseContext)
      expect(res.ok).toBe(false)
      expect(res.diagnostics.some((d) => d.code === 'SCENARIO_LOOP_MODULE_UNSUPPORTED')).toBe(true)
    })

    it('rejects loop worst-case budget exceeded with SCENARIO_LOOP_BUDGET_EXCEEDED', () => {
      // 100 iterations * 25 steps per iteration = 2500 steps > 2000
      const stepsInBody: any[] = []
      for (let i = 1; i <= 25; i++) {
        stepsInBody.push({
          kind: 'step',
          step: {
            id: `00000000-0000-4000-8000-${String(200 + i).padStart(12, '0')}`,
            name: `步 ${i}`,
            type: 'click',
            effectType: 'SIDE_EFFECT',
            input: { target: { candidates: [{ by: 'css', value: `.btn-${i}` }] } },
          },
        })
      }

      const doc: ScenarioAuthoringDocumentV2 = {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [{ key: 'items', label: '列表', type: 'json' as any }],
        nodes: [
          {
            kind: 'block',
            blockId: ID(170),
            control: { type: 'for_each', over: { from: 'items' }, as: 'item', maxItems: 100 },
            body: stepsInBody,
          },
        ],
      }

      const res = expandAuthoringDocument(doc, baseContext)
      expect(res.ok).toBe(false)
      expect(res.diagnostics.some((d) => d.code === 'SCENARIO_LOOP_BUDGET_EXCEEDED')).toBe(true)
    })
  })
})
