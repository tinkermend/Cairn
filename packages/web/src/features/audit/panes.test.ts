import { describe, expect, it } from 'vitest'
import type { AuthUser } from '@/stores/auth-store'
import { visibleAuditPanes } from './panes'

function user(permissions: string[]): AuthUser {
  return { id: 'u1', displayName: '测试', email: null, roles: [], permissions }
}

describe('visibleAuditPanes', () => {
  it('按权限决定可见表格，互不隐含', () => {
    expect(visibleAuditPanes(user(['audit:read', 'audit:login']))).toEqual([
      'operations',
      'logins',
    ])
    expect(visibleAuditPanes(user(['audit:read']))).toEqual(['operations'])
    expect(visibleAuditPanes(user(['audit:login']))).toEqual(['logins'])
    expect(visibleAuditPanes(user([]))).toEqual([])
    expect(visibleAuditPanes(null)).toEqual([])
  })
})
