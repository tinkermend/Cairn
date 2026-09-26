import { describe, expect, it } from 'vitest'
import {
  generatorTemplateIssues,
  evaluateGenerator,
  evaluateGeneratorWithUniqueness,
  materializeBatchInputs,
  type DataGeneratorSpec,
  type ScenarioInputDecl,
} from '../index.js'

describe('Data Generator Engine (DC-01, DC-02)', () => {
  it('生成器宏目录与求值器接受相同语法，并拒绝未知宏', () => {
    expect(generatorTemplateIssues('商品_{{rand:8}}')).toEqual([])
    expect(String(evaluateGenerator({ kind: 'template', pattern: '商品_{{rand:8}}', unique: false }))).toMatch(/^商品_[A-Za-z0-9]{8}$/)
    expect(generatorTemplateIssues('商品_{{random_string}}')).toHaveLength(1)
    expect(() => evaluateGenerator({ kind: 'template', pattern: '商品_{{random_string}}', unique: false })).toThrow('不支持的生成器宏')
  })
  it('DC-01（随机数值范围与精度）：100 次求值严格落在 [10, 20] 且小数位不超过 2 位', () => {
    const spec: DataGeneratorSpec = {
      kind: 'random_number',
      min: 10,
      max: 20,
      precision: 2,
    }

    for (let i = 0; i < 100; i++) {
      const val = evaluateGenerator(spec)
      expect(typeof val).toBe('number')
      const num = val as number
      expect(num).toBeGreaterThanOrEqual(10)
      expect(num).toBeLessThanOrEqual(20)

      const str = num.toString()
      const decimals = str.includes('.') ? str.split('.')[1]!.length : 0
      expect(decimals).toBeLessThanOrEqual(2)
    }
  })

  it('DC-02（批次内全局唯一性）：开启 unique: true，生成 500 个 SKU 无重复', () => {
    const spec: DataGeneratorSpec = {
      kind: 'random_string',
      prefix: 'SKU_',
      length: 12,
      charset: 'alphanumeric',
      unique: true,
    }

    const usedSets = new Map<string, Set<string | number>>()
    const generated = new Set<string | number>()

    for (let i = 0; i < 500; i++) {
      const val = evaluateGeneratorWithUniqueness(spec, 'sku', usedSets)
      expect(typeof val).toBe('string')
      expect(generated.has(val as string)).toBe(false)
      generated.add(val as string)
    }

    expect(generated.size).toBe(500)
  })

  it('模板生成器支持日期插槽与随机串插槽', () => {
    const spec: DataGeneratorSpec = {
      kind: 'template',
      pattern: 'ITEM_{{date.YYYYMMDD}}_{{rand.6}}',
      unique: true,
    }

    const val = evaluateGenerator(spec) as string
    expect(val).toMatch(/^ITEM_\d{8}_[a-zA-Z0-9]{6}$/)
  })

  it('预置规则生成有效手机号、身份证与中文名称', () => {
    const phone = evaluateGenerator({ kind: 'mock_preset', preset: 'phone_cn', unique: false }) as string
    expect(phone).toMatch(/^1[3-9]\d{9}$/)

    const idCard = evaluateGenerator({ kind: 'mock_preset', preset: 'id_card_cn', unique: false }) as string
    expect(idCard).toMatch(/^\d{17}[\dX]$/)

    const name = evaluateGenerator({ kind: 'mock_preset', preset: 'name_cn', unique: false }) as string
    expect(name.length).toBeGreaterThanOrEqual(2)

    const email = evaluateGenerator({ kind: 'mock_preset', preset: 'email', unique: false }) as string
    expect(email).toMatch(/^user_[a-f0-9]+@test\.com$/)
  })

  it('materializeBatchInputs 跨行排重并补全缺省入参', () => {
    const schemaInputs: ScenarioInputDecl[] = [
      { key: 'orderNo', label: '订单号', type: 'string', required: true, defaultGenerator: { kind: 'random_string', prefix: 'ORD_', length: 8, charset: 'numeric', unique: true } },
      { key: 'customerName', label: '客户姓名', type: 'string', required: true, defaultGenerator: { kind: 'mock_preset', preset: 'name_cn', unique: false } },
    ]

    const rawRows = [
      { orderNo: 'EXISTING_001', customerName: '' },
      { orderNo: '', customerName: '张三' },
      { orderNo: '', customerName: '' },
    ]

    const materialized = materializeBatchInputs(schemaInputs, rawRows)
    expect(materialized).toHaveLength(3)
    expect(materialized[0]!['orderNo']).toBe('EXISTING_001')
    expect(typeof materialized[0]!['customerName']).toBe('string')
    expect(materialized[0]!['customerName']).not.toBe('')

    expect(String(materialized[1]!['orderNo'])).toMatch(/^ORD_\d{8}$/)
    expect(materialized[1]!['customerName']).toBe('张三')

    expect(String(materialized[2]!['orderNo'])).toMatch(/^ORD_\d{8}$/)
    expect(materialized[1]!['orderNo']).not.toBe(materialized[2]!['orderNo'])
  })
})
