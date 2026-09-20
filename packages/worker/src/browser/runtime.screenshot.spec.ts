/**
 * A5：截图不得改业务输入。无 chromium 时 skip。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { screenshotPage } from './runtime.js'

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

describe('screenshotPage 无副作用', () => {
  let hasBrowser = false

  beforeAll(async () => {
    hasBrowser = await chromiumAvailable()
  })

  it('截图前后输入值、焦点、滚动不变，且不派发 input/change', async ({ skip }) => {
    if (!hasBrowser) {
      skip()
      return
    }
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    try {
      await page.setContent(`<!doctype html><html><body style="height:2000px">
        <input id="user" value="alice" />
        <input id="pass" type="password" value="s3cret-password" />
        <textarea id="note">keep</textarea>
        <script>
          window.__events = []
          for (const id of ['user', 'pass', 'note']) {
            const el = document.getElementById(id)
            el.addEventListener('input', () => window.__events.push(id + ':input'))
            el.addEventListener('change', () => window.__events.push(id + ':change'))
          }
          document.getElementById('note').focus()
          window.scrollTo(0, 240)
        </script>
      </body></html>`)
      await page.evaluate(() => {
        document.getElementById('note')?.focus()
        window.scrollTo(0, 240)
      })
      const before = await page.evaluate(() => ({
        user: (document.getElementById('user') as HTMLInputElement).value,
        pass: (document.getElementById('pass') as HTMLInputElement).value,
        note: (document.getElementById('note') as HTMLTextAreaElement).value,
        focus: document.activeElement?.id ?? '',
        scroll: window.scrollY,
        events: [...((window as unknown as { __events: string[] }).__events ?? [])],
      }))
      const png = await screenshotPage(page)
      expect(png[0]).toBe(0x89)
      const after = await page.evaluate(() => ({
        user: (document.getElementById('user') as HTMLInputElement).value,
        pass: (document.getElementById('pass') as HTMLInputElement).value,
        note: (document.getElementById('note') as HTMLTextAreaElement).value,
        focus: document.activeElement?.id ?? '',
        scroll: window.scrollY,
        events: [...((window as unknown as { __events: string[] }).__events ?? [])],
      }))
      expect(after.user).toBe('alice')
      expect(after.pass).toBe('s3cret-password')
      expect(after.note).toBe('keep')
      expect(after.focus).toBe(before.focus)
      expect(after.scroll).toBe(before.scroll)
      expect(after.events).toEqual(before.events)
      expect(after.pass).not.toBe('••••')
    } finally {
      await browser.close()
    }
  }, 30_000)

  it('VE11：密码、iframe 与开放 Shadow 的敏感像素被 mask，输入值不变', async ({ skip }) => {
    if (!hasBrowser) {
      skip()
      return
    }
    const { chromium } = await import('playwright')
    const sharp = (await import('sharp')).default
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    try {
      await page.setContent(`<!doctype html><html><body style="margin:0;background:#ffffff">
        <input id="pass" type="password" value="s3cret-password" style="width:280px;height:48px;font-size:28px" />
        <iframe id="ve11-frame" style="display:block;width:760px;height:140px;border:0"
          srcdoc="<!doctype html><html><body style='margin:0;background:#ffffff'><p class='ve11-secret' style='color:#ff0000;font-size:64px;font-weight:700;line-height:1;margin:0'>VE11-IFRAME-SECRET</p></body></html>"></iframe>
        <div id="host"></div>
        <script>
          const host = document.getElementById('host')
          const root = host.attachShadow({ mode: 'open' })
          root.innerHTML = '<p class="ve11-secret" style="color:#ff0000;font-size:64px;font-weight:700;line-height:1;margin:0">VE11-SHADOW-SECRET</p>'
        </script>
      </body></html>`)
      await page.locator('#pass').waitFor()
      await page.locator('iframe').contentFrame().locator('.ve11-secret').waitFor()
      await page.locator('.ve11-secret').waitFor()

      const beforePass = await page.locator('#pass').inputValue()
      const exposed = await screenshotPage(page)
      const masked = await screenshotPage(page, { selectors: ['.ve11-secret'] })
      const afterPass = await page.locator('#pass').inputValue()
      expect(beforePass).toBe('s3cret-password')
      expect(afterPass).toBe(beforePass)
      expect(exposed[0]).toBe(0x89)
      expect(masked[0]).toBe(0x89)

      const exposedRed = await countHue(sharp, exposed, isSecretRed)
      const maskedRed = await countHue(sharp, masked, isSecretRed)
      const maskedMagenta = await countHue(sharp, masked, isMaskMagenta)
      expect(exposedRed).toBeGreaterThan(80)
      expect(maskedRed).toBeLessThan(Math.max(8, Math.floor(exposedRed * 0.05)))
      expect(maskedMagenta).toBeGreaterThan(80)
    } finally {
      await browser.close()
    }
  }, 45_000)
})

function isSecretRed(r: number, g: number, b: number): boolean {
  return r >= 200 && g <= 50 && b <= 50
}

function isMaskMagenta(r: number, g: number, b: number): boolean {
  return r >= 200 && g <= 50 && b >= 200
}

async function countHue(
  sharp: typeof import('sharp').default,
  png: Buffer,
  pred: (r: number, g: number, b: number) => boolean,
): Promise<number> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let count = 0
  for (let i = 0; i < data.length; i += info.channels) {
    if (pred(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0)) count += 1
  }
  return count
}
