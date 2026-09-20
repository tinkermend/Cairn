import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  excelFile,
  guessMapping,
  mappedRows,
  readExcel,
  templateRows,
} from './excel'

describe('Excel 凭据导入边界', () => {
  it('文本模板保留前导零、Unicode、前后空格与等号文本；空密码跳过', () => {
    const bytes = excelFile([
      ['目标系统编码', '登录名', '新密码'],
      ['CRM', '000001', '  密码🔑  '],
      ['CRM', '12345678901234567890', '=secret'],
      ['CRM', 'bob', ''],
    ])
    const sheet = readExcel(bytes).sheets[0]!
    const rows = mappedRows(sheet, guessMapping(sheet))
    expect(rows.map((r) => r.values.password)).toEqual([
      '  密码🔑  ',
      '=secret',
      undefined,
    ])
    expect(rows[0]?.values.username).toBe('000001')
    expect(rows[1]?.values.username).toBe('12345678901234567890')
    expect(rows[2]?.skip).toBe(true)
    expect(rows.every((r) => !r.error)).toBe(true)
    expect(JSON.stringify(rows.map((r) => r.match))).not.toContain('密码🔑')
  })
  it('真正公式与数字登录名 / 密码不能用缓存或转字符串绕过', () => {
    const files = unzipSync(
      excelFile([
        ['目标系统编码', '登录名', '新密码'],
        ['CRM', '001', 'secret'],
      ])
    )
    files['xl/worksheets/sheet1.xml'] = strToU8(
      strFromU8(files['xl/worksheets/sheet1.xml']!)
        .replace(
          '<c r="B2" t="inlineStr" s="0"><is><t xml:space="preserve">001</t></is></c>',
          '<c r="B2"><v>1</v></c>'
        )
        .replace(
          '<c r="C2" t="inlineStr" s="0"><is><t xml:space="preserve">secret</t></is></c>',
          '<c r="C2" t="str"><f>SECRET()</f><v>cached-password</v></c>'
        )
    )
    const sheet = readExcel(zipSync(files)).sheets[0]!
    const row = mappedRows(sheet, guessMapping(sheet))[0]!
    expect(row.error).toContain('登录名必须为文本')
    expect(row.error).toContain('新密码不支持公式')
    expect(row.error).not.toContain('cached-password')
    expect(row.values.password).toBeUndefined()
  })
  it('自备列名映射和整表默认目标，拒绝冲突期限与数字日期', () => {
    const sheet = readExcel(
      excelFile([
        ['用户', '口令', '单位', '数量'],
        ['00001', 'value', '永久', '30'],
      ])
    ).sheets[0]!
    const [row] = mappedRows(
      sheet,
      { username: 0, password: 1, mode: 2, amount: 3 },
      'T1'
    )
    expect(row?.match).toEqual({ row: 2, targetCode: 'T1', username: '00001' })
    expect(row?.error).toContain('永久有效期不能同时填写数量')
  })
  it('超行数、超文件大小、宏、XML 实体与非 XLSX 明确拒绝', () => {
    expect(() =>
      readExcel(excelFile(Array.from({ length: 1002 }, () => ['text'])))
    ).toThrow('1000')
    expect(() => readExcel(new Uint8Array(5 * 1024 * 1024 + 1))).toThrow(
      '5 MiB'
    )
    expect(() => readExcel(strToU8('not-a-workbook'))).toThrow('未加密')
    const files = unzipSync(excelFile([['header']]))
    files['xl/vbaProject.bin'] = new Uint8Array([1])
    expect(() => readExcel(zipSync(files))).toThrow('宏')
    delete files['xl/vbaProject.bin']
    files['xl/workbook.xml'] = strToU8(
      '<!DOCTYPE x [<!ENTITY x "secret">]><x/>'
    )
    expect(() => readExcel(zipSync(files))).toThrow('XML')
  })
  it('压缩炸弹按实际解压累计大小拒绝；空模板无秘密', () => {
    const files = unzipSync(excelFile([['header']]))
    files['padding.xml'] = new Uint8Array(21 * 1024 * 1024).fill(65)
    expect(() => readExcel(zipSync(files))).toThrow('20 MiB')
    expect(templateRows([])[0]).toContain('新密码')
    expect(templateRows([])).toHaveLength(1)
  })
})
