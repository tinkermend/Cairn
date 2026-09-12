import { z } from 'zod'
import { EVIDENCE_TYPES, evidenceTypeSchema, type EvidenceType } from './evidence.js'

export const EVIDENCE_CAPTURE_MODES = ['off', 'on_failure', 'always'] as const
export type EvidenceCaptureMode = (typeof EVIDENCE_CAPTURE_MODES)[number]
export const evidenceCaptureModeSchema = z.enum(EVIDENCE_CAPTURE_MODES)

export const DEFAULT_SCREENSHOT_RETAIN_DAYS = 30
export const DEFAULT_TRACE_RETAIN_DAYS = 14
export const DEFAULT_DEBUG_TRACE_RETAIN_DAYS = 7

/**
 * 冻结进 RunSnapshot 的证据策略。字段都可选：存量 Snapshot 没有它，
 * `resolveEvidencePolicy` 补平台默认，避免 P5 D8b 那种「加必填键让老 Run 全炸」。
 */
export const evidencePolicySchema = z.strictObject({
  screenshot: evidenceCaptureModeSchema.optional(),
  trace: evidenceCaptureModeSchema.optional(),
  required: z.array(evidenceTypeSchema).min(1).max(EVIDENCE_TYPES.length).optional(),
  retainDays: z
    .strictObject({
      screenshot: z.number().int().positive().max(3650).optional(),
      trace: z.number().int().positive().max(3650).optional(),
    })
    .optional(),
})
export type EvidencePolicy = z.infer<typeof evidencePolicySchema>

export type ResolvedEvidencePolicy = {
  screenshot: EvidenceCaptureMode
  trace: EvidenceCaptureMode
  required: EvidenceType[]
  retainDays: { screenshot: number; trace: number }
}

export const DEFAULT_EVIDENCE_POLICY: ResolvedEvidencePolicy = {
  screenshot: 'on_failure',
  trace: 'off',
  required: ['input'],
  retainDays: {
    screenshot: DEFAULT_SCREENSHOT_RETAIN_DAYS,
    trace: DEFAULT_TRACE_RETAIN_DAYS,
  },
}

export function resolveEvidencePolicy(policy?: EvidencePolicy | null): ResolvedEvidencePolicy {
  const screenshot = policy?.screenshot ?? DEFAULT_EVIDENCE_POLICY.screenshot
  const trace = policy?.trace ?? DEFAULT_EVIDENCE_POLICY.trace
  const required = policy?.required ?? DEFAULT_EVIDENCE_POLICY.required
  const traceRetain =
    policy?.retainDays?.trace ??
    (trace === 'always' ? DEFAULT_DEBUG_TRACE_RETAIN_DAYS : DEFAULT_TRACE_RETAIN_DAYS)
  return {
    screenshot,
    trace,
    required: [...required],
    retainDays: {
      screenshot: policy?.retainDays?.screenshot ?? DEFAULT_SCREENSHOT_RETAIN_DAYS,
      trace: traceRetain,
    },
  }
}

export function shouldCaptureEvidence(
  mode: EvidenceCaptureMode,
  failed: boolean,
): boolean {
  if (mode === 'off') return false
  if (mode === 'always') return true
  return failed
}

export function retainUntilFor(
  type: 'screenshot' | 'trace',
  policy: ResolvedEvidencePolicy,
  now = new Date(),
): Date {
  const days = policy.retainDays[type]
  return new Date(now.getTime() + days * 86_400_000)
}
