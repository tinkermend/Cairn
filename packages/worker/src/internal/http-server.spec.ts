import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEV_INTERNAL_AUTH_SECRET,
  requireInternalSecret,
  signInternalHeaders,
  workerInternalPath,
  workerRunsInternalPath,
} from '@cairn/shared'
import { startManagedBrowserHttp } from './http-server'

const actorId = '00000000-0000-4000-8000-000000000031'
const runId = '00000000-0000-4000-8000-000000000032'
const workerInstanceId = '00000000-0000-4000-8000-000000000033'

function stubSessions() {
  return {
    describeRunBrowser: vi.fn(async () => ({
      runId,
      runStatus: 'RUNNING',
      sessionId: null,
      sessionGeneration: null,
      ownerWorkerId: null,
      framesAvailable: false,
      viewingOtherPage: false,
      currentPage: null,
      pages: [],
      authHold: null,
      authControl: null,
      capabilities: {
        screencast: 'closed',
        authInput: 'closed',
        popupHandoff: 'closed',
        chineseInsertText: 'closed',
      },
      degradedReason: 'worker_unreachable',
    })),
    acquireRunAuthControl: vi.fn(),
    heartbeatRunAuthControl: vi.fn(),
    inputRunAuthControl: vi.fn(),
    releaseRunAuthControl: vi.fn(),
    resumeRunAuth: vi.fn(),
    subscribeRunFrames: vi.fn(),
    observeRun: vi.fn(),
    invalidateObserveGrant: vi.fn(),
  }
}

describe('内部 HTTP', () => {
  const closers: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (closers.length) await closers.pop()!()
  })

  it('拒绝错误签名，接受正确签名且路径不含控制面路由', async () => {
    const sessions = stubSessions()
    const http = await startManagedBrowserHttp({
      host: '127.0.0.1',
      port: 0,
      secret: DEV_INTERNAL_AUTH_SECRET,
      workerInstanceId,
      sessions: sessions as never,
    })
    closers.push(http.close)
    const addr = http.server.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    const path = workerInternalPath('/meta')
    const unsigned = await fetch(`http://127.0.0.1:${addr.port}${path}`)
    expect(unsigned.status).toBe(401)
    const headers = await signInternalHeaders(requireInternalSecret(DEV_INTERNAL_AUTH_SECRET), {
      method: 'GET',
      path,
      body: '',
      expiresUnix: Math.floor(Date.now() / 1000) + 10,
      actorId,
      runId,
      sessionGeneration: 1,
      workerInstanceId,
    })
    const ok = await fetch(`http://127.0.0.1:${addr.port}${path}`, { headers })
    expect(ok.status).toBe(200)
    expect(sessions.describeRunBrowser).toHaveBeenCalledWith({ runId, actorId, pageId: undefined })
    expect(await ok.text()).not.toContain('/api/runs')
  })

  it('断开画面连接必须中止 Worker 订阅', { timeout: 8_000 }, async () => {
    const sessions = stubSessions()
    let frameSignal: AbortSignal | undefined
    let finishFeed: (() => void) | undefined
    sessions.subscribeRunFrames.mockImplementation(
      async ({ signal, onFrame }: { signal: AbortSignal; onFrame: (x: unknown) => void }) => {
        frameSignal = signal
        if (signal.aborted) return
        await new Promise<void>((resolve) => {
          finishFeed = resolve
          signal.addEventListener('abort', () => resolve(), { once: true })
          onFrame({ testFrame: true })
        })
      },
    )
    const http = await startManagedBrowserHttp({
      host: '127.0.0.1',
      port: 0,
      secret: DEV_INTERNAL_AUTH_SECRET,
      workerInstanceId,
      sessions: sessions as never,
    })
    closers.push(async () => {
      finishFeed?.()
      http.server.closeAllConnections()
      await http.close()
    })
    const addr = http.server.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    const path = workerInternalPath('/frames')
    const headers = await signInternalHeaders(requireInternalSecret(DEV_INTERNAL_AUTH_SECRET), {
      method: 'GET',
      path,
      body: '',
      expiresUnix: Math.floor(Date.now() / 1000) + 10,
      actorId,
      runId,
      sessionGeneration: 1,
      workerInstanceId,
    })
    const controller = new AbortController()
    const response = await fetch(`http://127.0.0.1:${addr.port}${path}`, { headers, signal: controller.signal })
    await response.body!.getReader().read()
    controller.abort()
    await vi.waitFor(() => expect(frameSignal?.aborted).toBe(true), { timeout: 1000 })
  })

  it('observe 与 debug-resume 走内部路径，不出现控制面 /api/runs', async () => {
    const sessions = stubSessions()
    sessions.observeRun.mockResolvedValue({
      outcome: 'FOUND',
      page: { url: 'https://shop.example.com' },
      diagnostics: { outcome: 'FOUND', candidatesTried: [] },
      source: 'managed',
    })
    const engine = {
      resumeDebug: vi.fn(async () => ({ ok: true })),
    }
    const http = await startManagedBrowserHttp({
      host: '127.0.0.1',
      port: 0,
      secret: DEV_INTERNAL_AUTH_SECRET,
      workerInstanceId,
      sessions: sessions as never,
      engine: engine as never,
    })
    closers.push(http.close)
    const addr = http.server.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')

    const observePath = workerInternalPath('/observe')
    const observeBody = JSON.stringify({ op: 'highlight' })
    const observeHeaders = await signInternalHeaders(requireInternalSecret(DEV_INTERNAL_AUTH_SECRET), {
      method: 'POST',
      path: observePath,
      body: observeBody,
      expiresUnix: Math.floor(Date.now() / 1000) + 10,
      actorId,
      runId,
      sessionGeneration: 1,
      workerInstanceId,
    })
    const observed = await fetch(`http://127.0.0.1:${addr.port}${observePath}`, {
      method: 'POST',
      headers: { ...observeHeaders, 'content-type': 'application/json' },
      body: observeBody,
    })
    expect(observed.status).toBe(200)
    expect(observePath).not.toContain('/api/runs')
    expect(sessions.observeRun).toHaveBeenCalled()

    const debugPath = workerRunsInternalPath('/debug-resume')
    const debugBody = JSON.stringify({ action: 'stop' })
    const debugHeaders = await signInternalHeaders(requireInternalSecret(DEV_INTERNAL_AUTH_SECRET), {
      method: 'POST',
      path: debugPath,
      body: debugBody,
      expiresUnix: Math.floor(Date.now() / 1000) + 10,
      actorId,
      runId,
      sessionGeneration: 1,
      workerInstanceId,
    })
    const resumed = await fetch(`http://127.0.0.1:${addr.port}${debugPath}`, {
      method: 'POST',
      headers: { ...debugHeaders, 'content-type': 'application/json' },
      body: debugBody,
    })
    expect(resumed.status).toBe(200)
    expect(debugPath).toBe('/internal/runs/debug-resume')
    expect(engine.resumeDebug).toHaveBeenCalled()
    expect(sessions.invalidateObserveGrant).toHaveBeenCalledWith(runId)
  })
})
