import { FACTORY_SESSION_AUTH } from '@cairn/shared'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { settleAuthenticatedLanding } from './landing-settle.js'

const target = {
  entryUrl: 'http://127.0.0.1/app',
  loginUrl: 'http://127.0.0.1/login',
}

function sessionAuth(overrides?: Partial<typeof FACTORY_SESSION_AUTH>) {
  return { ...FACTORY_SESSION_AUTH, ...overrides }
}

const RELOAD_DISMISSES = `<!doctype html>
<html><head><meta charset="utf-8" /></head><body>
<button id="work">业务按钮</button>
<script>
  if (!localStorage.getItem('welcomed')) {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.style.cssText = 'position:fixed;inset:20% 25%;background:#fff;border:1px solid #333;padding:24px;z-index:9'
    dialog.innerHTML = '<p>欢迎</p><button>立即体验</button>'
    document.body.appendChild(dialog)
    localStorage.setItem('welcomed', '1')
  }
</script>
</body></html>`

const GOT_IT = `<!doctype html>
<html><head><meta charset="utf-8" /></head><body>
<div role="dialog" aria-modal="true" style="position:fixed;inset:20% 25%;background:#fff;border:1px solid #333;padding:24px">
  <p>产品说明</p>
  <button>立即体验</button>
  <button onclick="this.closest('[role=dialog]').remove()">知道了</button>
</div>
<button id="work">业务按钮</button>
</body></html>`

const EXPERIENCE_ONLY = `<!doctype html>
<html><head><meta charset="utf-8" /></head><body>
<div role="dialog" aria-modal="true" style="position:fixed;inset:20% 25%;background:#fff;border:1px solid #333;padding:24px">
  <p>开通</p>
  <button>立即体验</button>
</div>
</body></html>`

function delayedDialogHtml(delayMs: number) {
  return `<!doctype html>
<html><head><meta charset="utf-8" /></head><body>
<button id="work">业务按钮</button>
<script>
  setTimeout(() => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.style.cssText = 'position:fixed;inset:20% 25%;background:#fff;border:1px solid #333;padding:24px'
    const text = document.createElement('p')
    text.textContent = '晚到'
    const btn = document.createElement('button')
    btn.textContent = '知道了'
    btn.addEventListener('click', () => dialog.remove())
    dialog.append(text, btn)
    document.body.appendChild(dialog)
  }, ${delayMs})
</script>
</body></html>`
}

const OTP = `<!doctype html>
<html><head><meta charset="utf-8" /></head><body>
<h1>二次验证</h1>
<label>验证码 <input autocomplete="one-time-code" /></label>
<div role="dialog" aria-modal="true"><button>知道了</button></div>
</body></html>`

const APP_SHELL = `<!doctype html>
<html><head><meta charset="utf-8" /></head><body>
<div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#f5f5f5">
  <h1>应用壳</h1>
  <button id="work">打开菜单</button>
</div>
</body></html>`

describe('落地整理夹具', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser.close()
  })

  async function open(html: string, url = 'http://127.0.0.1/app'): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    await page.goto('about:blank')
    await page.route('**/*', async (route) => {
      if (route.request().resourceType() === 'document') {
        await route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: Buffer.from(html, 'utf8'),
        })
        return
      }
      await route.fulfill({ status: 204, body: '' })
    })
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    return page
  }

  it('刷新后因 localStorage 不再出欢迎层', async () => {
    const page = await open(RELOAD_DISMISSES)
    expect(await page.getByRole('dialog').count()).toBe(1)
    const result = await settleAuthenticatedLanding({
      page,
      target,
      sessionAuth: sessionAuth(),
    })
    expect(result.didReload).toBe(true)
    expect(result.skippedReason).toBeUndefined()
    expect(await page.getByRole('dialog').count()).toBe(0)
    expect(await page.locator('#work').isEnabled()).toBe(true)
    await page.close()
  })

  it('知道了可关，立即体验不点', async () => {
    const page = await open(GOT_IT)
    const result = await settleAuthenticatedLanding({
      page,
      target,
      sessionAuth: sessionAuth(),
    })
    expect(result.overlaysDismissed).toBe(1)
    expect(result.residualOverlay).toBe(false)
    expect(await page.getByRole('dialog').count()).toBe(0)
    await page.close()

    const blocked = await open(EXPERIENCE_ONLY)
    const leftover = await settleAuthenticatedLanding({
      page: blocked,
      target,
      sessionAuth: sessionAuth(),
    })
    expect(leftover.overlaysDismissed).toBe(0)
    expect(leftover.residualOverlay).toBe(true)
    expect(await blocked.getByRole('dialog').count()).toBe(1)
    await blocked.close()
  })

  it('观察窗内关掉延迟插入的层；窗为 0 则留下', async () => {
    const page = await open(delayedDialogHtml(800))
    const result = await settleAuthenticatedLanding({
      page,
      target,
      sessionAuth: sessionAuth(),
    })
    expect(result.overlaysDismissed).toBe(1)
    expect(await page.getByRole('dialog').count()).toBe(0)
    await page.close()

    const missed = await open(delayedDialogHtml(2_500))
    const leftover = await settleAuthenticatedLanding({
      page: missed,
      target,
      sessionAuth: sessionAuth({ landingSettleWatchMs: 1, landingSettleBudgetMs: 2_000 }),
      alreadyOpenedEntry: true,
    })
    expect(leftover.overlaysDismissed).toBe(0)
    await missed.waitForTimeout(3_000)
    expect(await missed.getByRole('dialog').count()).toBe(1)
    await missed.close()
  })

  it('二次验证输入可见时整次跳过', async () => {
    const page = await open(OTP, 'http://127.0.0.1/otp')
    const result = await settleAuthenticatedLanding({
      page,
      target,
      sessionAuth: sessionAuth(),
    })
    expect(result.skippedReason).toBe('interstitial')
    expect(result.didReload).toBe(false)
    expect(await page.getByRole('dialog').count()).toBe(1)
    await page.close()
  })

  it('满视口无关闭钮的 dialog 当应用壳，不 Escape', async () => {
    const page = await open(APP_SHELL)
    const result = await settleAuthenticatedLanding({
      page,
      target,
      sessionAuth: sessionAuth(),
    })
    expect(result.overlaysDismissed).toBe(0)
    expect(await page.getByRole('dialog').count()).toBe(1)
    expect(await page.locator('#work').isVisible()).toBe(true)
    await page.close()
  })

  it('目标关闭整理时不刷新不点', async () => {
    const page = await open(GOT_IT)
    const result = await settleAuthenticatedLanding({
      page,
      target: { ...target, landingSettleMode: 'off' },
      sessionAuth: sessionAuth(),
    })
    expect(result.skippedReason).toBe('mode_off')
    expect(result.didReload).toBe(false)
    expect(await page.getByRole('dialog').count()).toBe(1)
    await page.close()
  })

  it('本轮已打开入口则不再 reload', async () => {
    const page = await open(GOT_IT)
    const result = await settleAuthenticatedLanding({
      page,
      target,
      sessionAuth: sessionAuth(),
      alreadyOpenedEntry: true,
    })
    expect(result.didReload).toBe(false)
    expect(result.didNavigate).toBe(false)
    expect(result.overlaysDismissed).toBe(1)
    await page.close()
  })

  it('预算用尽仍返回部分结果', async () => {
    const page = await open(delayedDialogHtml(800))
    const result = await settleAuthenticatedLanding({
      page,
      target,
      sessionAuth: sessionAuth({ landingSettleBudgetMs: 1, landingSettleWatchMs: 0 }),
    })
    expect(result.skippedReason).toBeUndefined()
    expect(result.didReload || result.overlaysDismissed === 0).toBe(true)
    await page.close()
  })
})
