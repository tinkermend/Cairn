import { describe, expect, it } from 'vitest'
import { can, visibleByPermission } from './rbac'
import type { AuthUser } from '@/stores/auth-store'

const admin: AuthUser = {
  id: 'a1',
  displayName: 'Admin',
  email: 'a@example.com',
  roles: ['admin'],
  permissions: ['account:read', 'account:write', 'role:read', 'role:write'],
}

const viewer: AuthUser = {
  id: 'v1',
  displayName: 'Viewer',
  email: null,
  roles: ['viewer'],
  permissions: ['account:read', 'role:read'],
}

describe('can', () => {
  it('没有登录主体时隐藏', () => {
    expect(can(null, 'role:write')).toBe(false)
  })

  it('有主体时按权限判定', () => {
    expect(can(admin, 'role:write')).toBe(true)
    expect(can(viewer, 'role:write')).toBe(false)
    expect(can(viewer, 'role:read')).toBe(true)
  })
})

describe('visibleByPermission', () => {
  const items = [
    { title: 'Dashboard' },
    { title: 'Users', permission: 'account:read' as const },
    { title: 'Roles', permission: 'role:write' as const },
  ]

  it('无主体时只保留不要求权限的项', () => {
    expect(visibleByPermission(items, null).map((i) => i.title)).toEqual(['Dashboard'])
  })

  it('viewer 看不到需要 write 的项', () => {
    expect(visibleByPermission(items, viewer).map((i) => i.title)).toEqual([
      'Dashboard',
      'Users',
    ])
  })
})
