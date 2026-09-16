import type {
  EffectType,
  ModuleExecutionMode,
  ModuleHealthSignal,
  ModulePublicationStatus,
  ModuleValueType,
} from '@cairn/shared'

export const MODULE_EXECUTION_MODE_LABELS: Record<ModuleExecutionMode, string> =
  {
    DETERMINISTIC: '确定性',
    AI: 'AI',
    HYBRID: '混编',
  }

export const MODULE_EXECUTION_MODE_VARIANTS: Record<
  ModuleExecutionMode,
  'secondary' | 'default' | 'outline'
> = {
  DETERMINISTIC: 'secondary',
  AI: 'default',
  HYBRID: 'outline',
}

export const MODULE_EFFECT_CEILING_LABELS: Record<EffectType, string> = {
  READ_ONLY: '只读',
  IDEMPOTENT: '可重入',
  SIDE_EFFECT: '有副作用',
}

export const MODULE_PUBLICATION_STATUS_LABELS: Record<
  ModulePublicationStatus,
  string
> = {
  published: '已发布',
  deprecated: '已弃用',
  withdrawn: '已撤回',
}

export const MODULE_HEALTH_LABELS: Record<ModuleHealthSignal, string> = {
  unknown: '样本不足',
  healthy: '健康',
  degraded: '降级',
}

export const MODULE_VALUE_TYPE_LABELS: Record<ModuleValueType, string> = {
  string: '字符串',
  number: '数值',
  boolean: '布尔值',
  json: 'JSON',
}
