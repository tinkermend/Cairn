import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import {
  generateSliderTrajectory,
  detectPuzzleGapOffset,
  recognizeImageBuffer,
  getOcrSession,
  getCharsets,
  detectChallenge,
  solveChallenge,
  resolveLoginLocator,
  ImageCaptchaHandler,
} from '../index.js'
import { BUILTIN_CAPTCHA_FINGERPRINTS } from '@cairn/shared'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

describe('Authentication Runtime Captcha Solvers (Phase 1)', () => {
  describe('Trajectory Planner', () => {
    it('generates human-like trajectory with bezier curve, overshoot and pullback', () => {
      const startX = 100
      const startY = 200
      const distance = 300

      const points = generateSliderTrajectory(startX, startY, distance, {
        minDurationMs: 800,
        maxDurationMs: 1200,
        jitterY: 3,
        overshootPx: 4,
      })

      expect(points.length).toBeGreaterThan(25)

      // First point should be near start
      const firstPoint = points[0]!
      expect(firstPoint.x).toBeGreaterThanOrEqual(startX)
      expect(Math.abs(firstPoint.y - startY)).toBeLessThanOrEqual(4)

      // Final point must exactly reach target position
      const lastPoint = points[points.length - 1]!
      expect(lastPoint.x).toBe(startX + distance)
      expect(lastPoint.y).toBe(startY)

      // An overshoot point must exist beyond target position
      const hasOvershoot = points.some((p) => p.x > startX + distance)
      expect(hasOvershoot).toBe(true)

      // All delay durations must be positive
      for (const p of points) {
        expect(p.delayMs).toBeGreaterThan(0)
      }
    })
  })

  describe('In-Process ONNX OCR Engine', () => {
    it('loads ONNX session and charsets successfully', async () => {
      const session = await getOcrSession()
      expect(session).toBeDefined()
      expect(session.inputNames).toContain('input1')
      expect(session.outputNames).toContain('output')

      const charsets = getCharsets()
      expect(Array.isArray(charsets)).toBe(true)
      expect(charsets.length).toBeGreaterThan(100)
    })

    it('recognizes a synthesized clean text image or returns deterministic output', async () => {
      // Create a 120x40 image with sharp
      const svg = `
        <svg width="120" height="40" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="#ffffff"/>
          <text x="20" y="28" font-family="Arial" font-size="24" fill="#000000">8421</text>
        </svg>
      `
      const buffer = await sharp(Buffer.from(svg)).png().toBuffer()
      const result = await recognizeImageBuffer(buffer)
      expect(result).toBeDefined()
      expect(typeof result.text).toBe('string')
      expect(typeof result.confidence).toBe('number')
    })

    it('flattens transparent gin-vue-admin captcha onto white before OCR', async () => {
      const fixture = path.join(fixturesDir, 'gin-rgba-280447.png')
      const buffer = fs.readFileSync(fixture)
      const metadata = await sharp(buffer).metadata()
      expect(metadata.hasAlpha).toBe(true)
      const result = await recognizeImageBuffer(buffer)
      expect(result.text).toBe('280447')
      expect(result.confidence).toBeGreaterThan(0)
    })
  })

  describe('Slider Gap Detection', () => {
    it('detects shadow gap edge in synthetic background image', async () => {
      const width = 300
      const height = 150
      // Create an image with a dark rectangle at x=180
      const rawData = new Uint8Array(width * height * 3).fill(220)
      for (let y = 30; y < 100; y += 1) {
        for (let x = 180; x < 220; x += 1) {
          const idx = (y * width + x) * 3
          rawData[idx] = 40
          rawData[idx + 1] = 40
          rawData[idx + 2] = 40
        }
      }

      const buffer = await sharp(rawData, {
        raw: { width, height, channels: 3 },
      })
        .png()
        .toBuffer()

      const detectedOffset = await detectPuzzleGapOffset(buffer)
      // Should detect edge around 180 (within reasonable tolerance)
      expect(detectedOffset).toBeGreaterThanOrEqual(175)
      expect(detectedOffset).toBeLessThanOrEqual(185)
    })
  })

  describe('Challenge Dispatcher', () => {
    it('resolves CSS, ID and name locators correctly', () => {
      const mockPage = {
        locator: vi.fn((sel: string) => ({ selector: sel })),
      } as any

      const byCss = resolveLoginLocator(mockPage, { by: 'css', value: '.slider-knob' })
      expect(mockPage.locator).toHaveBeenCalledWith('.slider-knob')

      const byId = resolveLoginLocator(mockPage, { by: 'id', value: 'captcha-img' })
      expect(mockPage.locator).toHaveBeenCalledWith('#captcha-img')

      const byName = resolveLoginLocator(mockPage, { by: 'name', value: 'captchaCode' })
      expect(mockPage.locator).toHaveBeenCalledWith('[name="captchaCode"]')
    })

    it('detects challenge from explicit TargetAuth captcha definition', async () => {
      const mockImg = { isVisible: vi.fn(async () => true) }
      const mockInp = { isVisible: vi.fn(async () => true) }
      const mockPage = {
        locator: vi.fn((sel: string) => {
          if (sel === '#captcha-img') return mockImg
          if (sel === '#captcha-inp') return mockInp
          return { isVisible: async () => false }
        }),
      } as any

      const detected = await detectChallenge(mockPage, {
        type: 'IMAGE',
        image: {
          imageLocator: { by: 'id', value: 'captcha-img' },
          inputLocator: { by: 'id', value: 'captcha-inp' },
        },
      })

      expect(detected).not.toBeNull()
      expect(detected?.type).toBe('IMAGE_CAPTCHA')
      expect(detected?.source).toBe('EXPLICIT_TARGET_CONFIG')
      expect(detected?.confidence).toBe(1.0)
    })

    it('detects explicit locators when captcha type is AUTO', async () => {
      const mockImg = { isVisible: vi.fn(async () => true) }
      const mockInp = { isVisible: vi.fn(async () => true) }
      const mockPage = {
        locator: vi.fn((sel: string) => {
          if (sel === '#captcha-img') return mockImg
          if (sel === '#captcha-inp') return mockInp
          return { first: () => ({ isVisible: async () => false }) }
        }),
      } as any

      const detected = await detectChallenge(mockPage, {
        type: 'AUTO',
        image: {
          imageLocator: { by: 'id', value: 'captcha-img' },
          inputLocator: { by: 'id', value: 'captcha-inp' },
        },
      })

      expect(detected?.source).toBe('EXPLICIT_TARGET_CONFIG')
      expect(detected?.type).toBe('IMAGE_CAPTCHA')
    })

    it('detects Gin-Vue-Admin via built-in fingerprint', async () => {
      const gvaRule = BUILTIN_CAPTCHA_FINGERPRINTS.find((r) => r.id === 'gin-vue-admin-image')!

      const mockImg = { isVisible: vi.fn(async () => true) }
      const mockInp = { isVisible: vi.fn(async () => true) }

      const mockPage = {
        locator: vi.fn((sel: string) => {
          if (sel === gvaRule.detectors.imageSelector) {
            return { first: () => mockImg }
          }
          if (sel === gvaRule.detectors.inputSelector) {
            return { first: () => mockInp }
          }
          return { first: () => ({ isVisible: async () => false }) }
        }),
      } as any

      const detected = await detectChallenge(mockPage, null)
      expect(detected).not.toBeNull()
      expect(detected?.type).toBe('IMAGE_CAPTCHA')
      expect(detected?.source).toBe('FINGERPRINT:gin-vue-admin-image')
    })

    it('detects Vben Admin slider via built-in fingerprint', async () => {
      const vbenRule = BUILTIN_CAPTCHA_FINGERPRINTS.find((r) => r.id === 'vben-admin-slider')!

      const mockKnob = { isVisible: vi.fn(async () => true) }
      const mockContainer = { isVisible: vi.fn(async () => true) }

      const mockPage = {
        locator: vi.fn((sel: string) => {
          if (sel === vbenRule.detectors.knobSelector) {
            return { first: () => mockKnob }
          }
          if (sel === vbenRule.detectors.containerSelector) {
            return { first: () => mockContainer }
          }
          return { first: () => ({ isVisible: async () => false }) }
        }),
      } as any

      const detected = await detectChallenge(mockPage, null)
      expect(detected).not.toBeNull()
      expect(detected?.type).toBe('SLIDER_CAPTCHA')
      expect(detected?.source).toBe('FINGERPRINT:vben-admin-slider')
    })

    it('ImageCaptchaHandler SPI detects explicit image challenges', async () => {
      const handler = new ImageCaptchaHandler()
      expect(handler.supportedType).toBe('IMAGE_CAPTCHA')
      const mockImg = { isVisible: vi.fn(async () => true) }
      const mockInp = { isVisible: vi.fn(async () => true) }
      const page = {
        locator: vi.fn((sel: string) => {
          if (sel === '#captcha-img') return mockImg
          if (sel === '#captcha-inp') return mockInp
          return { first: () => ({ isVisible: async () => false }) }
        }),
      } as any
      await expect(
        handler.detect({
          page,
          captcha: {
            type: 'IMAGE',
            image: {
              imageLocator: { by: 'id', value: 'captcha-img' },
              inputLocator: { by: 'id', value: 'captcha-inp' },
            },
          },
        }),
      ).resolves.toBe(true)
    })
  })
})
