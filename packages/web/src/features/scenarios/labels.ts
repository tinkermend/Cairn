import type {
  EffectType,
  ExecutableStepType,
  RunStatus,
  ScenarioStatus,
  StepRunStatus,
} from '@cairn/shared'

export const SCENARIO_STATUS_LABELS: Record<ScenarioStatus, string> = {
  active: '已启用',
  disabled: '已停用',
}

export const STEP_TYPE_LABELS: Record<ExecutableStepType, string> = {
  echo: '回显',
  delay: '等待',
  fail: '失败',
  navigate: '导航',
  click: '点击',
  fill: '填写',
  extract: '提取',
  assert: '断言',
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
  WAITING_FOR_AUTH: '等待目标系统登录',
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
