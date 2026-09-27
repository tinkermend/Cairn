import { describe, expect, it } from 'vitest'
import { extractStepStructureFacts } from './step-structure-facts.js'
import type { Step } from '@cairn/shared'

describe('extractStepStructureFacts (M4 - Step Structure Fact Extractor)', () => {
  it('当步骤 ID 在场景中不存在时，诚实返回 found: false', () => {
    const scenario = {
      steps: [
        {
          id: 'step-1',
          name: '点击按钮',
          type: 'click' as const,
          effectType: 'READ_ONLY' as const,
          input: {
            target: {
              candidates: [{ by: 'text' as const, value: '点击' }],
              framePath: [],
            },
          },
        } as Step,
      ],
    }

    const result = extractStepStructureFacts(scenario, 'non-existent-step-id')
    expect(result.found).toBe(false)
    expect(result.facts).toEqual([])
  })

  it('全面解析：选中含 CSS 候选、变量依赖、紧邻 decide 与 assert 的步骤', () => {
    const steps: Step[] = [
      {
        id: 'step-nav',
        name: '打开订单列表',
        type: 'navigate' as const,
        effectType: 'READ_ONLY' as const,
        input: { url: 'https://erp.example.com/orders' },
        outputKey: 'orderPageUrl',
      } as Step,
      {
        id: 'step-decide',
        name: '检查是否已登录',
        type: 'decide' as const,
        effectType: 'READ_ONLY' as const,
        input: {
          blockId: 'block-auth',
          condition: { kind: 'field', from: 'isLoggedIn', op: 'eq', value: true } as any,
        },
      } as Step,
      {
        id: 'step-target',
        name: '输入搜索关键词',
        type: 'fill' as const,
        effectType: 'IDEMPOTENT' as const,
        policy: {
          retryLimit: 3,
          timeoutMs: 5000,
        },
        input: {
          target: {
            candidates: [
              { by: 'role' as const, name: '搜索框', value: 'searchbox' },
              { by: 'css' as const, value: 'input.order-search-input' },
            ],
            anchor: {
              withinText: '订单号搜索',
              scope: 'row' as const,
            },
            semantic: '表格上方的订单搜索输入框',
            framePath: [],
          },
          from: 'orderPageUrl',
          fromField: 'query',
        },
        outputKey: 'searchedKeyword',
      } as Step,
      {
        id: 'step-assert',
        name: '验证搜索结果可见',
        type: 'assert' as const,
        effectType: 'READ_ONLY' as const,
        input: {
          target: {
            candidates: [{ by: 'text' as const, value: '搜索完成' }],
            framePath: [],
          },
          expect: {
            visible: true,
          },
        },
      } as unknown as Step,
      {
        id: 'step-extract',
        name: '提取查询结果列表',
        type: 'extract' as const,
        effectType: 'READ_ONLY' as const,
        input: {
          target: {
            candidates: [{ by: 'css' as const, value: '.order-row' }],
            framePath: [],
          },
          as: 'text' as const,
        },
        fieldRefs: {
          'search.filter': {
            from: 'searchedKeyword',
          },
        },
      } as Step,
    ]

    const result = extractStepStructureFacts({ steps }, 'step-target')
    expect(result.found).toBe(true)

    // 1. 基础信息
    const baseFact = result.facts.find((f) => f.citation === 'step:step-target')
    expect(baseFact).toBeDefined()
    expect(baseFact!.fact).toContain('步骤名: 输入搜索关键词')
    expect(baseFact!.fact).toContain('步骤类型: fill')

    // 2. 选择器与定位 (step:step-target:selector)
    const selectorFact = result.facts.find((f) => f.citation === 'step:step-target:selector')
    expect(selectorFact).toBeDefined()
    expect(selectorFact!.fact).toContain('css: input.order-search-input (CSS 选择器定位)')
    expect(selectorFact!.fact).toContain('role: [搜索框] searchbox')
    expect(selectorFact!.fact).toContain('相对锚点: 邻近文本 "订单号搜索"')
    expect(selectorFact!.fact).toContain('自然语言语义描述: "表格上方的订单搜索输入框"')

    // 3. 变量读写依赖 (step:step-target:vars)
    const varsFact = result.facts.find((f) => f.citation === 'step:step-target:vars')
    expect(varsFact).toBeDefined()
    expect(varsFact!.fact).toContain('输出变量 (outputKey): 将操作结果写入 context 键「searchedKeyword」')
    expect(varsFact!.fact).toContain('下游直接引用步骤: 第 5 步「提取查询结果列表」')
    expect(varsFact!.fact).toContain('读取变量 (from): 引用上游 context 键「orderPageUrl」 (字段: query)')
    expect(varsFact!.fact).toContain('上游依赖步骤: 第 1 步「打开订单列表」')

    // 4. 控制流上下文 (step:step-target:flow)
    const flowFact = result.facts.find((f) => f.citation === 'step:step-target:flow')
    expect(flowFact).toBeDefined()
    expect(flowFact!.fact).toContain('直接前驱步骤: 第 2 步「检查是否已登录」')
    expect(flowFact!.fact).toContain('直接后继步骤: 第 4 步「验证搜索结果可见」')
    expect(flowFact!.fact).toContain('配置了单步自动重试 (retryLimit: 3 次)')
    expect(flowFact!.fact).toContain('超时上限: 5000ms')
    expect(flowFact!.fact).toContain('紧邻前置分支判定步骤「检查是否已登录」')

    // 5. 邻近断言 (step:step-target:assertion)
    const assertFact = result.facts.find((f) => f.citation === 'step:step-target:assertion')
    expect(assertFact).toBeDefined()
    expect(assertFact!.fact).toContain('后置断言: 第 4 步「验证搜索结果可见」进行了校验')
  })

  it('支持从草稿 AST 结构中提取并解析独立步骤与 AI 视觉步骤', () => {
    const draft = {
      document: {
        schemaVersion: 2,
        nodes: [
          {
            kind: 'step',
            step: {
              id: 'ai-step-1',
              name: '智能点击提交',
              type: 'ai_action',
              effectType: 'SIDE_EFFECT',
              input: {
                instruction: '点击左下角的确认支付按钮',
              },
            },
          },
          {
            kind: 'step',
            step: {
              id: 'ai-step-2',
              name: '智能验证成功提示',
              type: 'ai_assert',
              effectType: 'READ_ONLY',
              input: {
                assertion: '页面出现支付成功提示',
              },
            },
          },
        ],
      },
    }

    const result = extractStepStructureFacts({ draft } as any, 'ai-step-1')
    expect(result.found).toBe(true)

    const selectorFact = result.facts.find((f) => f.citation === 'step:ai-step-1:selector')
    expect(selectorFact!.fact).toContain('AI 视觉操作步骤，指令: "点击左下角的确认支付按钮"')

    const varsFact = result.facts.find((f) => f.citation === 'step:ai-step-1:vars')
    expect(varsFact!.fact).toContain('该步骤为独立执行单元，无变量写入')

    const assertFact = result.facts.find((f) => f.citation === 'step:ai-step-1:assertion')
    expect(assertFact!.fact).toContain('当前步骤自身及紧邻的前后步骤均未配置 assert 断言校验')
  })

  it('识别 ai_action 原子操作 operation=input 对上游变量的读取依赖', () => {
    const steps: Step[] = [
      {
        id: 'step-search',
        name: '搜索订单',
        type: 'fill' as const,
        effectType: 'IDEMPOTENT' as const,
        input: {
          target: { candidates: [{ by: 'css' as const, value: '#search' }], framePath: [] },
          value: '订单123',
        },
        outputKey: 'orderKeyword',
      } as Step,
      {
        id: 'ai-step-input',
        name: 'AI 智能填充备注',
        type: 'ai_action' as const,
        effectType: 'SIDE_EFFECT' as const,
        input: {
          operation: 'input',
          targetDescription: '备注输入框',
          mode: 'replace',
          from: 'orderKeyword',
          fromField: 'value',
        },
      } as unknown as Step,
    ]

    const result = extractStepStructureFacts({ steps }, 'ai-step-input')
    expect(result.found).toBe(true)

    const selectorFact = result.facts.find((f) => f.citation === 'step:ai-step-input:selector')
    expect(selectorFact!.fact).toContain('AI 视觉原子操作: input')
    expect(selectorFact!.fact).toContain('目标描述: "备注输入框"')
    expect(selectorFact!.fact).toContain('输入来源: 引用 context 键「orderKeyword」 (字段: value)')

    const varsFact = result.facts.find((f) => f.citation === 'step:ai-step-input:vars')
    expect(varsFact!.fact).toContain('读取变量 (from): 引用上游 context 键「orderKeyword」 (字段: value)')
    expect(varsFact!.fact).toContain('上游依赖步骤: 第 1 步「搜索订单」(输出「orderKeyword」)')
    expect(varsFact!.fact).not.toContain('该步骤为独立执行单元')
  })
})
