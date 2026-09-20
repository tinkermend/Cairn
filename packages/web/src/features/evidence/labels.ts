import type { OutcomeStatus } from '@cairn/shared'
import { EVIDENCE_RETENTION_OBJECT_VIEWS } from '@cairn/shared'

export const OUTCOME_STATUS_LABELS: Record<OutcomeStatus, string> = {
  PASS: '通过',
  WARN: '告警',
  FAIL: '未通过',
  UNKNOWN: '未知',
  NOT_EVALUATED: '未评价',
}

export const RETENTION_VIEW_LABELS: Record<(typeof EVIDENCE_RETENTION_OBJECT_VIEWS)[number], string> = {
  pending_cleanup: '待清理',
  expiring_soon: '即将到期',
  purge_failed: '清理失败',
  deleted_run: '已删除运行',
}

export const CANDIDATE_REASON_LABELS = {
  expired: '已到期',
  upload_incomplete: '上传未完成',
  run_deleted: '来源运行已删除',
  purge_failed: '清理失败',
  expiring_soon: '即将到期',
} as const

export function formatKnownBytes(bytes: number | null | undefined, unknown?: boolean): string {
  if (unknown || bytes == null) return '未知'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function formatWhen(value: string | null | undefined): string {
  if (!value) return '未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString()
}
