import { describe, expect, it } from 'vitest'
import { isExecutableStepType, stepSchema } from '../step.js'

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

  it('拒绝未注册的 Step Type', () => {
    expect(() =>
      stepSchema.parse({
        id: echoId,
        name: '打开首页',
        type: 'navigate',
        effectType: 'IDEMPOTENT',
        input: { url: 'https://example.com' },
      }),
    ).toThrow()
    expect(isExecutableStepType('navigate')).toBe(false)
    expect(isExecutableStepType('fail')).toBe(true)
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
