/**
 * pageLooksLoading 只认标准 Web Animations API，不靠任何框架 class 名；
 * 用真实 Chromium 验证：整页级动画遮罩判进去，页面静止或只有小局部动画判不进去。
 * 无浏览器时 skip，不拖垮 CI。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pageLooksLoading, waitForVisibleContent, waitWhileLoading } from './screenshot-quality.js'

/** 带顶栏文字 + 整页加载遮罩的壳层，遮罩 300ms 后自行移除，模拟真实 SPA 首屏。 */
const SHELL_WITH_DELAYED_CONTENT = `<!doctype html><html><body style="margin:0">
  <header>某某系统</header>
  <div id="mask" style="position:fixed;inset:0;top:24px;display:flex;align-items:center;justify-content:center;background:#fff">
    <div style="width:32px;height:32px;border:4px solid #ccc;border-top-color:#333;border-radius:50%;
      animation:spin 1s linear infinite"></div>
  </div>
  <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
  <script>setTimeout(() => document.getElementById('mask').remove(), 300)</script>
</body></html>`

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

describe('pageLooksLoading × 真实 Chromium', { timeout: 60_000 }, () => {
  let hasBrowser = false

  beforeAll(async () => {
    hasBrowser = await chromiumAvailable()
  })

  afterAll(() => undefined)

  it('整页旋转加载遮罩（覆盖视口过半）判为仍在加载', async () => {
    if (!hasBrowser) return
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
    try {
      await page.setContent(`<!doctype html><html><body style="margin:0">
        <div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#fff">
          <div style="width:32px;height:32px;border:4px solid #ccc;border-top-color:#333;border-radius:50%;
            animation:spin 1s linear infinite"></div>
        </div>
        <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
      </body></html>`)
      await page.waitForTimeout(50)
      expect(await pageLooksLoading(page)).toBe(true)
    } finally {
      await browser.close()
    }
  })

  it('静态页面（没有任何动画）判为已加载完', async () => {
    if (!hasBrowser) return
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
    try {
      await page.setContent(`<!doctype html><html><body style="margin:0">
        <h1>数据库实例</h1><p>共 12 个实例</p>
      </body></html>`)
      expect(await pageLooksLoading(page)).toBe(false)
    } finally {
      await browser.close()
    }
  })

  it('只有小局部动画（例如按钮里的小图标）不当作整页仍在加载', async () => {
    if (!hasBrowser) return
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
    try {
      await page.setContent(`<!doctype html><html><body style="margin:0">
        <h1>数据库实例</h1>
        <button style="width:24px;height:24px">
          <span style="display:inline-block;width:12px;height:12px;border:2px solid #333;border-top-color:transparent;
            border-radius:50%;animation:spin 1s linear infinite"></span>
        </button>
        <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
      </body></html>`)
      await page.waitForTimeout(50)
      expect(await pageLooksLoading(page)).toBe(false)
    } finally {
      await browser.close()
    }
  })

  it('顶栏有文字、内容区仍盖着遮罩：waitForVisibleContent 立刻判满足，等不到遮罩消失', async () => {
    if (!hasBrowser) return
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
    try {
      await page.setContent(SHELL_WITH_DELAYED_CONTENT)
      const started = Date.now()
      await waitForVisibleContent(page, 2_000)
      expect(Date.now() - started).toBeLessThan(250)
      expect(await pageLooksLoading(page)).toBe(true)
    } finally {
      await browser.close()
    }
  })

  it('waitWhileLoading 能等到遮罩真的消失，不被顶栏文字提前满足', async () => {
    if (!hasBrowser) return
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
    try {
      await page.setContent(SHELL_WITH_DELAYED_CONTENT)
      const started = Date.now()
      await waitWhileLoading(page, 2_000)
      expect(Date.now() - started).toBeGreaterThanOrEqual(250)
      expect(await pageLooksLoading(page)).toBe(false)
    } finally {
      await browser.close()
    }
  })

  it('遮罩撤下后内容仍在逐行渲染：waitWhileLoading 等到 DOM 静默才放行，不在遮罩一消失就按快门', async () => {
    if (!hasBrowser) return
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
    try {
      // 遮罩 80ms 后移除；之后列表还在以 100ms 间隔逐行插入，到约 380ms 才停。
      await page.setContent(`<!doctype html><html><body style="margin:0">
        <div id="mask" style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#fff">
          <div style="width:32px;height:32px;border:4px solid #ccc;border-top-color:#333;border-radius:50%;
            animation:spin 1s linear infinite"></div>
        </div>
        <ul id="list"></ul>
        <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
        <script>
          setTimeout(() => document.getElementById('mask').remove(), 80)
          let n = 0
          const iv = setInterval(() => {
            document.getElementById('list').insertAdjacentHTML('beforeend', '<li>row ' + (n++) + '</li>')
            if (n >= 3) clearInterval(iv)
          }, 100)
        </script>
      </body></html>`)
      const started = Date.now()
      await waitWhileLoading(page, 2_000)
      const elapsed = Date.now() - started
      // 遮罩本身 80ms 就没了；如果只等遮罩消失，这里应该 <200ms 就返回。
      // 真正等到列表停止插入（约 380ms）再加 200ms 静默期，理应明显晚于遮罩消失时刻。
      expect(elapsed).toBeGreaterThanOrEqual(450)
    } finally {
      await browser.close()
    }
  })

  it('waitWhileLoading 不超过预算：一直卡着的遮罩到点就放行，不无限等', async () => {
    if (!hasBrowser) return
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
    try {
      await page.setContent(`<!doctype html><html><body style="margin:0">
        <div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#fff">
          <div style="width:32px;height:32px;border:4px solid #ccc;border-top-color:#333;border-radius:50%;
            animation:spin 1s linear infinite"></div>
        </div>
        <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
      </body></html>`)
      const started = Date.now()
      await waitWhileLoading(page, 400)
      const elapsed = Date.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(350)
      expect(elapsed).toBeLessThan(1_000)
    } finally {
      await browser.close()
    }
  })
})
