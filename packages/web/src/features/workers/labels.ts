import type { StatusTone } from '@/components/status-badge'
import type {
  SessionStatus,
  WorkerHandleMismatchState,
  WorkerRouteReason,
  WorkerStatus,
  WorkerSummary,
} from '@cairn/shared'

export function workerLifecycle(worker: Pick<WorkerSummary, 'status' | 'heartbeatFresh'>): {
  tone: StatusTone
  label: string
} {
  if (worker.status === 'READY' && worker.heartbeatFresh) return { tone: 'success', label: '就绪' }
  if (worker.status === 'READY') return { tone: 'warning', label: '就绪登记已过期' }
  if (worker.status === 'DISABLED') return { tone: 'warning', label: '已禁用 (维护中)' }
  if (worker.status === 'DRAINING') return { tone: 'warning', label: '收尾中' }
  if (worker.status === 'STOPPED') return { tone: 'neutral', label: '已停止' }
  return { tone: 'error', label: '失联' }
}

export const WORKER_STATUS_FILTER_LABELS: Record<WorkerStatus, string> = {
  READY: '就绪',
  DISABLED: '已禁用',
  DRAINING: '收尾中',
  STOPPED: '已停止',
  LOST: '失联',
}

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  CREATING: '启动中',
  OPEN: '已打开',
  CLOSING: '关闭中',
  CLOSED: '已关闭',
  LOST: '会话失联',
}

export const SESSION_HEALTH_LABELS: Record<string, string> = {
  HEALTHY: '健康',
  UNHEALTHY: '异常',
  UNKNOWN: '未知',
}

export const SESSION_AUTH_STATE_LABELS: Record<string, string> = {
  AUTHENTICATED: '已登录',
  EXPIRED: '已过期',
  UNKNOWN: '未核验',
}

export const ROUTE_REASON_LABELS: Record<WorkerRouteReason, string> = {
  worker_not_ready: '节点未就绪',
  registration_incomplete: '登记不完整',
  heartbeat_expired: '心跳已过期',
  endpoint_missing: '缺少内部入口',
  endpoint_invalid: '内部入口无效',
}

export const MISMATCH_LABELS: Record<WorkerHandleMismatchState, string> = {
  unknown: '未知样本',
  none: '采样一致',
  pending: '采样差异，待复核',
  persistent: '持续采样差异',
}

export type WorkerRoleCategory = 'executor' | 'scheduler' | 'analyst' | 'maintenance' | 'monolithic'

export interface WorkerRoleMeta {
  key: WorkerRoleCategory
  label: string
  shortLabel: string
  description: string
  colorClass: string
  bgClass: string
  borderClass: string
}

export const WORKER_ROLE_METAS: Record<WorkerRoleCategory, WorkerRoleMeta> = {
  executor: {
    key: 'executor',
    label: '执行器集群',
    shortLabel: '执行器',
    description: '受管 Chromium 浏览器、步骤执行、录像与会话保活',
    colorClass: 'text-primary',
    bgClass: 'bg-primary/10',
    borderClass: 'border-primary/30',
  },
  scheduler: {
    key: 'scheduler',
    label: '调度守卫',
    shortLabel: '调度器',
    description: '定时任务触发、地图扫描周期调度、套件分期控制',
    colorClass: 'text-tech-purple-primary',
    bgClass: 'bg-tech-purple-primary/10',
    borderClass: 'border-tech-purple-primary/30',
  },
  analyst: {
    key: 'analyst',
    label: 'AI 分析引擎',
    shortLabel: 'AI分析',
    description: '知识库提炼、场景可靠性评估、AI 模型效能分析',
    colorClass: 'text-amber-600 dark:text-amber-400',
    bgClass: 'bg-amber-500/10',
    borderClass: 'border-amber-500/30',
  },
  maintenance: {
    key: 'maintenance',
    label: '后台运维与投递',
    shortLabel: '维护器',
    description: 'Webhook 投递、S3 证据与临时对象回收、过期租约对账',
    colorClass: 'text-emerald-600 dark:text-emerald-400',
    bgClass: 'bg-emerald-500/10',
    borderClass: 'border-emerald-500/30',
  },
  monolithic: {
    key: 'monolithic',
    label: '单机全功能',
    shortLabel: '全功能',
    description: '聚合执行、调度、分析、维护全部能力，单机开发或一体化轻量运行',
    colorClass: 'text-slate-600 dark:text-slate-400',
    bgClass: 'bg-slate-500/10',
    borderClass: 'border-slate-500/30',
  },
}

export function classifyWorkerRole(workerId: string): WorkerRoleCategory {
  const lower = workerId.toLowerCase()
  if (lower.includes('executor')) return 'executor'
  if (lower.includes('scheduler')) return 'scheduler'
  if (lower.includes('analyst')) return 'analyst'
  if (lower.includes('maintenance')) return 'maintenance'
  return 'monolithic'
}

