import { inflateSync } from 'node:zlib'
import type { ScreenshotDiagnosis } from '@cairn/shared'
import type { Page } from 'playwright'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export async function pageHasMeaningfulContent(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const doc = (globalThis as { document?: { body?: { innerText?: string; querySelector: (selector: string) => unknown } } }).document
      const body = doc?.body
      if (!body) return false
      const text = String(body.innerText ?? '').replace(/\s+/g, '')
      if (text.length > 0) return true
      return body.querySelector('img,canvas,svg,video,iframe,input,button,textarea,select') != null
    })
  } catch {
    return true
  }
}

export async function isOmittableInitialBlank(page: Page, commandType?: string): Promise<boolean> {
  if (commandType !== 'navigate') return false
  let url = ''
  try {
    url = page.url()
  } catch {
    return false
  }
  if (url !== 'about:blank') return false
  return !(await pageHasMeaningfulContent(page))
}

export function pngLooksUniform(bytes: Buffer): boolean {
  const samples = samplePng(bytes)
  if (!samples || samples.length === 0) return false
  const [base] = samples
  return samples.every((pixel) => pixel.every((channel, index) => Math.abs(channel - (base?.[index] ?? channel)) <= 12))
}

export async function diagnoseScreenshot(page: Page, bytes: Buffer): Promise<ScreenshotDiagnosis> {
  if (await pageHasMeaningfulContent(page)) return 'not_flagged'
  return pngLooksUniform(bytes) ? 'suspected_blank' : 'not_flagged'
}

export async function waitForVisibleContent(page: Page, budgetMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + Math.max(0, budgetMs)
  while (Date.now() < deadline && !signal?.aborted) {
    if (await pageHasMeaningfulContent(page)) return
    const slice = Math.min(200, deadline - Date.now())
    if (slice <= 0) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, slice)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
  }
}

function samplePng(bytes: Buffer): number[][] | undefined {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) return undefined
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(dataStart)
      height = bytes.readUInt32BE(dataStart + 4)
      colorType = bytes[dataStart + 9] ?? 0
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!width || !height || channels === 0 || idat.length === 0) return undefined
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch {
    return undefined
  }
  const stride = width * channels
  const samples: number[][] = []
  const points = 24
  for (let index = 0; index < points; index += 1) {
    const x = Math.min(width - 1, Math.floor(((index + 0.5) * width) / points))
    const y = Math.min(height - 1, Math.floor(((index * 7) % points) * height / points))
    const rowStart = y * (stride + 1)
    if (rowStart + 1 + stride > raw.length) return undefined
    const filter = raw[rowStart]
    if (filter !== 0) return undefined
    const pixel = rowStart + 1 + x * channels
    samples.push([raw[pixel] ?? 0, raw[pixel + 1] ?? 0, raw[pixel + 2] ?? 0])
  }
  return samples
}
