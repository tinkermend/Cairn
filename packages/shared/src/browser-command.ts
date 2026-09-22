import { z } from 'zod'
import { evidenceCaptureModeSchema } from './evidence-policy.js'
import { screenshotViewportSchema, sensitiveSelectorsSchema } from './evidence-slots.js'
import { executionErrorSchema } from './runtime-error.js'
import { objectContentTypeSchema, objectDigestSchema, objectKeySchema } from './object-store.js'
import { pageAfterSchema } from './managed-browser.js'
import { locatorCandidateSchema, targetDescriptorSchema } from './target-descriptor.js'
import { healingPatchSchema } from './healer.js'
import { jsonValueSchema, utcInstantSchema } from './wire.js'

export const RESOLVER_OUTCOMES = [
  'FOUND',
  'NOT_FOUND',
  'AMBIGUOUS',
  'SURFACE_LOST',
  'CAPABILITY_MISSING',
] as const
export type ResolverOutcome = (typeof RESOLVER_OUTCOMES)[number]
export const resolverOutcomeSchema = z.enum(RESOLVER_OUTCOMES)

export const BROWSER_STEP_ERROR_CODES = [
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'SURFACE_LOST',
  'ASSERT_FAILED',
  'ASSERT_TEMPLATE_INVALID',
  'BROWSER_CAPABILITY_MISSING',
  'NAVIGATE_OUT_OF_SCOPE',
  'SESSION_LEASE_LOST',
  'PAGE_HANDOFF_NO_POPUP',
  'PAGE_HANDOFF_AMBIGUOUS',
  'PAGE_HANDOFF_OUT_OF_SCOPE',
  'PAGE_HANDOFF_CLOSED',
  'DOWNLOAD_TIMEOUT',
  'DOWNLOAD_FAILED',
  'DOWNLOAD_REJECTED',
  'DOWNLOAD_TOO_LARGE',
  'FIXTURE_NOT_FOUND',
  'FIXTURE_DIGEST_MISMATCH',
  'FILE_HANDLE_INVALID',
  'FILE_HANDLE_FOREIGN_RUN',
  'FILE_OBJECT_UNAVAILABLE',
  'UPLOAD_PAYLOAD_TOO_LARGE',
  'UPLOAD_NO_FILE_INPUT',
  'UPLOAD_TARGET_NOT_FILE_INPUT',
  'UPLOAD_TARGET_SINGLE_ONLY',
  'UPLOAD_PRECONDITION_FAILED',
  'UPLOAD_FILE_CHOOSER_TIMEOUT',
  'FIXTURE_SIZE_EXCEEDED',
] as const
export type BrowserStepErrorCode = (typeof BROWSER_STEP_ERROR_CODES)[number]

export const EXTRACT_AS = ['text', 'value', 'attribute'] as const
export type ExtractAs = (typeof EXTRACT_AS)[number]

export const ASSERT_KINDS = ['exists', 'visible', 'text_equals', 'text_contains', 'number_compare', 'aria_snapshot'] as const
export type AssertKind = (typeof ASSERT_KINDS)[number]

export const NUMBER_COMPARE_OPS = ['eq', 'gt', 'gte', 'lt', 'lte'] as const
export type NumberCompareOp = (typeof NUMBER_COMPARE_OPS)[number]

export const assertExpectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('exists') }),
  z.strictObject({ kind: z.literal('visible') }),
  z.strictObject({ kind: z.literal('text_equals'), value: z.string().max(2048) }),
  z.strictObject({ kind: z.literal('text_contains'), value: z.string().min(1).max(2048) }),
  z.strictObject({
    kind: z.literal('number_compare'),
    op: z.enum(NUMBER_COMPARE_OPS),
    value: z.number().finite(),
  }),
  z.strictObject({
    kind: z.literal('aria_snapshot'),
    template: z.string().min(1).max(16384),
  }),
])
export type AssertExpect = z.infer<typeof assertExpectSchema>

/**
 * 纯文本脱敏处理：离开 Worker 内存的快照文本一律脱敏
 * 1. textbox / searchbox / spinbutton / combobox 的值替换为 ***
 * 2. 连续 >= 13 位的数字替换为 ***
 */
export function sanitizeAriaSnapshot(yaml: string): string {
  let sanitized = yaml.replace(
    /^(\s*-\s*(?:textbox|searchbox|spinbutton|combobox)(?:\s+["'][^"']*["'])?:\s*)(.+)$/gm,
    '$1***',
  )
  sanitized = sanitized.replace(/\b\d{13,}\b/g, '***')
  return sanitized
}

export const candidateTrySchema = z.strictObject({
  index: z.number().int().nonnegative(),
  by: z.string().min(1),
  value: z.string(),
  matches: z.number().int().nonnegative(),
})
export type CandidateTry = z.infer<typeof candidateTrySchema>

export const resolverDiagnosticsSchema = z.strictObject({
  outcome: resolverOutcomeSchema,
  candidatesTried: z.array(candidateTrySchema),
  framePathResolved: z.array(z.string()).optional(),
  resolvedVia: z.enum(['deterministic', 'map', 'ai']).optional(),
  suggestedCandidate: locatorCandidateSchema.optional(),
  suggestedPatch: healingPatchSchema.optional(),
})
export type ResolverDiagnostics = z.infer<typeof resolverDiagnosticsSchema>

export const resolvedUploadFileSchema = z.strictObject({
  /** Worker 本地绝对路径，磁盘文件名与 name 一致。 */
  localPath: z.string().min(1).max(4096),
  name: z.string().min(1).max(255),
  mimeType: objectContentTypeSchema,
  digest: objectDigestSchema,
  byteSize: z.number().int().nonnegative(),
})
export type ResolvedUploadFile = z.infer<typeof resolvedUploadFileSchema>

const originSchema = z.string().trim().min(1).max(256)

export const browserCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('navigate'),
    url: z.string().trim().min(1).max(2048),
    allowedOrigins: z.array(originSchema).min(1).max(16),
  }),
  z.strictObject({
    type: z.literal('click'),
    target: targetDescriptorSchema,
    pageAfter: pageAfterSchema.optional(),
    button: z.enum(['left', 'right', 'middle']).optional(),
    clickCount: z.union([z.literal(1), z.literal(2)]).optional(),
    modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
  }),
  z.strictObject({
    type: z.literal('fill'),
    target: targetDescriptorSchema,
    value: z.string().max(16_384),
  }),
  z.strictObject({
    type: z.literal('locate'),
    target: targetDescriptorSchema,
    timeoutMs: z.number().int().min(1).max(5_000).optional(),
  }),
  z.strictObject({
    type: z.literal('extract'),
    expectedTargetToken: z.string().uuid().optional(),
    target: targetDescriptorSchema,
    as: z.enum(EXTRACT_AS),
    attribute: z.string().trim().min(1).max(128).optional(),
  }),
  z.strictObject({
    type: z.literal('assert'),
    expectedTargetToken: z.string().uuid().optional(),
    target: targetDescriptorSchema.optional(),
    expect: assertExpectSchema,
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.strictObject({
    type: z.literal('select'),
    target: targetDescriptorSchema,
    by: z.enum(['label', 'value', 'index']),
    value: z.string().optional(),
    index: z.number().int().min(0).optional(),
  }),
  z.strictObject({
    type: z.literal('keyboard'),
    target: targetDescriptorSchema.optional(),
    keys: z.array(z.string().min(1).max(64)).min(1).max(4),
  }),
  z.strictObject({
    type: z.literal('wait'),
    kind: z.enum(['time', 'visible', 'hidden', 'url', 'text']),
    target: targetDescriptorSchema.optional(),
    urlPattern: z.string().trim().min(1).max(2048).optional(),
    text: z.string().min(1).max(1024).optional(),
    durationMs: z.number().int().positive().max(60_000).optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.strictObject({
    type: z.literal('upload'),
    expectedTargetToken: z.string().uuid().optional(),
    target: targetDescriptorSchema,
    files: z.array(resolvedUploadFileSchema).min(1).max(10),
  }),
  z.strictObject({
    type: z.literal('download'),
    expectedTargetToken: z.string().uuid().optional(),
    target: targetDescriptorSchema.optional(),
    waitMs: z.number().int().min(1_000).max(120_000),
    saveDir: z.string().min(1).max(4096),
    expect: z
      .strictObject({
        fileNamePattern: z.string().optional(),
        minBytes: z.number().int().optional(),
      })
      .optional(),
  }),
])
export type BrowserCommand = z.infer<typeof browserCommandSchema>

export const screenshotPointerSchema = z.strictObject({
  objectKey: objectKeySchema.optional(),
  contentType: objectContentTypeSchema.optional(),
  byteSize: z.number().int().nonnegative().optional(),
  digest: z.string().min(1).max(128).optional(),
  missingReason: z.string().min(1).max(512).optional(),
})
export type ScreenshotPointer = z.infer<typeof screenshotPointerSchema>

export const evidenceObjectPointerSchema = screenshotPointerSchema
export type EvidenceObjectPointer = ScreenshotPointer

export const browserCommandResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    resolvedTargetToken: z.string().uuid().optional(),
    output: jsonValueSchema,
    diagnostics: resolverDiagnosticsSchema.optional(),
    screenshot: screenshotPointerSchema.optional(),
    trace: evidenceObjectPointerSchema.optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: executionErrorSchema,
    output: jsonValueSchema.optional(),
    diagnostics: resolverDiagnosticsSchema.optional(),
    screenshot: screenshotPointerSchema.optional(),
    trace: evidenceObjectPointerSchema.optional(),
  }),
])
export type BrowserCommandResult = z.infer<typeof browserCommandResultSchema>

export const BROWSER_COMMAND_EVIDENCE = z.strictObject({
  runId: z.string().min(1),
  stepRunId: z.string().min(1),
  attemptId: z.string().min(1),
  screenshot: evidenceCaptureModeSchema.optional(),
  trace: evidenceCaptureModeSchema.optional(),
  screenshotRetainUntil: utcInstantSchema.optional(),
  traceRetainUntil: utcInstantSchema.optional(),
  commandType: z.string().min(1).max(32).optional(),
  screenshotViewport: screenshotViewportSchema.optional(),
  sensitiveSelectors: sensitiveSelectorsSchema.optional(),
})
export type BrowserCommandEvidence = z.infer<typeof BROWSER_COMMAND_EVIDENCE>
