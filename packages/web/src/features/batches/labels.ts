import type { StatusTone } from '@/components/status-badge'

export function batchStatusTone(status: string): StatusTone {
  switch (status) {
    case 'COMPLETED':
      return 'success'
    case 'RUNNING':
      return 'info'
    case 'PAUSED':
      return 'warning'
    case 'FAILED':
      return 'error'
    case 'QUEUED':
    default:
      return 'neutral'
  }
}

export const BATCH_STATUS_LABELS: Record<string, string> = {
  COMPLETED: '已完成',
  RUNNING: '运行中',
  PAUSED: '已暂停',
  FAILED: '失败',
  QUEUED: '排队中',
  CANCELLED: '已终止',
}

export function batchItemStatusTone(status: string): StatusTone {
  switch (status) {
    case 'SUCCEEDED':
      return 'success'
    case 'FAILED':
      return 'error'
    case 'NEEDS_REVIEW':
      return 'warning'
    case 'RUNNING':
      return 'info'
    case 'PENDING':
    default:
      return 'neutral'
  }
}

export const BATCH_ITEM_STATUS_LABELS: Record<string, string> = {
  SUCCEEDED: '成功',
  FAILED: '失败',
  NEEDS_REVIEW: '需复核',
  RUNNING: '执行中',
  PENDING: '等待中',
  SKIPPED: '已跳过',
}
