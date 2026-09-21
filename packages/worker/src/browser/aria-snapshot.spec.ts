import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getAriaSnapshot } from './aria-snapshot.js'
import { sanitizeAriaSnapshot } from '@cairn/shared'

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

describe('TC-PAS-A04 & TC-PAS-A05: getAriaSnapshot 与脱敏', () => {
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

  it('TC-PAS-A04: 基础提取、层级与深度截断', async ({ skip }) => {
    if (!hasBrowser || !browser) return skip()
    const page = await browser.newPage()
    try {
      await page.setContent(`<!doctype html>
        <html>
          <body>
            <header>
              <nav>
                <a href="/">首页</a>
              </nav>
            </header>
            <main>
              <h1>订单管理</h1>
              <button>查询</button>
            </main>
          </body>
        </html>`)

      // 全量提取
      const full = await getAriaSnapshot(page.locator('body'), { timeoutMs: 1000 })
      expect(full.truncated).toBe(false)
      expect(full.text).toContain('订单管理')
      expect(full.text).toContain('查询')
      expect(full.text).toContain('首页')

      // depth 限制
      const shallow = await getAriaSnapshot(page.locator('body'), { timeoutMs: 1000, depth: 1 })
      expect(shallow.text).toBeDefined()

      // maxLength 截断
      const truncated = await getAriaSnapshot(page.locator('body'), { timeoutMs: 1000, maxLength: 20 })
      expect(truncated.truncated).toBe(true)
      expect(truncated.text.length).toBeLessThanOrEqual(20)
    } finally {
      await page.close()
    }
  })

  it('TC-PAS-A05: 敏感数据脱敏验证', async ({ skip }) => {
    if (!hasBrowser || !browser) return skip()
    const page = await browser.newPage()
    try {
      await page.setContent(`<!doctype html>
        <html>
          <body>
            <form>
              <label for="u">用户名</label>
              <input id="u" type="text" value="alice" />
              <label for="p">密码</label>
              <input id="p" type="password" value="my-secret-123" />
              <label for="idcard">身份证号</label>
              <input id="idcard" type="text" value="110101199001011234" />
            </form>
          </body>
        </html>`)

      const res = await getAriaSnapshot(page.locator('body'), { timeoutMs: 1000 })
      // 密码与输入框值不应以明文存在
      expect(res.text).not.toContain('my-secret-123')
      expect(res.text).not.toContain('alice')
      expect(res.text).not.toContain('110101199001011234')
      // 结构与角色标签保留
      expect(res.text).toContain('密码')
      expect(res.text).toContain('用户名')
    } finally {
      await page.close()
    }
  })

  it('TC-PAS-A05: sanitizeAriaSnapshot 纯文本脱敏函数单测', () => {
    const raw = `
- heading "个人信息" [level=1]
- textbox "用户名": testuser
- textbox "密码": secret_password_value
- textbox "卡号": 6222021234567890123
- combobox "角色": 管理员
- button "保存"
`
    const sanitized = sanitizeAriaSnapshot(raw)
    expect(sanitized).toContain('- heading "个人信息" [level=1]')
    expect(sanitized).toContain('- button "保存"')
    expect(sanitized).toContain('- textbox "用户名": ***')
    expect(sanitized).toContain('- textbox "密码": ***')
    expect(sanitized).toContain('- combobox "角色": ***')
    expect(sanitized).not.toContain('testuser')
    expect(sanitized).not.toContain('secret_password_value')
    expect(sanitized).not.toContain('6222021234567890123')
  })
})
