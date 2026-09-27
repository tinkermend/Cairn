import {
  ANALYSIS_MODE_LABELS,
  SCHEDULE_CONSUMER_LABELS,
  SCHEDULE_SKIP_REASON_METAS,
  SCHEDULE_SKIP_REASONS,
  type ScheduleAdmissionStatus,
  type ScheduleConsumerType,
  type ScheduleSkipReason,
} from '@cairn/shared'

export const CONSUMER_LABELS = SCHEDULE_CONSUMER_LABELS
export const MODE_LABELS = ANALYSIS_MODE_LABELS

export const ADMISSION_LABELS: Record<ScheduleAdmissionStatus, string> = {
  PENDING: '待准入',
  ADMITTED: '已准入',
  SKIPPED: '已跳过',
  FAILED: '准入失败',
}

export const SKIP_LABELS: Record<ScheduleSkipReason, string> = Object.fromEntries(
  SCHEDULE_SKIP_REASONS.map((reason) => {
    if (reason === 'FACTORY_DISABLED') {
      return [reason, '平台尚未开放此类定时任务；请在平台配置中开放后再执行']
    }
    return [reason, SCHEDULE_SKIP_REASON_METAS[reason].label]
  }),
) as Record<ScheduleSkipReason, string>


export function consumerLabel(type: ScheduleConsumerType) {
  return CONSUMER_LABELS[type]
}

export function lastResult(status: ScheduleAdmissionStatus | undefined, reason: ScheduleSkipReason | null | undefined) {
  if (!status) return '还没有窗口'
  if (status === 'ADMITTED') return '已准入（已创建执行对象，不等于业务成功）'
  if (status === 'SKIPPED' && reason) return `已跳过 · ${SKIP_LABELS[reason]}`
  return ADMISSION_LABELS[status]
}
export const CANDIDATE_STATUS: Record<string, string> = { pending: '待审阅', proposed: '已转入审阅', accepted: '已采纳', rejected: '已拒绝' }
