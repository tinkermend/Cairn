import { describe, expect, it } from 'vitest'
import { can, canAny, filterNavItems, visibleByPermission } from './rbac'
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
    { title: '首页' },
    { title: '用户', permission: 'account:read' as const },
    { title: '角色', permission: 'role:write' as const },
  ]

  it('无主体时只保留不要求权限的项', () => {
    expect(visibleByPermission(items, null).map((i) => i.title)).toEqual(['首页'])
  })

  it('viewer 看不到需要 write 的项', () => {
    expect(visibleByPermission(items, viewer).map((i) => i.title)).toEqual([
      '首页',
      '用户',
    ])
  })

  it('anyOf 有其中一项权限即显示，并优先于 permission', () => {
    const gated = [
      { title: '审计', permission: 'audit:read' as const, anyOf: ['audit:read', 'audit:login'] as const },
    ]
    expect(visibleByPermission(gated, user(['audit:login'])).map((i) => i.title)).toEqual(['审计'])
    expect(visibleByPermission(gated, user(['audit:read'])).map((i) => i.title)).toEqual(['审计'])
    expect(visibleByPermission(gated, user([]))).toEqual([])
    expect(canAny(user(['audit:login']), ['audit:read', 'audit:login'])).toBe(true)
    expect(canAny(user(['account:read']), ['audit:read', 'audit:login'])).toBe(false)
  })
})

describe('filterNavItems', () => {
  it('父级无可见子项则整项去掉，与侧栏一致', () => {
    const items = [
      { title: '首页' },
      { title: '用户', permission: 'account:read' as const },
      {
        title: '设置',
        items: [
          { title: '个人资料' },
          { title: '外观' },
        ],
      },
      { title: '审计', anyOf: ['audit:read', 'audit:login'] as const },
    ]
    expect(filterNavItems(items, user(['target:read'])).map((item) => item.title)).toEqual([
      '首页',
      '设置',
    ])
    expect(filterNavItems(items, user(['audit:read'])).map((item) => item.title)).toEqual([
      '首页',
      '设置',
      '审计',
    ])
  })
})

function user(permissions: string[]): AuthUser {
  return { id: 'u2', displayName: '测试', email: null, roles: [], permissions }
}
