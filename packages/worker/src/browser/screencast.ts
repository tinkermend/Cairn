import type { CDPSession, Page } from 'playwright'
import {
  BROWSER_FRAME_MAX_EDGE,
  BROWSER_FRAME_QUALITY,
  type ManagedBrowserFrame,
  type PageRef,
} from '@cairn/shared'

export type ScreencastHandle = {
  latest: ManagedBrowserFrame | null
  stop: () => Promise<void>
}

/** CDP 投屏在静止登录页上可能十几秒不推新帧；过期后鼠标会被拒。用截图补新鲜度。 */
export async function refreshScreencastIfStale(
  page: Page,
  state: ScreencastHandle,
  pageRef: PageRef,
  staleMs = 1000,
): Promise<void> {
  const age = state.latest ? Date.now() - Date.parse(state.latest.capturedAt) : Number.POSITIVE_INFINITY
  if (Number.isFinite(age) && age <= staleMs) return
  if (page.isClosed()) return
  try {
    const buffer = await page.screenshot({ type: 'jpeg', quality: BROWSER_FRAME_QUALITY })
    const viewport = page.viewportSize() ?? { width: BROWSER_FRAME_MAX_EDGE, height: 720 }
    state.latest = {
      pageRef,
      frameId: `s-${Date.now().toString(36)}`,
      width: viewport.width,
      height: viewport.height,
      capturedAt: new Date().toISOString(),
      image: `data:image/jpeg;base64,${buffer.toString('base64')}`,
    }
  } catch {
    return
  }
}

export async function startScreencast(page: Page, pageRef: PageRef): Promise<ScreencastHandle> {
  const cdp: CDPSession = await page.context().newCDPSession(page)
  const state: ScreencastHandle = { latest: null, stop: async () => undefined }
  const onFrame = (event: { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } }) => {
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined)
    state.latest = {
      pageRef,
      frameId: `f-${event.sessionId}`,
      width: event.metadata?.deviceWidth ?? BROWSER_FRAME_MAX_EDGE,
      height: event.metadata?.deviceHeight ?? BROWSER_FRAME_MAX_EDGE,
      capturedAt: new Date().toISOString(),
      image: `data:image/jpeg;base64,${event.data}`,
    }
  }
  cdp.on('Page.screencastFrame', onFrame)
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: BROWSER_FRAME_QUALITY,
    maxWidth: BROWSER_FRAME_MAX_EDGE,
    maxHeight: BROWSER_FRAME_MAX_EDGE,
  })
  state.stop = async () => {
    cdp.off('Page.screencastFrame', onFrame)
    await cdp.send('Page.stopScreencast').catch(() => undefined)
    await cdp.detach().catch(() => undefined)
  }
  return state
}
