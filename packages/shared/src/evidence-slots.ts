import { z } from 'zod'
import { pageRefSchema } from './managed-browser.js'
import { utcInstantSchema } from './wire.js'
import type { EvidenceType } from './evidence.js'

export const SCREENSHOT_ROLES = [
  'before_action',
  'after_action',
  'after_condition',
  'on_error',
  'handoff',
  'final',
] as const
export type ScreenshotRole = (typeof SCREENSHOT_ROLES)[number]
export const screenshotRoleSchema = z.enum(SCREENSHOT_ROLES)

export const SCREENSHOT_VIEWPORTS = ['viewport', 'full_page'] as const
export type ScreenshotViewport = (typeof SCREENSHOT_VIEWPORTS)[number]
export const screenshotViewportSchema = z.enum(SCREENSHOT_VIEWPORTS)

export const SCREENSHOT_ROLE_LABELS: Record<ScreenshotRole, string> = {
  before_action: '操作前',
  after_action: '操作后',
  after_condition: '条件达成',
  on_error: '失败现场',
  handoff: '页面交接',
  final: '运行结束',
}

export const sensitiveSelectorSchema = z.string().trim().min(1).max(256)
export const sensitiveSelectorsSchema = z.array(sensitiveSelectorSchema).max(32)
export type SensitiveSelectors = z.infer<typeof sensitiveSelectorsSchema>

export const EVIDENCE_ARTIFACT_KEY_MAX = 160

export const evidenceArtifactKeySchema = z.string().trim().min(1).max(EVIDENCE_ARTIFACT_KEY_MAX)

export const SCREENSHOT_DIAGNOSES = ['suspected_blank', 'not_flagged'] as const
export type ScreenshotDiagnosis = (typeof SCREENSHOT_DIAGNOSES)[number]
export const screenshotDiagnosisSchema = z.enum(SCREENSHOT_DIAGNOSES)

export const SCREENSHOT_DIAGNOSIS_LABELS: Record<ScreenshotDiagnosis, string> = {
  suspected_blank: '截图疑似空白',
  not_flagged: '未发现空白迹象',
}

export const screenshotEvidencePayloadSchema = z.strictObject({
  role: screenshotRoleSchema,
  viewport: screenshotViewportSchema,
  capturedAt: utcInstantSchema,
  pageRef: pageRefSchema.optional(),
  seq: z.number().int().nonnegative().optional(),
  diagnosis: screenshotDiagnosisSchema.optional(),
  omittedBefore: z.literal('initial_blank_page').optional(),
})
export type ScreenshotEvidencePayload = z.infer<typeof screenshotEvidencePayloadSchema>

export function writeEvidenceArtifactKey(input: {
  type: EvidenceType
  id?: string
  attemptId?: string
  role?: ScreenshotRole
  seq?: number
}): string {
  if (input.type === 'video' && !input.attemptId) return 'video:run'
  if (input.type === 'screenshot' && input.attemptId && input.role) {
    return `screenshot:${input.attemptId}:${input.role}:${input.seq ?? 0}`
  }
  if (input.attemptId) return `${input.type}:${input.attemptId}`
  return `${input.type}:${input.id ?? 'legacy'}`
}

export function readScreenshotPayload(value: unknown): ScreenshotEvidencePayload | undefined {
  const parsed = screenshotEvidencePayloadSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function requiredScreenshotRole(input: {
  failed: boolean
  stepType?: string
  commandType?: string
}): ScreenshotRole {
  if (input.failed) return 'on_error'
  const kind = input.commandType ?? input.stepType
  if (kind === 'wait') return 'after_condition'
  return 'after_action'
}

export function isSideEffectBrowserCommand(type: string): boolean {
  return (
    type === 'click' ||
    type === 'fill' ||
    type === 'select' ||
    type === 'keyboard' ||
    type === 'navigate' ||
    type === 'upload' ||
    type === 'download'
  )
}

export function screenshotRoleOf(row: {
  artifactKey?: string | null
  payload?: unknown
}): ScreenshotRole | undefined {
  const parsed = readScreenshotPayload(row.payload)
  if (parsed?.role) return parsed.role
  const key = row.artifactKey
  if (!key?.startsWith('screenshot:')) return undefined
  const role = key.split(':')[2]
  if (!role || !(SCREENSHOT_ROLES as readonly string[]).includes(role)) return undefined
  return role as ScreenshotRole
}

export function screenshotSatisfiesRequiredRole(
  row: { type: string; artifactKey?: string | null; payload?: unknown },
  role: ScreenshotRole,
): boolean {
  return row.type === 'screenshot' && screenshotRoleOf(row) === role
}

export function faceScreenshot<T extends { attemptId?: string; type: string; payload?: unknown }>(
  items: readonly T[],
  attemptId: string,
): T | undefined {
  const shots = items.filter((item) => item.attemptId === attemptId && item.type === 'screenshot')
  const rank = (item: T) => {
    const payload = readScreenshotPayload(item.payload)
    const role = payload?.role
    const roleRank =
      role === 'on_error' ? 0
      : role === 'after_action' || role === 'after_condition' || role === 'final' ? 1
      : role === 'handoff' ? 2
      : role === 'before_action' ? 3
      : 4
    const blankRank = payload?.diagnosis === 'suspected_blank' ? 1 : 0
    const seq = payload?.seq ?? 0
    return [roleRank, blankRank, -seq] as const
  }
  return [...shots].sort((left, right) => {
    const a = rank(left)
    const b = rank(right)
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  })[0]
}
