import { z } from 'zod'
import { entityIdSchema } from './wire.js'

export const LOCATOR_ROUTES = ['rule', 'text_ai', 'vision_ai'] as const
export const LOCATOR_RESOLUTION_PROTOCOL = 'snapshot.resolution@2' as const
export const locatorRouteSchema = z.enum(LOCATOR_ROUTES)
export type LocatorRoute = z.infer<typeof locatorRouteSchema>

export const LOCATOR_ROUTE_LABELS: Record<LocatorRoute, string> = {
  rule: '规则',
  text_ai: '文本模型',
  vision_ai: '视觉模型',
}

const routeListSchema = z.array(locatorRouteSchema).min(1).max(3).refine(
  (routes) => new Set(routes).size === routes.length,
  '定位路线不能重复',
)

export const locatorPlanSchema = z.strictObject({ v: z.literal(2), order: routeListSchema })
export const locatorLimitsSchema = z.strictObject({ v: z.literal(2), allowed: routeListSchema })
export type LocatorPlan = z.infer<typeof locatorPlanSchema>
export type LocatorLimits = z.infer<typeof locatorLimitsSchema>

export const LOCATOR_PRESETS = {
  rule_only: { v: 2, order: ['rule'] },
  rule_text: { v: 2, order: ['rule', 'text_ai'] },
  rule_vision: { v: 2, order: ['rule', 'vision_ai'] },
  rule_text_vision: { v: 2, order: ['rule', 'text_ai', 'vision_ai'] },
  text_only: { v: 2, order: ['text_ai'] },
  text_rule: { v: 2, order: ['text_ai', 'rule'] },
  vision_rule: { v: 2, order: ['vision_ai', 'rule'] },
  vision_only: { v: 2, order: ['vision_ai'] },
  text_vision: { v: 2, order: ['text_ai', 'vision_ai'] },
} as const satisfies Record<string, LocatorPlan>
export type LocatorPreset = keyof typeof LOCATOR_PRESETS

export const LOCATOR_PRESET_LABELS: Record<LocatorPreset, string> = {
  rule_only: '仅规则',
  rule_text: '规则优先，文本兜底',
  rule_vision: '规则优先，视觉兜底',
  rule_text_vision: '规则优先，完整兜底',
  text_only: '仅文本模型',
  text_rule: '文本优先，规则兜底',
  vision_rule: '视觉优先，规则兜底',
  vision_only: '仅视觉定位',
  text_vision: '仅模型定位：文本 → 视觉',
}

export const locatorSkipSchema = z.strictObject({
  route: locatorRouteSchema,
  reason: z.enum(['PLATFORM_LIMIT', 'TARGET_LIMIT', 'TEXT_NOT_READY', 'VISION_NOT_READY']),
})
export type LocatorSkip = z.infer<typeof locatorSkipSchema>

export const LOCATOR_SKIP_LABELS: Record<LocatorSkip['reason'], string> = {
  PLATFORM_LIMIT: '平台未允许',
  TARGET_LIMIT: '目标系统未允许',
  TEXT_NOT_READY: '文本模型未就绪',
  VISION_NOT_READY: '视觉模型未就绪',
}

export const frozenLocatorStepSchema = z.strictObject({
  requested: routeListSchema,
  actual: routeListSchema,
  skipped: z.array(locatorSkipSchema).max(3),
  source: z.enum(['step', 'scenario', 'target', 'platform']),
})
export type FrozenLocatorStep = z.infer<typeof frozenLocatorStepSchema>

export const frozenLocatorResolutionSchema = z.strictObject({
  protocol: z.literal(LOCATOR_RESOLUTION_PROTOCOL),
  allowed: routeListSchema,
  steps: z.record(entityIdSchema, frozenLocatorStepSchema),
  textConfigVersion: z.string().max(64).optional(),
  visionConfigVersion: z.string().max(64).optional(),
})
export type FrozenLocatorResolution = z.infer<typeof frozenLocatorResolutionSchema>

export function locatorPlanPreset(value: LocatorPreset): LocatorPlan {
  return { v: 2, order: [...LOCATOR_PRESETS[value].order] }
}

export function locatorPresetFor(plan: LocatorPlan): LocatorPreset | undefined {
  return (Object.keys(LOCATOR_PRESETS) as LocatorPreset[]).find((key) =>
    LOCATOR_PRESETS[key].order.join(',') === plan.order.join(','),
  )
}
