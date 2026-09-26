import { describe, expect, it } from 'vitest'
import { parseAiOutput } from '@cairn/shared'
import { buildDataDemand, detectFabrication } from '../midscene/extract.js'

describe('CFA-13: AI 提取列表', () => {
  const schema = {
    kind: 'list' as const,
    item: {
      kind: 'object' as const,
      fields: [
        { name: 'orderNo', type: 'string' as const },
        { name: 'amount', type: 'number' as const },
      ],
    },
    maxItems: 3,
  }

  it('Midscene 提示包含上限与数组标记', () => {
    const demand = buildDataDemand('提取表格前几行', schema)
    expect(demand).toBe('{orderNo: string, amount: number}[]，最多 3 项，只返回这些键，键名原样使用。提取表格前几行')
  })

  it('合法列表数据成功解析', () => {
    const raw = [
      { orderNo: 'SO-101', amount: 100 },
      { orderNo: 'SO-102', amount: 200 },
    ]
    const parsed = parseAiOutput(raw, schema)
    expect(parsed).toEqual({
      ok: true,
      value: [
        { orderNo: 'SO-101', amount: 100 },
        { orderNo: 'SO-102', amount: 200 },
      ],
    })
  })

  it('超过上限返回 AI_OUTPUT_INVALID 并带有实际数量', () => {
    const raw = [
      { orderNo: 'SO-101', amount: 100 },
      { orderNo: 'SO-102', amount: 200 },
      { orderNo: 'SO-103', amount: 300 },
      { orderNo: 'SO-104', amount: 400 },
    ]
    const parsed = parseAiOutput(raw, schema)
    expect(parsed).toEqual({
      ok: false,
      code: 'AI_OUTPUT_INVALID',
      message: '提取结果超过上限 3 项（实际 4 项）',
    })
  })

  it('字段类型错误或缺必填字段失败', () => {
    const badType = [
      { orderNo: 'SO-101', amount: 'not-a-number' },
    ]
    expect(parseAiOutput(badType, schema).ok).toBe(false)

    const missingField = [
      { orderNo: 'SO-101' },
    ]
    expect(parseAiOutput(missingField, schema).ok).toBe(false)
  })

  it('编造检测：页面文本中不包含的值被识别为编造', () => {
    const pageText = '欢迎访问商城。当前订单 SO-101 金额 100，SO-102 金额 200。'
    expect(detectFabrication(pageText, 'SO-101')).toBe(false)
    expect(detectFabrication(pageText, 'SO-999')).toBe(true)
  })
})
