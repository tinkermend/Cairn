import { z } from 'zod'

/**
 * RBAC 契约。权限目录由代码拥有，角色是权限的命名集合。
 *
 * 模型对齐 Kubernetes RBAC / Harbor / Grafana 的实践：
 * - 权限是 `resource:action`，目录封闭，调用方不能自造权限码
 * - 系统角色（admin / operator / viewer）由代码定义，不可删、不可改权限集
 * - 自定义角色可配目录内的权限，禁止 `*:*`
 * - 账号与角色多对多；鉴权只认解析后的权限集，不认角色名
 *
 * 前端用同一批 schema 解析接口，用 `hasPermission` 做按钮/路由显隐。
 * 真正的拒绝在 api 的 PermissionsGuard，前端隐藏不是安全边界。
 */

export const PERMISSION_RESOURCES = [
  'account',
  'role',
  'workflow',
  'run',
  'target',
  'settings',
  'audit',
] as const
export type PermissionResource = (typeof PERMISSION_RESOURCES)[number]

export const PERMISSION_ACTIONS = ['read', 'write', 'delete', 'execute', 'cancel'] as const
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number]

export const PERMISSIONS = [
  'account:read',
  'account:write',
  'account:delete',
  'role:read',
  'role:write',
  'role:delete',
  'workflow:read',
  'workflow:write',
  'workflow:delete',
  'run:read',
  'run:execute',
  'run:cancel',
  'target:read',
  'target:write',
  'target:delete',
  'settings:read',
  'settings:write',
  'audit:read',
] as const
export type PermissionCode = (typeof PERMISSIONS)[number]

export const WILDCARD_PERMISSION = '*:*' as const

export const permissionCodeSchema = z.enum(PERMISSIONS)
export const grantedPermissionSchema = z.union([
  permissionCodeSchema,
  z.literal(WILDCARD_PERMISSION),
  z.string().regex(/^[a-z]+:\*$/),
])

export const RESOURCE_LABELS: Record<PermissionResource, string> = {
  account: 'Accounts',
  role: 'Roles',
  workflow: 'Workflows',
  run: 'Runs',
  target: 'Targets',
  settings: 'Settings',
  audit: 'Audit',
}

export const PERMISSION_LABELS: Record<PermissionCode, string> = {
  'account:read': 'View accounts',
  'account:write': 'Create and update accounts',
  'account:delete': 'Delete accounts',
  'role:read': 'View roles',
  'role:write': 'Create and update roles',
  'role:delete': 'Delete custom roles',
  'workflow:read': 'View workflows',
  'workflow:write': 'Create and update workflows',
  'workflow:delete': 'Delete workflows',
  'run:read': 'View runs',
  'run:execute': 'Start runs',
  'run:cancel': 'Cancel runs',
  'target:read': 'View targets',
  'target:write': 'Create and update targets',
  'target:delete': 'Delete targets',
  'settings:read': 'View settings',
  'settings:write': 'Update settings',
  'audit:read': 'View audit log',
}

export interface PermissionDef {
  code: PermissionCode
  resource: PermissionResource
  action: string
  label: string
}

export const PERMISSION_CATALOG: readonly PermissionDef[] = PERMISSIONS.map((code) => {
  const [resource, action] = code.split(':') as [PermissionResource, string]
  return { code, resource, action, label: PERMISSION_LABELS[code] }
})

export const SYSTEM_ROLE_KEYS = ['admin', 'operator', 'viewer'] as const
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number]

export const DEFAULT_ACCOUNT_ROLE_KEY: SystemRoleKey = 'operator'
export const ADMIN_ROLE_KEY: SystemRoleKey = 'admin'

export const ROLE_KIND = ['system', 'custom'] as const
export type RoleKind = (typeof ROLE_KIND)[number]

export const ACCOUNT_STATUS = ['active', 'disabled'] as const
export type AccountStatus = (typeof ACCOUNT_STATUS)[number]

const OPERATOR_PERMISSIONS: readonly PermissionCode[] = [
  'account:read',
  'role:read',
  'workflow:read',
  'workflow:write',
  'workflow:delete',
  'run:read',
  'run:execute',
  'run:cancel',
  'target:read',
  'target:write',
  'target:delete',
  'settings:read',
  'audit:read',
]

const VIEWER_PERMISSIONS: readonly PermissionCode[] = [
  'account:read',
  'role:read',
  'workflow:read',
  'run:read',
  'target:read',
  'settings:read',
  'audit:read',
]

export const SYSTEM_ROLE_DEFINITIONS: Readonly<
  Record<SystemRoleKey, { name: string; description: string; permissions: readonly PermissionCode[] }>
> = {
  admin: {
    name: 'Administrator',
    description: 'Full access, including identity and permission management.',
    permissions: PERMISSIONS,
  },
  operator: {
    name: 'Operator',
    description: 'Run and edit workflows. Cannot manage accounts or roles.',
    permissions: OPERATOR_PERMISSIONS,
  },
  viewer: {
    name: 'Viewer',
    description: 'Read-only access to the console.',
    permissions: VIEWER_PERMISSIONS,
  },
}

export function isPermissionCode(value: string): value is PermissionCode {
  return (PERMISSIONS as readonly string[]).includes(value)
}

export function isSystemRoleKey(value: string): value is SystemRoleKey {
  return (SYSTEM_ROLE_KEYS as readonly string[]).includes(value)
}

/**
 * 判定已授予集合是否覆盖所需权限。
 *
 * `*:*` 覆盖一切；`resource:*` 覆盖该资源下全部 action。
 * 不把通配展开进集合——存储保持原样，判定时解析。
 */
export function hasPermission(granted: readonly string[], required: string): boolean {
  if (granted.includes(WILDCARD_PERMISSION)) return true
  if (granted.includes(required)) return true
  const sep = required.indexOf(':')
  if (sep <= 0) return false
  return granted.includes(`${required.slice(0, sep)}:*`)
}

export function hasAllPermissions(granted: readonly string[], required: readonly string[]): boolean {
  return required.every((code) => hasPermission(granted, code))
}

export function uniquePermissions(codes: readonly string[]): string[] {
  return [...new Set(codes)].sort()
}

export const roleKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,62}$/, '角色 key 须为小写字母开头的 slug（最多 63 字符）')

export const roleKindSchema = z.enum(ROLE_KIND)
export const accountStatusSchema = z.enum(ACCOUNT_STATUS)

export const roleRefSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  name: z.string().min(1),
  kind: roleKindSchema,
})
export type RoleRef = z.infer<typeof roleRefSchema>

export const roleSchema = roleRefSchema.extend({
  description: z.string().nullable(),
  permissions: z.array(z.string().min(1)),
  accountCount: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})
export type RoleDto = z.infer<typeof roleSchema>

export const accountSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  email: z.string().nullable(),
  status: accountStatusSchema,
  roles: z.array(roleRefSchema),
  permissions: z.array(z.string().min(1)),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})
export type AccountDto = z.infer<typeof accountSchema>

export const meResponseSchema = z.object({
  account: accountSchema,
})
export type MeResponse = z.infer<typeof meResponseSchema>

export const permissionCatalogResponseSchema = z.object({
  items: z.array(
    z.object({
      code: z.string().min(1),
      resource: z.string().min(1),
      action: z.string().min(1),
      label: z.string().min(1),
    }),
  ),
})
export type PermissionCatalogResponse = z.infer<typeof permissionCatalogResponseSchema>

export const roleListResponseSchema = z.object({
  items: z.array(roleSchema),
})
export type RoleListResponse = z.infer<typeof roleListResponseSchema>

export const accountListResponseSchema = z.object({
  items: z.array(accountSchema),
})
export type AccountListResponse = z.infer<typeof accountListResponseSchema>

const catalogPermissionListSchema = z
  .array(permissionCodeSchema)
  .min(1, '至少选择一项权限')
  .refine((codes) => new Set(codes).size === codes.length, '权限不能重复')

export const createRoleBodySchema = z.object({
  key: roleKeySchema,
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(256).optional(),
  permissions: catalogPermissionListSchema,
})
export type CreateRoleBody = z.infer<typeof createRoleBodySchema>

export const updateRoleBodySchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    description: z.string().trim().max(256).nullable().optional(),
    permissions: catalogPermissionListSchema.optional(),
  })
  .refine((body) => body.name !== undefined || body.description !== undefined || body.permissions !== undefined, {
    message: '至少提供一个要修改的字段',
  })
export type UpdateRoleBody = z.infer<typeof updateRoleBodySchema>

export const replaceRolePermissionsBodySchema = z.object({
  permissions: catalogPermissionListSchema,
})
export type ReplaceRolePermissionsBody = z.infer<typeof replaceRolePermissionsBodySchema>

export const passwordSchema = z
  .string()
  .min(8, '密码至少 8 个字符')
  .max(128, '密码最多 128 个字符')

export const createAccountBodySchema = z.object({
  displayName: z.string().trim().min(1).max(64),
  email: z.email(),
  password: passwordSchema,
  status: accountStatusSchema.optional(),
  roleIds: z.array(z.string().min(1)).optional(),
})
export type CreateAccountBody = z.infer<typeof createAccountBodySchema>

export const loginBodySchema = z.object({
  email: z.email(),
  password: z.string().min(1, '请输入密码'),
})
export type LoginBody = z.infer<typeof loginBodySchema>

export const loginResponseSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
  account: accountSchema,
})
export type LoginResponse = z.infer<typeof loginResponseSchema>

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码'),
  newPassword: passwordSchema,
})
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>

export const setPasswordBodySchema = z.object({
  password: passwordSchema,
})
export type SetPasswordBody = z.infer<typeof setPasswordBodySchema>

export const updateMeBodySchema = z.object({
  displayName: z.string().trim().min(1).max(64),
})
export type UpdateMeBody = z.infer<typeof updateMeBodySchema>

export const AUDIT_ACTIONS = [
  'account.create',
  'account.update',
  'account.delete',
  'account.roles',
  'account.password',
  'role.create',
  'role.update',
  'role.delete',
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export const auditEventSchema = z.object({
  id: z.string().min(1),
  action: z.string().min(1),
  resource: z.string().min(1),
  resourceId: z.string().nullable(),
  summary: z.string().min(1),
  actor: z
    .object({
      id: z.string().min(1),
      displayName: z.string().min(1),
      email: z.string().nullable(),
    })
    .nullable(),
  createdAt: z.string().min(1),
})
export type AuditEventDto = z.infer<typeof auditEventSchema>

export const auditListResponseSchema = z.object({
  items: z.array(auditEventSchema),
})
export type AuditListResponse = z.infer<typeof auditListResponseSchema>

export const updateAccountBodySchema = z
  .object({
    displayName: z.string().trim().min(1).max(64).optional(),
    email: z.union([z.email(), z.null()]).optional(),
    status: accountStatusSchema.optional(),
  })
  .refine((body) => body.displayName !== undefined || body.email !== undefined || body.status !== undefined, {
    message: '至少提供一个要修改的字段',
  })
export type UpdateAccountBody = z.infer<typeof updateAccountBodySchema>

export const assignAccountRolesBodySchema = z.object({
  roleIds: z.array(z.string().min(1)).min(1, '账号至少保留一个角色'),
})
export type AssignAccountRolesBody = z.infer<typeof assignAccountRolesBodySchema>
