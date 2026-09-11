import { describe, expect, it } from 'vitest'
import type { DbHandle } from '@cairn/db'
import { BrowserSessionManager } from './session-manager'

describe('浏览器命令入口 × SessionGuard', () => {
  it('租约撤销后返回 SESSION_LEASE_LOST，不落到 Playwright', async () => {
    const manager = new BrowserSessionManager({} as DbHandle, {
      workerId: 'guard-test',
      profileRoot: '/tmp',
      headless: true,
      maxSessions: 1,
      defaultLeaseTtlSeconds: 30,
      defaultAuthWaitSeconds: 30,
      heartbeatMs: 60_000,
    })
    const grant = {
      sessionId: '00000000-0000-4000-8000-000000000001',
      leaseId: '00000000-0000-4000-8000-000000000002',
      generation: 1,
      sessionFencingToken: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    manager.guard.install(grant)
    manager.guard.revoke(grant.leaseId)
    let pageTouched = false
    manager.pageForGrant = () => {
      pageTouched = true
      return undefined
    }
    const result = await manager.execute(grant, {
      type: 'click',
      target: { framePath: [], candidates: [{ by: 'text', value: '确定' }] },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('ok')
    expect(result.error.code).toBe('SESSION_LEASE_LOST')
    expect(pageTouched).toBe(false)
  })
})
