import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { probeHealth, type BrowserHandle } from './runtime'

let browser: Browser
beforeAll(async () => { browser = await chromium.launch({ headless: true }) })
afterAll(async () => { await browser?.close() })

it('导航销毁探针的执行上下文只表示本次未知，不能关闭健康浏览器', async () => {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    const handle: BrowserHandle = { context, basePage: page, profileDir: '' }
    let started!: () => void
    const probing = new Promise<void>(resolve => { started = resolve })
    await page.exposeFunction('__healthProbeStarted', started)
    const evaluate = page.evaluate.bind(page)
    // Keep a real protocol evaluation in flight so navigation deterministically
    // destroys its execution context; the browser produces the actual error.
    const spy = vi.spyOn(page, 'evaluate').mockImplementationOnce(() => evaluate(async () => {
      await (window as unknown as { __healthProbeStarted: () => Promise<void> }).__healthProbeStarted()
      await new Promise(() => {})
    }))
    const health = probeHealth(handle)
    await probing
    await page.goto('data:text/html,<p>new document</p>')
    expect(await health).toBe('UNKNOWN')
    spy.mockRestore()
    expect(await probeHealth(handle)).toBe('HEALTHY')
    await page.close()
    expect(await probeHealth(handle)).toBe('UNHEALTHY')
  } finally {
    await context.close()
    vi.restoreAllMocks()
  }
})
