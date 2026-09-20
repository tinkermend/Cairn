import { DEMONSTRATION_LIMITS } from './demonstration.js'

/** Only accepts metadata-free raster output (e.g. a reviewed browser canvas export). */
export function inspectRecordingImage(
  bytes: Uint8Array,
  contentType: 'image/png' | 'image/jpeg',
): { width: number; height: number } {
  const fail = (): never => {
    throw new Error('图片无效、含未移除的元数据或超过限制')
  }
  if (!bytes.length || bytes.length > DEMONSTRATION_LIMITS.imageBytes) fail()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0
  let height = 0
  if (contentType === 'image/png') {
    if (bytes.length < 45 || [137, 80, 78, 71, 13, 10, 26, 10].some((v, i) => bytes[i] !== v))
      fail()
    let offset = 8
    let ended = false
    let hasData = false
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset)
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
      if (
        offset + length + 12 > bytes.length ||
        !['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'pHYs'].includes(type)
      )
        fail()
      if (type === 'pHYs' && (length !== 9 || bytes[offset + 16]! > 1)) fail()
      if (offset === 8 && (type !== 'IHDR' || length !== 13)) fail()
      if (type === 'IHDR') {
        if (offset !== 8 || length !== 13) fail()
        width = view.getUint32(offset + 8)
        height = view.getUint32(offset + 12)
      }
      if (type === 'IDAT') hasData = true
      offset += length + 12
      if (type === 'IEND') {
        if (length !== 0 || offset !== bytes.length) fail()
        ended = true
        break
      }
    }
    if (!ended || !hasData) fail()
  } else {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) fail()
    let offset = 2
    let ended = false
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) fail()
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]!
      if (marker === 0xd9) {
        ended = offset === bytes.length
        break
      }
      if (marker === 0xd8 || marker === 0x00 || offset + 2 > bytes.length) fail()
      const length = view.getUint16(offset)
      if (length < 2 || offset + length > bytes.length) fail()
      if (marker === 0xfe || (marker >= 0xe1 && marker <= 0xef)) fail()
      if (
        marker === 0xe0 &&
        (length !== 16 ||
          String.fromCharCode(...bytes.subarray(offset + 2, offset + 7)) !== 'JFIF\0')
      )
        fail()
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8 || width) fail()
        height = view.getUint16(offset + 3)
        width = view.getUint16(offset + 5)
      }
      offset += length
      if (marker === 0xda) {
        while (offset < bytes.length) {
          if (bytes[offset] !== 0xff) {
            offset++
            continue
          }
          const next = bytes[offset + 1]
          if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) {
            offset += 2
            continue
          }
          break
        }
      }
    }
    if (!ended) fail()
  }
  if (!width || !height || width * height > DEMONSTRATION_LIMITS.imagePixels) fail()
  return { width, height }
}
