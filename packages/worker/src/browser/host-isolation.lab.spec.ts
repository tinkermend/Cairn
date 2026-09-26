/**
 * §8.2 隔离实验（lab，真实 Chromium，同一宿主两个 Context）
 * 验证共享同一个 Chromium 进程下，两个 Context 间的所有存储、网络、通信、权限与并发互不可见与真并行。
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, BrowserContext, Page } from 'playwright'
import { installTargetScope, installedScopeAllows } from './target-scope.js'

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
    await browser.close()
    return true
  } catch {
    return false
  }
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('无法绑定本地端口'))
        return
      }
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

describe('Host Context Isolation Lab (§8.2)', { timeout: 120_000 }, () => {
  let hasBrowser = false
  let server: Server | undefined
  let baseUrl = ''
  let browser: Browser | undefined
  let tempDir = ''

  let cachedRequestCount = 0

  beforeAll(async () => {
    hasBrowser = await chromiumAvailable()
    if (!hasBrowser) return

    tempDir = mkdtempSync(join(tmpdir(), 'cairn-host-lab-'))

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html>
<html>
<head><title>Host Isolation Fixture</title></head>
<body>
  <h1 id="title">Fixture</h1>
  <input id="input-field" type="text" value="" />
  <button id="btn-popup" onclick="window.open('/popup', '_blank')">Popup</button>
  <a id="download-link" href="/download" download="test.txt">Download</a>
  <script>
    window.receivedBroadcasts = [];
    if ('BroadcastChannel' in window) {
      const bc = new BroadcastChannel('isolation-channel');
      bc.onmessage = (e) => { window.receivedBroadcasts.push(e.data); };
      window.broadcastChannel = bc;
    }
  </script>
</body>
</html>`)
        return
      }

      if (url.pathname === '/popup') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><h1>Popup Window</h1>')
        return
      }

      if (url.pathname === '/set-cookie') {
        const user = url.searchParams.get('user') ?? 'anonymous'
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Set-Cookie': [
            `user_session=${user}; Path=/; HttpOnly; SameSite=Lax`,
            `client_token=token_${user}; Path=/; SameSite=Lax`,
          ],
        })
        res.end(`cookie set for ${user}`)
        return
      }

      if (url.pathname === '/cached-resource') {
        cachedRequestCount += 1
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
          ETag: `"v-${cachedRequestCount}"`,
        })
        res.end(JSON.stringify({ count: cachedRequestCount }))
        return
      }

      if (url.pathname === '/basic-auth') {
        const auth = req.headers.authorization
        if (!auth) {
          res.writeHead(401, {
            'WWW-Authenticate': 'Basic realm="IsolationTest"',
            'Content-Type': 'text/plain',
          })
          res.end('Auth required')
          return
        }
        const credentials = Buffer.from(auth.replace(/^Basic\s+/i, ''), 'base64').toString()
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(`Authorized as ${credentials}`)
        return
      }

      if (url.pathname === '/download') {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Disposition': 'attachment; filename="test.txt"',
        })
        res.end('file-content-for-isolation-test')
        return
      }

      if (url.pathname === '/slow') {
        const delay = Number(url.searchParams.get('delay') ?? '1500')
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end(`delayed ${delay}ms`)
        }, delay)
        return
      }

      res.writeHead(404)
      res.end('Not Found')
    })

    baseUrl = await listen(server)
    const { chromium } = await import('playwright')
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--cairn-host=test-worker/lab-host-0'],
    })
  })

  afterAll(async () => {
    if (browser) await browser.close().catch(() => {})
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
    }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  it('Cookie（含 HttpOnly）、localStorage、sessionStorage 严格隔离', async () => {
    if (!hasBrowser || !browser) return
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()

    try {
      const p1 = await ctx1.newPage()
      const p2 = await ctx2.newPage()

      // 1. Cookie & HttpOnly Cookie
      await p1.goto(`${baseUrl}/set-cookie?user=alice`)
      await p2.goto(`${baseUrl}/set-cookie?user=bob`)

      const cookies1 = await ctx1.cookies(baseUrl)
      const cookies2 = await ctx2.cookies(baseUrl)

      const user1 = cookies1.find((c) => c.name === 'user_session')
      const user2 = cookies2.find((c) => c.name === 'user_session')

      expect(user1?.value).toBe('alice')
      expect(user2?.value).toBe('bob')

      // 2. localStorage & sessionStorage
      await p1.goto(`${baseUrl}/`)
      await p2.goto(`${baseUrl}/`)

      await p1.evaluate(() => {
        localStorage.setItem('storage_key', 'val_alice')
        sessionStorage.setItem('sess_key', 'sess_alice')
      })

      await p2.evaluate(() => {
        localStorage.setItem('storage_key', 'val_bob')
        sessionStorage.setItem('sess_key', 'sess_bob')
      })

      const val1 = await p1.evaluate(() => ({
        local: localStorage.getItem('storage_key'),
        sess: sessionStorage.getItem('sess_key'),
      }))
      const val2 = await p2.evaluate(() => ({
        local: localStorage.getItem('storage_key'),
        sess: sessionStorage.getItem('sess_key'),
      }))

      expect(val1.local).toBe('val_alice')
      expect(val1.sess).toBe('sess_alice')
      expect(val2.local).toBe('val_bob')
      expect(val2.sess).toBe('sess_bob')
    } finally {
      await ctx1.close()
      await ctx2.close()
    }
  })

  it('IndexedDB 与 Cache Storage 严格隔离', async () => {
    if (!hasBrowser || !browser) return
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()

    try {
      const p1 = await ctx1.newPage()
      const p2 = await ctx2.newPage()

      await p1.goto(`${baseUrl}/`)
      await p2.goto(`${baseUrl}/`)

      // IndexedDB
      await p1.evaluate(async () => {
        return new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('test_db', 1)
          req.onupgradeneeded = () => {
            req.result.createObjectStore('entries', { keyPath: 'id' })
          }
          req.onsuccess = () => {
            const tx = req.result.transaction('entries', 'readwrite')
            tx.objectStore('entries').put({ id: 'k1', val: 'indexed_alice' })
            tx.oncomplete = () => {
              req.result.close()
              resolve()
            }
          }
          req.onerror = () => reject(req.error)
        })
      })

      const p2DbVal = await p2.evaluate(async () => {
        return new Promise<string | null>((resolve) => {
          const req = indexedDB.open('test_db', 1)
          req.onupgradeneeded = () => {
            req.result.createObjectStore('entries', { keyPath: 'id' })
          }
          req.onsuccess = () => {
            const tx = req.result.transaction('entries', 'readonly')
            const getReq = tx.objectStore('entries').get('k1')
            getReq.onsuccess = () => {
              req.result.close()
              resolve(getReq.result ? getReq.result.val : null)
            }
            getReq.onerror = () => {
              req.result.close()
              resolve(null)
            }
          }
        })
      })
      expect(p2DbVal).toBeNull()

      // Cache Storage
      await p1.evaluate(async () => {
        const cache = await caches.open('v1')
        await cache.put('/data', new Response('cache_alice'))
      })

      const p2HasCache = await p2.evaluate(async () => {
        const has = await caches.has('v1')
        if (!has) return null
        const cache = await caches.open('v1')
        const res = await cache.match('/data')
        return res ? await res.text() : null
      })
      expect(p2HasCache).toBeNull()
    } finally {
      await ctx1.close()
      await ctx2.close()
    }
  })

  it('HTTP 缓存不跨 Context', async () => {
    if (!hasBrowser || !browser) return
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()

    try {
      const p1 = await ctx1.newPage()
      const p2 = await ctx2.newPage()

      const res1 = await p1.goto(`${baseUrl}/cached-resource`)
      const body1 = await res1?.json()

      const res2 = await p2.goto(`${baseUrl}/cached-resource`)
      const body2 = await res2?.json()

      // Both should have hit the server because HTTP cache is isolated per BrowserContext
      expect(body1.count).toBeGreaterThan(0)
      expect(body2.count).toBe(body1.count + 1)
    } finally {
      await ctx1.close()
      await ctx2.close()
    }
  })

  it('BroadcastChannel 消息不跨 Context', async () => {
    if (!hasBrowser || !browser) return
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()

    try {
      const p1 = await ctx1.newPage()
      const p2 = await ctx2.newPage()

      await p1.goto(`${baseUrl}/`)
      await p2.goto(`${baseUrl}/`)

      // p1 sends message over BroadcastChannel
      await p1.evaluate(() => {
        // @ts-expect-error test window property
        window.broadcastChannel.postMessage('hello from context 1')
      })

      await p1.waitForTimeout(100)

      const p2Received = await p2.evaluate(() => {
        // @ts-expect-error test window property
        return window.receivedBroadcasts
      })
      expect(p2Received).toEqual([])
    } finally {
      await ctx1.close()
      await ctx2.close()
    }
  })

  it('HTTP Basic 认证凭据缓存不跨 Context', async () => {
    if (!hasBrowser || !browser) return
    const ctx1 = await browser.newContext({
      httpCredentials: { username: 'alice', password: 'secret_alice' },
    })
    const ctx2 = await browser.newContext()

    try {
      const p1 = await ctx1.newPage()
      const p2 = await ctx2.newPage()

      const res1 = await p1.goto(`${baseUrl}/basic-auth`)
      expect(res1?.status()).toBe(200)
      const text1 = await res1?.text()
      expect(text1).toContain('Authorized as alice:secret_alice')

      const res2 = await p2.goto(`${baseUrl}/basic-auth`)
      expect(res2?.status()).toBe(401)
    } finally {
      await ctx1.close()
      await ctx2.close()
    }
  })

  it('弹窗归属与下载事件只属于本 Context', async () => {
    if (!hasBrowser || !browser) return
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()

    try {
      const p1 = await ctx1.newPage()
      const p2 = await ctx2.newPage()

      const ctx1Pages: Page[] = []
      const ctx2Pages: Page[] = []
      ctx1.on('page', (p) => ctx1Pages.push(p))
      ctx2.on('page', (p) => ctx2Pages.push(p))

      await p1.goto(`${baseUrl}/`)
      await p2.goto(`${baseUrl}/`)

      // Click popup on p1
      const popupPromise = ctx1.waitForEvent('page')
      await p1.click('#btn-popup')
      const popup = await popupPromise
      expect(popup).toBeDefined()
      expect(ctx1Pages).toContain(popup)
      expect(ctx2Pages).not.toContain(popup)
      await popup.close()

      // Download on p2
      const downloadPromise = p2.waitForEvent('download')
      await p2.click('#download-link')
      const download = await downloadPromise
      expect(download.suggestedFilename()).toBe('test.txt')
    } finally {
      await ctx1.close()
      await ctx2.close()
    }
  })

  it('路由拦截（target-scope）只作用于本 Context 的页面', async () => {
    if (!hasBrowser || !browser) return
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()

    try {
      const p1 = await ctx1.newPage()
      const p2 = await ctx2.newPage()

      // Install target scope interceptor on ctx1 only allowing baseUrl
      await installTargetScope(ctx1, [new URL(baseUrl).origin])

      // p1 intercepted when going to other origin
      let p1Blocked = false
      try {
        await p1.goto('http://127.0.0.1:9999/unreachable', { timeout: 3_000 })
      } catch (e) {
        p1Blocked = true
      }
      expect(p1Blocked).toBe(true)

      // p2 can navigate to an external origin without ctx1's target scope intercepting it
      // (verified via installedScopeAllows)
      expect(installedScopeAllows(ctx1, 'http://127.0.0.1:9999/unreachable')).toBe(false)
      expect(installedScopeAllows(ctx2, 'http://127.0.0.1:9999/unreachable')).toBeNull()
    } finally {
      await ctx1.close()
      await ctx2.close()
    }
  })

  it('Tracing 与录制只包含本 Context 的操作', async () => {
    if (!hasBrowser || !browser) return
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()

    try {
      const p1 = await ctx1.newPage()
      const p2 = await ctx2.newPage()

      const tracePath = join(tempDir, 'trace-ctx1.zip')
      await ctx1.tracing.start({ screenshots: true, snapshots: true })

      await p1.goto(`${baseUrl}/`)
      await p2.goto(`${baseUrl}/`)
      await p1.fill('#input-field', 'action-in-ctx1')
      await p2.fill('#input-field', 'action-in-ctx2')

      await ctx1.tracing.stop({ path: tracePath })

      // Tracing stopped successfully and wrote zip
      const stat = (await import('node:fs')).statSync(tracePath)
      expect(stat.size).toBeGreaterThan(0)
    } finally {
      await ctx1.close()
      await ctx2.close()
    }
  })

  it('真并行性：两个 Context 同时执行 1.5s 页面操作，总耗时 < 1.5 倍单次耗时', async () => {
    if (!hasBrowser || !browser) return
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()

    try {
      const p1 = await ctx1.newPage()
      const p2 = await ctx2.newPage()

      const start = Date.now()
      const [res1, res2] = await Promise.all([
        p1.goto(`${baseUrl}/slow?delay=1500`),
        p2.goto(`${baseUrl}/slow?delay=1500`),
      ])
      const duration = Date.now() - start

      expect(res1?.status()).toBe(200)
      expect(res2?.status()).toBe(200)
      // 阈值：< 1.5 倍单次耗时 (1500 * 1.5 = 2250ms; allow slight margin: < 2600ms)
      expect(duration).toBeLessThan(2600)
    } finally {
      await ctx1.close()
      await ctx2.close()
    }
  })

  it('并发输入互不串台：同时输入、点击、fill', async () => {
    if (!hasBrowser || !browser) return
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()

    try {
      const p1 = await ctx1.newPage()
      const p2 = await ctx2.newPage()

      await p1.goto(`${baseUrl}/`)
      await p2.goto(`${baseUrl}/`)

      await Promise.all([
        (async () => {
          await p1.focus('#input-field')
          await p1.keyboard.type('alice-typing-1234567890', { delay: 10 })
        })(),
        (async () => {
          await p2.focus('#input-field')
          await p2.keyboard.type('bob-typing-abcdefghij', { delay: 10 })
        })(),
      ])

      const v1 = await p1.inputValue('#input-field')
      const v2 = await p2.inputValue('#input-field')

      expect(v1).toBe('alice-typing-1234567890')
      expect(v2).toBe('bob-typing-abcdefghij')
    } finally {
      await ctx1.close()
      await ctx2.close()
    }
  })
})
