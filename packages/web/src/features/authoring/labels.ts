import type { EffectType } from '@cairn/shared'

export {
  STEP_TYPE_LABELS,
  STEP_TYPE_HINTS,
  stepTypeLabel,
} from './step-registry'

export const EFFECT_TYPE_LABELS: Record<EffectType, string> = {
  READ_ONLY: '只读',
  IDEMPOTENT: '可重入',
  SIDE_EFFECT: '有副作用',
}
