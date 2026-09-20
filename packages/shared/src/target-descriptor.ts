import { z } from 'zod'

/**
 * 页面目标描述。每次执行重新解析，不存运行期句柄，也不存 frame 下标。
 */

export const MAX_FRAME_DEPTH = 4
export const MAX_LOCATOR_CANDIDATES = 5

export const LOCATOR_BY = ['role', 'label', 'text', 'title', 'testId', 'css'] as const
export type LocatorBy = (typeof LOCATOR_BY)[number]
export const locatorBySchema = z.enum(LOCATOR_BY)

export const RELATIVE_ANCHOR_SCOPES = ['row', 'nearest'] as const
export type RelativeAnchorScope = (typeof RELATIVE_ANCHOR_SCOPES)[number]

export const frameStepSchema = z
  .strictObject({
    urlPattern: z.string().trim().min(1).max(512).optional(),
    name: z.string().trim().min(1).max(128).optional(),
    selector: z.string().trim().min(1).max(512).optional(),
  })
  .refine((step) => Boolean(step.urlPattern || step.name || step.selector), {
    message: 'FrameStep 必须提供 urlPattern / name / selector 至少一项',
  })
export type FrameStep = z.infer<typeof frameStepSchema>

export const locatorCandidateSchema = z.strictObject({
  by: locatorBySchema,
  /** role 时为角色名；其余档为可见文本 / 选择器。 */
  value: z.string().trim().min(1).max(512),
  /** 仅 role：无障碍名称。 */
  name: z.string().trim().min(1).max(256).optional(),
})
export type LocatorCandidate = z.infer<typeof locatorCandidateSchema>

export const relativeAnchorSchema = z.strictObject({
  withinText: z.string().trim().min(1).max(256),
  scope: z.enum(RELATIVE_ANCHOR_SCOPES),
})
export type RelativeAnchor = z.infer<typeof relativeAnchorSchema>

export const targetDescriptorSchema = z
  .strictObject({
    framePath: z.array(frameStepSchema).max(MAX_FRAME_DEPTH).default([]),
    candidates: z.array(locatorCandidateSchema).min(1).max(MAX_LOCATOR_CANDIDATES),
    anchor: relativeAnchorSchema.optional(),
  })
  .superRefine((descriptor, ctx) => {
    const cssIndexes = descriptor.candidates
      .map((candidate, index) => (candidate.by === 'css' ? index : -1))
      .filter((index) => index >= 0)
    if (cssIndexes.length === 0) return
    const last = descriptor.candidates.length - 1
    if (cssIndexes.some((index) => index !== last) || cssIndexes.length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['candidates'],
        message: 'css 候选只能作为最后一档',
      })
    }
  })
export type TargetDescriptor = z.infer<typeof targetDescriptorSchema>

const ARRIVAL_ROLE_FALLBACKS = ['heading', 'menuitem', 'link', 'button'] as const

function candidateKey(candidate: LocatorCandidate): string {
  return `${candidate.by}:${candidate.value}:${candidate.name ?? ''}`
}

/** 到达名按标题 → 菜单项 → 链接 → 按钮补齐，避免业务页只有侧栏项时断言空转。 */
export function expandArrivalTarget(target: TargetDescriptor, arrivalName: string): TargetDescriptor {
  const name = arrivalName.trim()
  if (!name) return target
  const seen = new Set(target.candidates.map(candidateKey))
  const extras: LocatorCandidate[] = []
  for (const role of ARRIVAL_ROLE_FALLBACKS) {
    const candidate: LocatorCandidate = { by: 'role', value: role, name }
    const key = candidateKey(candidate)
    if (seen.has(key)) continue
    extras.push(candidate)
    seen.add(key)
  }
  const text: LocatorCandidate = { by: 'text', value: name }
  if (!seen.has(candidateKey(text))) extras.push(text)
  return {
    ...target,
    candidates: [...target.candidates, ...extras].slice(0, MAX_LOCATOR_CANDIDATES),
  }
}

export function arrivalTargetForName(name: string): TargetDescriptor {
  const trimmed = name.trim()
  return expandArrivalTarget(
    { framePath: [], candidates: [{ by: 'role', value: 'heading', name: trimmed }] },
    trimmed,
  )
}
