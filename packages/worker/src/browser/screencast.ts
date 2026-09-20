import type { CDPSession, Page } from 'playwright'
import {
  BROWSER_FRAME_MAX_EDGE,
  BROWSER_FRAME_QUALITY,
  type ManagedBrowserFrame,
  type PageRef,
} from '@cairn/shared'
import type { CapturedFrame } from './captured-frame.js'

export type ScreencastHandle = {
  latest: ManagedBrowserFrame | null
  captureEpoch: number
  stop: () => Promise<void>
  subscribe: (listener: (frame: ManagedBrowserFrame) => void) => () => void
  subscribeCaptured: (listener: (frame: CapturedFrame) => void) => () => void
}

let nextCaptureEpoch = 1

function emitLive(
  state: ScreencastHandle & { liveListeners: Set<(frame: ManagedBrowserFrame) => void> },
  frame: ManagedBrowserFrame,
) {
  state.latest = frame
  for (const listener of state.liveListeners) listener(frame)
}

function emitCaptured(
  capturedListeners: Set<(frame: CapturedFrame) => void>,
  frame: CapturedFrame,
) {
  for (const listener of capturedListeners) listener(frame)
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
    const frame: ManagedBrowserFrame = {
      pageRef,
      frameId: `s-${Date.now().toString(36)}`,
      width: viewport.width,
      height: viewport.height,
      capturedAt: new Date().toISOString(),
      image: `data:image/jpeg;base64,${buffer.toString('base64')}`,
    }
    const liveListeners =
      'liveListeners' in state
        ? (state as typeof state & { liveListeners: Set<(frame: ManagedBrowserFrame) => void> }).liveListeners
        : undefined
    state.latest = frame
    if (liveListeners) {
      for (const listener of liveListeners) listener(frame)
    }
  } catch {
    return
  }
}

export async function startScreencast(page: Page, pageRef: PageRef): Promise<ScreencastHandle> {
  const cdp: CDPSession = await page.context().newCDPSession(page)
  const liveListeners = new Set<(frame: ManagedBrowserFrame) => void>()
  const capturedListeners = new Set<(frame: CapturedFrame) => void>()
  const captureEpoch = nextCaptureEpoch
  nextCaptureEpoch += 1
  let sourceSeq = 0
  const state: ScreencastHandle & {
    liveListeners: typeof liveListeners
    capturedListeners: typeof capturedListeners
  } = {
    latest: null,
    captureEpoch,
    liveListeners,
    capturedListeners,
    subscribe: (listener) => {
      liveListeners.add(listener)
      return () => liveListeners.delete(listener)
    },
    subscribeCaptured: (listener) => {
      capturedListeners.add(listener)
      return () => capturedListeners.delete(listener)
    },
    stop: async () => undefined,
  }
  const onFrame = (event: {
    data: string
    sessionId: number
    metadata?: { deviceWidth?: number; deviceHeight?: number; timestamp?: number }
  }) => {
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined)
    sourceSeq += 1
    let jpeg: Buffer
    try {
      jpeg = Buffer.from(event.data, 'base64')
    } catch {
      return
    }
    const width = event.metadata?.deviceWidth ?? BROWSER_FRAME_MAX_EDGE
    const height = event.metadata?.deviceHeight ?? BROWSER_FRAME_MAX_EDGE
    const sourceTimestampMs =
      event.metadata?.timestamp != null && Number.isFinite(event.metadata.timestamp)
        ? event.metadata.timestamp * 1000
        : undefined
    const captured: CapturedFrame = {
      pageId: pageRef.pageId,
      captureEpoch,
      sourceSeq,
      origin: 'cdp',
      ...(sourceTimestampMs != null ? { sourceTimestampMs } : {}),
      receivedMonoMs: performance.now(),
      jpeg,
      width,
      height,
    }
    emitCaptured(capturedListeners, captured)
    emitLive(state, {
      pageRef,
      frameId: `f-${captureEpoch}-${sourceSeq}`,
      width,
      height,
      capturedAt: new Date().toISOString(),
      image: `data:image/jpeg;base64,${event.data}`,
    })
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
    liveListeners.clear()
    capturedListeners.clear()
    await cdp.send('Page.stopScreencast').catch(() => undefined)
    await cdp.detach().catch(() => undefined)
  }
  return state
}
