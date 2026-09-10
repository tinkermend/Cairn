import { describe, expect, it } from 'vitest'
import {
  ADMIN_ROLE_KEY,
  DEFAULT_ACCOUNT_ROLE_KEY,
  PERMISSIONS,
  PERMISSION_CATALOG,
  SYSTEM_ROLE_DEFINITIONS,
  SYSTEM_ROLE_KEYS,
  WILDCARD_PERMISSION,
  accountSchema,
  accountListResponseSchema,
  createAccountBodySchema,
  createRoleBodySchema,
  hasAllPermissions,
  hasPermission,
  isPermissionCode,
  isSystemRoleKey,
  meResponseSchema,
  permissionCatalogResponseSchema,
  roleListResponseSchema,
  uniquePermissions,
  updateAccountBodySchema,
  updateRoleBodySchema,
} from '../rbac.js'

describe('hasPermission', () => {
  it('精确匹配', () => {
    expect(hasPermission(['workflow:read'], 'workflow:read')).toBe(true)
    expect(hasPermission(['workflow:read'], 'workflow:write')).toBe(false)
  })

  it('*:* 覆盖任意权限', () => {
    expect(hasPermission([WILDCARD_PERMISSION], 'account:delete')).toBe(true)
    expect(hasPermission([WILDCARD_PERMISSION], 'run:execute')).toBe(true)
  })

  it('resource:* 只覆盖该资源', () => {
    expect(hasPermission(['workflow:*'], 'workflow:delete')).toBe(true)
    expect(hasPermission(['workflow:*'], 'account:read')).toBe(false)
  })

  it('空集合一律拒绝', () => {
    expect(hasPermission([], 'account:read')).toBe(false)
  })

  it('畸形权限码不会被 resource:* 误伤', () => {
    expect(hasPermission(['workflow:*'], 'workflow')).toBe(false)
    expect(hasPermission(['*:*'], 'not-a-permission')).toBe(true)
  })
})

describe('hasAllPermissions', () => {
  it('必须全部命中', () => {
    expect(hasAllPermissions(['account:read', 'role:read'], ['account:read'])).toBe(true)
    expect(hasAllPermissions(['account:read'], ['account:read', 'account:write'])).toBe(false)
  })
})

describe('catalog', () => {
  it('每条权限都能拆成 resource:action，且出现在目录里', () => {
    expect(PERMISSION_CATALOG).toHaveLength(PERMISSIONS.length)
    for (const def of PERMISSION_CATALOG) {
      expect(def.code).toBe(`${def.resource}:${def.action}`)
      expect(isPermissionCode(def.code)).toBe(true)
    }
  })

  it('系统角色权限都在目录内，admin 拥有全部', () => {
    expect(SYSTEM_ROLE_DEFINITIONS.admin.permissions).toEqual(PERMISSIONS)
    for (const key of SYSTEM_ROLE_KEYS) {
      for (const code of SYSTEM_ROLE_DEFINITIONS[key].permissions) {
        expect(isPermissionCode(code)).toBe(true)
      }
    }
  })

  it('operator 不能管理身份与权限，viewer 只有 read', () => {
    expect(SYSTEM_ROLE_DEFINITIONS.operator.permissions).not.toContain('account:write')
    expect(SYSTEM_ROLE_DEFINITIONS.operator.permissions).not.toContain('role:write')
    expect(SYSTEM_ROLE_DEFINITIONS.viewer.permissions.every((c) => c.endsWith(':read'))).toBe(true)
  })

  it('默认新账号角色是 operator，管理员 key 稳定', () => {
    expect(DEFAULT_ACCOUNT_ROLE_KEY).toBe('operator')
    expect(ADMIN_ROLE_KEY).toBe('admin')
    expect(isSystemRoleKey('admin')).toBe(true)
    expect(isSystemRoleKey('cashier')).toBe(false)
  })
})

describe('uniquePermissions', () => {
  it('去重并排序', () => {
    expect(uniquePermissions(['b:write', 'a:read', 'b:write'])).toEqual(['a:read', 'b:write'])
  })
})

describe('body schemas', () => {
  it('创建角色拒绝目录外权限与非法 key', () => {
    expect(() =>
      createRoleBodySchema.parse({
        key: 'qa_lead',
        name: 'QA',
        permissions: ['workflow:read'],
      }),
    ).not.toThrow()

    expect(() =>
      createRoleBodySchema.parse({
        key: 'QA-Lead',
        name: 'QA',
        permissions: ['workflow:read'],
      }),
    ).toThrow()

    expect(() =>
      createRoleBodySchema.parse({
        key: 'qa_lead',
        name: 'QA',
        permissions: ['*:*'],
      }),
    ).toThrow()

    expect(() =>
      createRoleBodySchema.parse({
        key: 'admin',
        name: 'dup',
        permissions: ['workflow:read', 'workflow:read'],
      }),
    ).toThrow()
  })

  it('更新角色至少要有一个字段', () => {
    expect(() => updateRoleBodySchema.parse({})).toThrow()
    expect(() => updateRoleBodySchema.parse({ name: 'Ops' })).not.toThrow()
  })

  it('创建账号必须带邮箱和密码，角色可省略（服务端补默认 operator）', () => {
    expect(
      createAccountBodySchema.parse({
        displayName: '运维甲',
        email: 'a@cairn.dev',
        password: 'password1',
      }),
    ).toEqual({
      displayName: '运维甲',
      email: 'a@cairn.dev',
      password: 'password1',
    })
    expect(() => createAccountBodySchema.parse({ displayName: '运维甲' })).toThrow()
    expect(() =>
      createAccountBodySchema.parse({
        displayName: '运维甲',
        email: 'a@cairn.dev',
        password: 'short',
      }),
    ).toThrow()
  })

  it('更新账号至少要有一个字段', () => {
    expect(() => updateAccountBodySchema.parse({})).toThrow()
    expect(updateAccountBodySchema.parse({ status: 'disabled' })).toEqual({ status: 'disabled' })
    expect(updateAccountBodySchema.parse({ email: null })).toEqual({ email: null })
  })
})

describe('response schemas', () => {
  const role = {
    id: 'admin',
    key: 'admin',
    name: 'Administrator',
    kind: 'system' as const,
    description: 'all',
    permissions: ['account:read'],
    accountCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  const account = {
    id: 'acc-1',
    displayName: '运维甲',
    email: 'a@example.com',
    status: 'active' as const,
    roles: [{ id: 'admin', key: 'admin', name: 'Administrator', kind: 'system' as const }],
    permissions: ['account:read'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  it('account / me / catalog 响应可解析', () => {
    expect(accountSchema.parse(account).id).toBe('acc-1')
    expect(meResponseSchema.parse({ account }).account.displayName).toBe('运维甲')
    expect(permissionCatalogResponseSchema.parse({ items: [...PERMISSION_CATALOG] }).items).toHaveLength(
      PERMISSIONS.length,
    )
  })

  it('拒绝把脚手架的 cashier 角色混进来', () => {
    expect(() =>
      accountSchema.parse({
        ...account,
        roles: [{ id: 'x', key: 'cashier', name: 'Cashier', kind: 'custom' }],
      }),
    ).not.toThrow()
    expect(() => accountSchema.parse({ ...account, status: 'invited' })).toThrow()
  })

  it('role 必须带 accountCount', () => {
    const { accountCount: _drop, ...without } = role
    expect(() => accountSchema.parse({ ...account, roles: [without] })).not.toThrow()
  })

  it('集合信封接受省略的 nextCursor，也接受服务端给出的游标', () => {
    expect(roleListResponseSchema.parse({ items: [role] }).nextCursor).toBeUndefined()
    expect(accountListResponseSchema.parse({ items: [account] }).nextCursor).toBeUndefined()
    expect(roleListResponseSchema.parse({ items: [role], nextCursor: 'c-2' }).nextCursor).toBe('c-2')
  })

  it('nextCursor 为空串视为非法——空游标无法与「没有下一页」区分', () => {
    expect(() => roleListResponseSchema.parse({ items: [role], nextCursor: '' })).toThrow()
  })
})
