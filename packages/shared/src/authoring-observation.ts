import { z } from 'zod'
import { resolverDiagnosticsSchema } from './browser-command.js'
import { pageRefSchema, type PageRef } from './managed-browser.js'
import { isSensitiveLocatorHay } from './sensitive-fill.js'
import { targetDescriptorSchema } from './target-descriptor.js'
import { entityIdSchema } from './wire.js'

export const TARGET_OBSERVATION_OUTCOMES = [
  'FOUND',
  'NOT_FOUND',
  'AMBIGUOUS',
  'SURFACE_LOST',
  'CAPABILITY_MISSING',
] as const
export type TargetObservationOutcome = (typeof TARGET_OBSERVATION_OUTCOMES)[number]
export const targetObservationOutcomeSchema = z.enum(TARGET_OBSERVATION_OUTCOMES)

export const targetAssistSchema = z.strictObject({
  explanation: z.string().max(1024).optional(),
  recommendedRanking: z.array(z.number().int().nonnegative()).optional(),
  suggestedStepName: z.string().max(128).optional(),
})
export type TargetAssist = z.infer<typeof targetAssistSchema>

export const targetObservationPreviewSchema = z.strictObject({
  box: z
    .strictObject({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
  tag: z.string().optional(),
  text: z.string().optional(),
  cropObjectKey: z.string().optional(),
})
export type TargetObservationPreview = z.infer<typeof targetObservationPreviewSchema>

export const targetObservationSchema = z.strictObject({
  outcome: targetObservationOutcomeSchema,
  target: targetDescriptorSchema.optional(),
  page: z.strictObject({
    pageRef: pageRefSchema.optional(),
    url: z.string().optional(),
    title: z.string().optional(),
  }),
  preview: targetObservationPreviewSchema.optional(),
  diagnostics: resolverDiagnosticsSchema,
  source: z.enum(['managed', 'extension']),
  alternatives: z
    .array(
      z.strictObject({
        index: z.number().int().nonnegative(),
        reason: z.string(),
      }),
    )
    .optional(),
  assist: targetAssistSchema.optional(),
})
export type TargetObservation = z.infer<typeof targetObservationSchema>

export const observeGrantSchema = z.strictObject({
  runId: entityIdSchema,
  sessionGeneration: z.number().int().nonnegative(),
  pageRef: pageRefSchema,
  epoch: z.number().int().nonnegative(),
})
export type ObserveGrant = z.infer<typeof observeGrantSchema>

export const observeOperationSchema = z.strictObject({
  op: z.enum(['highlight', 'pick']),
  x: z.number().optional(),
  y: z.number().optional(),
  target: targetDescriptorSchema.optional(),
  applyOverlay: z.boolean().optional(),
  clearOverlayStepId: entityIdSchema.optional(),
})
export type ObserveOperation = z.infer<typeof observeOperationSchema>

export const DEBUG_ACTIONS = ['retry_current', 'continue', 'stop', 'pause'] as const
export type DebugActionType = (typeof DEBUG_ACTIONS)[number]
export const debugActionSchema = z.strictObject({
  action: z.enum(DEBUG_ACTIONS),
  targetOverride: targetDescriptorSchema.optional(),
  fencingToken: z.string().min(1).optional(),
  confirmSideEffect: z.boolean().optional(),
  pageChangedAck: z.boolean().optional(),
})
export type DebugAction = z.infer<typeof debugActionSchema>

export const authoringObservationSubmitSchema = z.strictObject({
  targetId: entityIdSchema,
  url: z.string().trim().min(1).max(2048),
  title: z.string().max(512).optional(),
  target: targetDescriptorSchema.optional(),
  preview: targetObservationPreviewSchema.optional(),
  diagnostics: resolverDiagnosticsSchema.optional(),
})
export type AuthoringObservationSubmit = z.infer<typeof authoringObservationSubmitSchema>

export function pageIdentityChanged(
  checkpoint: { pageRef?: PageRef; url?: string },
  current?: { pageRef?: PageRef; url?: string } | null,
): boolean {
  if (!checkpoint.pageRef && !checkpoint.url) return false
  if (!current) return false
  if (checkpoint.pageRef && current.pageRef) {
    if (checkpoint.pageRef.pageId !== current.pageRef.pageId) return true
    if (checkpoint.pageRef.documentEpoch !== current.pageRef.documentEpoch) return true
  }
  if (checkpoint.url && current.url && checkpoint.url !== current.url) return true
  return false
}

export function observationShowsFragileCss(observation: { diagnostics?: { framePathResolved?: string[] } }): boolean {
  return observation.diagnostics?.framePathResolved?.includes('fragile-css') === true
}

export function normalizeAuthoringObservation(input: AuthoringObservationSubmit): TargetObservation {
  const candidates = input.target?.candidates ?? []
  const sanitized = candidates
    .filter((candidate) => !isSensitiveLocatorHay(`${candidate.by} ${candidate.value} ${candidate.name ?? ''}`))
    .map((candidate) => ({
      by: candidate.by,
      value: candidate.value.slice(0, 512),
      ...(candidate.name ? { name: candidate.name.slice(0, 256) } : {}),
    }))
  const css = sanitized.filter((candidate) => candidate.by === 'css')
  const rest = sanitized.filter((candidate) => candidate.by !== 'css')
  const ordered = [...rest, ...css.slice(0, 1)].slice(0, 5)
  const target =
    ordered.length > 0
      ? {
          framePath: (input.target?.framePath ?? []).slice(0, 4),
          candidates: ordered,
          ...(input.target?.anchor ? { anchor: input.target.anchor } : {}),
        }
      : undefined
  const outcome = target ? 'FOUND' : 'NOT_FOUND'
  return targetObservationSchema.parse({
    outcome,
    ...(target ? { target } : {}),
    page: { url: input.url, title: input.title },
    preview: input.preview,
    diagnostics: input.diagnostics ?? {
      outcome,
      candidatesTried: ordered.map((candidate, index) => ({
        index,
        by: candidate.by,
        value: candidate.value,
        matches: target ? 1 : 0,
      })),
    },
    source: 'extension',
  })
}

export const authoringCapabilitiesSchema = z.strictObject({
  indicate: z.enum(['open', 'closed']),
  highlight: z.enum(['open', 'closed']),
  debugHold: z.enum(['open', 'closed']),
  assist: z.enum(['open', 'closed']),
  stepTypesExtra: z.array(z.enum(['select', 'keyboard', 'wait'])),
})
export type AuthoringCapabilities = z.infer<typeof authoringCapabilitiesSchema>
