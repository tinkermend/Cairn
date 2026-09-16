import { describe, expect, it } from 'vitest'
import { GuardError, SessionGuard } from './guard'

const base = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  leaseId: '00000000-0000-4000-8000-000000000002',
  generation: 1,
  sessionFencingToken: 3,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}

describe('SessionGuard', () => {
  it('install 后 assertHeld 通过', () => {
    const guard = new SessionGuard()
    guard.install(base)
    expect(guard.assertHeld(base.leaseId).sessionFencingToken).toBe(3)
  })

  it('过期后拒绝命令并撤销', () => {
    const guard = new SessionGuard()
    guard.install({ ...base, expiresAt: new Date(Date.now() - 1000).toISOString() })
    expect(() => guard.assertHeld(base.leaseId)).toThrow(GuardError)
    expect(() => guard.assertHeld(base.leaseId)).toThrow(/租约/)
  })

  it('revoke 后任何命令失败，需重新 install', () => {
    const guard = new SessionGuard()
    guard.install(base)
    guard.revoke(base.leaseId)
    expect(() => guard.assertHeld(base.leaseId)).toThrow(GuardError)
    guard.install({ ...base, sessionFencingToken: 4 })
    expect(guard.assertHeld(base.leaseId).sessionFencingToken).toBe(4)
  })

  it('fencing 不匹配时 refresh 会 revoke', () => {
    const guard = new SessionGuard()
    guard.install(base)
    guard.refresh({ ...base, sessionFencingToken: 9, expiresAt: new Date(Date.now() + 60_000).toISOString() })
    expect(() => guard.assertHeld(base.leaseId)).toThrow(GuardError)
  })

  it('AUTH_WAIT 不能作为执行器 grant；EXECUTION 可以通过', () => {
    const guard = new SessionGuard()
    guard.install({ ...base, purpose: 'AUTH_WAIT' })
    expect(() => guard.assertExecutor(base.leaseId)).toThrow(/不能作为执行器/)
    guard.install({ ...base, purpose: 'EXECUTION' })
    expect(guard.assertExecutor(base.leaseId).purpose).toBe('EXECUTION')
  })

  it('pageForGrant 允许 AUTH_WAIT 观察，不允许 MAINTENANCE 执行', () => {
    const guard = new SessionGuard()
    guard.install({ ...base, purpose: 'AUTH_WAIT' })
    expect(guard.assertPurpose(base.leaseId, ['EXECUTION', 'AUTH_WAIT']).purpose).toBe('AUTH_WAIT')
    guard.install({ ...base, purpose: 'MAINTENANCE', leaseId: '00000000-0000-4000-8000-000000000003' })
    expect(() =>
      guard.assertExecutor('00000000-0000-4000-8000-000000000003'),
    ).toThrow(/不能作为执行器/)
  })
})
