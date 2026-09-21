import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeOnPage } from './surface.js'
import type { BrowserCommand } from '@cairn/shared'

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

describe('TC-PAS-A06 & TC-PAS-A07: 确定性 aria_snapshot 断言执行与失败 Diff 证据', () => {
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

  it('TC-PAS-A06: 缺省 target (body) 与带 target 时断言成功', async ({ skip }) => {
    if (!hasBrowser || !browser) return skip()
    const page = await browser.newPage()
    try {
      await page.setContent(`<!doctype html>
        <html>
          <body>
            <header>
              <h1>系统控制台</h1>
            </header>
            <div id="modal" role="dialog" aria-label="确认弹窗">
              <h2>操作提示</h2>
              <button>确认</button>
              <button>取消</button>
            </div>
          </body>
        </html>`)

      // 1. 缺省 target: 匹配整页 body
      const cmdBody: BrowserCommand = {
        type: 'assert',
        timeoutMs: 1000,
        expect: {
          kind: 'aria_snapshot',
          template: `
- banner:
  - heading "系统控制台" [level=1]
- dialog "确认弹窗":
  - heading "操作提示" [level=2]
  - button "确认"
  - button "取消"
`,
        },
      }
      const resBody = await executeOnPage(page, cmdBody)
      expect(resBody.ok).toBe(true)
      if (resBody.ok) {
        expect((resBody.output as { passed: boolean }).passed).toBe(true)
      }

      // 2. 带 target: 作用域限定在 modal
      const cmdTarget: BrowserCommand = {
        type: 'assert',
        target: {
          framePath: [],
          candidates: [{ by: 'role', value: 'dialog', name: '确认弹窗' }],
        },
        timeoutMs: 1000,
        expect: {
          kind: 'aria_snapshot',
          template: `
- heading "操作提示" [level=2]
- button /确认/
`,
        },
      }
      const resTarget = await executeOnPage(page, cmdTarget)
      expect(resTarget.ok).toBe(true)
    } finally {
      await page.close()
    }
  })

  it('TC-PAS-A07: 断言失败返回 ASSERT_FAILED、Diff 证据且已脱敏', async ({ skip }) => {
    if (!hasBrowser || !browser) return skip()
    const page = await browser.newPage()
    try {
      await page.setContent(`<!doctype html>
        <html>
          <body>
            <h1>用户中心</h1>
            <input type="password" value="my-secret-pass" />
            <button>注销</button>
          </body>
        </html>`)

      const cmd: BrowserCommand = {
        type: 'assert',
        timeoutMs: 300,
        expect: {
          kind: 'aria_snapshot',
          template: `
- heading "后台管理"
- button "注销"
`,
        },
      }

      const res = await executeOnPage(page, cmd)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.code).toBe('ASSERT_FAILED')
        expect(res.error.retryable).toBe(false)
        const output = res.output as { passed: boolean; expected: string; actual: string; diff?: string }
        expect(output.passed).toBe(false)
        expect(output.diff).toBeDefined()
        expect(output.diff).toContain('--- 预期模板')
        expect(output.diff).toContain('+++ 实际快照')
        // 验证敏感信息脱敏：密码不出现在 actual 和 diff 中
        expect(output.actual).not.toContain('my-secret-pass')
        expect(output.diff).not.toContain('my-secret-pass')
      }

      // 验证配置敏感选择器时，Diff 顶部标注「已含敏感区，仅存脱敏结果」
      const resWithSensitive = await executeOnPage(page, cmd, undefined, {
        runId: 'r1',
        stepRunId: 's1',
        attemptId: 'a1',
        sensitiveSelectors: ['input[type="password"]'],
      })
      expect(resWithSensitive.ok).toBe(false)
      if (!resWithSensitive.ok) {
        const output = resWithSensitive.output as { diff?: string }
        expect(output.diff).toContain('# 已含敏感区，仅存脱敏结果')
      }
    } finally {
      await page.close()
    }
  })

  it('TC-PAS-A07: 模板语法非法返回 ASSERT_TEMPLATE_INVALID 且不重试', async ({ skip }) => {
    if (!hasBrowser || !browser) return skip()
    const page = await browser.newPage()
    try {
      await page.setContent(`<div>content</div>`)

      const cmd: BrowserCommand = {
        type: 'assert',
        timeoutMs: 300,
        expect: {
          kind: 'aria_snapshot',
          template: `::: invalid [[[ :::`,
        },
      }

      const res = await executeOnPage(page, cmd)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.code).toBe('ASSERT_TEMPLATE_INVALID')
        expect(res.error.retryable).toBe(false)
      }
    } finally {
      await page.close()
    }
  })

  it('TC-PAS-A09: 能力闸门：Worker 不支持 _expect 时返回 BROWSER_CAPABILITY_MISSING', async ({ skip }) => {
    if (!hasBrowser || !browser) return skip()
    const page = await browser.newPage()
    try {
      await page.setContent(`<div>content</div>`)
      const originalLocator = page.locator.bind(page)
      // 模拟缺少 _expect 的旧版环境
      page.locator = ((selector: string, options?: unknown) => {
        const loc = originalLocator(selector, options as never)
        // @ts-expect-error simulate missing _expect
        loc._expect = undefined
        return loc
      }) as typeof page.locator

      const cmd: BrowserCommand = {
        type: 'assert',
        timeoutMs: 300,
        expect: {
          kind: 'aria_snapshot',
          template: `- text: "content"`,
        },
      }

      const res = await executeOnPage(page, cmd)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.code).toBe('BROWSER_CAPABILITY_MISSING')
        expect(res.error.retryable).toBe(false)
        expect(res.error.safeMessage).toContain('不支持 _expect')
      }
    } finally {
      await page.close()
    }
  })
})
