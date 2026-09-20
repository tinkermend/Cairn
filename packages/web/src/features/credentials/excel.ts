import type {
  CredentialImportResolveBody,
  CredentialListItem,
} from '@cairn/shared'
import { XMLParser } from 'fast-xml-parser'
import { Unzip, UnzipInflate, strFromU8, strToU8, zipSync } from 'fflate'

export type ExcelCell = { text: string; kind: 'text' | 'number' | 'formula' }
export type ExcelSheet = {
  name: string
  rows: { row: number; cells: ExcelCell[] }[]
}
export type ExcelBook = { sheets: ExcelSheet[] }
export type ImportField =
  | 'targetCode'
  | 'username'
  | 'password'
  | 'credentialId'
  | 'targetId'
  | 'targetAccountId'
  | 'mode'
  | 'amount'
  | 'timeZone'
  | 'startedAt'
export const IMPORT_FIELDS: { key: ImportField; label: string }[] = [
  { key: 'targetCode', label: '目标系统编码' },
  { key: 'username', label: '登录名' },
  { key: 'password', label: '新密码' },
  { key: 'credentialId', label: '凭据 ID（可选）' },
  { key: 'targetId', label: '目标系统 ID（可选）' },
  { key: 'targetAccountId', label: '目标账号 ID（可选）' },
  { key: 'mode', label: '有效期单位（可选）' },
  { key: 'amount', label: '有效期数量（可选）' },
  { key: 'timeZone', label: '时区（可选）' },
  { key: 'startedAt', label: '本次启用时间（可选）' },
]
export type ImportMapping = Partial<Record<ImportField, number>>
const MiB = 1024 * 1024
export class ExcelImportError extends Error {}
const fail = (message: string): never => {
  throw new ExcelImportError(message)
}
const xmlText = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(xmlText).join('')
  if (node && typeof node === 'object') {
    const n = node as Record<string, unknown>
    return xmlText(n['#text'] ?? n.t ?? n.r ?? '')
  }
  return ''
}

/** Runs inside the import worker. Bounds apply before parsing, and to actual inflated bytes. */
export function readExcel(bytes: Uint8Array): ExcelBook {
  if (bytes.byteLength > 5 * MiB) fail('文件超过 5 MiB，请拆分后导入')
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) fail('请选择未加密的 .xlsx 文件')
  const files = new Map<string, Uint8Array>()
  let inflated = 0
  let count = 0
  const unzip = new Unzip((file) => {
    if (++count > 512 || files.has(file.name))
      fail('工作簿文件结构异常或内容过多')
    if (
      file.name.includes('..') ||
      file.name.startsWith('/') ||
      /vbaProject|macrosheet/i.test(file.name)
    )
      fail('不支持含宏的工作簿')
    if ((file.originalSize ?? 0) > 20 * MiB) fail('解压后内容超过 20 MiB')
    const chunks: Uint8Array[] = []
    let length = 0
    file.ondata = (error, chunk, final) => {
      if (error) fail('无法读取工作簿，请确认文件未加密且完整')
      inflated += chunk.length
      length += chunk.length
      if (inflated > 20 * MiB) fail('解压后内容超过 20 MiB')
      chunks.push(chunk)
      if (final) {
        const data = new Uint8Array(length)
        let offset = 0
        for (const c of chunks) {
          data.set(c, offset)
          offset += c.length
        }
        files.set(file.name, data)
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  for (let i = 0; i < bytes.length; i += 1024)
    unzip.push(bytes.subarray(i, i + 1024), i + 1024 >= bytes.length)
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    isArray: (name) =>
      ['sheet', 'Relationship', 'si', 'row', 'c', 'r'].includes(name),
  })
  const parse = (path: string) => {
    const content = files.get(path)
    if (!content) return fail('工作簿缺少必要内容')
    const xml = strFromU8(content)
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('工作簿包含不支持的 XML 声明')
    return parser.parse(xml)
  }
  const types = strFromU8(files.get('[Content_Types].xml') ?? new Uint8Array())
  if (/macroEnabled|vbaProject/i.test(types)) fail('不支持含宏的工作簿')
  const workbook = parse('xl/workbook.xml') as {
    workbook?: { sheets?: { sheet?: { '@_name': string; '@_r:id': string }[] } }
  }
  const rels = parse('xl/_rels/workbook.xml.rels') as {
    Relationships?: {
      Relationship?: {
        '@_Id': string
        '@_Target': string
        '@_TargetMode'?: string
      }[]
    }
  }
  const shared = files.has('xl/sharedStrings.xml')
    ? ((
        parse('xl/sharedStrings.xml') as { sst?: { si?: unknown[] } }
      ).sst?.si?.map(xmlText) ?? [])
    : []
  const sheets = workbook.workbook?.sheets?.sheet ?? []
  if (!sheets.length || sheets.length > 32) fail('工作簿必须有 1–32 个工作表')
  return {
    sheets: sheets.map((sheet) => {
      const rel = rels.Relationships?.Relationship?.find(
        (r) => r['@_Id'] === sheet['@_r:id']
      )
      if (!rel || rel['@_TargetMode'] === 'External')
        return fail('不支持外部工作表')
      const path = rel['@_Target'].startsWith('/')
        ? rel['@_Target'].slice(1)
        : `xl/${rel['@_Target']}`
      if (!path.startsWith('xl/worksheets/') || path.includes('..'))
        return fail('工作表路径异常')
      type CellNode = {
        '@_r'?: string
        '@_t'?: string
        f?: unknown
        v?: unknown
        is?: unknown
      }
      const content = parse(path) as {
        worksheet?: {
          sheetData?: { row?: { '@_r'?: string; c?: CellNode[] }[] }
        }
      }
      const rows = content.worksheet?.sheetData?.row ?? []
      if (rows.length > 1001) fail('每个工作表最多 1000 条数据，请拆分后导入')
      return {
        name: sheet['@_name'],
        rows: rows.map((row, index) => {
          const cells: ExcelCell[] = []
          if ((row.c?.length ?? 0) > 64) fail('工作表列数超过 64 列')
          for (const [i, cell] of (row.c ?? []).entries()) {
            const letters = cell['@_r']?.match(/^[A-Z]+/)?.[0]
            const col = letters
              ? [...letters].reduce(
                  (n, c) => n * 26 + c.charCodeAt(0) - 64,
                  0
                ) - 1
              : i
            if (col < 0 || col >= 64) fail('工作表列数超过 64 列')
            const type = cell['@_t']
            const text =
              type === 's'
                ? (shared[Number(xmlText(cell.v))] ?? '')
                : type === 'inlineStr'
                  ? xmlText(cell.is)
                  : xmlText(cell.v)
            if (text.length > 8192) fail('单元格内容过长')
            cells[col] = {
              text,
              kind:
                cell.f !== undefined
                  ? 'formula'
                  : ['s', 'inlineStr', 'str'].includes(type ?? '')
                    ? 'text'
                    : 'number',
            }
          }
          return { row: Number(row['@_r'] ?? index + 1), cells }
        }),
      }
    }),
  }
}

export function guessMapping(sheet: ExcelSheet): ImportMapping {
  const aliases: Record<ImportField, string[]> = {
    targetCode: ['目标系统编码', 'targetCode', '系统编码'],
    username: ['登录名', 'username', '账号'],
    password: ['新密码', 'password', '密码'],
    credentialId: ['凭据ID', 'credentialId'],
    targetId: ['目标系统ID', 'targetId'],
    targetAccountId: ['目标账号ID', 'targetAccountId'],
    mode: ['有效期单位', 'mode'],
    amount: ['有效期数量', 'amount'],
    timeZone: ['时区', 'timeZone'],
    startedAt: ['本次启用时间', 'startedAt'],
  }
  const mapping: ImportMapping = {}
  sheet.rows[0]?.cells.forEach((cell, index) => {
    if (!cell) return
    const key = (Object.keys(aliases) as ImportField[]).find((k) =>
      aliases[k].some(
        (s) => s.toLowerCase() === cell.text.replace(/\s/g, '').toLowerCase()
      )
    )
    if (key) mapping[key] = index
  })
  return mapping
}

export function mappedRows(
  sheet: ExcelSheet,
  mapping: ImportMapping,
  defaultTargetCode = ''
) {
  if (
    mapping.password === undefined ||
    (!mapping.credentialId &&
      mapping.credentialId !== 0 &&
      ((mapping.targetCode === undefined && !defaultTargetCode) ||
        mapping.username === undefined))
  )
    fail('请映射新密码，以及目标系统编码 + 登录名（或凭据 ID）')
  if (new Set(Object.values(mapping)).size !== Object.values(mapping).length)
    fail('同一列不能映射到多个字段')
  return sheet.rows
    .slice(1)
    .filter((row) =>
      Object.values(mapping).some(
        (col) =>
          row.cells[col]?.text !== '' && row.cells[col]?.text !== undefined
      )
    )
    .map((row) => {
      const values: Partial<Record<ImportField, string>> = {}
      const errors: string[] = []
      for (const field of IMPORT_FIELDS) {
        const col = mapping[field.key]
        if (col === undefined) continue
        const cell = row.cells[col]
        if (!cell || cell.text === '') continue
        if (cell.kind === 'formula') {
          errors.push(`${field.label}不支持公式，请粘贴为文本值`)
          continue
        }
        if (cell.kind !== 'text' && field.key !== 'amount') {
          errors.push(`${field.label}必须为文本，数字可能已丢失前导零`)
          continue
        }
        values[field.key] = cell.text
      }
      if (!values.targetCode && defaultTargetCode)
        values.targetCode = defaultTargetCode
      if (values.password && values.password.length > 256)
        errors.push('新密码须为 1–256 字符')
      if (
        values.startedAt &&
        (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(
          values.startedAt
        ) ||
          !Number.isFinite(Date.parse(values.startedAt)) ||
          Date.parse(values.startedAt) > Date.now())
      )
        errors.push('启用时间须为带时区的 ISO 日期时间，且不能晚于当前时间')
      if (['permanent', '永久'].includes(values.mode ?? '') && values.amount)
        errors.push('永久有效期不能同时填写数量')
      if (!values.credentialId && (!values.targetCode || !values.username))
        errors.push('缺少目标系统编码或登录名')
      for (const key of [
        'credentialId',
        'targetId',
        'targetAccountId',
      ] as const)
        if (
          values[key] &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            values[key]!
          )
        )
          errors.push(`${key} 格式不正确`)
      const match: CredentialImportResolveBody['rows'][number] = {
        row: row.row,
      }
      for (const key of [
        'credentialId',
        'targetId',
        'targetAccountId',
        'targetCode',
        'username',
      ] as const)
        if (values[key]) match[key] = values[key]
      return {
        row: row.row,
        values,
        match,
        skip: !values.password && !errors.length,
        error: errors.join('；'),
      }
    })
}

const escapeXml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .split('')
    .filter((c) => c.charCodeAt(0) >= 32 || ['\t', '\n', '\r'].includes(c))
    .join('')
export function excelFile(rows: string[][]) {
  const cellRef = (i: number): string =>
    i < 26
      ? String.fromCharCode(65 + i)
      : `${cellRef(Math.floor(i / 26) - 1)}${cellRef(i % 26)}`
  const files = {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="账号凭据" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml':
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="9" width="26" customWidth="1" style="0"/></cols><sheetData>${rows.map((row, i) => `<row r="${i + 1}">${row.map((s, j) => `<c r="${cellRef(j)}${i + 1}" t="inlineStr" s="0"><is><t xml:space="preserve">${escapeXml(s)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`,
  }
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([key, value]) => [key, strToU8(value)])
    )
  )
}

export function downloadExcel(rows: string[][], name: string) {
  const bytes = excelFile(rows)
  const blob = new Blob([new Uint8Array(bytes)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function templateRows(items: CredentialListItem[]) {
  return [
    [
      '目标系统编码',
      '登录名',
      '新密码',
      '凭据ID',
      '目标系统ID',
      '目标账号ID',
      '有效期单位',
      '有效期数量',
      '时区',
    ],
    ...items.map((i) => [
      i.target?.code ?? '',
      i.target?.username ?? i.safeIdentifier,
      '',
      i.id,
      i.targetId ?? '',
      i.targetAccountId ?? '',
      i.validityPolicy.mode === 'unknown' ? '' : i.validityPolicy.mode,
      i.validityPolicy.amount?.toString() ?? '',
      i.validityPolicy.timeZone ?? '',
    ]),
  ]
}
