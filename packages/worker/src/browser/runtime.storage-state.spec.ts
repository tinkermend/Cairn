import { describe, expect, it, vi } from 'vitest'
import { BrowserRuntimeError, injectStorageState, openSharedSession, runWithOccupancy } from './runtime'
import { SessionLeaseError } from './session-error.js'

const grant = {
  sessionId: 's',
  leaseId: 'l',
  generation: 1,
  sessionFencingToken: 1,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  purpose: 'EXECUTION' as const,
  ownerKind: 'RUN' as const,
  runId: 'r',
  operationId: null,
}

function fakeContext(opts: { cookiesError?: Error; initScriptError?: Error } = {}) {
  return {
    addCookies: vi.fn(async () => {
      if (opts.cookiesError) throw opts.cookiesError
    }),
    addInitScript: vi.fn(async () => {
      if (opts.initScriptError) throw opts.initScriptError
    }),
    newPage: vi.fn(async () => ({})),
    close: vi.fn(async () => {}),
  }
}

describe('injectStorageState', () => {
  it('Cookie 被浏览器拒收时抛 AUTH_STORAGE_STATE_INVALID', async () => {
    const context = fakeContext({ cookiesError: new Error('Invalid cookie fields') })
    const err = await injectStorageState(context as never, { cookies: [{ name: 'a', value: 'b' }] }).catch((e) => e)
    expect(err).toBeInstanceOf(SessionLeaseError)
    expect(err.code).toBe('AUTH_STORAGE_STATE_INVALID')
  })

  it('LocalStorage 脚本注入失败时抛 AUTH_STORAGE_STATE_INVALID', async () => {
    const context = fakeContext({ initScriptError: new Error('closed') })
    const err = await injectStorageState(context as never, {
      origins: [{ origin: 'https://example.com', localStorage: [{ name: 'k', value: 'v' }] }],
    }).catch((e) => e)
    expect(err).toBeInstanceOf(SessionLeaseError)
    expect(err.code).toBe('AUTH_STORAGE_STATE_INVALID')
  })
})

describe('openSharedSession 注入失败', () => {
  it('关闭已创建的 context，且不改写成 BROWSER_LAUNCH_FAILED', async () => {
    const context = fakeContext({ cookiesError: new Error('Invalid cookie fields') })
    const browser = { newContext: vi.fn(async () => context) }
    const err = await Promise.resolve(
      runWithOccupancy(grant, () =>
        openSharedSession({ browser: browser as never, hostId: 'h' }, {
          headless: true,
          storageState: { cookies: [{ name: 'a', value: 'b' }] },
        } as never),
      ),
    ).catch((e: any) => e)
    expect(err).toBeInstanceOf(SessionLeaseError)
    expect(err).not.toBeInstanceOf(BrowserRuntimeError)
    expect(err.code).toBe('AUTH_STORAGE_STATE_INVALID')
    expect(context.close).toHaveBeenCalled()
    expect(context.newPage).not.toHaveBeenCalled()
  })
})
