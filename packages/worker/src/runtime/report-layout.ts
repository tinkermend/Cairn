import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import PDFDocument from 'pdfkit'
import { REPORT_LIMITS, type ReportDocument } from '@cairn/shared'
import { reportLines } from './report-content'

export type ReportImage = { id: string; body: Buffer; width: number; height: number; kind: 'logo' | 'screenshot'; caption: string }
export function crc32(buf: Buffer, previous = 0): number {
  let crc = ~previous
  for (const byte of buf) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

export function zipHeaders(nameText: string, size: number, crc: number, offset: number) {
  const name = Buffer.from(nameText)
  const local = Buffer.alloc(30 + name.length)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6)
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(size, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30)
  const central = Buffer.alloc(46 + name.length)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8)
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(size, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46)
  return { local, central }
}
export function zipEnd(count: number, size: number, offset: number) {
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16)
  return end
}
function zipStore(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const { local, central } = zipHeaders(file.name, file.data.length, crc32(file.data), offset)
    locals.push(local, file.data); centrals.push(central); offset += local.length + file.data.length
    if (offset > REPORT_LIMITS.fileBytes) throw new Error('报告文件超过 100 MiB 上限，请新建修订减少截图')
  }
  const central = Buffer.concat(centrals)
  const result = Buffer.concat([...locals, central, zipEnd(files.length, central.length, offset)])
  if (result.length > REPORT_LIMITS.fileBytes) throw new Error('报告文件超过 100 MiB 上限')
  return result
}
function xml(value: string) {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function tableRows(document: ReportDocument): string[][] {
  const values = document.source.kind === 'SUITE_RUN' ? document.source.items : document.source.stepRuns
  if (!Array.isArray(values)) return []
  const labels: Record<string, string> = { PASS: '通过', FAIL: '异常', WARN: '提示', UNKNOWN: '未知', NOT_EVALUATED: '未评估', SUCCEEDED: '执行成功', FAILED: '执行失败', CANCELLED: '已取消', SKIPPED: '已跳过', QUEUED: '未执行' }
  const label = (value: unknown) => labels[String(value)] ?? String(value ?? '未记录')
  return [['成员 / 步骤', '执行状态', '业务结果'], ...values.map((value) => {
    const row = value as Record<string, unknown>
    return [String(row.displayName ?? row.name ?? ''), label(row.admission === 'SKIPPED' ? 'SKIPPED' : row.runStatus ?? row.status), label(row.outcomeStatus)]
  })]
}
export function renderReportDocx(document: ReportDocument, images: ReportImage[] = []): Buffer {
  // ECMA-376 font embedding: reverse the GUID bytes and XOR the first 32 font bytes.
  const fontKey = '1F309C52-A67D-41E3-B5C8-24D79A062E11'
  const keyBytes = Buffer.from(fontKey.replaceAll('-', ''), 'hex').reverse()
  const font = readFileSync(join(__dirname, 'fonts/NotoSansCJKsc-Regular.otf'))
  for (let index = 0; index < 32; index++) font[index] = font[index]! ^ keyBytes[index % 16]!
  const paragraph = (text: string, level = 'body') => `<w:p><w:pPr>${level !== 'body' ? `<w:pStyle w:val="${level === 'title' ? 'Title' : 'Heading1'}"/><w:keepNext/>` : ''}<w:spacing w:after="160"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Noto Sans CJK SC"/><w:sz w:val="${level === 'title' ? 40 : level === 'heading' ? 28 : 22}"/>${level !== 'body' ? '<w:b/>' : ''}</w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`
  const body = reportLines(document).map((line) => paragraph(line.text, line.level)).join('')
  const rows = tableRows(document)
  const table = rows.length ? `<w:tbl><w:tblPr><w:tblW w:w="9638" w:type="dxa"/><w:tblBorders>${['top','left','bottom','right','insideH','insideV'].map((edge) => `<w:${edge} w:val="single" w:sz="4" w:color="CBD5E1"/>`).join('')}</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="5138"/><w:gridCol w:w="2250"/><w:gridCol w:w="2250"/></w:tblGrid>${rows.map((row, index) => `<w:tr><w:trPr>${index === 0 ? '<w:tblHeader/>' : ''}<w:cantSplit/></w:trPr>${row.map((cell, column) => `<w:tc><w:tcPr><w:tcW w:w="${column === 0 ? 5138 : 2250}" w:type="dxa"/>${index === 0 ? '<w:shd w:fill="EAF0F5"/>' : ''}</w:tcPr>${paragraph(cell)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>` : ''
  const imageXml = images.map((image, i) => {
    const scale = Math.min(1, (image.kind === 'logo' ? 160 : 580) / image.width, (image.kind === 'logo' ? 90 : 700) / image.height)
    const cx = Math.round(image.width * scale * 9525), cy = Math.round(image.height * scale * 9525)
    return (image.kind === 'logo' ? '' : paragraph(image.caption, 'heading')) + `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${i + 1}" name="图片 ${i + 1}" descr="${xml(image.caption)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${i + 1}" name="image${i}.jpg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="img${i}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  })
  const logoXml = imageXml.filter((_, i) => images[i]!.kind === 'logo').join('')
  const screenshotsXml = imageXml.filter((_, i) => images[i]!.kind === 'screenshot').join('')
  const main = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${logoXml}${body}${table}${screenshotsXml}<w:sectPr><w:footerReference w:type="default" r:id="footer"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:footer="567"/></w:sectPr></w:body></w:document>`
  const relation = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`
  const relations = (text: string) => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${text}</Relationships>`
  return zipStore([
    { name: 'word/fonts/NotoSansCJKsc-Regular.odttf', data: font },
    { name: 'word/fontTable.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:font w:name="Noto Sans CJK SC"><w:family w:val="swiss"/><w:embedRegular r:id="cjk" w:fontKey="{${fontKey}}"/></w:font></w:fonts>`) },
    { name: 'word/_rels/fontTable.xml.rels', data: Buffer.from(relations(relation('cjk', 'font', 'fonts/NotoSansCJKsc-Regular.odttf'))) },
    { name: '[Content_Types].xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/><Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`) },
    { name: '_rels/.rels', data: Buffer.from(relations(relation('root', 'officeDocument', 'word/document.xml'))) },
    { name: 'word/document.xml', data: Buffer.from(main) },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(relations(relation('styles','styles','styles.xml') + relation('fonts','fontTable','fontTable.xml') + relation('footer','footer','footer.xml') + images.map((_, i) => relation(`img${i}`, 'image', `media/image${i}.jpg`)).join(''))) },
    { name: 'word/styles.xml', data: Buffer.from('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Noto Sans CJK SC" w:hAnsi="Noto Sans CJK SC" w:eastAsia="Noto Sans CJK SC"/><w:lang w:val="zh-CN" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>') },
    { name: 'word/footer.xml', data: Buffer.from('<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>识途 · 第 </w:t></w:r><w:fldSimple w:instr="PAGE"/><w:r><w:t> / </w:t></w:r><w:fldSimple w:instr="NUMPAGES"/><w:r><w:t> 页</w:t></w:r></w:p></w:ftr>') },
    ...images.map((image, i) => ({ name: `word/media/image${i}.jpg`, data: image.body })),
  ])
}

export async function renderReportPdf(document: ReportDocument, images: ReportImage[] = []): Promise<Buffer> {
  const pdf = new PDFDocument({ size: 'A4', margins: { top: 52, bottom: 58, left: 52, right: 52 }, bufferPages: true, info: { Title: document.title, Author: document.authorDisplayName ?? '识途', CreationDate: new Date(document.generatedAt) } })
  const output = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0
    pdf.on('data', (chunk: Buffer) => { size += chunk.length; if (size > REPORT_LIMITS.fileBytes) pdf.destroy(new Error('报告文件超过 100 MiB 上限')); else chunks.push(chunk) })
    pdf.on('error', reject); pdf.on('end', () => resolve(Buffer.concat(chunks)))
  })
  try {
    pdf.font(join(__dirname, 'fonts/NotoSansCJKsc-Regular.otf'))
    for (const image of images.filter((item) => item.kind === 'logo')) {
      const scale = Math.min(1, 160 / image.width, 90 / image.height)
      pdf.image(image.body, 52, pdf.y, { width: image.width * scale, height: image.height * scale })
      pdf.y += image.height * scale + 18
    }
    for (const line of reportLines(document)) {
      pdf.fontSize(line.level === 'title' ? 20 : line.level === 'heading' ? 13 : 10).fillColor(line.level === 'body' ? '#263243' : '#153658')
      const height = pdf.heightOfString(line.text, { width: 491, lineGap: 3 })
      if (line.level !== 'body' && pdf.y + height + 36 > pdf.page.height - 58) pdf.addPage()
      pdf.text(line.text, { width: 491, lineGap: 3 }).moveDown(line.level === 'body' ? 0.35 : 0.6)
    }
    const rows = tableRows(document)
    const drawRow = (row: string[], header: boolean) => {
      pdf.fontSize(10)
      const widths = [251, 120, 120], x = [52, 303, 423]
      const height = Math.max(...row.map((cell, i) => pdf.heightOfString(cell, { width: widths[i]! - 16 }))) + 16
      if (height > 690) throw new Error('表格单行超过页面高度，请缩短成员名称')
      if (pdf.y + height > pdf.page.height - 58) { pdf.addPage(); if (!header && rows[0]) drawRow(rows[0], true) }
      const y = pdf.y
      row.forEach((cell, i) => { pdf.rect(x[i]!, y, widths[i]!, height).fillAndStroke(header ? '#EAF0F5' : '#FFFFFF', '#CBD5E1'); pdf.fillColor('#263243').text(cell, x[i]! + 8, y + 8, { width: widths[i]! - 16 }) })
      pdf.x = 52; pdf.y = y + height
    }
    if (rows.length) { pdf.addPage(); rows.forEach((row, i) => drawRow(row, i === 0)); pdf.moveDown() }
    for (const image of images.filter((item) => item.kind === 'screenshot')) {
      const scale = Math.min(1, 491 / image.width, 600 / image.height)
      const width = image.width * scale, height = image.height * scale
      pdf.fontSize(11)
      const captionHeight = pdf.heightOfString(image.caption, { width: 491 }) + 12
      if (pdf.y + captionHeight + height > pdf.page.height - 58) pdf.addPage()
      pdf.fillColor('#153658').text(image.caption, 52, pdf.y, { width: 491 }).moveDown(0.4)
      const y = pdf.y; pdf.image(image.body, 52, y, { width, height }); pdf.y = y + height + 18
    }
    const pages = pdf.bufferedPageRange()
    for (let index = pages.start; index < pages.start + pages.count; index++) {
      pdf.switchToPage(index); pdf.fontSize(9).fillColor('#697586'); pdf.page.margins.bottom = 0
      pdf.text(`识途 · 第 ${index + 1} / ${pages.count} 页`, 52, pdf.page.height - 35, { width: 491, align: 'right', lineBreak: false })
      pdf.page.margins.bottom = 58
    }
    if (pdf.bufferedPageRange().count !== pages.count) throw new Error('报告页码排版产生了额外页面')
    pdf.end()
  } catch (error) { pdf.destroy(error instanceof Error ? error : new Error('报告渲染失败')) }
  return output
}
