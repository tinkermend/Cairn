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
  'credential',
  'service',
  'settings',
  'audit',
  'ai',
  'platform-config',
  'map',
  'module',
  'schedule',
  'monitor',
  'notification',
  'suite',
  'report',
] as const
export type PermissionResource = (typeof PERMISSION_RESOURCES)[number]

export const PERMISSION_ACTIONS = ['read', 'write', 'delete', 'execute', 'cancel', 'review', 'assist', 'publish', 'maintain', 'explore', 'operate', 'import'] as const
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
  'run:delete',
  'session:read',
  'session:view',
  'session:control',
  'session:manage',
  'session:dispose',
  'target:read',
  'target:write',
  'target:delete',
  'credential:read',
  'credential:write',
  'credential:delete',
  'credential:import',
  'service:read',
  'service:write',
  'settings:read',
  'settings:write',
  'audit:read',
  'audit:login',
  'ai:execute',
  'ai:assist',
  'platform-config:read',
  'platform-config:write',
  'map:read',
  'map:review',
  'map:publish',
  'map:maintain',
  'map:explore',
  'module:read',
  'module:write',
  'module:publish',
  'schedule:read',
  'schedule:write',
  'monitor:read',
  'monitor:operate',
  'notification:read',
  'notification:operate',
  'suite:read',
  'suite:write',
  'suite:delete',
  'report:read',
  'report:export',
  'report:delete',
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
  credential: '凭据管理',
  service: '开放服务',
  settings: '设置',
  audit: '审计',
  ai: 'AI',
  'platform-config': '平台配置',
  map: '运营地图',
  module: '动作模块',
  schedule: '平台调度',
  monitor: '运行监控',
  notification: '通知',
  suite: '场景集',
  report: '运行报告',
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
  'run:delete': '删除终态运行与清理附件',
  'session:read': '查看浏览器会话',
  'session:view': '查看受管浏览器画面',
  'session:control': '处理目标系统登录',
  'session:manage': '关闭、重启和清除浏览器会话',
  'session:dispose': '处置卡死的浏览器会话',
  'target:read': '查看目标系统',
  'target:write': '登记和维护目标系统',
  'target:delete': '删除目标系统',
  'credential:read': '查看目标账号凭据',
  'credential:write': '维护账号密码及有效期',
  'credential:delete': '删除凭据登记',
  'credential:import': '导入更新账号密码',
  'service:read': '查看开放服务',
  'service:write': '管理服务凭据与证据发布',
  'settings:read': '查看设置',
  'settings:write': '更新设置',
  'audit:read': '查看操作记录',
  'audit:login': '查看登录记录',
  'ai:execute': '执行含 AI 步骤的运行',
  'ai:assist': '使用平台助手',
  'platform-config:read': '查看平台配置',
  'platform-config:write': '修改平台配置',
  'map:read': '查看目标知识',
  'map:review': '复核地图身份与引用',
  'map:publish': '发布和撤回地图版本',
  'map:maintain': '维护安全进入并触发手工地图作业',
  'map:explore': '配置并触发有界地图探索',
  'module:read': '查看动作模块',
  'module:write': '创建和编辑动作模块',
  'module:publish': '发布动作模块版本',
  'schedule:read': '查看平台调度计划',
  'schedule:write': '创建和修订调度计划',
  'monitor:read': '查看运行监控',
  'monitor:operate': '触发探测与静默告警',
  'notification:read': '查看通知',
  'notification:operate': '处理通知投递',
  'suite:read': '查看场景集',
  'suite:write': '创建和编辑场景集',
  'suite:delete': '删除场景集',
  'report:read': '查看运行报告',
  'report:export': '生成并下载运行报告',
  'report:delete': '删除运行报告',
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
  'notification:read',
  'credential:read',
  'credential:write',
  'credential:delete',
  'credential:import',
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
  'ai:assist',
  'session:read',
  'session:view',
  'session:control',
  'settings:read',
  'map:read',
  'map:review',
  'module:read',
  'module:write',
  'module:publish',
  'suite:read',
  'suite:write',
  'suite:delete',
  'report:read',
  'report:export',
]

const OPERATOR_PERMISSIONS: readonly PermissionCode[] = [
  'notification:read',
  'notification:operate',
  'credential:read',
  'target:read',
  'workflow:read',
  'run:read',
  'run:execute',
  'run:cancel',
  'run:review',
  'ai:execute',
  'ai:assist',
  'session:read',
  'session:view',
  'session:control',
  'session:manage',
  'session:dispose',
  'settings:read',
  'map:read',
  'map:maintain',
  'map:explore',
  'module:read',
  'schedule:read',
  'schedule:write',
  'monitor:read',
  'monitor:operate',
  'suite:read',
  'report:read',
  'report:export',
]

const VIEWER_PERMISSIONS: readonly PermissionCode[] = [
  'notification:read',
  'credential:read',
  'target:read',
  'workflow:read',
  'run:read',
  'settings:read',
  'ai:assist',
  'map:read',
  'suite:read',
  'report:read',
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

export const CAPABILITY_GROUPS = ['workbench', 'execution-observation', 'governance', 'other'] as const
export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number]

export const CAPABILITY_GROUP_LABELS: Record<CapabilityGroup, string> = {
  workbench: '工作台',
  'execution-observation': '执行与观测',
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
  { id: 'menu.suites', kind: 'menu', group: 'workbench', label: '场景集', allOf: ['suite:read'] },
  { id: 'menu.action-modules', kind: 'menu', group: 'workbench', label: '动作库', allOf: ['module:read'] },
  { id: 'menu.recordings', kind: 'menu', group: 'workbench', label: '录制草稿', allOf: ['workflow:write'] },
  { id: 'menu.runs', kind: 'menu', group: 'execution-observation', label: '运行', allOf: ['run:read'] },
  { id: 'menu.schedules', kind: 'menu', group: 'execution-observation', label: '自动复查', allOf: ['schedule:read'] },
  { id: 'menu.sessions', kind: 'menu', group: 'execution-observation', label: '浏览器会话', allOf: ['session:read'] },
  { id: 'menu.evidence', kind: 'menu', group: 'execution-observation', label: '证据与报告', allOf: ['run:read'] },
  { id: 'menu.monitoring', kind: 'menu', group: 'execution-observation', label: '运行监控', allOf: ['monitor:read'] },
  { id: 'menu.notifications', kind: 'menu', group: 'execution-observation', label: '通知', allOf: ['notification:read'] },
  { id: 'menu.users', kind: 'menu', group: 'governance', label: '用户', allOf: ['account:read'] },
  { id: 'menu.roles', kind: 'menu', group: 'governance', label: '角色', allOf: ['role:read'] },
  { id: 'menu.services', kind: 'menu', group: 'governance', label: '开放服务', allOf: ['service:read'] },
  { id: 'action.service.write', kind: 'action', label: '管理开放服务', allOf: ['service:write'] },
  {
    id: 'menu.credentials',
    kind: 'menu',
    group: 'governance',
    label: '凭据管理',
    allOf: ['credential:read', 'target:read'],
  },
  { id: 'menu.platform-config', kind: 'menu', group: 'governance', label: '平台配置', allOf: ['platform-config:read'] },
  { id: 'menu.workers', kind: 'menu', group: 'governance', label: '执行节点', allOf: ['session:read'] },
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
  { id: 'action.recording.update', kind: 'action', label: '重命名录制草稿', allOf: ['workflow:write'] },
  { id: 'action.recording.delete', kind: 'action', label: '删除录制草稿', allOf: ['workflow:delete'] },
  { id: 'action.run.delete', kind: 'action', label: '删除运行与清理附件', allOf: ['run:delete'] },
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
  { id: 'action.assistant.use', kind: 'action', label: '使用平台助手', allOf: ['ai:assist'] },
  { id: 'action.session.view', kind: 'action', label: '查看受管浏览器画面', allOf: ['session:view'] },
  {
    id: 'action.session.control',
    kind: 'action',
    label: '处理目标系统登录',
    allOf: ['session:control', 'run:execute'],
  },
  { id: 'action.session.manage', kind: 'action', label: '关闭、重启和清除浏览器会话', allOf: ['session:manage'] },
  { id: 'action.session.dispose', kind: 'action', label: '处置卡死的浏览器会话', allOf: ['session:dispose'] },
  { id: 'action.account.write', kind: 'action', label: '管理控制台账号', allOf: ['account:write'] },
  { id: 'action.role.write', kind: 'action', label: '管理自定义角色', allOf: ['role:write'] },
  { id: 'action.map.review', kind: 'action', label: '复核地图身份与引用', allOf: ['map:review'] },
  { id: 'action.map.publish', kind: 'action', label: '发布和撤回地图版本', allOf: ['map:publish'] },
  { id: 'action.map.maintain', kind: 'action', label: '维护并触发手工地图作业', allOf: ['map:maintain'] },
  { id: 'action.map.explore', kind: 'action', label: '配置并触发有界地图探索', allOf: ['map:explore', 'map:maintain'] },
  { id: 'action.schedule.write', kind: 'action', label: '设置自动复查计划', allOf: ['schedule:write', 'map:maintain'] },
  { id: 'action.module.write', kind: 'action', label: '创建和编辑动作模块', allOf: ['module:write'] },
  { id: 'action.module.publish', kind: 'action', label: '发布动作模块版本', allOf: ['module:publish'] },
  { id: 'action.suite.write', kind: 'action', label: '创建和编辑场景集', allOf: ['suite:write'] },
  { id: 'action.suite.delete', kind: 'action', label: '删除场景集', allOf: ['suite:delete'] },
  {
    id: 'action.suite.execute',
    kind: 'action',
    label: '执行场景集',
    allOf: ['suite:read', 'run:execute', 'target:read', 'workflow:read'],
  },
  { id: 'action.report.read', kind: 'action', label: '查看运行报告', allOf: ['report:read'] },
  { id: 'action.report.export', kind: 'action', label: '生成并下载运行报告', allOf: ['report:export', 'report:read'] },
  { id: 'action.report.delete', kind: 'action', label: '删除运行报告', allOf: ['report:delete'] },
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
    'execution-observation': [],
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

/** 展示名只有 PERMISSION_LABELS 一个来源，树里不再抄一份。 */
export type CapabilityTreeNode = {
  code: PermissionCode
  isPageAccess?: boolean
  dependencies?: readonly PermissionCode[]
}

export type CapabilityTreeModule = {
  key: PermissionResource
  label: string
  description?: string
  items: readonly CapabilityTreeNode[]
}

export type CapabilityTreeCategory = {
  key: CapabilityGroup
  label: string
  modules: readonly CapabilityTreeModule[]
}

export const CAPABILITY_TREE_GROUPS: readonly CapabilityTreeCategory[] = [
  {
    key: 'workbench',
    label: '工作台',
    modules: [
      {
        key: 'target',
        label: '目标系统',
        description: '目标系统身份与凭据接入',
        items: [
          { code: 'target:read', isPageAccess: true },
          { code: 'target:write' },
          { code: 'target:delete' },
        ],
      },
      {
        key: 'workflow',
        label: '场景',
        description: '业务场景编排与步骤定义',
        items: [
          { code: 'workflow:read', isPageAccess: true },
          { code: 'workflow:write' },
          { code: 'workflow:delete' },
        ],
      },
      {
        key: 'suite',
        label: '场景集',
        description: '同一目标下已发布场景的编排与巡检',
        items: [
          { code: 'suite:read', isPageAccess: true },
          { code: 'suite:write' },
          { code: 'suite:delete' },
        ],
      },
      {
        key: 'module',
        label: '动作模块',
        description: '可复用的标准化步骤组件',
        items: [
          { code: 'module:read', isPageAccess: true },
          { code: 'module:write' },
          { code: 'module:publish' },
        ],
      },
      {
        key: 'map',
        label: '运营地图',
        description: '目标系统可操作世界模型与知识',
        items: [
          { code: 'map:read' },
          { code: 'map:review' },
          { code: 'map:publish' },
          { code: 'map:maintain' },
          { code: 'map:explore', dependencies: ['map:maintain'] },
        ],
      },
    ],
  },
  {
    key: 'execution-observation',
    label: '执行与观测',
    modules: [
      {
        key: 'run',
        label: '运行',
        description: '场景仿真执行与证据',
        items: [
          { code: 'run:read', isPageAccess: true },
          { code: 'run:execute', dependencies: ['target:read', 'workflow:read'] },
          { code: 'run:cancel' },
          { code: 'run:review' },
          { code: 'run:delete' },
        ],
      },
      {
        key: 'report',
        label: '运行报告',
        description: '单场景与场景集的导出报告',
        items: [
          { code: 'report:read', isPageAccess: true },
          { code: 'report:export', dependencies: ['report:read'] },
          { code: 'report:delete' },
        ],
      },
      {
        key: 'session',
        label: '浏览器会话',
        description: '受管浏览器实例与登录态',
        items: [
          { code: 'session:read', isPageAccess: true },
          { code: 'session:view' },
          { code: 'session:control', dependencies: ['run:execute'] },
          { code: 'session:manage' },
          { code: 'session:dispose' },
        ],
      },
      {
        key: 'schedule',
        label: '平台调度',
        description: '定时与自动复查计划',
        items: [
          { code: 'schedule:read', isPageAccess: true },
          { code: 'schedule:write', dependencies: ['map:maintain'] },
        ],
      },
      {
        key: 'monitor',
        label: '运行监控',
        description: '平台自身健康、容量、积压与异常',
        items: [
          { code: 'monitor:read', isPageAccess: true },
          { code: 'monitor:operate' },
        ],
      },
      { key: 'notification', label: '通知', description: '运行结果与告警通知', items: [
        { code: 'notification:read', isPageAccess: true }, { code: 'notification:operate' },
      ] },
    ],
  },
  {
    key: 'governance',
    label: '治理与运维',
    modules: [
      {
        key: 'credential', label: '凭据管理', description: '授权目标账号的密码与维护期限',
        items: [
          { code: 'credential:read', isPageAccess: true, dependencies: ['target:read'] },
          { code: 'credential:write', dependencies: ['credential:read'] },
          { code: 'credential:delete', dependencies: ['credential:read', 'credential:write'] },
          { code: 'credential:import', dependencies: ['credential:read', 'credential:write'] },
        ],
      },
      {
        key: 'account',
        label: '控制台账号',
        description: '平台用户与密码身份管理',
        items: [
          { code: 'account:read', isPageAccess: true },
          { code: 'account:write' },
          { code: 'account:delete' },
        ],
      },
      {
        key: 'role',
        label: '角色权限',
        description: '角色定义与权限配置',
        items: [
          { code: 'role:read', isPageAccess: true },
          { code: 'role:write' },
          { code: 'role:delete' },
        ],
      },
      {
        key: 'audit',
        label: '审计记录',
        description: '操作审计与登录审计',
        items: [
          { code: 'audit:read', isPageAccess: true },
          { code: 'audit:login' },
        ],
      },
      {
        key: 'service',
        label: '开放服务',
        description: '受控执行 API 与服务凭据',
        items: [
          { code: 'service:read', isPageAccess: true },
          { code: 'service:write' },
        ],
      },
        {
          key: 'platform-config',
          label: '平台配置',
          description: '运行时策略与超时参数中心',
          items: [
            { code: 'platform-config:read', isPageAccess: true },
            { code: 'platform-config:write' },
          ],
        },
      ],
    },
  {
    key: 'other',
    label: '通用设置与 AI',
    modules: [
      {
        key: 'settings',
        label: '系统设置',
        description: '个人偏好与全局环境设置',
        items: [
          { code: 'settings:read', isPageAccess: true },
          { code: 'settings:write' },
        ],
      },
      {
        key: 'ai',
        label: 'AI 能力',
        description: '浏览器 AI 执行与平台助手',
        items: [
          { code: 'ai:execute' },
          { code: 'ai:assist' },
        ],
      },
    ],
  },
]

export function getPermissionDependencies(code: PermissionCode): PermissionCode[] {
  const result = new Set<PermissionCode>()
  const visited = new Set<PermissionCode>()

  function collect(target: PermissionCode) {
    if (visited.has(target)) return
    visited.add(target)
    for (const group of CAPABILITY_TREE_GROUPS) {
      for (const mod of group.modules) {
        for (const item of mod.items) {
          if (item.code === target && item.dependencies) {
            for (const dep of item.dependencies) {
              result.add(dep)
              collect(dep)
            }
          }
        }
      }
    }
  }

  collect(code)
  return [...result]
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

export const roleTargetScopeSchema = z.object({
  roleId: z.string().min(1),
  mode: z.enum(['none', 'selected', 'all']),
  targetIds: z.array(z.string().uuid()).max(1000).default([]),
}).refine((value) => value.mode === 'selected' ? value.targetIds.length > 0 : value.targetIds.length === 0, {
  message: '指定范围需要至少一个目标；全部或无范围不能包含目标 ID',
})
export type RoleTargetScope = z.infer<typeof roleTargetScopeSchema>

export const accountSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  email: z.string().nullable(),
  status: accountStatusSchema,
  roles: z.array(roleRefSchema),
  permissions: z.array(z.string().min(1)),
  targetScopes: z.array(roleTargetScopeSchema).optional(),
  targetScopePermissions: z.array(z.object({ roleId: z.string(), permissions: z.array(z.string()) })).optional(),
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
  targetScopes: z.array(roleTargetScopeSchema).max(100).optional(),
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
  'notification.policy',
  'notification.test',
  'notification.retry',
  'notification.close',
  'service.create',
  'service.update',
  'service.status',
  'service.archive',
  'service.ip_whitelist',
  'service.webhook.create',
  'service.webhook.update',
  'service.webhook.retry',
  'credential.issue',
  'credential.update',
  'credential.revoke',
  'credential.suspend',
  'credential.reactivate',
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
  'credential.register',
  'credential.metadata',
  'credential.replace',
  'credential.disable',
  'credential.enable',
  'credential.version_revoke',
  'credential.batch',
  'credential.verify',
  'scenario.create',
  'scenario.update',
  'scenario.delete',
  'recording.create',
  'recording.update',
  'recording.delete',
  'run.create',
  'run.cancel',
  'run.review',
  'run.resume_auth',
  'run.debug',
  'run.delete',
  'target.cleanup_retry',
  'run.cleanup_retry',
  'session.auth_control_acquire',
  'session.auth_control_release',
  'session.dispose',
  'session.operation',
  'session.retention',
  'session.complete_auth',
  'platform_config.update',
  'platform_config.restore',
  'platform_config.secret',
  'module.create',
  'module.update',
  'module.delete',
  'module.publish',
  'module.publication',
  'module.upgrade',
  'module.extract',
  'module.replace',
  'module.resolve',
  'module.resolve_accept',
  'map.governance',
  'map.publish',
  'map.withdraw',
  'map.bind',
  'map.unbind',
  'map.rebuild',
  'map.scan',
  'map.consumption_policy.update',
  'target.access_policy.update',
  'map.job_policy.update',
  'map.safe_entry.create',
  'map.job.create',
  'map.job.cancel',
  'map.exploration_policy.update',
  'map.explore.create',
  'schedule.create',
  'schedule.update',
  'schedule.enable',
  'knowledge.term',
  'knowledge.propose',
  'knowledge.accept',
  'monitor.probe',
  'monitor.silence',
  'suite.create',
  'suite.update',
  'suite.publish',
  'suite.delete',
  'suite.run',
  'suite.cancel',
  'suite_run.create',
  'suite_run.cancel',
  'report.create',
  'report.profile.save',
  'report.asset.upload',
  'report.bundle',
  'report.export.cancel',
  'report.export.retry',
  'report.download',
  'report.auto.skipped',
  'report.export',
  'report.delete',
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
  'notification.policy': '更新通知设置',
  'notification.test': '测试通知',
  'notification.retry': '重试通知',
  'notification.close': '结案通知',
  'service.create': '创建服务调用方',
  'service.update': '更新服务调用方',
  'service.status': '调整服务调用方状态',
  'service.archive': '归档服务调用方',
  'service.ip_whitelist': '更新服务来源 IP 白名单',
  'service.webhook.create': '登记服务 Webhook',
  'service.webhook.update': '更新服务 Webhook',
  'service.webhook.retry': '重新推送服务 Webhook',
  'credential.issue': '签发服务凭据',
  'credential.update': '更新服务凭据范围',
  'credential.revoke': '吊销服务凭据',
  'credential.suspend': '冻结服务凭据',
  'credential.reactivate': '恢复服务凭据',
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
  'credential.register': '登记凭据',
  'credential.metadata': '修改凭据维护信息',
  'credential.replace': '替换凭据材料',
  'credential.disable': '暂停凭据取用',
  'credential.enable': '恢复凭据取用',
  'credential.version_revoke': '撤销凭据版本',
  'credential.batch': '批量维护凭据',
  'credential.verify': '记录凭据核验',
  'scenario.create': '创建场景',
  'scenario.update': '更新场景',
  'scenario.delete': '删除场景',
  'recording.create': '上传录制草稿',
  'recording.update': '重命名录制草稿',
  'recording.delete': '删除录制草稿',
  'run.create': '创建运行',
  'run.cancel': '取消运行',
  'run.review': '核查运行',
  'run.resume_auth': '确认目标系统登录',
  'run.debug': '调试会话动作',
  'run.delete': '删除运行与清理附件',
  'target.cleanup_retry': '重试目标系统附件清理',
  'run.cleanup_retry': '重试运行附件清理',
  'session.auth_control_acquire': '取得认证输入权',
  'session.auth_control_release': '释放认证输入权',
  'session.dispose': '处置浏览器会话',
  'session.operation': '发起会话维护操作',
  'session.retention': '设置会话保留',
  'session.complete_auth': '完成会话认证',
  'platform_config.update': '更新平台配置',
  'platform_config.restore': '恢复平台配置',
  'platform_config.secret': '登记平台模型密钥',
  'module.create': '创建动作模块',
  'module.update': '更新动作模块',
  'module.delete': '删除动作模块',
  'module.publish': '发布动作模块版本',
  'module.publication': '变更动作模块发布状态',
  'module.upgrade': '升级场景模块引用',
  'module.extract': '从步骤提炼动作模块',
  'module.replace': '用模块替换原步骤',
  'module.resolve': '解析动作模块说法',
  'module.resolve_accept': '接受模块映射写入草稿',
  'map.governance': '提交地图治理命令',
  'map.publish': '发布地图版本',
  'map.withdraw': '撤回地图版本',
  'map.bind': '绑定场景与地图对象',
  'map.unbind': '解除场景地图绑定',
  'map.rebuild': '重建地图投影',
  'map.scan': '扫描场景地图候选',
  'map.consumption_policy.update': '更新地图消费政策',
  'target.access_policy.update': '更新目标授权',
  'map.job_policy.update': '更新地图作业政策',
  'map.safe_entry.create': '登记安全进入路径',
  'map.job.create': '创建手工地图作业',
  'map.job.cancel': '取消地图作业',
  'map.exploration_policy.update': '更新地图探索政策',
  'map.explore.create': '创建有界探索作业',
  'schedule.create': '创建调度计划',
  'schedule.update': '修订调度计划',
  'schedule.enable': '启停调度计划',
  'knowledge.term': '维护目标术语',
  'knowledge.propose': '生成知识编写建议',
  'knowledge.accept': '接受知识编写建议',
  'monitor.probe': '触发监控探测',
  'monitor.silence': '静默监控告警',
  'suite.create': '创建场景集',
  'suite.update': '更新场景集',
  'suite.publish': '发布场景集',
  'suite.delete': '删除场景集',
  'suite.run': '启动场景集运行',
  'suite.cancel': '取消场景集运行',
  'suite_run.create': '启动场景集运行',
  'suite_run.cancel': '取消场景集运行',
  'report.create': '创建运行报告',
  'report.profile.save': '保存报告配置档',
  'report.asset.upload': '上传报告 Logo',
  'report.bundle': '创建报告包',
  'report.export.cancel': '取消报告导出',
  'report.export.retry': '重试报告导出',
  'report.download': '下载报告文件',
  'report.auto.skipped': '自动报告未生成',
  'report.export': '导出运行报告',
  'report.delete': '删除运行报告',
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
  targetScopes: z.array(roleTargetScopeSchema).max(100).optional(),
})
export type AssignAccountRolesBody = z.infer<typeof assignAccountRolesBodySchema>

export const roleAccountItemSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  email: z.string().nullable(),
  status: accountStatusSchema,
  assignedAt: z.string().min(1),
})
export type RoleAccountItemDto = z.infer<typeof roleAccountItemSchema>

export const roleAccountsResponseSchema = z.object({
  items: z.array(roleAccountItemSchema),
  nextCursor: nextCursorSchema,
})
export type RoleAccountsResponse = z.infer<typeof roleAccountsResponseSchema>

export const roleAccountsQuerySchema = z.object({
  cursor: optionalQueryString,
  limit: z
    .preprocess(
      (value) => (value === '' || value === undefined || value === null ? 50 : value),
      z.coerce.number().int().min(1).max(100),
    )
    .optional(),
  search: optionalQueryString,
})
export type RoleAccountsQuery = z.infer<typeof roleAccountsQuerySchema>

export const addRoleAccountsBodySchema = z.object({
  accountIds: z.array(z.string().min(1)).min(1, '至少选择一个账号').max(100),
})
export type AddRoleAccountsBody = z.infer<typeof addRoleAccountsBodySchema>

export const removeRoleAccountsBodySchema = z.object({
  accountIds: z.array(z.string().min(1)).min(1, '至少选择一个账号').max(100),
})
export type RemoveRoleAccountsBody = z.infer<typeof removeRoleAccountsBodySchema>
