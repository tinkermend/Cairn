import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantCapabilityHandlerContext } from '../registry.js'

vi.mock('@cairn/db', () => ({
  getScenario: vi.fn(),
  loadScenarioVersion: vi.fn(),
  DomainError: class DomainError extends Error {
    constructor(public kind: string, public code: string, message: string) { super(message) }
  },
}))
vi.mock('./common.js', () => ({ requireVisibleTarget: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../model-session.js', () => ({
  generateExplanationText: vi.fn().mockResolvedValue({ summary: '已按全部步骤解释。' }),
}))

import { getScenario } from '@cairn/db'
import { generateExplanationText } from '../model-session.js'
import { handleScenarioExplain } from './explain.handler.js'

const SCENARIO_ID = '33333333-3333-4333-8333-333333333333'
const STEP_ID = '11111111-1111-4111-8111-111111111111'

function context(question: string): AssistantCapabilityHandlerContext {
  return {
    db: {} as never,
    actor: { id: 'author', displayName: 'Author', email: 'author@example.com', status: 'active', roles: [],
      permissions: ['target:read', 'workflow:read', 'ai:assist'] },
    slots: { scenarioId: SCENARIO_ID, stepId: STEP_ID },
    question,
    body: { question },
    session: { completeJson: vi.fn() } as never,
    platformConfig: {} as never,
    targets: {} as never,
    models: {} as never,
  }
}

function savedScenario() {
  return {
    id: SCENARIO_ID, name: '密钥查询', targetId: '44444444-4444-4444-8444-444444444444',
    draft: { revision: 3, document: {
      schemaVersion: 1,
      inputs: [{ key: 'keyName', label: '密钥名称', type: 'string' }],
      steps: [
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '打开页面', type: 'navigate',
          effectType: 'READ_ONLY', input: { url: 'https://example.com/keys' } },
        { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: '刷新密钥列表', type: 'navigate',
          effectType: 'READ_ONLY', input: { url: 'https://example.com/keys' } },
        { id: STEP_ID, name: '按名称查询', type: 'fill', effectType: 'READ_ONLY',
          input: { target: { framePath: [], candidates: [{ by: 'label', value: '搜索密钥' }] }, from: 'keyName' } },
      ],
    } },
  }
}

describe('explain.handler 相邻步骤事实', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getScenario).mockResolvedValue(savedScenario() as never)
  })

  it('从完整已保存定义定位前一步与场景输入，不把相邻步骤误称为 keyName 来源', async () => {
    const ctx = context('这一步用的 keyName 从哪来？删掉前一步会怎样？')
    const result = await handleScenarioExplain(ctx)
    expect(result.kind).toBe('explanation')
    if (result.kind !== 'explanation') return
    expect(result.stepSummary).toContain('绑定 keyName 来自场景输入')
    expect(result.stepSummary).toContain('紧邻前一步是「刷新密钥列表」（navigate）')
    expect(result.stepSummary).toContain('删除它不会删除场景输入 keyName')
    expect(ctx.session!.completeJson).not.toHaveBeenCalled()
  })

  it('问句中不存在的 customerId 不被描述为当前步骤引用', async () => {
    const result = await handleScenarioExplain(context('这一步用的 customerId 从哪来？删掉前一步会怎样？'))
    expect(result.kind).toBe('explanation')
    if (result.kind !== 'explanation') return
    expect(result.stepSummary).toContain('这一步没有引用 customerId，实际引用的是 keyName')
  })
})

describe('explain.handler 场景范围与成功条件', () => {
  const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const outcomeStepId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getScenario).mockResolvedValue({
      id: SCENARIO_ID,
      name: '实例查看',
      targetId: '44444444-4444-4444-8444-444444444444',
      draft: {
        revision: 16,
        document: {
          authoringSchemaVersion: 2,
          schemaVersion: 1,
          inputs: [],
          nodes: [
            { kind: 'step', step: { id: firstId, name: '打开页面', type: 'navigate',
              effectType: 'READ_ONLY', input: { url: 'https://example.com/instances' } } },
            { kind: 'step', step: { id: outcomeStepId, name: '查看 Mysql50.33 实例', type: 'click',
              effectType: 'READ_ONLY', input: { target: { framePath: [], candidates: [{ by: 'text', value: 'Mysql50.33' }] } } },
              outcomes: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', scope: 'step',
                meaning: '打开实例后看到 Mysql50.33', severity: 'MUST', onViolation: 'halt',
                provenance: 'manual', rule: { kind: 'deterministic', expect: { kind: 'exists' } } }] },
          ],
        },
      },
    } as never)
  })

  it('页面选中第一步时，全场景成功问题仍关联实际来源步骤并直接依据保存定义回答', async () => {
    const ctx = context('这个场景如何判断成功？')
    ctx.slots.stepId = firstId
    const result = await handleScenarioExplain(ctx)
    expect(result.kind).toBe('explanation')
    if (result.kind !== 'explanation') return
    expect(result.summary).toContain('MUST「打开实例后看到 Mysql50.33」')
    expect(result.summary).toContain('关联步骤「查看 Mysql50.33 实例」（点击）')
    expect(result.summary).toContain('检查目标元素存在，不满足时中止')
    expect(result.summary).not.toContain('关联步骤未包含')
    expect(result.stepSummary).toBeUndefined()
    expect(generateExplanationText).not.toHaveBeenCalled()
  })

  it('页面选中第一步时，问全场景用途会把全部步骤交给解释模型', async () => {
    const ctx = context('这个场景在做什么？')
    ctx.slots.stepId = firstId
    const result = await handleScenarioExplain(ctx)
    expect(result.kind).toBe('explanation')
    if (result.kind !== 'explanation') return
    expect(result.stepSummary).toBeUndefined()
    const facts = vi.mocked(generateExplanationText).mock.calls[0]?.[2] as { selectedStepId: string | null; steps: { id: string }[] }
    expect(facts.selectedStepId).toBeNull()
    expect(facts.steps.map((step) => step.id)).toEqual([firstId, outcomeStepId])
  })

  it('问选中步骤的成功标准时，不把另一节点的条件误归给它', async () => {
    const ctx = context('这一步如何判断成功？')
    ctx.slots.stepId = firstId
    const result = await handleScenarioExplain(ctx)
    expect(result.kind).toBe('explanation')
    if (result.kind !== 'explanation') return
    expect(result.stepSummary).toContain('这个步骤没有直接关联的成功条件')
    expect(result.stepSummary).not.toContain('关联步骤未包含')
    expect(generateExplanationText).not.toHaveBeenCalled()
  })

  it('要求按步骤说明时列出已保存顺序，即使页面选中第一步', async () => {
    const ctx = context('这个场景具体做什么？请按步骤说明。')
    ctx.slots.stepId = firstId
    const result = await handleScenarioExplain(ctx)
    expect(result.kind).toBe('explanation')
    if (result.kind !== 'explanation') return
    expect(result.summary).toContain('1.「打开页面」（导航）')
    expect(result.summary).toContain('2.「查看 Mysql50.33 实例」（点击）')
    expect(result.stepSummary).toBeUndefined()
    expect(generateExplanationText).not.toHaveBeenCalled()
  })

  it('同时问步骤和成功标准时两项都回答，不把配置当成运行通过', async () => {
    const ctx = context('这个场景具体做什么？请按步骤说明，并告诉我它如何判断成功。')
    ctx.slots.stepId = firstId
    const result = await handleScenarioExplain(ctx)
    expect(result.kind).toBe('explanation')
    if (result.kind !== 'explanation') return
    expect(result.summary).toContain('1.「打开页面」（导航）')
    expect(result.summary).toContain('2.「查看 Mysql50.33 实例」（点击）')
    expect(result.summary).toContain('MUST「打开实例后看到 Mysql50.33」')
    expect(result.summary).toContain('关联步骤「查看 Mysql50.33 实例」')
    expect(result.summary).toContain('不代表场景已经运行通过')
    expect(generateExplanationText).not.toHaveBeenCalled()
  })
})
