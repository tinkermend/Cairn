import { describe, expect, it } from 'vitest'
import {
  fillTextFromContext,
  parseAiOutput,
  readContextValue,
  scalarToFillText,
} from '../output-schema.js'

describe('parseAiOutput', () => {
  it('接受标量并拒绝类型错误', () => {
    expect(parseAiOutput('SO-1', { kind: 'scalar', type: 'string' })).toEqual({
      ok: true,
      value: 'SO-1',
    })
    expect(parseAiOutput(1, { kind: 'scalar', type: 'string' }).ok).toBe(false)
  })

  it('对象拒绝未声明字段和缺必填', () => {
    const schema = {
      kind: 'object' as const,
      fields: [
        { name: 'orderNo', type: 'string' as const },
        { name: 'paid', type: 'boolean' as const, required: false },
      ],
    }
    expect(parseAiOutput({ orderNo: 'A-1' }, schema)).toEqual({
      ok: true,
      value: { orderNo: 'A-1' },
    })
    expect(parseAiOutput({ orderNo: 'A-1', extra: 1 }, schema).ok).toBe(false)
    expect(parseAiOutput({ paid: true }, schema).ok).toBe(false)
  })

  // 页面还没渲染完时模型会回空串。必填放行空值等于把错误传给后续步骤。
  it('必填字符串不接受空值，可选字段仍允许空串', () => {
    const schema = {
      kind: 'object' as const,
      fields: [
        { name: 'orderNo', type: 'string' as const },
        { name: 'note', type: 'string' as const, required: false },
      ],
    }
    expect(parseAiOutput({ orderNo: '' }, schema).ok).toBe(false)
    expect(parseAiOutput({ orderNo: '   ' }, schema).ok).toBe(false)
    expect(parseAiOutput({ orderNo: 'A-1', note: '' }, schema)).toEqual({
      ok: true,
      value: { orderNo: 'A-1', note: '' },
    })
  })

  it('列表型输出正常解析标量与对象列表', () => {
    const scalarListSchema = {
      kind: 'list' as const,
      item: { kind: 'scalar' as const, type: 'string' as const },
      maxItems: 5,
    }
    expect(parseAiOutput(['A', 'B'], scalarListSchema)).toEqual({
      ok: true,
      value: ['A', 'B'],
    })

    const objectListSchema = {
      kind: 'list' as const,
      item: {
        kind: 'object' as const,
        fields: [{ name: 'id', type: 'number' as const }],
      },
      maxItems: 2,
    }
    expect(parseAiOutput([{ id: 1 }, { id: 2 }], objectListSchema)).toEqual({
      ok: true,
      value: [{ id: 1 }, { id: 2 }],
    })
  })

  it('列表型输出超过 maxItems 或格式错误时拒绝', () => {
    const listSchema = {
      kind: 'list' as const,
      item: { kind: 'scalar' as const, type: 'string' as const },
      maxItems: 2,
    }
    expect(parseAiOutput(['A', 'B', 'C'], listSchema)).toEqual({
      ok: false,
      code: 'AI_OUTPUT_INVALID',
      message: '提取结果超过上限 2 项（实际 3 项）',
    })
    expect(parseAiOutput('not-array', listSchema)).toEqual({
      ok: false,
      code: 'AI_OUTPUT_INVALID',
      message: '提取结果必须是数组',
    })
    expect(parseAiOutput(['A', 123], listSchema).ok).toBe(false)
  })
})

describe('fillTextFromContext', () => {
  it('有 fromField 时只取标量字段', () => {
    expect(fillTextFromContext({ order: { orderNo: 'A-1' } }, 'order', 'orderNo')).toEqual({
      ok: true,
      text: 'A-1',
    })
    expect(fillTextFromContext({ order: { orderNo: 'A-1' } }, 'order', 'missing').ok).toBe(false)
  })

  it('没有 fromField 时保留旧的 JSON.stringify', () => {
    expect(fillTextFromContext({ order: { orderNo: 'A-1' } }, 'order')).toEqual({
      ok: true,
      text: '{"orderNo":"A-1"}',
    })
    expect(scalarToFillText({ orderNo: 'A-1' }).ok).toBe(false)
  })
})

describe('readContextValue', () => {
  it('拒绝保留属性名', () => {
    expect(readContextValue({ order: { constructor: 'x' } }, 'order', 'constructor').ok).toBe(false)
  })
})
