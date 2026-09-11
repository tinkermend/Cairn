/**
 * 真实浏览器 + target-login-hmi 夹具。
 * 无 chromium 或夹具起不来时 skip，不拖垮 CI。
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  closePage,
  countPages,
  launchSession,
  loginWithCredentials,
  openRunPage,
  probeAuth,
  probeHealth,
  stopSession,
  type BrowserHandle,
} from './runtime'
import { ensureProfileDir } from './profiles'

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright')
    const b = await Promise.race([
      chromium.launch({ headless: true }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('launch timeout')), 8_000),
      ),
    ])
    await b.close()
    return true
  } catch {
    return false
  }
}

describe('browser runtime + HMI 夹具', { timeout: 120_000 }, () => {
  let hasBrowser = false
  let baseUrl = ''
  let server: ReturnType<typeof createServer> | undefined
  let handle: BrowserHandle | undefined
  let profileRoot: string

  beforeAll(async () => {
    hasBrowser = await chromiumAvailable()
    if (!hasBrowser) return

    // 内嵌最小登录页，避免依赖外部 HMI 进程
    server = createServer((req, res) => {
      const url = req.url ?? '/'
      if (url.startsWith('/login') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`<!doctype html><html><body>
          <form method="POST" action="/login">
            <input name="username" id="user" />
            <input name="password" id="pass" type="password" />
            <button type="submit" id="go">登录</button>
          </form>
        </body></html>`)
        return
      }
      if (url.startsWith('/login') && req.method === 'POST') {
        res.writeHead(302, { Location: '/', 'Set-Cookie': 'hmi=ok; Path=/' })
        res.end()
        return
      }
      if (url === '/' || url.startsWith('/?')) {
        const cookie = req.headers.cookie ?? ''
        if (!cookie.includes('hmi=ok')) {
          res.writeHead(302, { Location: '/login' })
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><h1>home</h1></body></html>')
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolveListen) => {
      server!.listen(0, '127.0.0.1', () => resolveListen())
    })
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    baseUrl = `http://127.0.0.1:${addr.port}`
    profileRoot = mkdtempSync(join(tmpdir(), 'cairn-hmi-'))
  })

  afterAll(async () => {
    if (handle) {
      await Promise.race([
        stopSession(handle, 2_000),
        new Promise((r) => setTimeout(r, 3_000)),
      ]).catch(() => {})
      handle = undefined
    }
    if (server) {
      await Promise.race([
        new Promise<void>((r) => server!.close(() => r())),
        new Promise<void>((r) => setTimeout(r, 2_000)),
      ])
    }
  }, 15_000)

  it('login + probeAuth；NEW_PAGE 释放后页面不累积', async ({ skip }) => {
    if (!hasBrowser) {
      skip()
      return
    }
    const key = {
      targetId: '00000000-0000-4000-8000-0000000000aa',
      targetAccountId: '00000000-0000-4000-8000-0000000000bb',
    }
    const { profileDir } = ensureProfileDir(profileRoot, key)
    handle = await launchSession(profileDir, { headless: true })
    expect(await probeHealth(handle)).toBe('HEALTHY')

    const target = {
      entryUrl: `${baseUrl}/`,
      loginUrl: `${baseUrl}/login`,
      loginFields: {
        username: { by: 'name' as const, value: 'username' },
        password: { by: 'name' as const, value: 'password' },
        submit: { by: 'css' as const, value: 'button[type=submit]' },
      },
    }
    expect(await probeAuth(handle, target)).toBe('EXPIRED')
    expect(
      await loginWithCredentials(handle, target, { username: 'demo', password: 'x' }),
    ).toBe(true)
    expect(await probeAuth(handle, target)).toBe('AUTHENTICATED')

    // RF17：50 次 acquire 风格开页并关闭后，页面数 ≤ 会话数×1（仅 basePage）
    for (let i = 0; i < 50; i++) {
      const page = await openRunPage(handle)
      await closePage(page)
    }
    expect(countPages(handle)).toBe(1)

    const stop = await stopSession(handle)
    expect(stop).toBe('stopped')
    handle = undefined
  })
})
