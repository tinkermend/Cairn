import type {
  MonitorMetricNumber,
  MonitorSource,
  MonitorUnavailableReason,
  MonitorUnknownReason,
} from '@cairn/shared'
import type { StatusTone } from '@/components/status-badge'

export const AUTO_REFRESH_STORAGE_KEY = 'cairn.monitoring.auto-refresh'

export type MonitorFailureKind = 'object' | 'read' | 'permission'

export const MONITOR_FAILURE_TITLE: Record<MonitorFailureKind, string> = {
  object: '被监控对象故障',
  read: '监控数据读取失败',
  permission: '无权限',
}

export function readAutoRefreshEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_REFRESH_STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

export function writeAutoRefreshEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, enabled ? 'on' : 'off')
  } catch {
    /* 无存储时仍可在本次会话使用 */
  }
}

export function formatAsOf(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

export function freshnessLabel(source: MonitorSource, sampledAt: string): string {
  if (source === 'sample') return `上次采样（${formatAsOf(sampledAt)}）`
  return `此刻的事实 · 截至 ${formatAsOf(sampledAt)}`
}

export function unknownLabel(reason: MonitorUnknownReason): string {
  if (reason === 'sample_stale') return '采样已过期'
  if (reason === 'instance_replaced') return '实例已更换'
  return '未采集／未上报'
}

export function formatMetric(metric: MonitorMetricNumber, suffix = ''): string {
  if (metric.availability === 'unknown') return unknownLabel(metric.reason)
  return `${metric.value}${suffix}`
}

export function formatBytes(metric: MonitorMetricNumber): string {
  if (metric.availability === 'unknown') return unknownLabel(metric.reason)
  const value = metric.value
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function formatWait(metric: MonitorMetricNumber): string {
  if (metric.availability === 'unknown') return unknownLabel(metric.reason)
  if (metric.value <= 0) return '无等待'
  if (metric.value < 1000) return `${metric.value} 毫秒`
  const seconds = Math.round(metric.value / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.round(minutes / 60)} 小时`
}

export function partitionFailure(reasonCode: MonitorUnavailableReason): {
  kind: MonitorFailureKind
  title: string
  description: string
} {
  const title = MONITOR_FAILURE_TITLE.read
  if (reasonCode === 'DATA_PLANE_UNAVAILABLE') {
    return { kind: 'read', title, description: '数据面不可用，监控数据读取失败。其余分区仍可查看。' }
  }
  return { kind: 'read', title, description: '聚合失败，监控数据读取失败。其余分区仍可查看。' }
}

export function objectFailure(detail: string): { kind: MonitorFailureKind; title: string; description: string } {
  return { kind: 'object', title: MONITOR_FAILURE_TITLE.object, description: detail }
}

export function permissionFailure(detail: string): {
  kind: MonitorFailureKind
  title: string
  description: string
} {
  return { kind: 'permission', title: MONITOR_FAILURE_TITLE.permission, description: detail }
}

export function schemaTone(
  consistency: 'consistent' | 'mismatch' | 'unknown',
): { tone: StatusTone; label: string } {
  if (consistency === 'consistent') return { tone: 'success', label: '版本一致' }
  if (consistency === 'mismatch') return { tone: 'error', label: '版本不一致' }
  return { tone: 'neutral', label: '未采集／未上报' }
}

export function pingTone(ping: 'up' | 'down'): { tone: StatusTone; label: string } {
  return ping === 'up' ? { tone: 'success', label: '可达' } : { tone: 'error', label: '不可达' }
}

export function apiStatusTone(status: 'ok' | 'degraded'): { tone: StatusTone; label: string } {
  return status === 'ok' ? { tone: 'success', label: '就绪' } : { tone: 'warning', label: '降级' }
}

export function profileStateLabel(state: 'ABSENT' | 'PRESENT'): string {
  return state === 'PRESENT' ? '在场' : '缺席'
}

export function objectStoreTone(status: MonitorMetricNumber): { tone: StatusTone; label: string } {
  if (status.availability === 'unknown') return { tone: 'neutral', label: unknownLabel(status.reason) }
  if (status.value === 1) return { tone: 'success', label: '可达' }
  return { tone: 'error', label: '不可达' }
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} 分钟`
  const hours = Math.round(seconds / 3600)
  return `${Math.max(1, hours)} 小时`
}

export function alertStateTone(state: 'firing' | 'interrupted' | 'resolved'): {
  tone: StatusTone
  label: string
} {
  if (state === 'firing') return { tone: 'error', label: '未恢复' }
  if (state === 'interrupted') return { tone: 'warning', label: '判定依据已中断' }
  return { tone: 'success', label: '已恢复' }
}

export function noticeKindLabel(kind: 'firing' | 'resolved' | 'interrupted' | null): string {
  if (kind === 'firing') return '触发'
  if (kind === 'resolved') return '恢复'
  if (kind === 'interrupted') return '判定依据已中断'
  return '尚未通知'
}

export function deliveryStatusLabel(
  status: 'pending' | 'sent' | 'failed' | 'suppressed' | null,
): string {
  if (status === 'pending') return '待投递'
  if (status === 'sent') return '已投递'
  if (status === 'failed') return '投递失败'
  if (status === 'suppressed') return '已抑制'
  return '不外发'
}

export const SERIES_KEY_LABELS: Record<string, string> = {
  'queue.claimableRuns': '待领取 Run',
  'worker.status.ready': '就绪 Worker',
  'evidence.pendingUpload': '证据待上传',
}
