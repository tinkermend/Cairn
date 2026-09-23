import { describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { applyAuthInput, handoffMessage, viewportMatches } from './managed-helpers'
import type { BrowserAuthInputCommand } from '@cairn/shared'

describe('managed helpers', () => {
  it('视口容差内匹配，超出则拒绝', () => {
    expect(viewportMatches({ width: 1280, height: 720 }, { width: 1280, height: 720 })).toBe(true)
    expect(viewportMatches({ width: 1290, height: 720 }, { width: 1280, height: 720 })).toBe(true)
    expect(viewportMatches({ width: 1400, height: 720 }, { width: 1280, height: 720 })).toBe(false)
  })

  it('交接错误有明确中文说明', () => {
    expect(handoffMessage('PAGE_HANDOFF_NO_POPUP')).toContain('没有')
    expect(handoffMessage('PAGE_HANDOFF_OUT_OF_SCOPE')).toContain('范围')
  })

  describe('真实 Chromium 滚轮与键盘导航端到端验证', () => {
    it('精准落点 mouse_wheel 只滚动光标下的局部容器，不影响其他容器', async () => {
      const browser = await chromium.launch({ headless: true })
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
        await page.setContent(`<!doctype html>
<html>
<head><style>
  body { margin: 0; padding: 0; }
  #sidebar {
    position: absolute; left: 0; top: 0; width: 250px; height: 400px;
    overflow-y: scroll; background: #eee;
  }
  #main {
    position: absolute; left: 300px; top: 0; width: 500px; height: 400px;
    overflow-y: scroll; background: #ddd;
  }
  .spacer { height: 2000px; }
</style></head>
<body>
  <div id="sidebar" tabindex="0"><div class="spacer">侧边栏深层内容</div></div>
  <div id="main" tabindex="0"><div class="spacer">主体内容</div></div>
</body>
</html>`)

        // 初始状态下两个容器 scrollTop 均为 0
        const initialScroll = await page.evaluate(() => ({
          sidebar: document.getElementById('sidebar')!.scrollTop,
          main: document.getElementById('main')!.scrollTop,
        }))
        expect(initialScroll).toEqual({ sidebar: 0, main: 0 })

        // 1. 光标落点在侧边栏内 (x: 100, y: 150)，派发滚轮 120px
        const sidebarWheelCommand: BrowserAuthInputCommand = {
          type: 'mouse_wheel',
          x: 100,
          y: 150,
          deltaX: 0,
          deltaY: 120,
          commandId: 'cmd-wheel-sidebar',
          seq: 1,
          pageRef: { sessionId: 's1', sessionGeneration: 1, pageId: 'p1', documentEpoch: 0 },
          frameId: 'f1',
          viewport: { width: 1280, height: 720 },
        }
        await applyAuthInput(page, sidebarWheelCommand)

        // 验证：侧边栏发生滚动，而主体完全未滚动！
        await page.waitForFunction(() => document.getElementById('sidebar')!.scrollTop > 0, { timeout: 2000 })
        const afterSidebarWheel = await page.evaluate(() => ({
          sidebar: document.getElementById('sidebar')!.scrollTop,
          main: document.getElementById('main')!.scrollTop,
        }))
        expect(afterSidebarWheel.sidebar).toBeGreaterThan(0)
        expect(afterSidebarWheel.main).toBe(0)

        // 2. 光标落点移至主体容器 (x: 400, y: 150)，派发滚轮 150px
        const mainWheelCommand: BrowserAuthInputCommand = {
          type: 'mouse_wheel',
          x: 400,
          y: 150,
          deltaX: 0,
          deltaY: 150,
          commandId: 'cmd-wheel-main',
          seq: 2,
          pageRef: { sessionId: 's1', sessionGeneration: 1, pageId: 'p1', documentEpoch: 0 },
          frameId: 'f1',
          viewport: { width: 1280, height: 720 },
        }
        await applyAuthInput(page, mainWheelCommand)

        // 验证：主体发生滚动，侧边栏维持之前位移不变！
        await page.waitForFunction(() => document.getElementById('main')!.scrollTop > 0, { timeout: 2000 })
        const afterMainWheel = await page.evaluate(() => ({
          sidebar: document.getElementById('sidebar')!.scrollTop,
          main: document.getElementById('main')!.scrollTop,
        }))
        expect(afterMainWheel.sidebar).toBe(afterSidebarWheel.sidebar)
        expect(afterMainWheel.main).toBeGreaterThan(0)

        // 3. 验证键盘 PageDown 翻页按键能力
        await page.focus('#main')
        const pageDownCommand: BrowserAuthInputCommand = {
          type: 'key',
          key: 'PageDown',
          commandId: 'cmd-pagedown',
          seq: 3,
          pageRef: { sessionId: 's1', sessionGeneration: 1, pageId: 'p1', documentEpoch: 0 },
          frameId: 'f1',
          viewport: { width: 1280, height: 720 },
        }
        await applyAuthInput(page, pageDownCommand)

        await page.waitForFunction((prev) => document.getElementById('main')!.scrollTop > prev, afterMainWheel.main, { timeout: 2000 })
        const afterPageDown = await page.evaluate(() => document.getElementById('main')!.scrollTop)
        expect(afterPageDown).toBeGreaterThan(afterMainWheel.main)
      } finally {
        await browser.close()
      }
    })
  })
})
