import { describe, expect, it } from 'vitest'
import { isAiStepType, isBrowserStepType, isExecutableStepType, stepSchema, stepUsesBrowser } from '../step.js'

const echoId = '00000000-0000-4000-8000-000000000011'
const delayId = '00000000-0000-4000-8000-000000000012'
const failId = '00000000-0000-4000-8000-000000000013'

describe('stepSchema', () => {
  it('接受 Echo / Delay / Fail', () => {
    expect(
      stepSchema.parse({
        id: echoId,
        name: '回显订单号',
        type: 'echo',
        effectType: 'READ_ONLY',
        outputKey: 'order_id',
        input: { value: 'SO-1' },
      }),
    ).toMatchObject({ type: 'echo', outputKey: 'order_id' })

    expect(
      stepSchema.parse({
        id: delayId,
        name: '等待',
        type: 'delay',
        effectType: 'READ_ONLY',
        input: { durationMs: 50 },
      }),
    ).toMatchObject({ type: 'delay' })

    expect(
      stepSchema.parse({
        id: failId,
        name: '注入失败',
        type: 'fail',
        effectType: 'SIDE_EFFECT',
        input: { message: '提交后失联', category: 'UNKNOWN', retryable: false },
      }),
    ).toMatchObject({ type: 'fail', effectType: 'SIDE_EFFECT' })
  })

  it('Echo 可以用 from 引用 context', () => {
    expect(
      stepSchema.parse({
        id: echoId,
        name: '再回显',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { from: 'order_id' },
      }).input,
    ).toEqual({ from: 'order_id' })
  })

  it('Echo 必须恰好 value 或 from 一个', () => {
    expect(() =>
      stepSchema.parse({
        id: echoId,
        name: '空 echo',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: {},
      }),
    ).toThrow()

    expect(() =>
      stepSchema.parse({
        id: echoId,
        name: '双写 echo',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { value: 1, from: 'order_id' },
      }),
    ).toThrow()
  })

  it('接受 navigate / click，拒绝未注册类型', () => {
    expect(
      stepSchema.parse({
        id: echoId,
        name: '打开首页',
        type: 'navigate',
        effectType: 'IDEMPOTENT',
        input: { url: 'https://example.com' },
      }),
    ).toMatchObject({ type: 'navigate' })
    expect(isExecutableStepType('navigate')).toBe(true)
    expect(isBrowserStepType('click')).toBe(true)
    expect(isBrowserStepType('echo')).toBe(false)
    expect(isAiStepType('ai_action')).toBe(true)
    expect(stepUsesBrowser('ai_extract')).toBe(true)
    expect(isExecutableStepType('ai_assert')).toBe(true)
    expect(
      stepSchema.parse({
        id: echoId,
        name: 'AI 操作',
        type: 'ai_action',
        effectType: 'SIDE_EFFECT',
        input: { instruction: '查询订单' },
      }),
    ).toMatchObject({ type: 'ai_action' })
    expect(() =>
      stepSchema.parse({
        id: echoId,
        name: 'AI 操作',
        type: 'ai_action',
        effectType: 'READ_ONLY',
        input: { instruction: '查询订单' },
      }),
    ).toThrow()
    expect(() =>
      stepSchema.parse({
        id: echoId,
        name: 'AI 操作',
        type: 'ai_action',
        effectType: 'SIDE_EFFECT',
        policy: { retryLimit: 1 },
        input: { instruction: '查询订单' },
      }),
    ).toThrow()
  })

  it('接受 AI Extract / Assert，并锁定 effectType', () => {
    expect(
      stepSchema.parse({
        id: echoId,
        name: '提取',
        type: 'ai_extract',
        effectType: 'READ_ONLY',
        outputKey: 'order',
        input: {
          instruction: '读取订单号',
          outputSchema: { kind: 'object', fields: [{ name: 'orderNo', type: 'string' }] },
        },
      }),
    ).toMatchObject({ type: 'ai_extract' })
    expect(
      stepSchema.parse({
        id: echoId,
        name: '断言',
        type: 'ai_assert',
        effectType: 'READ_ONLY',
        input: { instruction: '结果页已出现成功提示' },
      }),
    ).toMatchObject({ type: 'ai_assert' })
    expect(() =>
      stepSchema.parse({
        id: echoId,
        name: '提取',
        type: 'ai_extract',
        effectType: 'SIDE_EFFECT',
        input: {
          instruction: '读取订单号',
          outputSchema: { kind: 'scalar', type: 'string' },
        },
      }),
    ).toThrow()
  })

  it('fromField 只能配合 from 使用', () => {
    expect(
      stepSchema.parse({
        id: echoId,
        name: '再回显',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { from: 'order', fromField: 'orderNo' },
      }).input,
    ).toEqual({ from: 'order', fromField: 'orderNo' })
    expect(() =>
      stepSchema.parse({
        id: echoId,
        name: '非法字段',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { value: 'x', fromField: 'orderNo' },
      }),
    ).toThrow()
  })

  it('css 候选只能放在最后；FrameStep 不许只有下标字段', () => {
    expect(() =>
      stepSchema.parse({
        id: echoId,
        name: '点',
        type: 'click',
        effectType: 'SIDE_EFFECT',
        input: {
          target: {
            candidates: [
              { by: 'css', value: '#a' },
              { by: 'text', value: '确定' },
            ],
          },
        },
      }),
    ).toThrow()
    expect(() =>
      stepSchema.parse({
        id: echoId,
        name: '点',
        type: 'click',
        effectType: 'SIDE_EFFECT',
        input: {
          target: {
            framePath: [{ index: 0 }],
            candidates: [{ by: 'text', value: '确定' }],
          },
        },
      }),
    ).toThrow()
  })

  it('不给浏览器步骤默认 effectType', () => {
    expect(() =>
      stepSchema.parse({
        id: echoId,
        name: '打开',
        type: 'navigate',
        input: { url: '/' },
      }),
    ).toThrow()
  })

  it('effectType 必填，不从 type 名推断', () => {
    expect(() =>
      stepSchema.parse({
        id: echoId,
        name: '回显',
        type: 'echo',
        input: { value: 1 },
      }),
    ).toThrow()
  })

  it('Delay 超过夹具上限被拒绝', () => {
    expect(() =>
      stepSchema.parse({
        id: delayId,
        name: '睡太久',
        type: 'delay',
        effectType: 'READ_ONLY',
        input: { durationMs: 300_001 },
      }),
    ).toThrow()
  })

  it('拒绝 Step 上的多余字段', () => {
    expect(() =>
      stepSchema.parse({
        id: echoId,
        name: '回显',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { value: 1 },
        selector: '#submit',
      }),
    ).toThrow()
  })
})
