import { isExecutorGrant, type SessionGrant, type SessionLeasePurpose } from '@cairn/shared'

/**
 * 进程内命令面 guard：四元组 + 到期时间任一不符即拒绝。
 * 不做每条命令回库；续租失败后立即 revoke。
 */
export class SessionGuard {
  private grants = new Map<string, SessionGrant>()
  private revoked = new Set<string>()

  install(grant: SessionGrant): void {
    this.revoked.delete(grant.leaseId)
    this.grants.set(grant.leaseId, grant)
  }

  refresh(grant: SessionGrant): void {
    if (this.revoked.has(grant.leaseId)) return
    const current = this.grants.get(grant.leaseId)
    if (!current) return
    if (
      current.sessionId !== grant.sessionId ||
      current.generation !== grant.generation ||
      current.sessionFencingToken !== grant.sessionFencingToken
    ) {
      this.revoke(grant.leaseId)
      return
    }
    this.grants.set(grant.leaseId, grant)
  }

  revoke(leaseId: string): void {
    this.grants.delete(leaseId)
    this.revoked.add(leaseId)
  }

  /** 命令面校验。过期用 grant.expiresAt（续租会刷新）；库才是事实源。 */
  assertHeld(leaseId: string, expected?: Partial<SessionGrant>): SessionGrant {
    if (this.revoked.has(leaseId)) {
      throw new GuardError('SESSION_LEASE_LOST', '租约已撤销，拒绝浏览器命令')
    }
    const grant = this.grants.get(leaseId)
    if (!grant) {
      throw new GuardError('SESSION_LEASE_LOST', '租约不在本进程 guard 中')
    }
    if (expected) {
      if (expected.sessionId !== undefined && expected.sessionId !== grant.sessionId) {
        throw new GuardError('SESSION_LEASE_LOST', 'sessionId 不匹配')
      }
      if (expected.generation !== undefined && expected.generation !== grant.generation) {
        throw new GuardError('SESSION_LEASE_LOST', 'generation 不匹配')
      }
      if (
        expected.sessionFencingToken !== undefined &&
        expected.sessionFencingToken !== grant.sessionFencingToken
      ) {
        throw new GuardError('SESSION_LEASE_LOST', 'fencingToken 不匹配')
      }
    }
    if (Date.parse(grant.expiresAt) <= Date.now()) {
      this.revoke(leaseId)
      throw new GuardError('SESSION_LEASE_LOST', '租约已过期（进程侧）')
    }
    if (expected?.purpose && grant.purpose !== expected.purpose) {
      throw new GuardError('SESSION_LEASE_LOST', `租约用途 ${grant.purpose} 不匹配`)
    }
    return grant
  }

  assertExecutor(leaseId: string, expected?: Partial<SessionGrant>): SessionGrant {
    const grant = this.assertHeld(leaseId, expected)
    if (!isExecutorGrant(grant)) {
      throw new GuardError('SESSION_LEASE_LOST', `${grant.purpose ?? 'UNKNOWN'} 不能作为执行器 grant`)
    }
    return grant
  }

  assertPurpose(leaseId: string, purposes: SessionLeasePurpose[], expected?: Partial<SessionGrant>): SessionGrant {
    const grant = this.assertHeld(leaseId, expected)
    if (!purposes.includes(grant.purpose ?? 'EXECUTION')) {
      throw new GuardError('SESSION_LEASE_LOST', `租约用途 ${grant.purpose} 不允许`)
    }
    return grant
  }

  has(leaseId: string): boolean {
    return this.grants.has(leaseId) && !this.revoked.has(leaseId)
  }

  clear(): void {
    this.grants.clear()
    this.revoked.clear()
  }
}

export class GuardError extends Error {
  readonly code: 'SESSION_LEASE_LOST'

  constructor(code: 'SESSION_LEASE_LOST', message: string) {
    super(message)
    this.name = 'GuardError'
    this.code = code
  }
}
