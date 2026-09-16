import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { executeOnPage as executeOnPageRaw } from './surface.js'
import { withTestOccupancy } from './test-occupancy.js'

function executeOnPage(...args: Parameters<typeof executeOnPageRaw>) {
  return withTestOccupancy(() => executeOnPageRaw(...args))
}
import type { TargetDescriptor } from '@cairn/shared'

const target: TargetDescriptor = { framePath: [], candidates: [{ by: 'css', value: '#value' }] }
describe('OM-F real DOM identity and cancellation', () => {
  let browser: Browser
  beforeAll(async () => { browser = await chromium.launch({ headless: true }) })
  afterAll(async () => { await browser?.close() })
  it('探测与读取之间节点被替换，即使选择器仍唯一也不得读取新对象', async () => {
    const page = await browser.newPage()
    try {
      await page.setContent('<div id="value">original</div>')
      const located = await executeOnPage(page, { type: 'locate', target, timeoutMs: 100 })
      expect(located.ok).toBe(true)
      if (!located.ok) throw new Error('locate failed')
      await page.setContent('<div id="value">wrong object</div>')
      const result = await executeOnPage(page, { type: 'extract', target, as: 'text', expectedTargetToken: located.resolvedTargetToken })
      expect(result).toMatchObject({ ok: false, error: { code: 'SURFACE_LOST' } })
      expect(result.output).toBeUndefined()
    } finally { await page.close() }
  })
  it('同一节点可以读取，但凭据只能使用一次', async () => {
    const page = await browser.newPage()
    try {
      await page.setContent('<div id="value">actual</div>')
      const located = await executeOnPage(page, { type: 'locate', target, timeoutMs: 100 })
      if (!located.ok) throw new Error('locate failed')
      const command = { type: 'extract' as const, target, as: 'text' as const, expectedTargetToken: located.resolvedTargetToken }
      expect(await executeOnPage(page, command)).toMatchObject({ ok: true, output: { value: 'actual' } })
      expect(await executeOnPage(page, command)).toMatchObject({ ok: false, error: { code: 'SURFACE_LOST' } })
    } finally { await page.close() }
  })
  it('取消穿透正在等待的定位器，随后也不能读取', async () => {
    const page = await browser.newPage()
    try {
      await page.setContent('<div>empty</div>')
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), 25)
      const began = Date.now()
      const result = await executeOnPage(page, { type: 'locate', target, timeoutMs: 5000 }, abort.signal)
      clearTimeout(timer)
      expect(Date.now() - began).toBeLessThan(500)
      expect(result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
    } finally { await page.close() }
  })
})
