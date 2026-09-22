import { describe, expect, it } from 'vitest'
import {
  parseExcelOrCsv,
  buildResultWorkbook,
} from '../index.js'

describe('Dataset Parser Engine (DC-04, DC-05)', () => {
  it('DC-04（前导零与长文本防失真）：Excel 中 00892 与 13 位条码保持原样纯文本', () => {
    // 构造包含货号 00892 和 13 位条码 6901234567890 的工作簿
    const bytes = buildResultWorkbook([
      {
        name: '商品清单',
        columns: ['货号', '条形码', '商品名称', '价格'],
        rows: [
          ['00892', '6901234567890', '特制保温杯', '89.90'],
          ['00015', '6909876543210', '便携雨伞', '35.00'],
        ],
      },
    ])

    const parsed = parseExcelOrCsv(bytes, 'products.xlsx')
    expect(parsed.sourceType).toBe('excel')
    expect(parsed.activeSheet.name).toBe('商品清单')
    expect(parsed.activeSheet.rowCount).toBe(2)

    const row1 = parsed.activeSheet.rows[0]!
    const colCode = parsed.activeSheet.columns.find((c) => c.name === '货号')!
    const colBarcode = parsed.activeSheet.columns.find((c) => c.name === '条形码')!

    // 严格断言：前导零未丢失，长数字未转为科学计数法
    expect(row1[colCode.key]).toBe('00892')
    expect(row1[colBarcode.key]).toBe('6901234567890')
    expect(row1[colBarcode.key]).not.toContain('E+')
    expect(row1[colBarcode.key]).not.toContain('e+')
  })

  it('DC-05（幽灵空行剔除）：末尾带 200 行空白样式行时，rowCount 精确等于真实数据行数', () => {
    const realRows = [
      ['SKU_001', '商品A'],
      ['SKU_002', '商品B'],
      ['SKU_003', '商品C'],
    ]
    const emptyRows = Array.from({ length: 200 }, () => ['', '   '])

    const bytes = buildResultWorkbook([
      {
        name: 'Sheet1',
        columns: ['SKU', '名称'],
        rows: [...realRows, ...emptyRows],
      },
    ])

    const parsed = parseExcelOrCsv(bytes, 'inventory.xlsx')
    expect(parsed.activeSheet.rowCount).toBe(3)
    expect(parsed.activeSheet.rows).toHaveLength(3)
  })

  it('CSV 格式解析支持双引号转义与 UTF-8 BOM', () => {
    const csvContent = '\uFEFF"货号","标题","描述"\n"00123","无线鼠标","静音, 人体工学"\n"00456","机械键盘","""青轴"" 背光"'
    const bytes = new TextEncoder().encode(csvContent)

    const parsed = parseExcelOrCsv(bytes, 'data.csv')
    expect(parsed.sourceType).toBe('csv')
    expect(parsed.activeSheet.rowCount).toBe(2)

    const row1 = parsed.activeSheet.rows[0]!
    const row2 = parsed.activeSheet.rows[1]!

    const colCode = parsed.activeSheet.columns.find((c) => c.name === '货号')!
    const colDesc = parsed.activeSheet.columns.find((c) => c.name === '描述')!

    expect(row1[colCode.key]).toBe('00123')
    expect(row1[colDesc.key]).toBe('静音, 人体工学')
    expect(row2[colDesc.key]).toBe('"青轴" 背光')
  })
})
