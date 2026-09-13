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
