import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEV_INTERNAL_AUTH_SECRET,
  requireInternalSecret,
  signInternalHeaders,
  workerInternalPath,
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
})
