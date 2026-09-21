import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { matchAriaSnapshot } from './aria-match.js'

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

describe('TC-PAS-A08: aria-match 版本守卫与匹配器 (Playwright _expect)', () => {
  let hasBrowser = false
  let browser: import('playwright').Browser | undefined

  beforeAll(async () => {
    hasBrowser = await chromiumAvailable()
    if (hasBrowser) {
      const { chromium } = await import('playwright')
      browser = await chromium.launch({ headless: true })
    }
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('成功匹配：子集匹配、正则匹配、角色匹配', async ({ skip }) => {
    if (!hasBrowser || !browser) return skip()
    const page = await browser.newPage()
    try {
      await page.setContent(`<!doctype html>
        <html>
          <body>
            <h1>用户登录</h1>
            <button>提交</button>
            <a href="/help">帮助中心</a>
          </body>
        </html>`)

      const locator = page.locator('body')
      const template = `
- heading "用户登录" [level=1]
- button "提交"
- link /帮助/
`
      const res = await matchAriaSnapshot(locator, template, 1000)
      expect(res.kind).toBe('matched')
    } finally {
      await page.close()
    }
  })

  it('不匹配：返回 mismatch 并带上 received 实际值', async ({ skip }) => {
    if (!hasBrowser || !browser) return skip()
    const page = await browser.newPage()
    try {
      await page.setContent(`<!doctype html>
        <html>
          <body>
            <h1>用户登录</h1>
            <button>提交</button>
          </body>
        </html>`)

      const locator = page.locator('body')
      const template = `
- heading "后台管理"
`
      const res = await matchAriaSnapshot(locator, template, 300)
      expect(res.kind).toBe('mismatch')
      if (res.kind === 'mismatch') {
        expect(res.received).toContain('用户登录')
      }
    } finally {
      await page.close()
    }
  })

  it('模板语法非法：返回 template_invalid', async ({ skip }) => {
    if (!hasBrowser || !browser) return skip()
    const page = await browser.newPage()
    try {
      await page.setContent(`<div>test</div>`)
      const locator = page.locator('body')
      // 语法非法的 YAML / Aria 模板
      const invalidTemplate = `::: invalid yaml [[[ :::`

      const res = await matchAriaSnapshot(locator, invalidTemplate, 300)
      expect(res.kind).toBe('template_invalid')
    } finally {
      await page.close()
    }
  })
})
