/**
 * UR10：dpr=2 下 Midscene 1.12.6 的截图像素 center 必须先除以 dpr 再 elementFromPoint。
 * 无浏览器时 skip，不拖垮 CI。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cssViewportPoint } from './resolved-handle.js'

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

describe('点到元素坐标 × dpr=2', { timeout: 60_000 }, () => {
  let hasBrowser = false

  beforeAll(async () => {
    hasBrowser = await chromiumAvailable()
  })

  afterAll(() => undefined)

  it('截图像素除以 dpr 后命中目标按钮，不除则落到旁边', async () => {
    if (!hasBrowser) return
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 400, height: 300 } })
    try {
      await page.setContent(`<!doctype html><html><body style="margin:0">
        <button id="go" style="position:absolute;left:40px;top:60px;width:80px;height:32px">查询</button>
      </body></html>`)
      const box = await page.locator('#go').boundingBox()
      expect(box).toBeTruthy()
      const cssCenter = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
      const screenshotCenter: [number, number] = [cssCenter.x * 2, cssCenter.y * 2]
      const converted = cssViewportPoint(screenshotCenter, 2)
      const hit = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        return el?.id ?? el?.tagName ?? null
      }, converted)
      const rawHit = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        return el?.id ?? el?.tagName ?? null
      }, { x: screenshotCenter[0], y: screenshotCenter[1] })
      expect(hit).toBe('go')
      expect(rawHit).not.toBe('go')
    } finally {
      await page.close()
      await browser.close()
    }
  })
})
