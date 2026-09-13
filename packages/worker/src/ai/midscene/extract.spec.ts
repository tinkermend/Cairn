import { describe, expect, it } from 'vitest'
import { buildDataDemand, detectFabrication, takeStringField } from './extract.js'

describe('buildDataDemand', () => {
  // 键名只写在 instruction 里的话，模型会照措辞自造中文键名，之后被平台判为含未声明字段。
  it('把声明的字段名和类型带进提示', () => {
    const demand = buildDataDemand('读取表格第一行', {
      kind: 'object',
      fields: [
        { name: 'orderNo', type: 'string', required: true },
        { name: 'amount', type: 'number' },
        { name: 'note', type: 'string', required: false },
      ],
    })
    expect(demand).toContain('orderNo: string')
    expect(demand).toContain('amount: number')
    expect(demand).toContain('note?: string')
    expect(demand).toContain('读取表格第一行')
  })

  it('标量输出带上类型', () => {
    expect(buildDataDemand('读取总数', { kind: 'scalar', type: 'number' })).toBe('number, 读取总数')
  })

  it('没有声明 Schema 时原样透传', () => {
    expect(buildDataDemand('随便读点什么', undefined)).toBe('随便读点什么')
  })
})

describe('takeStringField', () => {
  it('只接受字符串字段', () => {
    expect(takeStringField({ orderNo: 'SO-1001' }, 'orderNo')).toEqual({ ok: true, value: 'SO-1001' })
    expect(takeStringField({ orderNo: { n: 1 } }, 'orderNo')).toEqual({ ok: false, reason: 'not_string' })
    expect(takeStringField({}, 'orderNo')).toEqual({ ok: false, reason: 'missing' })
  })

  it('页面没有该值则视为编造', () => {
    expect(detectFabrication('查到 0 条，页面没有单号。', 'SO-9999')).toBe(true)
    expect(detectFabrication('单号 SO-1001', 'SO-1001')).toBe(false)
  })
})
