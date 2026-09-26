import { REPORT_LIMITS } from '@cairn/shared'

export type { ReportImage } from './report-html.js'
export { renderReportHtml } from './report-html.js'

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
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x800, 6)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(size, 18)
  local.writeUInt32LE(size, 22)
  local.writeUInt16LE(name.length, 26)
  name.copy(local, 30)

  const central = Buffer.alloc(46 + name.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x800, 8)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(size, 20)
  central.writeUInt32LE(size, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(offset, 42)
  name.copy(central, 46)

  return { local, central }
}

export function zipEnd(count: number, size: number, offset: number) {
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return end
}

export function zipStore(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const { local, central } = zipHeaders(file.name, file.data.length, crc32(file.data), offset)
    locals.push(local, file.data)
    centrals.push(central)
    offset += local.length + file.data.length
    if (offset > REPORT_LIMITS.fileBytes) throw new Error('报告文件超过 100 MiB 上限，请新建修订减少截图')
  }
  const central = Buffer.concat(centrals)
  const result = Buffer.concat([...locals, central, zipEnd(files.length, central.length, offset)])
  if (result.length > REPORT_LIMITS.fileBytes) throw new Error('报告文件超过 100 MiB 上限')
  return result
}
