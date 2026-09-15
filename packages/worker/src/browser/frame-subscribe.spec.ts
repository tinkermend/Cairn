import { describe, expect, it, vi } from 'vitest'
import { BrowserSessionManager } from './session-manager'

const stop = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('./screencast.js', async (original) => {
  const actual = await original<typeof import('./screencast.js')>()
  return {
    ...actual,
    startScreencast: vi.fn(async (_page: unknown, pageRef: { pageId: string }) => ({
      latest: {
        pageRef,
        frameId: 'f-1',
        width: 1280,
        height: 720,
        capturedAt: new Date().toISOString(),
        image: 'data:image/jpeg;base64,ZmFrZQ==',
      },
      stop,
    })),
    refreshScreencastIfStale: vi.fn(async () => undefined),
  }
})

const sessionId = '00000000-0000-4000-8000-000000000011'
const runId = '00000000-0000-4000-8000-000000000012'
const actorId = '00000000-0000-4000-8000-000000000013'
const pageId = '00000000-0000-4000-8000-000000000014'

function subscribeManager() {
  const page = {
    isClosed: () => false,
    url: () => 'https://shop.example.com/app',
    viewportSize: () => ({ width: 1280, height: 720 }),
  }
  const live = {
    sessionId,
    autoInputClosed: false,
    inputAccepting: false,
    serial: Promise.resolve(),
    receipts: new Map(),
    lastSeq: 0,
    controlEpoch: 0,
    pages: new Map([[pageId, { pageId, runId, documentEpoch: 1, page, kind: 'run' }]]),
    currentPageIdByRun: new Map([[runId, pageId]]),
    currentPageIdByLease: new Map(),
    runPages: new Map(),
    screencasts: new Map(),
    screencastObservers: new Map(),
    allowedOrigins: ['https://shop.example.com'],
    handle: { basePage: page },
  }
  const session = {
    id: sessionId,
    generation: 1,
    ownerWorkerId: 'test-worker',
    ownerWorkerInstanceId: 'test-worker',
    authControlActorId: null,
    authControlExpiresAt: null,
  }
  const run = { status: 'RUNNING' }
  const manager = Object.create(BrowserSessionManager.prototype) as BrowserSessionManager
  Object.assign(manager, {
    dbHandle: {},
    workerInstanceId: 'test-worker',
    options: { workerId: 'test-worker' },
    lives: new Map([[sessionId, live]]),
    requireLiveAuthSession: async () => ({ session, live, run }),
    sessionOwnedHere: () => true,
    registrationLive: () => true,
  })
  return { manager, live }
}

describe('画面订阅生命周期', () => {
  it('20 次连接/关闭不残留观察者或采集句柄', async () => {
    const { manager, live } = subscribeManager()
    stop.mockClear()
    for (let i = 0; i < 20; i += 1) {
      const controller = new AbortController()
      const seen = new Promise<void>((resolve) => {
        void manager.subscribeRunFrames({
          runId,
          actorId,
          onFrame: () => {
            resolve()
            controller.abort()
          },
          signal: controller.signal,
        })
      })
      await seen
      await vi.waitFor(() => expect(manager.countScreencastObservers(sessionId)).toBe(0))
    }
    expect(stop).toHaveBeenCalledTimes(20)
    expect(live.screencasts.size).toBe(0)
    expect(manager.countScreencastObservers(sessionId)).toBe(0)
  })
})
