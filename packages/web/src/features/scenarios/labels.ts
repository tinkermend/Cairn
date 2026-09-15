import type { EffectType, RunStatus, ScenarioStatus, StepRunStatus } from '@cairn/shared'

export { STEP_TYPE_LABELS, stepTypeLabel } from './step-registry'

export const SCENARIO_STATUS_LABELS: Record<ScenarioStatus, string> = {
  active: '已启用',
  disabled: '已停用',
}

export const EFFECT_TYPE_LABELS: Record<EffectType, string> = {
  READ_ONLY: '只读',
  IDEMPOTENT: '可重入',
  SIDE_EFFECT: '有副作用',
}

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  QUEUED: '排队',
  RUNNING: '运行中',
  RECOVERING: '恢复中',
  WAITING_FOR_AUTH: '需要登录',
  HOLDING: '挂起中',
  SUCCEEDED: '成功',
  FAILED: '失败',
  CANCELLED: '已取消',
  NEEDS_REVIEW: '待核查',
}

export const STEP_RUN_STATUS_LABELS: Record<StepRunStatus, string> = {
  PENDING: '待执行',
  RUNNING: '运行中',
  SUCCEEDED: '成功',
  FAILED: '失败',
  SKIPPED: '已跳过',
  CANCELLED: '已取消',
}
