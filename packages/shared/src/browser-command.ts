import { z } from 'zod'
import { evidenceCaptureModeSchema } from './evidence-policy.js'
import { executionErrorSchema } from './runtime-error.js'
import { objectContentTypeSchema, objectKeySchema } from './object-store.js'
import { pageAfterSchema } from './managed-browser.js'
import { targetDescriptorSchema } from './target-descriptor.js'
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
  'BROWSER_CAPABILITY_MISSING',
  'NAVIGATE_OUT_OF_SCOPE',
  'SESSION_LEASE_LOST',
  'PAGE_HANDOFF_NO_POPUP',
  'PAGE_HANDOFF_AMBIGUOUS',
  'PAGE_HANDOFF_OUT_OF_SCOPE',
  'PAGE_HANDOFF_CLOSED',
] as const
export type BrowserStepErrorCode = (typeof BROWSER_STEP_ERROR_CODES)[number]

export const EXTRACT_AS = ['text', 'value', 'attribute'] as const
export type ExtractAs = (typeof EXTRACT_AS)[number]

export const ASSERT_KINDS = ['exists', 'visible', 'text_equals', 'text_contains', 'number_compare'] as const
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
])
export type AssertExpect = z.infer<typeof assertExpectSchema>

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
})
export type ResolverDiagnostics = z.infer<typeof resolverDiagnosticsSchema>

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
    type: z.literal('extract'),
    target: targetDescriptorSchema,
    as: z.enum(EXTRACT_AS),
    attribute: z.string().trim().min(1).max(128).optional(),
  }),
  z.strictObject({
    type: z.literal('assert'),
    target: targetDescriptorSchema.optional(),
    expect: assertExpectSchema,
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
})
export type BrowserCommandEvidence = z.infer<typeof BROWSER_COMMAND_EVIDENCE>
