import { z } from 'zod'

/**
 * RBAC 契约。权限目录由代码拥有，角色是权限的命名集合。
 *
 * 模型对齐 Kubernetes RBAC / Harbor / Grafana 的实践：
 * - 权限是 `resource:action`，目录封闭，调用方不能自造权限码
 * - 系统角色（admin / author / operator / viewer）由代码定义，不可删、不可改权限集
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
  'session',
  'target',
  'service',
  'settings',
  'audit',
  'ai',
  'platform-config',
] as const
export type PermissionResource = (typeof PERMISSION_RESOURCES)[number]

export const PERMISSION_ACTIONS = ['read', 'write', 'delete', 'execute', 'cancel', 'review'] as const
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
  'run:review',
  'session:read',
  'session:view',
  'session:control',
  'session:dispose',
  'target:read',
  'target:write',
  'target:delete',
  'service:read',
  'service:write',
  'settings:read',
  'settings:write',
  'audit:read',
  'audit:login',
  'ai:execute',
  'platform-config:read',
  'platform-config:write',
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
  account: '控制台账号',
  role: '角色',
  workflow: '场景',
  run: '运行',
  session: '浏览器会话',
  target: '目标系统',
  service: '开放服务',
  settings: '设置',
  audit: '审计',
  ai: '浏览器 AI',
  'platform-config': '平台配置',
}

export const PERMISSION_LABELS: Record<PermissionCode, string> = {
  'account:read': '查看控制台账号',
  'account:write': '创建和更新控制台账号',
  'account:delete': '删除控制台账号',
  'role:read': '查看角色',
  'role:write': '创建和更新角色',
  'role:delete': '删除自定义角色',
  'workflow:read': '查看场景',
  'workflow:write': '创建和编辑场景',
  'workflow:delete': '删除场景',
  'run:read': '查看运行',
  'run:execute': '发起运行',
  'run:cancel': '取消运行',
  'run:review': '核查暂停的运行',
  'session:read': '查看浏览器会话',
  'session:view': '查看受管浏览器画面',
  'session:control': '处理目标系统登录',
  'session:dispose': '处置卡死的浏览器会话',
  'target:read': '查看目标系统',
  'target:write': '登记和维护目标系统',
  'target:delete': '删除目标系统',
  'service:read': '查看开放服务',
  'service:write': '管理服务凭据与证据发布',
  'settings:read': '查看设置',
  'settings:write': '更新设置',
  'audit:read': '查看操作记录',
  'audit:login': '查看登录记录',
  'ai:execute': '执行含 AI 步骤的运行',
  'platform-config:read': '查看平台配置',
  'platform-config:write': '修改平台配置',
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

export const SYSTEM_ROLE_KEYS = ['admin', 'author', 'operator', 'viewer'] as const
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number]

export const DEFAULT_ACCOUNT_ROLE_KEY: SystemRoleKey = 'author'
export const ADMIN_ROLE_KEY: SystemRoleKey = 'admin'
export const AUTHOR_ROLE_KEY: SystemRoleKey = 'author'

export const ROLE_KIND = ['system', 'custom'] as const
export type RoleKind = (typeof ROLE_KIND)[number]

export const ACCOUNT_STATUS = ['active', 'disabled'] as const
export type AccountStatus = (typeof ACCOUNT_STATUS)[number]

const AUTHOR_PERMISSIONS: readonly PermissionCode[] = [
  'target:read',
  'target:write',
  'target:delete',
  'workflow:read',
  'workflow:write',
  'workflow:delete',
  'run:read',
  'run:execute',
  'run:cancel',
  'run:review',
  'ai:execute',
  'session:read',
  'session:view',
  'session:control',
  'settings:read',
]

const OPERATOR_PERMISSIONS: readonly PermissionCode[] = [
  'target:read',
  'workflow:read',
  'run:read',
  'run:execute',
  'run:cancel',
  'run:review',
  'ai:execute',
  'session:read',
  'session:view',
  'session:control',
  'session:dispose',
  'settings:read',
]

const VIEWER_PERMISSIONS: readonly PermissionCode[] = [
  'target:read',
  'workflow:read',
  'run:read',
  'settings:read',
]

export const SYSTEM_ROLE_DEFINITIONS: Readonly<
  Record<SystemRoleKey, { name: string; description: string; permissions: readonly PermissionCode[] }>
> = {
  admin: {
    name: '管理员',
    description: '治理与全部业务能力，包括身份与权限管理。',
    permissions: PERMISSIONS,
  },
  author: {
    name: '编写者',
    description: '登记目标、编写场景、试跑，也能创建正式 Run。不管账号与角色。',
    permissions: AUTHOR_PERMISSIONS,
  },
  operator: {
    name: '执行者',
    description: '选目标账号、发起 / 取消 / 核查运行。不改场景定义，不管身份。',
    permissions: OPERATOR_PERMISSIONS,
  },
  viewer: {
    name: '只读',
    description: '查看目标、场景、运行与证据。不能写，不能开跑。',
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

export const CAPABILITY_KINDS = ['menu', 'action'] as const
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number]

export const CAPABILITY_GROUPS = ['workbench', 'governance', 'other'] as const
export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number]

export const CAPABILITY_GROUP_LABELS: Record<CapabilityGroup, string> = {
  workbench: '工作台',
  governance: '治理',
  other: '其他',
}

export type ConsoleCapability = {
  id: string
  kind: CapabilityKind
  label: string
  /** 菜单所属分组；动作为空。 */
  group?: CapabilityGroup
  /** 空数组表示登录即可（仅首页）。与 anyOf 同时存在时以 anyOf 为准。 */
  allOf: readonly PermissionCode[]
  /** 有其中任一权限即授予；用于侧栏单入口对应多权限的菜单。 */
  anyOf?: readonly PermissionCode[]
}

export const CONSOLE_CAPABILITIES: readonly ConsoleCapability[] = [
  { id: 'menu.home', kind: 'menu', group: 'workbench', label: '首页', allOf: [] },
  { id: 'menu.targets', kind: 'menu', group: 'workbench', label: '目标系统', allOf: ['target:read'] },
  { id: 'menu.scenarios', kind: 'menu', group: 'workbench', label: '场景', allOf: ['workflow:read'] },
  { id: 'menu.recordings', kind: 'menu', group: 'workbench', label: '录制草稿', allOf: ['workflow:write'] },
  { id: 'menu.runs', kind: 'menu', group: 'workbench', label: '运行', allOf: ['run:read'] },
  { id: 'menu.users', kind: 'menu', group: 'governance', label: '用户', allOf: ['account:read'] },
  { id: 'menu.roles', kind: 'menu', group: 'governance', label: '角色', allOf: ['role:read'] },
  { id: 'menu.services', kind: 'menu', group: 'governance', label: '开放服务', allOf: ['service:read'] },
  { id: 'action.service.write', kind: 'action', label: '管理开放服务', allOf: ['service:write'] },
  { id: 'menu.platform-config', kind: 'menu', group: 'governance', label: '平台配置', allOf: ['platform-config:read'] },
  { id: 'action.platform-config.write', kind: 'action', label: '修改平台配置', allOf: ['platform-config:write'] },
  {
    id: 'menu.audit',
    kind: 'menu',
    group: 'governance',
    label: '审计',
    allOf: [],
    anyOf: ['audit:read', 'audit:login'],
  },
  { id: 'menu.settings', kind: 'menu', group: 'other', label: '设置', allOf: ['settings:read'] },
  { id: 'action.target.write', kind: 'action', label: '登记和维护目标系统', allOf: ['target:write'] },
  { id: 'action.target.delete', kind: 'action', label: '删除目标系统', allOf: ['target:delete'] },
  { id: 'action.scenario.write', kind: 'action', label: '创建和编辑场景', allOf: ['workflow:write'] },
  { id: 'action.scenario.delete', kind: 'action', label: '删除场景', allOf: ['workflow:delete'] },
  { id: 'action.recording.upload', kind: 'action', label: '上传录制草稿', allOf: ['workflow:write'] },
  {
    id: 'action.run.execute',
    kind: 'action',
    label: '对目标系统发起运行',
    allOf: ['run:execute', 'target:read', 'workflow:read'],
  },
  {
    id: 'action.run.trial',
    kind: 'action',
    label: '在工作区试跑',
    allOf: ['workflow:write', 'run:execute', 'target:read'],
  },
  { id: 'action.run.cancel', kind: 'action', label: '取消运行', allOf: ['run:cancel'] },
  { id: 'action.run.review', kind: 'action', label: '核查暂停的运行', allOf: ['run:review'] },
  { id: 'action.ai.execute', kind: 'action', label: '执行含 AI 步骤的运行', allOf: ['ai:execute'] },
  { id: 'action.session.view', kind: 'action', label: '查看受管浏览器画面', allOf: ['session:view'] },
  {
    id: 'action.session.control',
    kind: 'action',
    label: '处理目标系统登录',
    allOf: ['session:control', 'run:execute'],
  },
  { id: 'action.session.dispose', kind: 'action', label: '处置卡死的浏览器会话', allOf: ['session:dispose'] },
  { id: 'action.account.write', kind: 'action', label: '管理控制台账号', allOf: ['account:write'] },
  { id: 'action.role.write', kind: 'action', label: '管理自定义角色', allOf: ['role:write'] },
]

export type CapabilityPreview = {
  menus: Record<CapabilityGroup, string[]>
  actions: string[]
}

function capabilityGranted(granted: readonly string[], capability: ConsoleCapability): boolean {
  if (capability.anyOf?.length) return capability.anyOf.some((code) => hasPermission(granted, code))
  if (capability.allOf.length === 0) return true
  return hasAllPermissions(granted, capability.allOf)
}

export function previewCapabilities(granted: readonly string[]): CapabilityPreview {
  const menus: Record<CapabilityGroup, string[]> = {
    workbench: [],
    governance: [],
    other: [],
  }
  const actions: string[] = []
  for (const capability of CONSOLE_CAPABILITIES) {
    if (!capabilityGranted(granted, capability)) continue
    if (capability.kind === 'menu' && capability.group) {
      menus[capability.group].push(capability.label)
    } else if (capability.kind === 'action') {
      actions.push(capability.label)
    }
  }
  return { menus, actions }
}

export function capabilityById(id: string): ConsoleCapability {
  const found = CONSOLE_CAPABILITIES.find((item) => item.id === id)
  if (!found) throw new Error(`未知能力：${id}`)
  return found
}

export const RUN_EXECUTE_ALL_OF = capabilityById('action.run.execute').allOf
export const RUN_TRIAL_ALL_OF = capabilityById('action.run.trial').allOf

export function canExecuteRun(granted: readonly string[]): boolean {
  return hasAllPermissions(granted, RUN_EXECUTE_ALL_OF)
}

export function canTrialRun(granted: readonly string[]): boolean {
  return hasAllPermissions(granted, RUN_TRIAL_ALL_OF)
}

/**
 * 集合信封的游标。
 *
 * 有值即表示服务端还有下一页；服务端截断必须由它表达，静默截断是缺陷。
 * 内容由服务端生成、客户端只负责回传，不解释其含义。
 */
export const nextCursorSchema = z.string().min(1).optional()

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
  nextCursor: nextCursorSchema,
})
export type RoleListResponse = z.infer<typeof roleListResponseSchema>

export const accountListResponseSchema = z.object({
  items: z.array(accountSchema),
  nextCursor: nextCursorSchema,
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

/** 控制台登录名。不是邮箱，不要求 `@`。 */
export const accountLoginSchema = z.string().trim().min(1, '请输入账号').max(64)

export const createAccountBodySchema = z.object({
  displayName: z.string().trim().min(1).max(64),
  email: accountLoginSchema,
  password: passwordSchema,
  status: accountStatusSchema.optional(),
  roleIds: z.array(z.string().min(1)).optional(),
})
export type CreateAccountBody = z.infer<typeof createAccountBodySchema>

export const loginBodySchema = z.object({
  email: accountLoginSchema,
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

export const OPERATION_AUDIT_ACTIONS = [
  'service.create',
  'service.update',
  'credential.issue',
  'credential.update',
  'credential.revoke',
  'evidence.release',
  'account.create',
  'account.update',
  'account.delete',
  'account.roles',
  'account.password',
  'role.create',
  'role.update',
  'role.delete',
  'target.create',
  'target.update',
  'target.delete',
  'target_account.create',
  'target_account.update',
  'target_account.delete',
  'target_account.password',
  'scenario.create',
  'scenario.update',
  'scenario.delete',
  'recording.create',
  'run.create',
  'run.cancel',
  'run.review',
  'run.resume_auth',
  'session.auth_control_acquire',
  'session.auth_control_release',
  'session.dispose',
  'platform_config.update',
  'platform_config.restore',
  'platform_config.secret',
] as const
export type OperationAuditAction = (typeof OPERATION_AUDIT_ACTIONS)[number]

export const AUDIT_ACTIONS = [...OPERATION_AUDIT_ACTIONS, 'auth.login'] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export const AUDIT_CATEGORIES = ['operation', 'login'] as const
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number]

export const AUDIT_CLIENT_KINDS = ['web', 'extension'] as const
export type AuditClientKind = (typeof AUDIT_CLIENT_KINDS)[number]

export const LOGIN_AUDIT_OUTCOMES = ['success', 'failure'] as const
export type LoginAuditOutcome = (typeof LOGIN_AUDIT_OUTCOMES)[number]

export const LOGIN_FAILURE_REASONS = ['unknown_account', 'invalid_password', 'account_disabled'] as const
export type LoginFailureReason = (typeof LOGIN_FAILURE_REASONS)[number]

export const AUDIT_USER_AGENT_MAX = 512

export type AuditClient = {
  ip?: string | null
  userAgent?: string | null
  kind?: AuditClientKind | null
}

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  'service.create': '创建服务调用方',
  'service.update': '更新服务调用方',
  'credential.issue': '签发服务凭据',
  'credential.update': '更新服务凭据范围',
  'credential.revoke': '吊销服务凭据',
  'evidence.release': '调整证据对外可见性',
  'account.create': '创建账号',
  'account.update': '更新账号',
  'account.delete': '删除账号',
  'account.roles': '调整账号角色',
  'account.password': '修改账号密码',
  'role.create': '创建角色',
  'role.update': '更新角色',
  'role.delete': '删除角色',
  'target.create': '创建目标系统',
  'target.update': '更新目标系统',
  'target.delete': '删除目标系统',
  'target_account.create': '创建目标账号',
  'target_account.update': '更新目标账号',
  'target_account.delete': '删除目标账号',
  'target_account.password': '修改目标账号密码',
  'scenario.create': '创建场景',
  'scenario.update': '更新场景',
  'scenario.delete': '删除场景',
  'recording.create': '上传录制草稿',
  'run.create': '创建运行',
  'run.cancel': '取消运行',
  'run.review': '核查运行',
  'run.resume_auth': '确认目标系统登录',
  'session.auth_control_acquire': '取得认证输入权',
  'session.auth_control_release': '释放认证输入权',
  'session.dispose': '处置浏览器会话',
  'platform_config.update': '更新平台配置',
  'platform_config.restore': '恢复平台配置',
  'platform_config.secret': '登记平台模型密钥',
  'auth.login': '登录',
}

export const LOGIN_FAILURE_REASON_LABELS: Record<LoginFailureReason, string> = {
  unknown_account: '账号不存在',
  invalid_password: '密码不正确',
  account_disabled: '账号已停用',
}

export const AUDIT_CLIENT_KIND_LABELS: Record<AuditClientKind, string> = {
  web: '控制台',
  extension: '扩展',
}

export function normalizeLoginIdentifier(value: string): string {
  return value.trim().toLowerCase()
}

const unsetEmpty = (value: unknown) =>
  value === '' || value === null || value === undefined ? undefined : value

const optionalQueryString = z.preprocess(unsetEmpty, z.string().min(1).optional())
const optionalQueryDate = z.preprocess(unsetEmpty, z.coerce.date().optional())

const auditListQueryBase = {
  cursor: optionalQueryString,
  limit: z.preprocess((value) => (value === '' || value === undefined || value === null ? 50 : value), z.coerce.number().int().min(1).max(200)),
  from: optionalQueryDate,
  to: optionalQueryDate,
}

function refineAuditRange(
  query: { from?: Date; to?: Date },
  ctx: z.RefinementCtx,
): void {
  if (query.from && query.to && query.from.getTime() >= query.to.getTime()) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: 'from 必须早于 to' })
  }
}

export const operationAuditQuerySchema = z
  .object({
    ...auditListQueryBase,
    action: z.preprocess(unsetEmpty, z.enum(OPERATION_AUDIT_ACTIONS).optional()),
    actorId: optionalQueryString,
  })
  .superRefine(refineAuditRange)
export type OperationAuditQuery = z.infer<typeof operationAuditQuerySchema>

export const loginAuditQuerySchema = z
  .object({
    ...auditListQueryBase,
    outcome: z.preprocess(unsetEmpty, z.enum(LOGIN_AUDIT_OUTCOMES).optional()),
    actorId: optionalQueryString,
    identifier: z.preprocess(unsetEmpty, accountLoginSchema.optional()),
    clientKind: z.preprocess(unsetEmpty, z.enum(AUDIT_CLIENT_KINDS).optional()),
  })
  .superRefine(refineAuditRange)
export type LoginAuditQuery = z.infer<typeof loginAuditQuerySchema>

const auditActorSchema = z
  .object({
    kind: z.enum(['console', 'service']).optional(),
    credentialId: z.string().optional().nullable(),
    id: z.string().min(1),
    displayName: z.string().min(1),
    email: z.string().nullable(),
  })
  .nullable()

export const auditEventSchema = z.object({
  requestId: z.string().nullable().optional(),
  id: z.string().min(1),
  action: z.string().min(1),
  resource: z.string().min(1),
  resourceId: z.string().nullable(),
  summary: z.string().min(1),
  actor: auditActorSchema,
  clientIp: z.string().min(1).nullable().optional(),
  userAgent: z.string().min(1).nullable().optional(),
  clientKind: z.enum(AUDIT_CLIENT_KINDS).nullable().optional(),
  createdAt: z.string().min(1),
})
export type AuditEventDto = z.infer<typeof auditEventSchema>
export type OperationAuditEventDto = AuditEventDto

export const auditListResponseSchema = z.object({
  items: z.array(auditEventSchema),
  nextCursor: nextCursorSchema,
})
export type AuditListResponse = z.infer<typeof auditListResponseSchema>
export type OperationAuditListResponse = AuditListResponse

export const loginAuditEventSchema = z.object({
  id: z.string().min(1),
  loginIdentifier: z.string().min(1),
  outcome: z.enum(LOGIN_AUDIT_OUTCOMES),
  failureReason: z.enum(LOGIN_FAILURE_REASONS).nullable(),
  actor: auditActorSchema,
  clientIp: z.string().min(1).nullable(),
  userAgent: z.string().min(1).nullable(),
  clientKind: z.enum(AUDIT_CLIENT_KINDS),
  createdAt: z.string().min(1),
})
export type LoginAuditEventDto = z.infer<typeof loginAuditEventSchema>

export const loginAuditListResponseSchema = z.object({
  items: z.array(loginAuditEventSchema),
  nextCursor: nextCursorSchema,
})
export type LoginAuditListResponse = z.infer<typeof loginAuditListResponseSchema>

export const updateAccountBodySchema = z
  .object({
    displayName: z.string().trim().min(1).max(64).optional(),
    email: z.union([accountLoginSchema, z.null()]).optional(),
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
