import { z } from 'zod'
import { entityIdSchema } from './wire.js'
import type { LocatorCandidate } from './target-descriptor.js'

export const RESOLUTION_PROTOCOL = 'snapshot.resolution@1' as const

export const RESOLUTION_POLICIES = [
  'deterministic_only',
  'prefer_deterministic',
  'prefer_ai',
  'ai_only',
] as const
export type ResolutionPolicy = (typeof RESOLUTION_POLICIES)[number]
export const resolutionPolicySchema = z.enum(RESOLUTION_POLICIES)

export const RESOLUTION_POLICY_RANK: Record<ResolutionPolicy, number> = {
  deterministic_only: 0,
  prefer_deterministic: 1,
  prefer_ai: 2,
  ai_only: 3,
}

export const FACTORY_RESOLUTION_CEILING = 'deterministic_only' as const
export const FACTORY_RESOLUTION_DEFAULT = 'prefer_deterministic' as const

export function minResolutionPolicy(left: ResolutionPolicy, right: ResolutionPolicy): ResolutionPolicy {
  return RESOLUTION_POLICY_RANK[left] <= RESOLUTION_POLICY_RANK[right] ? left : right
}

export function mergeResolutionCeiling(input: {
  ceiling: ResolutionPolicy
  targetCeiling?: ResolutionPolicy
  browserAiEnabled?: boolean
}): ResolutionPolicy {
  const platform = input.browserAiEnabled === false ? 'deterministic_only' : input.ceiling
  return input.targetCeiling ? minResolutionPolicy(platform, input.targetCeiling) : platform
}

export function mergeEffectiveResolution(input: {
  ceiling: ResolutionPolicy
  defaultResolution: ResolutionPolicy
  targetCeiling?: ResolutionPolicy
  targetPreference?: ResolutionPolicy
  document?: ResolutionPolicy
  step?: ResolutionPolicy
  browserAiEnabled?: boolean
}): ResolutionPolicy {
  const ceiling = mergeResolutionCeiling(input)
  const requested = requestedResolution(input)
  return minResolutionPolicy(ceiling, requested)
}

export function requestedResolution(input: {
  defaultResolution: ResolutionPolicy
  targetPreference?: ResolutionPolicy
  document?: ResolutionPolicy
  step?: ResolutionPolicy
}): ResolutionPolicy {
  return input.step ?? input.document ?? input.targetPreference ?? input.defaultResolution
}

export const targetResolutionPolicySchema = z
  .strictObject({
    preference: resolutionPolicySchema.optional(),
    ceiling: resolutionPolicySchema.optional(),
  })
  .refine((value) => value.preference !== undefined || value.ceiling !== undefined, {
    message: '至少指定解析优先顺序或该系统解析上限',
  })
export type TargetResolutionPolicy = z.infer<typeof targetResolutionPolicySchema>

export const targetResolutionPolicyPatchSchema = z.strictObject({
  preference: resolutionPolicySchema.nullable().optional(),
  ceiling: resolutionPolicySchema.nullable().optional(),
})
export type TargetResolutionPolicyPatch = z.infer<typeof targetResolutionPolicyPatchSchema>

export function parseTargetResolutionPolicy(value: unknown): TargetResolutionPolicy | null {
  if (value == null) return null
  const parsed = z
    .strictObject({
      preference: resolutionPolicySchema.optional(),
      ceiling: resolutionPolicySchema.optional(),
    })
    .parse(value)
  if (parsed.preference === undefined && parsed.ceiling === undefined) return null
  return parsed
}

export function applyTargetResolutionPolicyPatch(
  current: TargetResolutionPolicy | null,
  patch: TargetResolutionPolicyPatch,
): TargetResolutionPolicy | null {
  const next: { preference?: ResolutionPolicy; ceiling?: ResolutionPolicy } = { ...current }
  if (patch.preference === null) delete next.preference
  else if (patch.preference !== undefined) next.preference = patch.preference
  if (patch.ceiling === null) delete next.ceiling
  else if (patch.ceiling !== undefined) next.ceiling = patch.ceiling
  return parseTargetResolutionPolicy(next)
}

export const RESOLUTION_CEILING_LABELS: Record<ResolutionPolicy, string> = {
  deterministic_only: '仅规则',
  prefer_deterministic: '规则优先，允许 AI 兜底',
  prefer_ai: '允许 AI 优先',
  ai_only: '允许仅 AI',
}

export const RESOLUTION_PREFERENCE_LABELS: Record<ResolutionPolicy, string> = {
  deterministic_only: '仅规则',
  prefer_deterministic: '规则优先，AI 兜底',
  prefer_ai: 'AI 优先，规则兜底',
  ai_only: '仅 AI',
}

export function policyAllowsAiRung(policy: ResolutionPolicy): boolean {
  return policy !== 'deterministic_only'
}

export function policyStartsAtAiRung(policy: ResolutionPolicy): boolean {
  return policy === 'prefer_ai' || policy === 'ai_only'
}

export const frozenResolutionSchema = z.strictObject({
  protocol: z.literal(RESOLUTION_PROTOCOL),
  ceiling: resolutionPolicySchema,
  scenarioDefault: resolutionPolicySchema,
  targetCeiling: resolutionPolicySchema.optional(),
  targetPreference: resolutionPolicySchema.optional(),
  steps: z.record(entityIdSchema, resolutionPolicySchema),
})
export type FrozenResolution = z.infer<typeof frozenResolutionSchema>

export function freezeResolutionSnapshot(input: {
  ceiling: ResolutionPolicy
  scenarioDefault: ResolutionPolicy
  targetCeiling?: ResolutionPolicy
  targetPreference?: ResolutionPolicy
  steps: Readonly<Record<string, ResolutionPolicy>>
}): FrozenResolution | undefined {
  if (!Object.values(input.steps).some(policyAllowsAiRung)) return undefined
  return frozenResolutionSchema.parse({
    protocol: RESOLUTION_PROTOCOL,
    ceiling: input.ceiling,
    scenarioDefault: input.scenarioDefault,
    ...(input.targetCeiling ? { targetCeiling: input.targetCeiling } : {}),
    ...(input.targetPreference ? { targetPreference: input.targetPreference } : {}),
    steps: input.steps,
  })
}

const ROLE_LABELS: Record<string, string> = {
  button: '按钮',
  heading: '标题',
  link: '链接',
  menuitem: '菜单项',
  textbox: '文本框',
  searchbox: '搜索框',
  combobox: '下拉框',
  checkbox: '复选框',
  radio: '单选',
  tab: '页签',
  option: '选项',
}

/** 图标字体、私用区和零宽字符不能当给人看的定位名，也会干扰角色名匹配。 */
export function sanitizeLocatorLabel(value: string): string {
  return value
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/([「『])\s+/g, '$1')
    .replace(/\s+([」』])/g, '$1')
    .trim()
}

export function describeLocatorCandidates(candidates: readonly LocatorCandidate[]): string {
  const preferred = candidates.find((candidate) => candidate.by !== 'css') ?? candidates[0]
  if (!preferred) return ''
  if (preferred.by === 'role') {
    const role = ROLE_LABELS[preferred.value] ?? preferred.value
    const name = preferred.name ? sanitizeLocatorLabel(preferred.name) : ''
    return name ? `名为「${name}」的${role}` : role
  }
  if (preferred.by === 'label') return `标签为「${sanitizeLocatorLabel(preferred.value)}」的元素`
  if (preferred.by === 'text') return `文本为「${sanitizeLocatorLabel(preferred.value)}」的元素`
  if (preferred.by === 'title') return `标题为「${sanitizeLocatorLabel(preferred.value)}」的元素`
  if (preferred.by === 'testId') return `测试标识为「${preferred.value}」的元素`
  return `选择器为「${preferred.value}」的元素`
}

export function normalizeCrossCheckText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

export const CROSS_CHECK_CONTAINER_TAGS = [
  'DIV',
  'SECTION',
  'ARTICLE',
  'MAIN',
  'ASIDE',
  'NAV',
  'HEADER',
  'FOOTER',
  'FORM',
  'TABLE',
  'TBODY',
  'THEAD',
  'TFOOT',
  'TR',
  'TD',
  'TH',
  'UL',
  'OL',
  'DL',
  'BODY',
  'HTML',
  'FIELDSET',
] as const

export function isCrossCheckContainerTag(tagName: string): boolean {
  return (CROSS_CHECK_CONTAINER_TAGS as readonly string[]).includes(tagName.toUpperCase())
}

export function crossCheckMatches(
  elementTexts: readonly string[],
  candidates: readonly LocatorCandidate[],
): boolean {
  const hay = elementTexts.map(normalizeCrossCheckText).filter(Boolean)
  return candidates.some((candidate) => {
    if (candidate.by === 'css') return false
    const needles = [candidate.value, candidate.name]
      .filter((item): item is string => Boolean(item))
      .map(normalizeCrossCheckText)
    return needles.some((needle) => needle && hay.some((item) => item.includes(needle)))
  })
}

export const RESOLUTION_MODE_LABELS = {
  rule: '规则',
  mixed: '规则 · AI 兜底',
  ai: 'AI',
} as const
export type ResolutionModeKind = keyof typeof RESOLUTION_MODE_LABELS

export function deriveStepResolutionBadge(input: {
  effective: ResolutionPolicy
  hasCandidates: boolean
  aiRungAvailable: boolean
}): { kind: ResolutionModeKind; unavailable?: string } {
  const unavailable = input.aiRungAvailable ? undefined : '当前未开放 AI 解析'
  if (input.effective === 'ai_only' || (input.effective !== 'deterministic_only' && !input.hasCandidates)) {
    return { kind: 'ai', ...(unavailable ? { unavailable } : {}) }
  }
  if (policyAllowsAiRung(input.effective)) {
    return { kind: 'mixed', ...(unavailable ? { unavailable } : {}) }
  }
  return { kind: 'rule' }
}
