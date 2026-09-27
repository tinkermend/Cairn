import { z } from 'zod'
import { permissionCodeSchema, type PermissionCode } from './rbac.js'

export const menuItemGroupSchema = z.enum([
  'overview',
  'workbench',
  'execution-observation',
  'resources',
  'operations',
  'governance',
  'other',
])
export type MenuItemGroup = z.infer<typeof menuItemGroupSchema>

export const menuItemDefinitionSchema = z.strictObject({
  id: z.string().min(1),
  route: z.string().min(1),
  permission: permissionCodeSchema.optional(),
  anyOf: z.array(permissionCodeSchema).optional(),
  title: z.string().min(1),
  group: menuItemGroupSchema,
  description: z.string().min(1),
  disabledReason: z.string().optional(),
})
export type MenuItemDefinition = z.infer<typeof menuItemDefinitionSchema>

export const MENU_CATALOG: readonly MenuItemDefinition[] = [
  {
    id: 'menu.home',
    route: '/',
    title: '总览',
    group: 'overview',
    description: '平台总体运行状态概览。',
  },
  {
    id: 'menu.scenarios',
    route: '/scenarios',
    permission: 'workflow:read',
    title: '场景编排',
    group: 'workbench',
    description: '查看与维护自动化场景工作流及步骤。',
  },
  {
    id: 'menu.suites',
    route: '/suites',
    permission: 'suite:read',
    title: '场景集',
    group: 'workbench',
    description: '组合多个场景形成测试集并批量执行。',
  },
  {
    id: 'menu.batches',
    route: '/batches',
    permission: 'batch:read',
    title: '批量任务',
    group: 'workbench',
    description: '基于数据集驱动的大规模场景批量并发任务。',
  },
  {
    id: 'menu.action-modules',
    route: '/action-modules',
    permission: 'module:read',
    title: '动作库',
    group: 'workbench',
    description: '可复用的公共动作模块与业务逻辑库。',
  },
  {
    id: 'menu.recordings',
    route: '/recordings',
    permission: 'workflow:write',
    title: '录制草稿',
    group: 'workbench',
    description: '通过浏览器插件录制的步骤草稿与动作流。',
  },
  {
    id: 'menu.schedules',
    route: '/schedules',
    permission: 'schedule:read',
    title: '定时任务',
    group: 'execution-observation',
    description: '基于 Cron 或定时规则自动触发的调度任务。',
  },
  {
    id: 'menu.runs',
    route: '/runs',
    permission: 'run:read',
    title: '运行记录',
    group: 'execution-observation',
    description: '执行记录、单步状态、Attempt 详情与实时过程。',
  },
  {
    id: 'menu.evidence',
    route: '/evidence',
    permission: 'run:read',
    title: '结果与报告',
    group: 'execution-observation',
    description: '查看失败截图、结构化证据包与保留状态。',
  },
  {
    id: 'menu.maintenance',
    route: '/maintenance',
    permission: 'reliability:read',
    title: '自动化维护',
    group: 'execution-observation',
    description: '场景健康度监测、缺陷自愈修复与规则维护。',
  },
  {
    id: 'menu.datasets',
    route: '/datasets',
    permission: 'dataset:read',
    title: '数据集',
    group: 'resources',
    description: '目标系统数据表格、导入快照与业务数据源。',
  },
  {
    id: 'menu.targets',
    route: '/targets',
    permission: 'target:read',
    title: '目标系统',
    group: 'resources',
    description: '仿真目标系统管理、目标账号与环境配置。',
  },
  {
    id: 'menu.sessions',
    route: '/sessions',
    permission: 'session:read',
    title: '账号会话',
    group: 'resources',
    description: '受管账号会话、登录保活与占用租约。',
  },
  {
    id: 'menu.monitoring',
    route: '/monitoring',
    permission: 'monitor:read',
    title: '监控',
    group: 'operations',
    description: '平台基础设施心跳、队列深度与告警观察。',
  },
  {
    id: 'menu.workers',
    route: '/workers',
    permission: 'session:read',
    title: '执行节点',
    group: 'operations',
    description: 'Worker 节点健康度、容量与心跳状态。',
  },
  {
    id: 'menu.outbound',
    route: '/outbound',
    permission: 'outbound:read',
    title: '消息推送',
    group: 'operations',
    description: '把场景运行结果与告警推送到 Webhook、邮件等外部渠道；每次投递独立记录，可重试。',
  },
  {
    id: 'menu.users',
    route: '/users',
    permission: 'account:read',
    title: '用户管理',
    group: 'governance',
    description: '控制台账号、状态与密码管理。',
  },
  {
    id: 'menu.roles',
    route: '/roles',
    permission: 'role:read',
    title: '角色权限',
    group: 'governance',
    description: 'RBAC 角色配置与细粒度权限策略。',
  },
  {
    id: 'menu.services',
    route: '/services',
    permission: 'service:read',
    title: 'API 接入',
    group: 'governance',
    description: '系统服务密钥与外部 API 接入管理。',
  },
  {
    id: 'menu.platform-config',
    route: '/platform-config',
    permission: 'platform-config:read',
    title: '平台配置',
    group: 'governance',
    description: 'AI 模型提供商、系统级参数与全局配置。',
  },
  {
    id: 'menu.audit',
    route: '/audit',
    anyOf: ['audit:read', 'audit:login'],
    title: '审计日志',
    group: 'governance',
    description: '操作审计记录与用户登录审计。',
  },
  {
    id: 'menu.settings',
    route: '/settings',
    permission: 'settings:read',
    title: '个人设置',
    group: 'other',
    description: '个人资料与密码修改。',
  },
]

export function getMenuItem(id: string): MenuItemDefinition | undefined {
  return MENU_CATALOG.find((item) => item.id === id)
}

export function requireMenuItem(id: string): MenuItemDefinition {
  const item = getMenuItem(id)
  if (!item) {
    throw new Error(`未知菜单项 ID: ${id}`)
  }
  return item
}
