import type { SuiteMemberAdmission, SuiteRunStatus, SuiteStatus, SuiteVerdict } from '@cairn/shared'
import { SUITE_VERDICT_LABELS } from '@cairn/shared'
import type { StatusTone } from '@/components/status-badge'

export const SUITE_STATUS_LABELS: Record<SuiteStatus, string> = {
  active: '已启用',
  disabled: '已停用',
}

export const SUITE_RUN_STATUS_LABELS: Record<SuiteRunStatus, string> = {
  QUEUED: '排队中',
  RUNNING: '运行中',
  WAITING: '等待中',
  NEEDS_REVIEW: '待核查',
  COMPLETED: '编排结束',
  CANCELLED: '已取消',
  FAILED: '推进故障',
}

export const SUITE_ADMISSION_LABELS: Record<SuiteMemberAdmission, string> = {
  PENDING: '待放行',
  ACTIVE: '执行中',
  SETTLED: '已收尾',
  SKIPPED: '已跳过',
}

export { SUITE_VERDICT_LABELS }

export function suiteStatusTone(status: SuiteStatus): StatusTone {
  return status === 'active' ? 'success' : 'neutral'
}

export function suiteRunStatusTone(status: SuiteRunStatus): StatusTone {
  if (status === 'COMPLETED') return 'success'
  if (status === 'FAILED') return 'error'
  if (status === 'CANCELLED' || status === 'NEEDS_REVIEW' || status === 'WAITING') return 'warning'
  if (status === 'RUNNING') return 'info'
  return 'neutral'
}

export function suiteVerdictTone(verdict: SuiteVerdict | null): StatusTone {
  if (verdict === 'all_pass') return 'success'
  if (verdict === 'pass_with_warnings') return 'warning'
  if (verdict === 'anomalies_found') return 'error'
  if (verdict === 'incomplete') return 'warning'
  return 'neutral'
}
