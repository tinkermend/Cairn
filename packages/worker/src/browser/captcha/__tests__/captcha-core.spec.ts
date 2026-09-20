import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyLoginSubmitText,
  decodeOcrOutput,
  expectedPatternFor,
  filterRgbByColors,
  recognizeImageBuffer,
  resolveCharsetChars,
  shouldContinueCaptchaRetry,
  shouldRetryLoginSubmit,
  slideComparison,
  slideMatch,
} from '../index.js'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

describe('ddddocr charset range', () => {
  it('maps official integer presets to digits and letters', () => {
    expect([...resolveCharsetChars(0)!].sort().join('')).toBe('0123456789')
    expect(resolveCharsetChars(1)?.has('a')).toBe(true)
    expect(resolveCharsetChars(1)?.has('A')).toBe(false)
    expect(resolveCharsetChars('012+-')?.has('+')).toBe(true)
    expect(expectedPatternFor({ charsetRange: 0, expectedLength: 6 })?.test('280447')).toBe(true)
    expect(expectedPatternFor({ charsetRange: 0, expectedLength: 6 })?.test('28044A')).toBe(false)
  })

  it('drops out-of-range CTC indices like official set_ranges', () => {
    const charsets = ['', '0', '1', 'A', '2']
    const decoded = decodeOcrOutput(
      { dims: [1, 5], type: 'int64', data: [0, 3, 1, 2, 4] },
      charsets,
      0,
    )
    expect(decoded.text).toBe('012')
  })

  it('argmaxes 3D logits inside the allowed digit set', () => {
    const charsets = ['', '0', '1', 'O']
    const logits = new Float32Array([
      0, 1, 0, 8,
      0, 0, 6, 1,
    ])
    const decoded = decodeOcrOutput({ dims: [2, 1, 4], type: 'float32', data: logits }, charsets, 0)
    expect(decoded.text).toBe('01')
    expect(decoded.confidence).toBeGreaterThan(0.2)
  })
})

describe('color filter', () => {
  it('keeps red pixels and paints the rest white', () => {
    const rgb = Uint8Array.from([255, 0, 0, 0, 0, 255])
    const filtered = filterRgbByColors(rgb, 2, 1, [[[0, 50, 50], [10, 255, 255]]])
    expect([...filtered.slice(0, 3)]).toEqual([255, 0, 0])
    expect([...filtered.slice(3)]).toEqual([255, 255, 255])
  })
})

describe('slide match', () => {
  it('finds a dark tile on a light background', () => {
    const width = 80
    const height = 40
    const background = { data: new Uint8Array(width * height).fill(220), width, height }
    const target = { data: new Uint8Array(16 * 16).fill(20), width: 16, height: 16 }
    for (let y = 8; y < 24; y += 1) {
      for (let x = 40; x < 56; x += 1) background.data[y * width + x] = 20
    }
    const match = slideMatch(target, background, true)
    expect(match.x).toBeGreaterThanOrEqual(40)
    expect(match.x).toBeLessThanOrEqual(56)
    expect(match.confidence).toBeGreaterThan(0.8)
  })

  it('compares a gapped image against a complete one', () => {
    const width = 60
    const height = 20
    const complete = { data: new Uint8Array(width * height).fill(200), width, height }
    const gapped = { data: new Uint8Array(complete.data), width, height }
    for (let y = 4; y < 16; y += 1) {
      for (let x = 30; x < 42; x += 1) gapped.data[y * width + x] = 20
    }
    const result = slideComparison(gapped, complete)
    expect(result.x).toBeGreaterThanOrEqual(30)
    expect(result.x).toBeLessThanOrEqual(42)
  })
})

describe('login submit outcome', () => {
  it('retries captcha errors and stops on credential errors', () => {
    expect(classifyLoginSubmitText('验证码错误')).toBe('captcha_failed')
    expect(classifyLoginSubmitText('请输入至少6位数字验证码')).toBe('captcha_failed')
    expect(classifyLoginSubmitText('用户名或密码错误')).toBe('credential_failed')
    expect(shouldRetryLoginSubmit('captcha_failed')).toBe(true)
    expect(shouldRetryLoginSubmit('credential_failed')).toBe(false)
    expect(shouldRetryLoginSubmit('ambiguous')).toBe(false)
  })

  it('never retries an ambiguous submit, even if a challenge widget is still visible', () => {
    expect(shouldRetryLoginSubmit('ambiguous', true)).toBe(false)
    expect(shouldRetryLoginSubmit('credential_failed', true)).toBe(false)
  })

  it('continues the outer captcha budget only for captcha_failed or unsolved', () => {
    expect(shouldContinueCaptchaRetry({ authenticated: false, submit: 'captcha_failed' })).toBe(true)
    expect(shouldContinueCaptchaRetry({ authenticated: false, submit: 'unsolved' })).toBe(true)
    expect(shouldContinueCaptchaRetry({ authenticated: false, submit: 'ambiguous' })).toBe(false)
    expect(shouldContinueCaptchaRetry({ authenticated: false, submit: 'credential_failed' })).toBe(false)
    expect(shouldContinueCaptchaRetry({ authenticated: true, submit: 'authenticated' })).toBe(false)
  })
})

describe('official default OCR model', () => {
  it('reads the gin RGBA fixture with the old logits model', async () => {
    const buffer = fs.readFileSync(path.join(fixturesDir, 'gin-rgba-280447.png'))
    const result = await recognizeImageBuffer(buffer, { model: 'old', charsetRange: 0, expectedLength: 6 })
    expect(result.text).toBe('280447')
    expect(result.confidence).toBeGreaterThan(0.8)
  })
})
