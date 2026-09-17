import type { OutcomeStatus, RunStatus } from '@cairn/shared'
import type { StatusTone } from '@/components/status-badge'

export const RUN_OUTCOME_STATUS_LABELS: Record<OutcomeStatus, string> = {
  PASS: '业务通过',
  WARN: '业务告警',
  FAIL: '业务异常',
  UNKNOWN: '业务未知',
  NOT_EVALUATED: '未评价业务结果',
}

export const RUN_OUTCOME_STATUS_HINTS: Record<OutcomeStatus, string> = {
  PASS: '已求值的必须与应当条件都成立。',
  WARN: '应当成立的条件未满足，必须条件已通过。',
  FAIL: '必须成立的条件未满足。',
  UNKNOWN: '有必须条件没能求值，不能据此判断业务成败。',
  NOT_EVALUATED: '这次运行没有成功条件，或历史运行尚未纳入结果轴。',
}

export const RUN_EXECUTION_AXIS_LABELS: Record<RunStatus, string> = {
  QUEUED: '等待执行',
  RUNNING: '正在执行',
  RECOVERING: '正在恢复执行',
  WAITING_FOR_AUTH: '执行等待登录',
  HOLDING: '执行挂起',
  SUCCEEDED: '执行完成',
  FAILED: '执行失败',
  CANCELLED: '执行已取消',
  NEEDS_REVIEW: '执行待核查',
}

export function runOutcomeStatusTone(status: OutcomeStatus): StatusTone {
  if (status === 'PASS') return 'success'
  if (status === 'FAIL') return 'error'
  if (status === 'WARN' || status === 'UNKNOWN') return 'warning'
  return 'neutral'
}
