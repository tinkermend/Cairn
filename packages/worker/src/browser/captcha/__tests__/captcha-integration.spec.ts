import { describe, it, expect } from 'vitest'
import { chromium } from 'playwright'
import { detectChallenge, solveChallenge } from '../index.js'

describe('Captcha Live Target Integration (AC-01 / AC-02)', () => {
  it('Gin-Vue-Admin live target: extracts, recognizes OCR and fills captcha input', async () => {
    let isReachable = false
    try {
      const res = await fetch('https://demo.gin-vue-admin.com/#/login', { signal: AbortSignal.timeout(4000) })
      isReachable = res.ok
    } catch {
      isReachable = false
    }

    if (!isReachable) {
      console.warn('Gin-Vue-Admin demo host unreachable, skipping live network test')
      return
    }

    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto('https://demo.gin-vue-admin.com/#/login', {
        waitUntil: 'networkidle',
        timeout: 15_000,
      })

      const challenge = await detectChallenge(page, null)
      expect(challenge).not.toBeNull()
      expect(challenge?.type).toBe('IMAGE_CAPTCHA')
      expect(challenge?.source).toBe('FINGERPRINT:gin-vue-admin-image')

      const outcome = await solveChallenge(page, challenge!, { timeoutMs: 15_000 })
      expect(outcome.solved).toBe(true)
      expect(outcome.handledBy).toBe('MACHINE')
      expect(outcome.durationMs).toBeGreaterThan(0)

      // Verify input value was populated
      const inputValue = await challenge!.locators.input!.inputValue()
      expect(inputValue.length).toBeGreaterThan(0)
    } finally {
      await browser.close()
    }
  }, 30_000)

  it('Gin-Vue-Admin full login flow (AC-01): fills credentials, solves captcha and submits form', async () => {
    let isReachable = false
    try {
      const res = await fetch('https://demo.gin-vue-admin.com/#/login', { signal: AbortSignal.timeout(4000) })
      isReachable = res.ok
    } catch {
      isReachable = false
    }

    if (!isReachable) {
      console.warn('Gin-Vue-Admin demo host unreachable, skipping live network test')
      return
    }

    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto('https://demo.gin-vue-admin.com/#/login', {
        waitUntil: 'networkidle',
        timeout: 15_000,
      })

      await page.locator('input[placeholder*="用户名"]').fill('admin')
      await page.locator('input[placeholder*="密码"]').fill('123456')

      const challenge = await detectChallenge(page, null)
      expect(challenge).not.toBeNull()
      const outcome = await solveChallenge(page, challenge!, { timeoutMs: 15_000 })
      expect(outcome.solved).toBe(true)

      await page.locator('button:has-text("登 录")').click()
      const leftLogin = await page
        .waitForFunction(
          `(() => {
            const hashPath = (location.hash.replace(/^#/, '').split('?')[0] || '').trim()
            const path = (hashPath.startsWith('/') ? hashPath : location.pathname).replace(/\\/+$/, '') || '/'
            return path !== '/login'
          })()`,
          undefined,
          { timeout: 8_000 },
        )
        .then(() => true)
        .catch(() => false)

      expect(leftLogin || page.url().includes('/#/layout') || !page.url().includes('/login')).toBe(true)
    } finally {
      await browser.close()
    }
  }, 30_000)

  it('Track slider interaction: smoothly drags knob to target with Bézier mouse trajectory', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.setContent(`
        <html>
          <head>
            <style>
              #track { width: 400px; height: 40px; background: #eee; position: relative; }
              #knob { width: 40px; height: 40px; background: #007bff; position: absolute; left: 0; top: 0; cursor: move; }
            </style>
          </head>
          <body>
            <div id="track">
              <div id="knob" class="cursor-move"></div>
            </div>
            <script>
              const knob = document.getElementById('knob');
              let isDragging = false;
              let startX = 0;
              let startLeft = 0;
              knob.addEventListener('mousedown', (e) => {
                isDragging = true;
                startX = e.clientX;
                startLeft = parseInt(knob.style.left || '0', 10);
              });
              window.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                const deltaX = e.clientX - startX;
                knob.style.left = Math.max(0, Math.min(360, startLeft + deltaX)) + 'px';
              });
              window.addEventListener('mouseup', () => {
                isDragging = false;
              });
            </script>
          </body>
        </html>
      `)

      const knob = page.locator('#knob')
      const track = page.locator('#track')

      const outcome = await solveChallenge(
        page,
        {
          type: 'SLIDER_CAPTCHA',
          source: 'TEST',
          confidence: 1.0,
          locators: {
            knob,
            containerOrBg: track,
          },
        },
        { minDurationMs: 400, maxDurationMs: 800 },
      )

      expect(outcome.solved).toBe(true)
      expect(outcome.challengeType).toBe('SLIDER_CAPTCHA')

      // Check that knob position moved towards the right end (>= 350px)
      const finalLeft = await knob.evaluate((el) => parseInt(el.style.left || '0', 10))
      expect(finalLeft).toBeGreaterThanOrEqual(350)
    } finally {
      await browser.close()
    }
  }, 15_000)

  it('Vben Admin live target: detects slider and performs a human-like drag', async () => {
    let isReachable = false
    try {
      const res = await fetch('https://www.vben.pro/', { signal: AbortSignal.timeout(4000) })
      isReachable = res.ok
    } catch {
      isReachable = false
    }

    if (!isReachable) {
      console.warn('Vben Admin demo host unreachable, skipping live network test')
      return
    }

    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto('https://www.vben.pro/#/auth/login', {
        waitUntil: 'networkidle',
        timeout: 20_000,
      })
      await page.locator('input[type="password"], input[placeholder*="密码"]').first().waitFor({
        state: 'visible',
        timeout: 10_000,
      }).catch(() => undefined)

      const challenge = await detectChallenge(page, null)
      if (!challenge || challenge.type !== 'SLIDER_CAPTCHA') {
        console.warn('Vben slider widget not visible, skipping live drag assertion')
        return
      }

      const outcome = await solveChallenge(page, challenge, {
        timeoutMs: 15_000,
        minDurationMs: 800,
        maxDurationMs: 1500,
      })
      expect(outcome.challengeType).toBe('SLIDER_CAPTCHA')
      expect(outcome.handledBy).toBe('MACHINE')
      expect(outcome.durationMs).toBeGreaterThan(0)
    } finally {
      await browser.close()
    }
  }, 40_000)
})
