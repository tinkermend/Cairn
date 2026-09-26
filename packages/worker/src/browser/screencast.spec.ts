import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startScreencast } from './screencast.js'
import type { CapturedFrame } from './captured-frame.js'
import type { PageRef } from '@cairn/shared'

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright')
    const browser = await Promise.race([
      chromium.launch({ headless: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('launch timeout')), 8_000)),
    ])
    await browser.close()
    return true
  } catch {
    return false
  }
}

describe('screencast 帧身份', () => {
  let hasBrowser = false

  beforeAll(async () => {
    hasBrowser = await chromiumAvailable()
  })

  afterAll(() => undefined)

  it('VE02：同一 CDP sessionId 的连续不同图片各有独立 sourceSeq', async ({ skip }) => {
    if (!hasBrowser) {
      skip()
      return
    }
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
    const pageRef: PageRef = {
      sessionId: '00000000-0000-4000-8000-000000000011',
      sessionGeneration: 1,
      pageId: '00000000-0000-4000-8000-000000000014',
      documentEpoch: 1,
    }
    try {
      await page.setContent('<html><body id="box" style="background:#111;width:100%;height:100%"></body></html>')
      const handle = await startScreencast(page, pageRef)
      const frames: CapturedFrame[] = []
      const stopListen = handle.subscribeCaptured((frame) => {
        frames.push(frame)
      })
      for (let i = 0; i < 8; i += 1) {
        await page.evaluate((n) => {
          document.body.style.background = `rgb(${20 + n * 20}, 40, 180)`
        }, i)
        await page.waitForTimeout(180)
      }
      stopListen()
      await handle.stop()
      expect(frames.length).toBeGreaterThanOrEqual(3)
      const seqs = frames.map((frame) => frame.sourceSeq)
      expect(new Set(seqs).size).toBe(seqs.length)
      expect(frames.every((frame) => frame.captureEpoch === handle.captureEpoch)).toBe(true)
      expect(frames.every((frame) => frame.origin === 'cdp')).toBe(true)
      const uniqueJpeg = new Set(frames.map((frame) => frame.jpeg.toString('base64')))
      expect(uniqueJpeg.size).toBeGreaterThan(1)
    } finally {
      await browser.close()
    }
  }, 30_000)

  it('动态 pageRef 解析器使随后的画面帧自动携带最新的 documentEpoch', async ({ skip }) => {
    if (!hasBrowser) {
      skip()
      return
    }
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
    let currentEpoch = 1
    const getPageRef = () => ({
      sessionId: '00000000-0000-4000-8000-000000000011',
      sessionGeneration: 1,
      pageId: '00000000-0000-4000-8000-000000000014',
      documentEpoch: currentEpoch,
    })
    try {
      await page.setContent('<html><body style="background:#222"></body></html>')
      const handle = await startScreencast(page, getPageRef)
      const liveFrames: import('@cairn/shared').ManagedBrowserFrame[] = []
      const stopListen = handle.subscribe((frame) => {
        liveFrames.push(frame)
      })
      await page.evaluate(() => {
        document.body.style.background = '#333'
      })
      await page.waitForTimeout(100)
      currentEpoch = 2
      await page.evaluate(() => {
        document.body.style.background = '#444'
      })
      await page.waitForTimeout(200)
      stopListen()
      await handle.stop()
      expect(liveFrames.some((f) => f.pageRef.documentEpoch === 1)).toBe(true)
      expect(liveFrames.some((f) => f.pageRef.documentEpoch === 2)).toBe(true)
    } finally {
      await browser.close()
    }
  }, 30_000)

  it('refreshScreencastIfStale 在代次变化时强制产生新帧', async ({ skip }) => {
    if (!hasBrowser) {
      skip()
      return
    }
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
    let currentEpoch = 1
    const getPageRef = () => ({
      sessionId: '00000000-0000-4000-8000-000000000011',
      sessionGeneration: 1,
      pageId: '00000000-0000-4000-8000-000000000014',
      documentEpoch: currentEpoch,
    })
    try {
      await page.setContent('<html><body style="background:#111"></body></html>')
      const { refreshScreencastIfStale } = await import('./screencast.js')
      const handle = await startScreencast(page, getPageRef)
      await refreshScreencastIfStale(page, handle, getPageRef, 5000)
      expect(handle.latest?.pageRef.documentEpoch).toBe(1)
      currentEpoch = 2
      await refreshScreencastIfStale(page, handle, getPageRef, 5000)
      expect(handle.latest?.pageRef.documentEpoch).toBe(2)
      await handle.stop()
    } finally {
      await browser.close()
    }
  }, 30_000)
})

