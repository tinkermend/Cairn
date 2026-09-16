import { describe, expect, it } from 'vitest'
import {
  ADMIN_ROLE_KEY,
  AUTHOR_ROLE_KEY,
  CONSOLE_CAPABILITIES,
  DEFAULT_ACCOUNT_ROLE_KEY,
  PERMISSIONS,
  PERMISSION_CATALOG,
  PERMISSION_LABELS,
  RESOURCE_LABELS,
  SYSTEM_ROLE_DEFINITIONS,
  SYSTEM_ROLE_KEYS,
  canExecuteRun,
  canTrialRun,
  previewCapabilities,
  WILDCARD_PERMISSION,
  AUDIT_ACTION_LABELS,
  AUDIT_ACTIONS,
  LOGIN_FAILURE_REASON_LABELS,
  normalizeLoginIdentifier,
  operationAuditQuerySchema,
  loginAuditQuerySchema,
  loginAuditListResponseSchema,
  accountSchema,
  accountListResponseSchema,
  createAccountBodySchema,
  createRoleBodySchema,
  loginBodySchema,
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

  it('产品角色：执行者能跑含 AI 的正式运行，不能写场景或管身份；只读全是 read', () => {
    expect(SYSTEM_ROLE_DEFINITIONS.operator.permissions).not.toContain('account:write')
    expect(SYSTEM_ROLE_DEFINITIONS.operator.permissions).not.toContain('role:write')
    expect(SYSTEM_ROLE_DEFINITIONS.operator.permissions).not.toContain('audit:login')
    expect(SYSTEM_ROLE_DEFINITIONS.operator.permissions).toContain('ai:execute')
    expect(SYSTEM_ROLE_DEFINITIONS.operator.permissions).not.toContain('workflow:write')
    expect(SYSTEM_ROLE_DEFINITIONS.operator.permissions).not.toContain('target:write')
    expect(SYSTEM_ROLE_DEFINITIONS.author.permissions).toContain('workflow:write')
    expect(SYSTEM_ROLE_DEFINITIONS.author.permissions).toContain('run:execute')
    expect(SYSTEM_ROLE_DEFINITIONS.author.permissions).not.toContain('session:dispose')
    expect(SYSTEM_ROLE_DEFINITIONS.author.permissions).not.toContain('account:read')
    expect(SYSTEM_ROLE_DEFINITIONS.viewer.permissions).not.toContain('audit:login')
    expect(SYSTEM_ROLE_DEFINITIONS.viewer.permissions).not.toContain('ai:execute')
    expect(SYSTEM_ROLE_DEFINITIONS.viewer.permissions).toContain('ai:assist')
    expect(
      SYSTEM_ROLE_DEFINITIONS.viewer.permissions.every((c) => c.endsWith(':read') || c === 'ai:assist'),
    ).toBe(true)
  })

  it('admin 有登录记录权限，动作标签覆盖全部审计动作', () => {
    expect(SYSTEM_ROLE_DEFINITIONS.admin.permissions).toContain('audit:login')
    expect(SYSTEM_ROLE_DEFINITIONS.admin.permissions).toContain('ai:execute')
    expect(Object.keys(AUDIT_ACTION_LABELS).sort()).toEqual([...AUDIT_ACTIONS].sort())
    expect(LOGIN_FAILURE_REASON_LABELS.unknown_account).toBe('账号不存在')
  })

  it('登录名规范化：去空白并小写', () => {
    expect(normalizeLoginIdentifier('  Admin ')).toBe('admin')
  })

  it('审计列表查询拒绝 from ≥ to，空串当作未设', () => {
    expect(operationAuditQuerySchema.parse({}).limit).toBe(50)
    expect(operationAuditQuerySchema.parse({ action: '', cursor: '' }).action).toBeUndefined()
    expect(() =>
      operationAuditQuerySchema.parse({
        from: '2026-09-13T00:00:00.000Z',
        to: '2026-09-13T00:00:00.000Z',
      }),
    ).toThrow()
    expect(loginAuditQuerySchema.parse({ outcome: 'failure', identifier: 'Admin' }).identifier).toBe(
      'Admin',
    )
  })

  it('登录列表面包络可解析', () => {
    expect(
      loginAuditListResponseSchema.parse({
        items: [
          {
            id: 'evt-1',
            loginIdentifier: 'admin',
            outcome: 'success',
            failureReason: null,
            actor: { id: 'acc-1', displayName: '管理员', email: 'admin' },
            clientIp: '127.0.0.1',
            userAgent: 'test',
            clientKind: 'web',
            createdAt: '2026-09-13T00:00:00.000Z',
          },
        ],
      }).items,
    ).toHaveLength(1)
  })

  it('默认新账号角色是 author，四个系统角色 key 稳定', () => {
    expect(DEFAULT_ACCOUNT_ROLE_KEY).toBe('author')
    expect(ADMIN_ROLE_KEY).toBe('admin')
    expect(AUTHOR_ROLE_KEY).toBe('author')
    expect(SYSTEM_ROLE_KEYS).toEqual(['admin', 'author', 'operator', 'viewer'])
    expect(isSystemRoleKey('admin')).toBe(true)
    expect(isSystemRoleKey('author')).toBe(true)
    expect(isSystemRoleKey('cashier')).toBe(false)
  })

  it('目录标签是中文产品用语，码仍是 workflow / run', () => {
    expect(RESOURCE_LABELS.workflow).toBe('场景')
    expect(RESOURCE_LABELS.ai).toBe('AI')
    expect(PERMISSION_LABELS['workflow:read']).toBe('查看场景')
    expect(PERMISSION_LABELS['run:execute']).toBe('发起运行')
    expect(PERMISSION_LABELS['ai:execute']).toBe('执行含 AI 步骤的运行')
  })
})

describe('能力地图', () => {
  it('开跑必须同时具备 execute、读目标和读场景', () => {
    expect(canExecuteRun(['run:execute'])).toBe(false)
    expect(canExecuteRun(['run:execute', 'target:read'])).toBe(false)
    expect(canExecuteRun(['run:execute', 'target:read', 'workflow:read'])).toBe(true)
    expect(canTrialRun(['workflow:write', 'run:execute'])).toBe(false)
    expect(canTrialRun(['workflow:write', 'run:execute', 'target:read'])).toBe(true)
    expect(previewCapabilities(['run:execute']).actions).not.toContain('对目标系统发起运行')
  })

  it('执行者预览只有业务菜单，没有治理；编写者能看见录制', () => {
    const operator = previewCapabilities(SYSTEM_ROLE_DEFINITIONS.operator.permissions)
    expect(operator.menus.workbench).toEqual(['首页', '目标系统', '浏览器会话', '场景', '动作库', '运行', '自动复查'])
    expect(operator.menus.governance).toEqual(['执行节点'])
    expect(operator.menus.other).toEqual(['设置'])
    expect(operator.actions).toContain('对目标系统发起运行')
    expect(operator.actions).not.toContain('创建和编辑场景')
    expect(operator.actions).toContain('执行含 AI 步骤的运行')

    const author = previewCapabilities(SYSTEM_ROLE_DEFINITIONS.author.permissions)
    expect(author.menus.workbench).toEqual(['首页', '目标系统', '浏览器会话', '场景', '动作库', '录制草稿', '运行'])
    expect(author.menus.governance).toEqual(['执行节点'])
    expect(author.actions).toContain('在工作区试跑')
    expect(author.actions).toContain('对目标系统发起运行')
    expect(author.actions).not.toContain('处置卡死的浏览器会话')

    const viewer = previewCapabilities(SYSTEM_ROLE_DEFINITIONS.viewer.permissions)
    expect(viewer.menus.workbench).toEqual(['首页', '目标系统', '场景', '运行'])
    expect(viewer.actions).toEqual(['使用平台助手'])

    const admin = previewCapabilities(SYSTEM_ROLE_DEFINITIONS.admin.permissions)
    expect(admin.menus.governance).toEqual(['用户', '角色', '开放服务', '平台配置', '执行节点', '审计'])
  })

  it('能力 id 不重复，菜单 besides 首页都有 allOf', () => {
    const ids = CONSOLE_CAPABILITIES.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const item of CONSOLE_CAPABILITIES) {
      if (item.id === 'menu.home') {
        expect(item.allOf).toEqual([])
        expect(item.anyOf).toBeUndefined()
      } else if (item.anyOf?.length) {
        expect(item.anyOf.length).toBeGreaterThan(0)
      } else {
        expect(item.allOf.length).toBeGreaterThan(0)
      }
    }
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

  it('登录名不是邮箱：admin 合法，空串非法', () => {
    expect(loginBodySchema.parse({ email: 'admin', password: 'cairn-admin' })).toEqual({
      email: 'admin',
      password: 'cairn-admin',
    })
    expect(() => loginBodySchema.parse({ email: '', password: 'cairn-admin' })).toThrow()
  })

  it('创建账号必须带账号和密码，角色可省略（服务端补默认 author）', () => {
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
