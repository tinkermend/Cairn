import { createServer } from 'node:http'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { NavigationOutcomeUnknownError, withNavigationOutcome } from './runtime'

let browser: Browser
beforeAll(async () => { browser = await chromium.launch({ headless: true }) })
afterAll(async () => { await browser?.close() })

it('真实表单请求已到达后断线，click 返回也不能判定成功；正常导航仍成功', async () => {
  let commits = 0
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      commits++
      req.resume()
      if (req.url === '/drop') return req.socket.destroy()
      res.end('accepted')
      return
    }
    res.setHeader('content-type', 'text/html')
    res.end('<form method="POST" action="/drop"><button id="drop">drop</button></form><form method="POST" action="/ok"><button id="ok">ok</button></form>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(url)
    await expect(withNavigationOutcome(page, () => page.locator('#drop').click())).rejects.toBeInstanceOf(NavigationOutcomeUnknownError)
    expect(commits).toBeGreaterThanOrEqual(1)
    expect(page.listenerCount('requestfailed')).toBe(0)
    await page.close()
    const healthyPage = await context.newPage()
    await healthyPage.goto(url)
    await expect(withNavigationOutcome(healthyPage, () => healthyPage.locator('#ok').click())).resolves.toBeUndefined()
    expect(healthyPage.listenerCount('requestfailed')).toBe(0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

it('injectStorageState 只在首次加载时写入一次，站点修改后的值在刷新后保留', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end('<!doctype html><p>storage test</p>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const origin = new URL(url).origin

  const context = await browser.newContext()
  try {
    const { injectStorageState } = await import('./runtime')
    await injectStorageState(context, {
      origins: [
        {
          origin,
          localStorage: [{ name: 'custom_token', value: 'initial_value' }],
        },
      ],
    })

    const page = await context.newPage()
    await page.goto(url)

    const initialVal = await page.evaluate(() => localStorage.getItem('custom_token'))
    expect(initialVal).toBe('initial_value')

    // Simulate site changing the token
    await page.evaluate(() => localStorage.setItem('custom_token', 'updated_by_site'))

    // Reload the page
    await page.reload()

    // Must still retain the updated value, NOT overwritten back to initial_value
    const reloadedVal = await page.evaluate(() => localStorage.getItem('custom_token'))
    expect(reloadedVal).toBe('updated_by_site')
  } finally {
    await context.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
