import { XMLParser } from 'fast-xml-parser'
import { unzipSync, strFromU8, strToU8, zipSync } from 'fflate'
import type { ScenarioInputType } from './step.js'
import type { DatasetColumn } from './dataset.js'

export type ParsedSheet = {
  name: string
  rowCount: number
  columns: DatasetColumn[]
  rows: Record<string, string>[]
}

export type ParsedDataset = {
  sourceType: 'excel' | 'csv'
  filename: string
  sheetNames: string[]
  activeSheet: ParsedSheet
}

const MiB = 1024 * 1024

export class DatasetParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatasetParseError'
  }
}

function fail(msg: string): never {
  throw new DatasetParseError(msg)
}

const xmlText = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(xmlText).join('')
  if (node && typeof node === 'object') {
    const n = node as Record<string, unknown>
    return xmlText(n['#text'] ?? n.t ?? n.r ?? n.v ?? '')
  }
  return ''
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

function cellRef(i: number): string {
  return i < 26
    ? String.fromCharCode(65 + i)
    : `${cellRef(Math.floor(i / 26) - 1)}${cellRef(i % 26)}`
}

function normalizeKey(header: string, index: number, usedKeys: Set<string>): string {
  let cleaned = header.trim().replace(/[^a-zA-Z0-9_]/g, '_')
  if (!cleaned || !/^[a-zA-Z]/.test(cleaned)) {
    cleaned = `col_${cleaned ? cleaned : index + 1}`
  }
  cleaned = cleaned.replace(/_+/g, '_').slice(0, 32)
  let candidate = cleaned
  let count = 2
  while (usedKeys.has(candidate)) {
    candidate = `${cleaned}_${count++}`
  }
  usedKeys.add(candidate)
  return candidate
}

function inferType(samples: string[]): ScenarioInputType {
  if (!samples.length) return 'string'

  const nonEmpties = samples.filter((s) => s.trim().length > 0)
  if (!nonEmpties.length) return 'string'

  const allBooleans = nonEmpties.every((s) => /^(true|false|1|0|是|否)$/i.test(s.trim()))
  if (allBooleans) return 'boolean'

  const allUrls = nonEmpties.every((s) => /^https?:\/\//i.test(s.trim()))
  if (allUrls) {
    const hasImageExt = nonEmpties.some((s) => /\.(png|jpe?g|gif|webp|svg|bmp|pdf)(\?.*)?$/i.test(s.trim()))
    return hasImageExt ? 'file' : 'url'
  }

  const allNumbers = nonEmpties.every((s) => /^-?\d+(\.\d+)?$/.test(s.trim()))
  if (allNumbers) {
    // If any number starts with leading zero and has >1 digit, keep as string (e.g. "00892")
    const hasLeadingZero = nonEmpties.some((s) => /^0\d+/.test(s.trim()))
    if (hasLeadingZero) return 'string'
    // If long digits >= 12 (like barcode), keep as string
    const isLongDigits = nonEmpties.some((s) => /^\d{12,}$/.test(s.trim()))
    if (isLongDigits) return 'string'
    return 'number'
  }

  const allJson = nonEmpties.every((s) => {
    const t = s.trim()
    return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))
  })
  if (allJson) return 'json'

  return 'string'
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let currentRow: string[] = []
  let currentCell = ''
  let inQuotes = false

  const cleanText = text.replace(/^\uFEFF/, '')
  const len = cleanText.length

  for (let i = 0; i < len; i++) {
    const char = cleanText[i]
    const next = cleanText[i + 1]

    if (inQuotes) {
      if (char === '"') {
        if (next === '"') {
          currentCell += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        currentCell += char
      }
    } else {
      if (char === '"') {
        inQuotes = true
      } else if (char === ',') {
        currentRow.push(currentCell)
        currentCell = ''
      } else if (char === '\r') {
        if (next === '\n') i++
        currentRow.push(currentCell)
        rows.push(currentRow)
        currentRow = []
        currentCell = ''
      } else if (char === '\n') {
        currentRow.push(currentCell)
        rows.push(currentRow)
        currentRow = []
        currentCell = ''
      } else {
        currentCell += char
      }
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell)
    rows.push(currentRow)
  }

  return rows
}

function trimTrailingEmptyRows(rawRows: string[][]): string[][] {
  let lastNonEmpty = rawRows.length - 1
  while (lastNonEmpty >= 0) {
    const row = rawRows[lastNonEmpty]!
    const isRowEmpty = row.every((c) => !c || c.trim().length === 0)
    if (!isRowEmpty) break
    lastNonEmpty--
  }
  return rawRows.slice(0, lastNonEmpty + 1)
}

function buildSheet(sheetName: string, rawRows: string[][]): ParsedSheet {
  const rows = trimTrailingEmptyRows(rawRows)
  if (rows.length === 0) {
    return { name: sheetName, rowCount: 0, columns: [], rows: [] }
  }

  const headerRow = rows[0]!
  const usedKeys = new Set<string>()
  const columns: DatasetColumn[] = []

  for (let i = 0; i < headerRow.length; i++) {
    const rawHeader = headerRow[i] ? headerRow[i]!.trim() : ''
    const header = rawHeader || `列${i + 1}`
    const key = normalizeKey(header, i, usedKeys)
    columns.push({
      name: header,
      key,
      type: 'string',
      sampleValues: [],
    })
  }

  const parsedDataRows: Record<string, string>[] = []
  const dataRows = rows.slice(1)

  for (const dataRow of dataRows) {
    const rowObj: Record<string, string> = {}
    for (let c = 0; c < columns.length; c++) {
      const col = columns[c]!
      const val = dataRow[c] !== undefined ? String(dataRow[c]) : ''
      rowObj[col.key] = val
      if (col.name && col.name !== col.key) {
        rowObj[col.name] = val
      }
      if (val.trim() && col.sampleValues.length < 5) {
        col.sampleValues.push(val.trim())
      }
    }
    parsedDataRows.push(rowObj)
  }

  for (const col of columns) {
    col.type = inferType(col.sampleValues)
  }

  return {
    name: sheetName,
    rowCount: parsedDataRows.length,
    columns,
    rows: parsedDataRows,
  }
}

export function parseExcelOrCsv(
  bytes: Uint8Array,
  filename: string,
  options?: { sheet?: string; maxRows?: number },
): ParsedDataset {
  const isCsv = filename.toLowerCase().endsWith('.csv')

  if (isCsv) {
    const text = strFromU8(bytes)
    const rawRows = parseCsv(text)
    const sheet = buildSheet('Sheet1', rawRows)
    return {
      sourceType: 'csv',
      filename,
      sheetNames: ['Sheet1'],
      activeSheet: sheet,
    }
  }

  if (bytes.byteLength > 20 * MiB) fail('文件超过 20 MiB，请拆分后上传')
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) fail('请选择未加密的标准 .xlsx 或 .csv 文件')

  let rawFiles: Record<string, Uint8Array>
  try {
    rawFiles = unzipSync(bytes)
  } catch (err) {
    fail(`解压工作簿失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (Object.keys(rawFiles).length > 512) fail('工作簿文件结构异常或内容过多')
  for (const name of Object.keys(rawFiles)) {
    if (name.includes('..') || name.startsWith('/') || /vbaProject|macrosheet/i.test(name)) {
      fail('不支持含宏的工作簿')
    }
  }
  const files = new Map<string, Uint8Array>(Object.entries(rawFiles))

  const xml = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseTagValue: false,
    isArray: (name) => ['sheet', 'Relationship', 'row', 'c', 'si'].includes(name),
  })
  const parse = (p: string) => {
    const buf = files.get(p)
    if (!buf) return {}
    try {
      return xml.parse(strFromU8(buf)) as unknown
    } catch {
      return {}
    }
  }

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
    ? ((parse('xl/sharedStrings.xml') as { sst?: { si?: unknown[] } }).sst?.si?.map(xmlText) ?? [])
    : []

  const sheetEntries = workbook.workbook?.sheets?.sheet ?? []
  if (!sheetEntries.length) fail('工作簿不含有效工作表')

  const sheetNames = sheetEntries.map((s) => s['@_name'])
  const selectedSheetName = options?.sheet && sheetNames.includes(options.sheet) ? options.sheet : sheetNames[0]!
  const targetEntry = sheetEntries.find((s) => s['@_name'] === selectedSheetName)!

  const rel = rels.Relationships?.Relationship?.find((r) => r['@_Id'] === targetEntry['@_r:id'])
  if (!rel || !rel['@_Target'] || rel['@_TargetMode'] === 'External') fail('不支持外部工作表')

  const sheetPath = rel['@_Target'].startsWith('/') ? rel['@_Target'].slice(1) : `xl/${rel['@_Target']}`
  if (!sheetPath.startsWith('xl/worksheets/') || sheetPath.includes('..')) fail('工作表路径异常')

  type CellNode = {
    '@_r'?: string
    '@_t'?: string
    f?: unknown
    v?: unknown
    is?: unknown
  }
  const content = parse(sheetPath) as {
    worksheet?: {
      sheetData?: { row?: { '@_r'?: string; c?: CellNode[] }[] }
    }
  }

  const rawRows: string[][] = []
  const rowsNode = content.worksheet?.sheetData?.row ?? []

  for (let rIdx = 0; rIdx < rowsNode.length; rIdx++) {
    const rowNode = rowsNode[rIdx]!
    const cells = rowNode.c ?? []
    const rowArr: string[] = []

    for (let cIdx = 0; cIdx < cells.length; cIdx++) {
      const cell = cells[cIdx]!
      const letters = cell['@_r']?.match(/^[A-Z]+/)?.[0]
      const colIndex = letters
        ? [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1
        : cIdx

      const type = cell['@_t']
      let cellStr = ''
      if (type === 's') {
        const idx = Number(xmlText(cell.v))
        cellStr = shared[idx] ?? ''
      } else if (type === 'inlineStr') {
        cellStr = xmlText(cell.is)
      } else {
        cellStr = xmlText(cell.v)
      }

      rowArr[colIndex] = cellStr
    }
    rawRows.push(rowArr)
  }

  const activeSheet = buildSheet(selectedSheetName, rawRows)

  return {
    sourceType: 'excel',
    filename,
    sheetNames,
    activeSheet,
  }
}

export const parseDatasetSheet = parseExcelOrCsv

export function buildResultWorkbook(sheets: {
  name: string
  columns: string[]
  rows: (string | number | boolean | null | undefined)[][]
}[]): Uint8Array {
  const files: Record<string, string> = {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((_s, idx) => `<Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '</Types>',
    '_rels/.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    'xl/workbook.xml':
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets.map((s, idx) => `<sheet name="${escapeXml(s.name)}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>`).join('') +
      '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_s, idx) => `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>',
    'xl/styles.xml':
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2">' +
      '<font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
      '</fonts>' +
      '<fills count="2">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '</fills>' +
      '<borders count="1"><border/></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2">' +
      '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '</cellXfs>' +
      '</styleSheet>',
  }

  sheets.forEach((sheet, sIdx) => {
    const allRows: (string | number | boolean | null | undefined)[][] = [
      sheet.columns,
      ...sheet.rows,
    ]

    const xmlRows = allRows
      .map((row, rIdx) => {
        const isHeader = rIdx === 0
        const styleId = isHeader ? '1' : '0'
        const cellsXml = row
          .map((cellVal, cIdx) => {
            const strVal = cellVal !== null && cellVal !== undefined ? String(cellVal) : ''
            return `<c r="${cellRef(cIdx)}${rIdx + 1}" t="inlineStr" s="${styleId}"><is><t xml:space="preserve">${escapeXml(strVal)}</t></is></c>`
          })
          .join('')
        return `<row r="${rIdx + 1}">${cellsXml}</row>`
      })
      .join('')

    files[`xl/worksheets/sheet${sIdx + 1}.xml`] =
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xmlRows}</sheetData></worksheet>`
  })

  return zipSync(
    Object.fromEntries(Object.entries(files).map(([key, val]) => [key, strToU8(val)])),
  )
}
