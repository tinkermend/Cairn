import { z } from 'zod'
import { EVIDENCE_TYPES, evidenceTypeSchema, type EvidenceType } from './evidence.js'
import { screenshotViewportSchema, type ScreenshotViewport } from './evidence-slots.js'

export const EVIDENCE_CAPTURE_MODES = ['off', 'on_failure', 'always'] as const
export type EvidenceCaptureMode = (typeof EVIDENCE_CAPTURE_MODES)[number]
export const evidenceCaptureModeSchema = z.enum(EVIDENCE_CAPTURE_MODES)

export const VIDEO_CAPTURE_MODES = ['off', 'always'] as const
export type VideoCaptureMode = (typeof VIDEO_CAPTURE_MODES)[number]
export const videoCaptureModeSchema = z.enum(VIDEO_CAPTURE_MODES)

export const DEFAULT_SCREENSHOT_RETAIN_DAYS = 30
export const DEFAULT_TRACE_RETAIN_DAYS = 14
export const DEFAULT_DEBUG_TRACE_RETAIN_DAYS = 7
export const DEFAULT_VIDEO_RETAIN_DAYS = 14

/**
 * 冻结进 RunSnapshot 的证据策略。字段都可选：存量 Snapshot 没有它，
 * `resolveEvidencePolicy` 补历史默认，避免把新产品出厂值回写到老 Run。
 */
export const evidencePolicySchema = z.strictObject({
  screenshot: evidenceCaptureModeSchema.optional(),
  video: videoCaptureModeSchema.optional(),
  trace: evidenceCaptureModeSchema.optional(),
  required: z.array(evidenceTypeSchema).min(1).max(EVIDENCE_TYPES.length).optional(),
  retainDays: z
    .strictObject({
      screenshot: z.number().int().positive().max(3650).optional(),
      video: z.number().int().positive().max(3650).optional(),
      trace: z.number().int().positive().max(3650).optional(),
    })
    .optional(),
  /** 快照只冻结合同版本；阈值见 shared `CAPTURE_CONTRACT_V1`。 */
  captureContractVersion: z.literal(1).optional(),
  /** 缺省按历史整页解释；新组装快照冻结 viewport。 */
  screenshotViewport: screenshotViewportSchema.optional(),
})
export type EvidencePolicy = z.infer<typeof evidencePolicySchema>

export type ResolvedEvidencePolicy = {
  screenshot: EvidenceCaptureMode
  video: VideoCaptureMode
  trace: EvidenceCaptureMode
  required: EvidenceType[]
  retainDays: { screenshot: number; video: number; trace: number }
  screenshotViewport: ScreenshotViewport
}

/** 历史 Snapshot / 无字段时的解释。新产品出厂默认在 FACTORY_PLATFORM_CONFIG.evidence。 */
export const DEFAULT_EVIDENCE_POLICY: ResolvedEvidencePolicy = {
  screenshot: 'on_failure',
  video: 'off',
  trace: 'off',
  required: ['input'],
  retainDays: {
    screenshot: DEFAULT_SCREENSHOT_RETAIN_DAYS,
    video: DEFAULT_VIDEO_RETAIN_DAYS,
    trace: DEFAULT_TRACE_RETAIN_DAYS,
  },
  screenshotViewport: 'full_page',
}

export function resolveEvidencePolicy(
  policy?: EvidencePolicy | null,
  platformDefault: ResolvedEvidencePolicy = DEFAULT_EVIDENCE_POLICY,
): ResolvedEvidencePolicy {
  const screenshot = policy?.screenshot ?? platformDefault.screenshot
  const video = policy?.video ?? platformDefault.video
  const trace = policy?.trace ?? platformDefault.trace
  const required = policy?.required ?? platformDefault.required
  const defaultTraceRetain =
    trace === 'always' ? DEFAULT_DEBUG_TRACE_RETAIN_DAYS : platformDefault.retainDays.trace
  const traceRetain = policy?.retainDays?.trace ?? defaultTraceRetain
  return {
    screenshot,
    video,
    trace,
    required: [...required],
    retainDays: {
      screenshot: policy?.retainDays?.screenshot ?? platformDefault.retainDays.screenshot,
      video: policy?.retainDays?.video ?? platformDefault.retainDays.video,
      trace: traceRetain,
    },
    screenshotViewport: policy?.screenshotViewport ?? platformDefault.screenshotViewport ?? 'full_page',
  }
}

export function shouldCaptureEvidence(
  mode: EvidenceCaptureMode | VideoCaptureMode,
  failed: boolean,
): boolean {
  if (mode === 'off') return false
  if (mode === 'always') return true
  return failed
}

export function retainUntilFor(
  type: 'screenshot' | 'trace' | 'video',
  policy: ResolvedEvidencePolicy,
  now = new Date(),
): Date {
  const days = policy.retainDays[type]
  return new Date(now.getTime() + days * 86_400_000)
}
