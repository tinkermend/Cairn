import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { installTargetScope, targetScopeReady } from './target-scope'
// Browser globals used only inside page.evaluate; do not add DOM globals to Worker production types.
declare const document: {
  createElement(tag: string): { src: string; onload: (() => void) | null }
  body: { append(node: unknown): void }
}
let browser: Browser, good: Server, bad: Server, origin: string, forbidden: string
let hits = 0
beforeAll(async () => {
  bad = createServer((_, res) => {
    hits++
    res.end('forbidden')
  }).listen(0, '127.0.0.1')
  await new Promise<void>((r) => bad.once('listening', r))
  forbidden = `http://127.0.0.1:${(bad.address() as { port: number }).port}`
  good = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/escape' })
      res.end()
      return
    }
    if (req.url === '/escape') {
      res.writeHead(302, { location: forbidden })
      res.end()
      return
    }
    if (req.url === '/safe-redirect') {
      res.writeHead(302, { location: '/ok' })
      res.end()
      return
    }
    res.setHeader('Content-Type', 'text/html')
    res.end(
      `<p>allowed</p><button onclick="window.open('${forbidden}')">bad popup</button><button onclick="window.open('/redirect')">redirect popup</button><button onclick="window.open('/ok')">good popup</button>`,
    )
  }).listen(0, '127.0.0.1')
  await new Promise<void>((r) => good.once('listening', r))
  origin = `http://127.0.0.1:${(good.address() as { port: number }).port}`
  browser = await chromium.launch({ headless: true })
})
afterAll(async () => {
  await browser?.close()
  good?.close()
  bad?.close()
})
it('real browser blocks forbidden navigation, every redirect hop, popup entry and nested frame before network IO', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const page = await context.newPage()
    await installTargetScope(context, [origin])
    await page.goto(origin + '/safe-redirect')
    expect(page.url()).toBe(origin + '/ok')
    for (const url of [forbidden, origin + '/redirect']) {
      const blocked = await context.newPage()
      await targetScopeReady(blocked)
      await expect(blocked.goto(url)).rejects.toThrow()
      await blocked.close()
    }
    await page.goto(origin)
    const popup = context.waitForEvent('page')
    await page.getByText('good popup', { exact: true }).click()
    const opened = await popup
    await targetScopeReady(opened)
    await opened.waitForLoadState()
    expect(opened.url()).toBe(origin + '/ok')
    await page.getByText('bad popup', { exact: true }).click()
    await page.getByText('redirect popup', { exact: true }).click()
    await page.evaluate(
      ({ origin, forbidden }) =>
        new Promise<void>((resolve) => {
          const frame = document.createElement('iframe')
          frame.src = origin + '/redirect'
          frame.onload = () => resolve()
          document.body.append(frame)
          const other = document.createElement('iframe')
          other.src = forbidden
          document.body.append(other)
        }),
      { origin, forbidden },
    )
    expect(hits).toBe(0)
    await opened.goto(origin + '/redirect').catch(() => {})
    expect(hits).toBe(0)
  } finally {
    await context.close()
  }
})

it('an authorized cross-site iframe cannot escape scope via redirects after process isolation', async () => {
  const second = origin.replace('127.0.0.1', 'localhost')
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const page = await context.newPage()
    await installTargetScope(context, [origin, second])
    await page.goto(origin)
    await page.evaluate(
      (url) =>
        new Promise<void>((resolve) => {
          const frame = document.createElement('iframe')
          frame.src = url
          frame.onload = () => resolve()
          document.body.append(frame)
        }),
      second + '/ok',
    )
    const frame = page.frames().find((f) => f.url() === second + '/ok')!
    expect(page.frames().map((f) => f.url())).toContain(second + '/ok')
    await frame.goto(second + '/redirect').catch(() => {})
    expect(hits).toBe(0)
  } finally {
    await context.close()
  }
})
