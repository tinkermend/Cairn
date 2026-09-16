import { createServer } from 'node:http'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import {
  targetAuthProfileDefinitionSchema,
  type FrozenAuthVerification,
} from '@cairn/shared'
import { verifyAuthProfile } from './session-auth'
import type { BrowserHandle } from './runtime'

let browser: Browser
let origin: string
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html')
  res.end(
    req.url === '/expired'
      ? '<div id="expired">请登录</div>'
      : req.url === '/delayed'
        ? '<script>setTimeout(()=>document.body.innerHTML=\'<div id="ready">就绪</div><span id="identity">alice</span>\',300)</script>'
        : '<div>无法确定登录状态</div>',
  )
})
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  browser = await chromium.launch({ headless: true })
})
afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function verify(path: string, timeout = 800) {
  const context = await browser.newContext()
  // A missing identity must be bounded by verifyTimeoutMs, not Playwright's default timeout.
  context.setDefaultTimeout(3_000)
  try {
    const definition = targetAuthProfileDefinitionSchema.parse({
      verify: {
        mode: 'page',
        path,
        success: { locator: { by: 'css', value: '#ready' } },
        failure: { locator: { by: 'css', value: '#expired' } },
      },
      identity: {
        source: 'page',
        locator: { by: 'css', value: '#identity' },
        normalize: 'exact',
      },
      scope: { origins: [origin], pathPrefixes: ['/'] },
    })
    const verification = {
      profileRevision: 1,
      profileDigest: 'test',
      loginFieldsDigest: 'test',
      expectedIdentity: 'alice',
      capability: 'IDENTITY_VERIFIED',
      freshnessSeconds: 60,
      verifyTimeoutMs: timeout,
      loginTimeoutMs: 1000,
      verifyRetryBackoffSeconds: [1],
      platformConfigRevision: 1,
    } satisfies FrozenAuthVerification
    return await verifyAuthProfile({ context } as BrowserHandle, {
      definition,
      verification,
    })
  } finally {
    await context.close()
  }
}

it('页面异步加载后等待正向信号并核验身份', async () => {
  expect((await verify('/delayed')).observation).toMatchObject({
    authState: 'AUTHENTICATED',
    identityState: 'MATCH',
  })
})
it('明确失败信号无需等待不存在的身份节点', async () => {
  const start = Date.now()
  expect((await verify('/expired')).observation.authState).toBe('EXPIRED')
  expect(Date.now() - start).toBeLessThan(1_500)
})
it('没有正反信号时按核验预算返回 UNKNOWN', async () => {
  const start = Date.now()
  expect((await verify('/ambiguous', 400)).observation.authState).toBe(
    'UNKNOWN',
  )
  expect(Date.now() - start).toBeLessThan(1_500)
})
