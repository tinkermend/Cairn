import fs from 'node:fs'
import path from 'node:path'
import type { Page, Locator } from 'playwright'
import sharp from 'sharp'
import { InferenceSession, Tensor } from 'onnxruntime-node'
import { allowedCharsetIndices, expectedPatternFor, type CharsetRange } from './charset-range.js'
import { filterRgbByColors, resolveColorRanges } from './color-filter.js'

export type OcrModelVariant = 'old' | 'beta'

export interface ImageCaptchaOptions {
  modelPath?: string
  charsetsPath?: string
  expectedPattern?: RegExp
  charsetRange?: CharsetRange
  expectedLength?: number
  colors?: string[]
  model?: 'auto' | OcrModelVariant
}

export interface ImageCaptchaResult {
  solved: boolean
  text: string
  confidence: number
  error?: string
}

const sessions = new Map<string, InferenceSession>()
const charsetCache = new Map<string, string[]>()

function resolveAssetPath(filename: string, customPath?: string): string {
  if (customPath && fs.existsSync(customPath)) {
    return customPath
  }

  const envDir = process.env.CAIRN_CAPTCHA_ASSETS_DIR
  const candidates = [
    ...(envDir ? [path.join(envDir, filename)] : []),
    path.resolve(__dirname, '../../../assets/captcha', filename),
    path.resolve(__dirname, '../../assets/captcha', filename),
    path.resolve(process.cwd(), 'packages/worker/assets/captcha', filename),
    path.resolve(process.cwd(), 'assets/captcha', filename),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(`Captcha asset '${filename}' not found. Searched paths: ${candidates.join(', ')}`)
}

function variantAssets(variant: OcrModelVariant): { model: string; charsets: string } {
  if (variant === 'old') {
    return { model: 'common_old.onnx', charsets: 'charsets_old.json' }
  }
  return { model: 'common.onnx', charsets: 'charsets.json' }
}

export function hasOcrModel(variant: OcrModelVariant): boolean {
  try {
    resolveAssetPath(variantAssets(variant).model)
    return true
  } catch {
    return false
  }
}

export async function getOcrSession(modelPath?: string): Promise<InferenceSession> {
  return getNamedSession(modelPath ?? resolveAssetPath('common.onnx'))
}

async function getNamedSession(resolvedModel: string): Promise<InferenceSession> {
  const cached = sessions.get(resolvedModel)
  if (cached) return cached
  const session = await InferenceSession.create(resolvedModel, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  })
  sessions.set(resolvedModel, session)
  return session
}

export function getCharsets(charsetsPath?: string): string[] {
  return loadCharsets(charsetsPath ?? resolveAssetPath('charsets.json'))
}

function loadCharsets(resolvedPath: string): string[] {
  const cached = charsetCache.get(resolvedPath)
  if (cached) return cached
  const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8')) as string[]
  charsetCache.set(resolvedPath, parsed)
  return parsed
}

export function decodeOcrOutput(
  output: { dims: readonly number[]; type?: string; data: ArrayLike<number | bigint> },
  charsets: readonly string[],
  charsetRange?: CharsetRange | null,
): { text: string; confidence: number } {
  const allowed = allowedCharsetIndices(charsets, charsetRange)
  const dims = output.dims
  const lastDim = dims[dims.length - 1] ?? 0
  const isLogits =
    output.type !== 'int64' &&
    (dims.length === 3 || lastDim === charsets.length || lastDim > 64)

  if (!isLogits) {
    const characters: string[] = []
    let lastItem = 0
    for (const item of Array.from(output.data)) {
      const num = Number(item)
      if (num === lastItem) continue
      lastItem = num
      if (num === 0) continue
      if (allowed && !allowed.has(num)) continue
      if (charsets[num]) characters.push(charsets[num]!)
    }
    const text = characters.join('')
    return { text, confidence: text.length > 0 ? 0.9 : 0 }
  }

  const classes = dims[dims.length - 1]!
  let timesteps = 1
  if (dims.length === 3) {
    timesteps = dims[1] === 1 ? dims[0]! : dims[0] === 1 ? dims[1]! : dims[0]!
  } else {
    timesteps = dims[0] === 1 ? dims[1]! : dims[0]!
  }

  const characters: string[] = []
  const confidences: number[] = []
  let lastItem = 0
  for (let t = 0; t < timesteps; t += 1) {
    const offset = t * classes
    let bestIndex = 0
    let bestValue = Number.NEGATIVE_INFINITY
    let maxValue = Number.NEGATIVE_INFINITY
    for (let c = 0; c < classes; c += 1) {
      const value = Number(output.data[offset + c] ?? Number.NEGATIVE_INFINITY)
      if (value > maxValue) maxValue = value
      const usable = !allowed || c === 0 || allowed.has(c)
      if (!usable) continue
      if (value > bestValue) {
        bestValue = value
        bestIndex = c
      }
    }
    let sum = 0
    for (let c = 0; c < classes; c += 1) {
      sum += Math.exp(Number(output.data[offset + c] ?? 0) - maxValue)
    }
    confidences.push(sum === 0 ? 0 : Math.exp(bestValue - maxValue) / sum)
    if (bestIndex === lastItem) continue
    lastItem = bestIndex
    if (bestIndex !== 0 && charsets[bestIndex]) characters.push(charsets[bestIndex]!)
  }

  const text = characters.join('')
  const confidence = confidences.length === 0 ? 0 : confidences.reduce((a, b) => a + b, 0) / confidences.length
  return { text, confidence }
}

async function preprocessImageBuffer(imageBuffer: Buffer, colors?: string[]): Promise<{ raw: Buffer; width: number; height: number }> {
  const metadata = await sharp(imageBuffer).metadata()
  const width = metadata.width ?? 120
  const height = metadata.height ?? 40
  const targetHeight = 64
  const targetWidth = Math.max(1, Math.floor(width * (targetHeight / height)))
  const ranges = resolveColorRanges(colors)

  let pipeline = sharp(imageBuffer).flatten({ background: { r: 255, g: 255, b: 255 } })
  if (ranges.length > 0) {
    const rgb = await pipeline.ensureAlpha().removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const channels = rgb.info.channels
    const packed = new Uint8Array(rgb.info.width * rgb.info.height * 3)
    for (let i = 0; i < rgb.info.width * rgb.info.height; i += 1) {
      packed[i * 3] = rgb.data[i * channels] ?? 0
      packed[i * 3 + 1] = rgb.data[i * channels + 1] ?? rgb.data[i * channels] ?? 0
      packed[i * 3 + 2] = rgb.data[i * channels + 2] ?? rgb.data[i * channels] ?? 0
    }
    const filtered = filterRgbByColors(packed, rgb.info.width, rgb.info.height, ranges)
    pipeline = sharp(filtered, {
      raw: { width: rgb.info.width, height: rgb.info.height, channels: 3 },
    })
  }

  const raw = await pipeline
    .resize(targetWidth, targetHeight, { kernel: 'lanczos3', fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer()
  return { raw, width: targetWidth, height: targetHeight }
}

async function inferVariant(
  variant: OcrModelVariant,
  imageBuffer: Buffer,
  options?: ImageCaptchaOptions,
): Promise<{ text: string; confidence: number }> {
  const assets = variantAssets(variant)
  const session = await getNamedSession(options?.modelPath && variant === 'beta' ? resolveAssetPath(assets.model, options.modelPath) : resolveAssetPath(assets.model))
  const charsets = loadCharsets(options?.charsetsPath && variant === 'beta' ? resolveAssetPath(assets.charsets, options.charsetsPath) : resolveAssetPath(assets.charsets))
  const processed = await preprocessImageBuffer(imageBuffer, options?.colors)
  const dims = [1, 1, processed.height, processed.width]
  const float32Data = new Float32Array(processed.raw.length)
  for (let i = 0; i < processed.raw.length; i += 1) {
    float32Data[i] = (((processed.raw[i] ?? 0) / 255) - 0.5) / 0.5
  }
  const inputName = session.inputNames[0] ?? 'input1'
  const runs = await session.run({ [inputName]: new Tensor('float32', float32Data, dims) })
  const outputName = session.outputNames[0] ?? 'output'
  const output = runs[outputName]
  if (!output) return { text: '', confidence: 0 }
  return decodeOcrOutput(
    {
      dims: output.dims,
      type: output.type,
      data: output.data as ArrayLike<number | bigint>,
    },
    charsets,
    options?.charsetRange,
  )
}

function variantOrder(preferred?: ImageCaptchaOptions['model']): OcrModelVariant[] {
  if (preferred === 'old' || preferred === 'beta') return [preferred]
  const order: OcrModelVariant[] = []
  if (hasOcrModel('old')) order.push('old')
  if (hasOcrModel('beta')) order.push('beta')
  return order
}

export async function recognizeImageBuffer(
  imageBuffer: Buffer,
  options?: ImageCaptchaOptions,
): Promise<{ text: string; confidence: number }> {
  const pattern = options?.expectedPattern ?? expectedPatternFor(options ?? {})
  let best = { text: '', confidence: 0 }
  for (const variant of variantOrder(options?.model)) {
    const result = await inferVariant(variant, imageBuffer, options)
    if (result.confidence > best.confidence || (result.text && !best.text)) best = result
    if (result.text && (!pattern || pattern.test(result.text))) return result
  }
  return best
}

export async function extractImageBuffer(locator: Locator): Promise<Buffer> {
  const src = await locator.getAttribute('src').catch(() => null)
  if (src && src.startsWith('data:image')) {
    const base64Part = src.replace(/^data:image\/\w+;base64,/, '')
    return Buffer.from(base64Part, 'base64')
  }
  return await locator.screenshot({ timeout: 5000 })
}

export async function solveImageCaptcha(
  page: Page,
  imageLocator: Locator,
  inputLocator: Locator,
  options?: ImageCaptchaOptions,
): Promise<ImageCaptchaResult> {
  try {
    await imageLocator.waitFor({ state: 'visible', timeout: 8000 })
    await inputLocator.waitFor({ state: 'visible', timeout: 8000 })

    const imageBuffer = await extractImageBuffer(imageLocator)
    const { text, confidence } = await recognizeImageBuffer(imageBuffer, options)
    const solvedText = text.trim()
    const pattern = options?.expectedPattern ?? expectedPatternFor(options ?? {})

    if (!solvedText) {
      return {
        solved: false,
        text: '',
        confidence: 0,
        error: 'OCR 未能识别出有效字符',
      }
    }

    if (pattern && !pattern.test(solvedText)) {
      return {
        solved: false,
        text: solvedText,
        confidence,
        error: `OCR 结果 ${solvedText} 不符合验证码格式`,
      }
    }

    await inputLocator.fill(solvedText)
    return {
      solved: true,
      text: solvedText,
      confidence,
    }
  } catch (error) {
    return {
      solved: false,
      text: '',
      confidence: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
