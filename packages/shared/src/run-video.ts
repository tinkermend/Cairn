import { z } from 'zod'
import { utcInstantSchema } from './wire.js'

export const CAPTURE_CONTRACT_V1 = {
  version: 1 as const,
  timingToleranceMs: 500,
  heartbeatIntervalMs: 2000,
  stillnessGapMs: 5000,
  firstFrameWaitMs: 2000,
}

export function captureContractFor(version: number | undefined): typeof CAPTURE_CONTRACT_V1 {
  return CAPTURE_CONTRACT_V1
}

export const VIDEO_MEDIA_SEGMENT_MS = 8_000
export const VIDEO_MEDIA_LEASE_MS = 180_000
export const VIDEO_MEDIA_MAX_ATTEMPTS = 8

export const VIDEO_MEDIA_JOB_STATUSES = ['pending', 'claimed', 'succeeded', 'failed'] as const
export type VideoMediaJobStatus = (typeof VIDEO_MEDIA_JOB_STATUSES)[number]

export const VIDEO_SEGMENT_STATUSES = ['local', 'encoded', 'uploaded', 'committed'] as const
export type VideoSegmentStatus = (typeof VIDEO_SEGMENT_STATUSES)[number]

export const runVideoSegmentManifestSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  fromMs: z.number().int().nonnegative(),
  toMs: z.number().int().nonnegative(),
  frameCount: z.number().int().nonnegative(),
  persistWatermark: z.number().int().nonnegative(),
  status: z.enum(VIDEO_SEGMENT_STATUSES),
  file: z.string().min(1).max(128).optional(),
  sha256: z.string().min(1).max(128).optional(),
  byteSize: z.number().int().nonnegative().optional(),
})
export type RunVideoSegmentManifest = z.infer<typeof runVideoSegmentManifestSchema>

export const runVideoManifestSchema = z.strictObject({
  contractVersion: z.literal(1),
  runId: z.string().min(1),
  sealed: z.boolean(),
  sealedTMs: z.number().int().nonnegative(),
  framesWritten: z.number().int().nonnegative(),
  persistWatermark: z.number().int().nonnegative(),
  segments: z.array(runVideoSegmentManifestSchema).max(4096),
})
export type RunVideoManifest = z.infer<typeof runVideoManifestSchema>

function asNonNegInt(value: unknown): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value))
  return value
}

export function writeRunVideoManifest(value: unknown): RunVideoManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return runVideoManifestSchema.parse(value)
  }
  const raw = value as Record<string, unknown>
  const segments = Array.isArray(raw.segments)
    ? raw.segments.map((segment) => {
        if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return segment
        const item = segment as Record<string, unknown>
        return {
          ...item,
          seq: asNonNegInt(item.seq),
          fromMs: asNonNegInt(item.fromMs),
          toMs: asNonNegInt(item.toMs),
          frameCount: asNonNegInt(item.frameCount),
          persistWatermark: asNonNegInt(item.persistWatermark),
          ...(item.byteSize === undefined ? {} : { byteSize: asNonNegInt(item.byteSize) }),
        }
      })
    : raw.segments
  return runVideoManifestSchema.parse({
    ...raw,
    sealedTMs: asNonNegInt(raw.sealedTMs),
    framesWritten: asNonNegInt(raw.framesWritten),
    persistWatermark: asNonNegInt(raw.persistWatermark),
    segments,
  })
}

export const VIDEO_COVERAGE_STATUSES = [
  'complete',
  'partial',
  'none',
  'unverified',
  'not_applicable',
] as const
export type VideoCoverageStatus = (typeof VIDEO_COVERAGE_STATUSES)[number]

export const VIDEO_COVERAGE_GAP_REASONS = [
  'rate_limit',
  'budget',
  'mask_failed',
  'capture_failed',
  'page_unavailable',
  'paused',
] as const
export type VideoCoverageGapReason = (typeof VIDEO_COVERAGE_GAP_REASONS)[number]

export const runVideoCoverageGapSchema = z.strictObject({
  fromMs: z.number().int().nonnegative(),
  toMs: z.number().int().nonnegative(),
  reason: z.enum(VIDEO_COVERAGE_GAP_REASONS),
})

export const runVideoCoverageSchema = z.strictObject({
  status: z.enum(VIDEO_COVERAGE_STATUSES),
  gaps: z.array(runVideoCoverageGapSchema).max(64),
})
export type RunVideoCoverage = z.infer<typeof runVideoCoverageSchema>

export const runVideoPayloadSchema = z.strictObject({
  truncated: z.boolean(),
  truncateReason: z.enum(['max_bytes']).optional(),
  passwordMask: z.enum(['applied', 'failed']),
  timing: z
    .strictObject({
      contractVersion: z.literal(1),
      captureStartedAt: utcInstantSchema,
      sealedAt: utcInstantSchema,
      capturedSpanMs: z.number().int().nonnegative(),
      decodedDurationMs: z.number().int().nonnegative(),
      decodedFrames: z.number().int().nonnegative(),
      framesWritten: z.number().int().nonnegative(),
      framesDropped: z.strictObject({
        rateLimited: z.number().int().nonnegative(),
        budget: z.number().int().nonnegative(),
        maskFailed: z.number().int().nonnegative(),
      }),
      finalFrame: z.enum(['captured', 'failed', 'page_closed']),
    })
    .optional(),
  coverage: runVideoCoverageSchema.optional(),
})
export type RunVideoPayload = z.infer<typeof runVideoPayloadSchema>

export function writeRunVideoPayload(value: unknown): RunVideoPayload {
  return runVideoPayloadSchema.parse(value)
}

export function readRunVideoPayload(value: unknown): RunVideoPayload | undefined {
  const strict = runVideoPayloadSchema.safeParse(value)
  if (strict.success) return strict.data
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const rec = value as Record<string, unknown>
  const loose = runVideoPayloadSchema.safeParse({
    truncated: rec.truncated === true,
    ...(rec.truncateReason === 'max_bytes' ? { truncateReason: 'max_bytes' as const } : {}),
    passwordMask: rec.passwordMask === 'failed' ? 'failed' : rec.passwordMask === 'applied' ? 'applied' : undefined,
    ...(rec.timing && typeof rec.timing === 'object' && !Array.isArray(rec.timing) ? { timing: rec.timing } : {}),
    ...(rec.coverage && typeof rec.coverage === 'object' && !Array.isArray(rec.coverage)
      ? { coverage: rec.coverage }
      : {}),
  })
  return loose.success ? loose.data : undefined
}

export function formatVideoSeconds(ms: number): string {
  const sec = Math.max(0, ms) / 1000
  return Number.isInteger(sec) ? String(sec) : sec.toFixed(1)
}

export function videoTimingCaption(
  payload: { timing?: { decodedDurationMs: number; capturedSpanMs: number } } | null | undefined,
): string {
  if (!payload?.timing) return '历史录像，覆盖范围未验证'
  return `录像 ${formatVideoSeconds(payload.timing.decodedDurationMs)} 秒 / 采集区间 ${formatVideoSeconds(payload.timing.capturedSpanMs)} 秒`
}

export function capturedSpanMsOf(payload: unknown): number {
  return readRunVideoPayload(payload)?.timing?.capturedSpanMs ?? -1
}

export function computeRunVideoCoverage(input: {
  frames: { tMs: number; origin?: string }[]
  capturedSpanMs: number
  decodedDurationMs: number
  truncated: boolean
  finalFrame?: 'captured' | 'failed' | 'page_closed'
  contract?: typeof CAPTURE_CONTRACT_V1
}): RunVideoCoverage {
  const contract = input.contract ?? CAPTURE_CONTRACT_V1
  const frames = [...input.frames].sort((a, b) => a.tMs - b.tMs || 0)
  const span = Math.max(0, input.capturedSpanMs)
  if (frames.length === 0) {
    return { status: 'none', gaps: [{ fromMs: 0, toMs: span, reason: 'capture_failed' }] }
  }

  const gaps: RunVideoCoverage['gaps'] = []
  const first = frames[0]!
  if (first.tMs > contract.firstFrameWaitMs) {
    gaps.push({ fromMs: 0, toMs: Math.round(first.tMs), reason: 'capture_failed' })
  }
  for (let i = 0; i < frames.length - 1; i += 1) {
    const from = frames[i]!.tMs
    const to = frames[i + 1]!.tMs
    if (to - from > contract.stillnessGapMs) {
      gaps.push({ fromMs: Math.round(from), toMs: Math.round(to), reason: 'rate_limit' })
    }
  }
  const last = frames[frames.length - 1]!
  if (input.truncated) {
    gaps.push({
      fromMs: Math.round(last.tMs),
      toMs: Math.round(Math.max(span, last.tMs)),
      reason: 'budget',
    })
  } else if (span - last.tMs > contract.stillnessGapMs && input.finalFrame !== 'captured') {
    gaps.push({
      fromMs: Math.round(last.tMs),
      toMs: Math.round(span),
      reason: input.finalFrame === 'page_closed' ? 'page_unavailable' : 'capture_failed',
    })
  }
  if (Math.abs(input.decodedDurationMs - span) > contract.timingToleranceMs) {
    const from = Math.min(input.decodedDurationMs, span)
    const to = Math.max(input.decodedDurationMs, span)
    gaps.push({ fromMs: Math.round(from), toMs: Math.round(to), reason: 'capture_failed' })
  }
  return { status: gaps.length > 0 ? 'partial' : 'complete', gaps }
}

export const VIDEO_COVERAGE_STATUS_LABELS: Record<VideoCoverageStatus, string> = {
  complete: '覆盖完整',
  partial: '部分覆盖',
  none: '没有可用的录像覆盖',
  unverified: '覆盖范围未验证',
  not_applicable: '按策略未采集',
}

export const VIDEO_COVERAGE_GAP_LABELS: Record<VideoCoverageGapReason, string> = {
  rate_limit: '采样限频',
  budget: '体积截断',
  mask_failed: '遮罩失败',
  capture_failed: '采集失败',
  page_unavailable: '页面不存在',
  paused: '主动暂停',
}

export function videoCoverageLines(payload: RunVideoPayload | null | undefined): string[] {
  const lines: string[] = []
  if (payload?.timing) lines.push(videoTimingCaption(payload))
  if (!payload?.timing && !payload?.coverage) {
    lines.push('历史录像，覆盖范围未验证')
  } else if (payload?.coverage?.status && payload.coverage.status !== 'complete') {
    lines.push(VIDEO_COVERAGE_STATUS_LABELS[payload.coverage.status])
  } else if (!payload?.coverage) {
    lines.push(VIDEO_COVERAGE_STATUS_LABELS.unverified)
  }
  for (const gap of payload?.coverage?.gaps ?? []) {
    lines.push(
      `${VIDEO_COVERAGE_GAP_LABELS[gap.reason]} ${formatVideoSeconds(gap.fromMs)}–${formatVideoSeconds(gap.toMs)} 秒`,
    )
  }
  return lines
}

export function videoAbsenceCaption(input: {
  video?: { status: string; missingReason?: string } | null
  policyVideo?: 'off' | 'always'
}): string | null {
  if (!input.video) {
    if (input.policyVideo !== 'always') return VIDEO_COVERAGE_STATUS_LABELS.not_applicable
    return null
  }
  if (input.video.status !== 'missing') return null
  if (input.video.missingReason === 'object_purged') return '录像已过期，步骤截图仍可查看。'
  if (input.video.missingReason === 'capture_failed') return '采集失败，没有留下可用字节'
  if (
    input.video.missingReason === 'object_store_unavailable' ||
    input.video.missingReason === 'upload_incomplete'
  ) {
    return '存储失败，录像未能保存'
  }
  return null
}
