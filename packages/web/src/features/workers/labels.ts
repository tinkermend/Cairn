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
  if (worker.status === 'DRAINING') return { tone: 'warning', label: '收尾中' }
  if (worker.status === 'STOPPED') return { tone: 'neutral', label: '已停止' }
  return { tone: 'error', label: '失联' }
}

export const WORKER_STATUS_FILTER_LABELS: Record<WorkerStatus, string> = {
  READY: '就绪',
  DRAINING: '收尾中',
  STOPPED: '已停止',
  LOST: '失联',
}

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  CREATING: '创建中',
  OPEN: '打开',
  CLOSING: '关闭中',
  CLOSED: '已关闭',
  LOST: '已隔离',
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
