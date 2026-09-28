import {
  type SuiteMemberAdmission,
  type SuiteRunStatus,
  type SuiteStatus,
  type SuiteVerdict,
  SUITE_VERDICT_LABELS,
} from '@cairn/shared'
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

export const SUITE_EXECUTION_MODE_LABELS = {
  parallel: '受控并发',
  sequential: '严格串行',
} as const

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

/**
 * 成员输入是已知死路：validateSuiteDocument 会用 assertRunFromResolved 在保存与发布期拦住，
 * 但成员 input 在界面上写死 {}，人没有地方能填。本轮先把拦截信息说成人话，
 * 逐成员输入编辑另案。
 */
export function suiteIssueMessage(issue: { code: string; message: string }): string {
  if (issue.code === 'SCENARIO_UNRESOLVED_REF') {
    return '成员场景需要运行输入，场景集暂不支持逐成员填写；请改用定时任务或手工创建运行。'
  }
  return issue.message
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return remainingSeconds > 0 ? `${minutes}分${remainingSeconds}秒` : `${minutes}分钟`
}

export { formatRelativeTime } from '@/lib/formatters'

