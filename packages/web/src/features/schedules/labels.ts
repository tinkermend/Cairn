import {
  ANALYSIS_MODE_LABELS,
  SCHEDULE_CONSUMER_LABELS,
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

export const SKIP_LABELS: Record<ScheduleSkipReason, string> = {
  WINDOW_CLOSED: '错过窗口',
  DST_NONEXISTENT: '夏令时不存在该本地时间',
  INVALID_RESOLVED_WINDOW: '解析后的窗口无效',
  FACTORY_DISABLED: '工厂未开放该类调度',
  SCHEDULE_DISABLED: '计划已停用',
  MANUAL_JOBS_DISABLED: '该目标尚未开放手工作业',
  AUTH_PREPARATION_REQUIRED: '认证尚未准备',
  SAFETY_BASIS_REQUIRED: '缺少安全进入依据',
  NO_ELIGIBLE_ASSETS: '没有可纳入的资产',
  COVERED_BY_RUN: '已被正式运行覆盖',
  PERMISSION_REVOKED: '授权已被收回',
  MAP_ACCOUNT_USAGE_REQUIRED: '账号已收回地图用途',
  WORKER_UNAVAILABLE: '没有可执行的节点',
  TARGET_PAUSED: '目标已停用',
  ACTIVE_SLICE_EXISTS: '同目标已有进行中的地图作业',
  OVERLAP_ACTIVE: '同计划仍有未结束的执行',
  NO_NEW_DATA: '没有新的分析来源',
  COALESCED: '已并入待执行请求',
  START_DEADLINE_ELAPSED: '超过最晚开始时间',
  RESOURCE_UNAVAILABLE: '资源不可用',
  INPUT_MISSING: '输入不完整',
  VERSION_INVALID: '版本无效',
  ACCOUNT_UNAVAILABLE: '账号不可用',
  ANALYSIS_BUDGET_EXHAUSTED: '分析预算已用尽',
  ANALYSIS_CONFIG_INVALID: '分析配置无效',
  DUPLICATE_ANALYSIS_SCOPE: '同范围已有分析计划',
}

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
