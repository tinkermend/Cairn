/**
 * L2：真实 chromium + tests/target-surface-lab。
 * 无浏览器时 skip，不拖垮 CI。
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BrowserCommand, TargetDescriptor } from '@cairn/shared'
import { executeOnPage } from './surface'
import { launchSession, stopSession, type BrowserHandle } from './runtime'
import { ensureProfileDir } from './profiles'

const LAB_PUBLIC = resolve(__dirname, '../../../../tests/target-surface-lab/public')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

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

function button(name: string, extra: Partial<TargetDescriptor> = {}): TargetDescriptor {
  return {
    framePath: extra.framePath ?? [],
    candidates: extra.candidates ?? [{ by: 'role', value: 'button', name }],
    anchor: extra.anchor,
  }
}

describe('Browser Surface × target-surface-lab（L2）', { timeout: 180_000 }, () => {
  let hasBrowser = false
  let baseUrl = ''
  let server: ReturnType<typeof createServer> | undefined
  let handle: BrowserHandle | undefined

  beforeAll(async () => {
    hasBrowser = await chromiumAvailable()
    if (!hasBrowser) return
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
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
    await new Promise<void>((resolveReady) => server!.listen(0, '127.0.0.1', resolveReady))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('lab port')
    baseUrl = `http://127.0.0.1:${address.port}`
    const profileRoot = mkdtempSync(join(tmpdir(), 'cairn-lab-'))
    const profile = ensureProfileDir(profileRoot, {
      targetId: '00000000-0000-4000-8000-0000000000aa',
      targetAccountId: '00000000-0000-4000-8000-0000000000ab',
    })
    handle = await launchSession(profile.profileDir, { headless: true })
  })

  afterAll(async () => {
    if (handle) await stopSession(handle)
    await new Promise<void>((resolveClose, reject) => {
      if (!server) return resolveClose()
      server.close((error) => (error ? reject(error) : resolveClose()))
    })
  })

  async function open(path: string) {
    if (!handle) throw new Error('no browser')
    await handle.basePage.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' })
    return handle.basePage
  }

  async function run(command: BrowserCommand) {
    if (!handle) throw new Error('no browser')
    return executeOnPage(handle.basePage, command)
  }

  it('普通 DOM / 两层 iframe / 重挂载 / popup / 行内锚点 各 20 次无误点', async ({ skip }) => {
    if (!hasBrowser) skip()
    for (let i = 0; i < 20; i++) {
      const page = await open('/')
      const clicked = await executeOnPage(page, { type: 'click', target: button('查询') })
      expect(clicked.ok, `普通 DOM #${i}`).toBe(true)
      expect(await page.locator('#status').innerText()).toBe('已查询')
    }

    for (let i = 0; i < 20; i++) {
      const page = await open('/nested.html')
      await page.waitForSelector('iframe[name="outer"]')
      const clicked = await executeOnPage(page, {
        type: 'click',
        target: button('深层确认', {
          framePath: [{ urlPattern: 'frame-outer.html' }, { urlPattern: 'frame-inner.html' }],
        }),
      })
      expect(clicked.ok, `嵌套 iframe #${i}`).toBe(true)
    }

    for (let i = 0; i < 20; i++) {
      const page = await open('/remount.html')
      await page.waitForSelector('iframe[name="live"]')
      const clicked = await executeOnPage(page, {
        type: 'click',
        target: button('心跳', { framePath: [{ urlPattern: 'remount-frame.html' }] }),
      })
      expect(clicked.ok, `重挂载 #${i}`).toBe(true)
    }

    for (let i = 0; i < 20; i++) {
      const page = await open('/popup.html')
      const opened = await executeOnPage(page, { type: 'click', target: button('打开子窗') })
      expect(opened.ok, `popup 打开 #${i}`).toBe(true)
      const child = page.context().pages().at(-1)
      expect(child).toBeTruthy()
      await child!.waitForLoadState('domcontentloaded')
      const confirmed = await executeOnPage(child!, { type: 'click', target: button('子窗确认') })
      expect(confirmed.ok, `popup 点击 #${i}`).toBe(true)
      await child!.close()
    }

    for (let i = 0; i < 20; i++) {
      const page = await open('/icons.html')
      const clicked = await executeOnPage(page, {
        type: 'click',
        target: button('删除', { anchor: { withinText: '乙订单', scope: 'row' } }),
      })
      expect(clicked.ok, `小图标 #${i}`).toBe(true)
      expect(await page.locator('#deleted').innerText()).toBe('乙订单')
    }
  })

  it('FrameStep.selector 按父文档匹配 iframe，错选择器走 SURFACE_LOST', async ({ skip }) => {
    if (!hasBrowser) skip()
    const page = await open('/nested.html')
    await page.waitForSelector('#outer-frame')
    const clicked = await executeOnPage(page, {
      type: 'click',
      target: button('深层确认', {
        framePath: [{ selector: '#outer-frame' }, { selector: 'iframe[name="inner"]' }],
      }),
    })
    expect(clicked.ok).toBe(true)
    expect(clicked.ok && clicked.diagnostics?.framePathResolved).toEqual([
      'main',
      '#outer-frame',
      'iframe[name="inner"]',
    ])

    const wrong = await executeOnPage(page, {
      type: 'click',
      target: button('深层确认', {
        framePath: [{ selector: 'iframe[name="nope"]' }],
      }),
    })
    expect(wrong.ok).toBe(false)
    if (wrong.ok) throw new Error('ok')
    expect(wrong.error.code).toBe('SURFACE_LOST')

    const mismatch = await executeOnPage(page, {
      type: 'click',
      target: button('深层确认', {
        framePath: [{ name: 'outer', selector: '#inner-frame' }],
      }),
    })
    expect(mismatch.ok).toBe(false)
    if (mismatch.ok) throw new Error('ok')
    expect(mismatch.error.code).toBe('SURFACE_LOST')
  })

  it('找不到 / 多匹配 / 页面关闭分别给出结构化错误', async ({ skip }) => {
    if (!hasBrowser) skip()
    await open('/missing.html')
    const missing = await run({ type: 'click', target: button('查询') })
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error('ok')
    expect(missing.error.code).toBe('TARGET_NOT_FOUND')
    expect(missing.diagnostics?.candidatesTried[0]?.matches).toBe(0)

    await open('/icons.html')
    const ambiguous = await run({ type: 'click', target: button('删除') })
    expect(ambiguous.ok).toBe(false)
    if (ambiguous.ok) throw new Error('ok')
    expect(ambiguous.error.code).toBe('TARGET_AMBIGUOUS')
    expect(ambiguous.diagnostics?.candidatesTried[0]?.matches).toBeGreaterThan(1)

    const page = await open('/')
    await page.close()
    const lost = await executeOnPage(page, { type: 'click', target: button('查询') })
    expect(lost.ok).toBe(false)
    if (lost.ok) throw new Error('ok')
    expect(lost.error.code).toBe('SURFACE_LOST')
    handle!.basePage = await handle!.context.newPage()
  })

  it('closed Shadow 与 Canvas 返回 BROWSER_CAPABILITY_MISSING', async ({ skip }) => {
    if (!hasBrowser) skip()
    await open('/shadow.html')
    const closed = await run({
      type: 'click',
      target: { framePath: [], candidates: [{ by: 'text', value: '暗处按钮' }] },
    })
    expect(closed.ok).toBe(false)
    if (closed.ok) throw new Error('ok')
    expect(closed.error.code).toBe('BROWSER_CAPABILITY_MISSING')

    await open('/canvas.html')
    const canvas = await run({
      type: 'click',
      target: { framePath: [], candidates: [{ by: 'css', value: '#board' }] },
    })
    expect(canvas.ok).toBe(false)
    if (canvas.ok) throw new Error('ok')
    expect(canvas.error.code).toBe('BROWSER_CAPABILITY_MISSING')
  })

  it('extract / assert / navigate 越界', async ({ skip }) => {
    if (!hasBrowser) skip()
    const page = await open('/')
    const extracted = await executeOnPage(page, {
      type: 'extract',
      target: { framePath: [], candidates: [{ by: 'testId', value: 'page-title' }] },
      as: 'text',
    })
    expect(extracted.ok).toBe(true)
    if (!extracted.ok) throw new Error('extract')
    expect(extracted.output).toEqual({ value: '普通 DOM' })

    const assertion = await executeOnPage(page, {
      type: 'assert',
      target: { framePath: [], candidates: [{ by: 'testId', value: 'page-title' }] },
      expect: { kind: 'text_equals', value: '普通 DOM' },
    })
    expect(assertion.ok).toBe(true)

    const failed = await executeOnPage(page, {
      type: 'assert',
      target: { framePath: [], candidates: [{ by: 'testId', value: 'page-title' }] },
      expect: { kind: 'text_equals', value: '别的' },
    })
    expect(failed.ok).toBe(false)
    if (failed.ok) throw new Error('assert')
    expect(failed.error.code).toBe('ASSERT_FAILED')
    expect(failed.output).toMatchObject({ expected: '别的', actual: '普通 DOM' })

    const nav = await executeOnPage(page, {
      type: 'navigate',
      url: 'https://evil.example/',
      allowedOrigins: [new URL(baseUrl).origin],
    })
    expect(nav.ok).toBe(false)
    if (nav.ok) throw new Error('nav')
    expect(nav.error.code).toBe('NAVIGATE_OUT_OF_SCOPE')
  })
})
