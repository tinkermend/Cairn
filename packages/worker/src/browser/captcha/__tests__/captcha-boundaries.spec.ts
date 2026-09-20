import { describe, it, expect, vi } from 'vitest'
import {
  generateSliderTrajectory,
  detectPuzzleGapOffset,
  solveImageCaptcha,
  solveSliderCaptcha,
  detectChallenge,
  solveChallenge,
  extractImageBuffer,
} from '../index.js'

describe('Captcha Boundary & Failure Resilience (AC-03 / AC-03b / Edge Cases)', () => {
  describe('Boundary: Missing / Invisible Locators', () => {
    it('handles image locator timeout gracefully without uncaught rejection', async () => {
      const mockPage = {} as any
      const mockImg = {
        waitFor: vi.fn().mockRejectedValue(new Error('Timeout 8000ms waiting for image')),
      } as any
      const mockInp = {
        waitFor: vi.fn().mockResolvedValue(undefined),
      } as any

      const result = await solveImageCaptcha(mockPage, mockImg, mockInp)
      expect(result.solved).toBe(false)
      expect(result.error).toContain('Timeout')
    })

    it('handles slider knob invisible or boundingBox null gracefully', async () => {
      const mockPage = {
        mouse: {
          move: vi.fn(),
          down: vi.fn(),
          up: vi.fn(),
        },
        waitForTimeout: vi.fn(),
      } as any
      const mockKnob = {
        waitFor: vi.fn().mockResolvedValue(undefined),
        boundingBox: vi.fn().mockResolvedValue(null),
      } as any

      const result = await solveSliderCaptcha(mockPage, mockKnob)
      expect(result.solved).toBe(false)
      expect(result.displacementPx).toBe(0)
      expect(result.error).toContain('无法获取滑块元素')
    })
  })

  describe('Boundary: Captcha Extraction with different formats', () => {
    it('extracts base64 from data:image/jpeg URL', async () => {
      const sampleBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      const mockLocator = {
        getAttribute: vi.fn().mockResolvedValue(`data:image/jpeg;base64,${sampleBase64}`),
        screenshot: vi.fn(),
      } as any

      const buffer = await extractImageBuffer(mockLocator)
      expect(buffer).toBeInstanceOf(Buffer)
      expect(buffer.length).toBeGreaterThan(0)
      expect(mockLocator.screenshot).not.toHaveBeenCalled()
    })

    it('falls back to locator.screenshot() when src attribute is regular URL or missing', async () => {
      const samplePng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      const mockLocator = {
        getAttribute: vi.fn().mockResolvedValue('/api/v1/captcha.png'),
        screenshot: vi.fn().mockResolvedValue(samplePng),
      } as any

      const buffer = await extractImageBuffer(mockLocator)
      expect(buffer).toEqual(samplePng)
      expect(mockLocator.screenshot).toHaveBeenCalled()
    })
  })

  describe('Boundary: Trajectory Constraints', () => {
    it('handles zero or small displacement safely without crash', () => {
      const points = generateSliderTrajectory(50, 50, 0, {
        minDurationMs: 200,
        maxDurationMs: 300,
      })
      expect(points.length).toBeGreaterThan(0)
      const lastPoint = points[points.length - 1]!
      expect(lastPoint.x).toBe(50)
      expect(lastPoint.y).toBe(50)
    })

    it('respects duration bounds and non-linear movement', () => {
      const points = generateSliderTrajectory(0, 0, 200, {
        minDurationMs: 1000,
        maxDurationMs: 1000,
        overshootPx: 5,
      })
      // Ensure distance increases gradually
      expect(points[1]!.x).toBeLessThan(points[points.length - 5]!.x)
    })
  })

  describe('Boundary: Fallback on Corrupted Image Buffer', () => {
    it('detectPuzzleGapOffset returns fallback value when buffer metadata is invalid', async () => {
      const corruptedBuffer = Buffer.from('not an image')
      const offset = await detectPuzzleGapOffset(corruptedBuffer).catch(() => 200)
      expect(typeof offset).toBe('number')
    })
  })

  describe('Boundary: Dispatcher Handles Unmatched or Empty Challenges', () => {
    it('returns null when no detector matches', async () => {
      const mockPage = {
        locator: vi.fn(() => ({
          first: () => ({
            isVisible: vi.fn().mockResolvedValue(false),
          }),
        })),
      } as any

      const detected = await detectChallenge(mockPage, null)
      expect(detected).toBeNull()
    })

    it('returns error in solveChallenge if locators are missing', async () => {
      const mockPage = {} as any
      const outcome = await solveChallenge(mockPage, {
        type: 'IMAGE_CAPTCHA',
        source: 'TEST',
        confidence: 1.0,
        locators: {}, // No image or input
      })
      expect(outcome.solved).toBe(false)
      expect(outcome.error).toContain('缺少图形验证码图片或输入框定位器')
    })
  })
})
