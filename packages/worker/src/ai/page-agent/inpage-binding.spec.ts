import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapInpageAgent, installInpageBinding, invokeInpageAgent } from './inpage-binding.js'

const LAB_PUBLIC = resolve(__dirname, '../../../../../tests/target-surface-lab/public')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

describe('S07-lite 页内 binding', { timeout: 60_000 }, () => {
  let browser: import('playwright').Browser
  let baseUrl = ''
  let server: ReturnType<typeof createServer> | undefined

  beforeAll(async () => {
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const raw = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
      const relative = extname(raw) ? raw : `${raw}.html`
      const file = join(LAB_PUBLIC, relative)
      try {
        const info = await stat(file)
        if (!info.isFile()) throw new Error('not file')
        const body = await readFile(file)
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
        res.end(body)
      } catch {
        res.writeHead(404)
        res.end('Not Found')
      }
    })
    await new Promise<void>((ready) => server!.listen(0, '127.0.0.1', ready))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('lab port')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await browser?.close()
    if (server) await new Promise<void>((done) => server!.close(() => done()))
  })

  async function open(path: string) {
    const context = await browser.newContext()
    const blocked: string[] = []
    await context.route('**/*', async (route) => {
      const url = route.request().url()
      if (!url.startsWith(baseUrl) && !url.startsWith('data:')) {
        blocked.push(url)
        await route.abort()
        return
      }
      await route.continue()
    })
    const page = await context.newPage()
    return { context, page, blocked }
  }

  it('nonce 正确才代发；无 nonce / 错 nonce 被拒', async () => {
    const { context, page } = await open('/')
    const nonce = 'attempt-1'
    const binding = await installInpageBinding(page, nonce, () => ({ ok: true }))
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
    await bootstrapInpageAgent(page)
    await expect(invokeInpageAgent(page, nonce, 'extract title')).resolves.toEqual({ ok: true })
    await expect(invokeInpageAgent(page, 'other', 'extract title')).rejects.toThrow(/CAIRN_BINDING_DENIED/)
    await expect(
      page.evaluate(() =>
        (
          globalThis as unknown as {
            cairnLlmInvoke: (payload: { intent: string }) => Promise<unknown>
          }
        ).cairnLlmInvoke({ intent: 'steal' }),
      ),
    ).rejects.toThrow(/CAIRN_BINDING_DENIED/)
    expect(binding.calls).toHaveLength(1)
    await context.close()
  })

  it('Worker stop 后拒绝新调用；导航后页内入口丢失', async () => {
    const { context, page } = await open('/')
    const nonce = 'attempt-2'
    const binding = await installInpageBinding(page, nonce, () => ({ ok: true }))
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
    await bootstrapInpageAgent(page)
    binding.stop()
    await expect(invokeInpageAgent(page, nonce, 'click')).rejects.toThrow(/CAIRN_STOPPED/)
    await page.goto(`${baseUrl}/canvas`, { waitUntil: 'domcontentloaded' })
    const alive = await page.evaluate(() =>
      Boolean((globalThis as { __cairnPageAgent?: unknown }).__cairnPageAgent),
    )
    expect(alive).toBe(false)
    await context.close()
  })

  it('CSP 页不加载外网脚本；route 挡住外网', async () => {
    const { context, page, blocked } = await open('/csp')
    await page.goto(`${baseUrl}/csp`, { waitUntil: 'domcontentloaded' })
    const status = await page.locator('#status').textContent()
    expect(status).toContain('拒绝外网脚本')
    await page.goto('https://cdn.invalid/page-agent.demo.js').catch(() => undefined)
    expect(blocked.some((url) => url.includes('cdn.invalid'))).toBe(true)
    await context.close()
  })

  it('CSP 页注入后 binding 可用，页内 fetch 被拦', async () => {
    const { context, page } = await open('/csp')
    await page.goto(`${baseUrl}/csp`, { waitUntil: 'domcontentloaded' })
    const nonce = 'attempt-csp'
    await installInpageBinding(page, nonce, () => ({ ok: true }))
    await bootstrapInpageAgent(page)
    await expect(invokeInpageAgent(page, nonce, 'extract title')).resolves.toEqual({ ok: true })
    const fetchBlocked = await page.evaluate(async () => {
      try {
        await fetch('https://cdn.invalid/llm')
        return false
      } catch {
        return true
      }
    })
    expect(fetchBlocked).toBe(true)
    await expect(invokeInpageAgent(page, nonce, 'still-bound')).resolves.toEqual({ ok: true })
    await context.close()
  })
})
