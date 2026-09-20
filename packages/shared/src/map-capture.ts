import { z } from 'zod'
import {
  MAP_FACT_MAX_BYTES,
  mapFactBatchItemSchema,
  mapObservationSchema,
  mapConditionSnapshotSchema,
  type MapConditionSnapshot,
  type MapFactBatchItem,
  type MapMissingReason,
  type MapObservation,
  type MapObservationPhase,
  type MapRunSourceType,
  type MapSourceType,
  type MapViewport,
} from './map-c0.js'
import { entityIdSchema } from './wire.js'

export const MAP_COLLECTOR_VERSION = 'map-collector@1'
export const MAP_REDACTION_REVISION = 'map-redaction@1'
export const MAP_CAPTURE_POLICY_SCHEMA_VERSION = 1 as const
export const MAP_CAPTURE_MAX_NODES = 100
export const MAP_CAPTURE_PHASE_BUDGET_MS = 250
export const MAP_CAPTURE_RUN_BUDGET_MS = 2_000

export const mapCapturePolicySchema = z.strictObject({
  enabled: z.boolean(),
  schemaVersion: z.literal(MAP_CAPTURE_POLICY_SCHEMA_VERSION),
  collectorVersion: z
    .string()
    .regex(/^[A-Za-z0-9.@_-]{1,64}$/)
    .default(MAP_COLLECTOR_VERSION),
  redactionRevision: z
    .string()
    .regex(/^[A-Za-z0-9.@_-]{1,64}$/)
    .default(MAP_REDACTION_REVISION),
  maxNodes: z.number().int().min(1).max(1_000).default(MAP_CAPTURE_MAX_NODES),
  maxBytes: z.number().int().min(1).max(MAP_FACT_MAX_BYTES).default(MAP_FACT_MAX_BYTES),
  phaseBudgetMs: z.number().int().min(1).max(5_000).default(MAP_CAPTURE_PHASE_BUDGET_MS),
  runBudgetMs: z.number().int().min(1).max(60_000).default(MAP_CAPTURE_RUN_BUDGET_MS),
  captureScreenshots: z.literal(false).default(false),
})
export type MapCapturePolicy = z.infer<typeof mapCapturePolicySchema>

export const FACTORY_MAP_CAPTURE_POLICY: MapCapturePolicy = mapCapturePolicySchema.parse({
  enabled: false,
  schemaVersion: MAP_CAPTURE_POLICY_SCHEMA_VERSION,
})

export const mapCapturePolicyOverrideSchema = mapCapturePolicySchema.partial().extend({
  schemaVersion: z.literal(MAP_CAPTURE_POLICY_SCHEMA_VERSION).optional(),
  captureScreenshots: z.literal(false).optional(),
})
export type MapCapturePolicyOverride = z.infer<typeof mapCapturePolicyOverrideSchema>

export function resolveMapCapturePolicy(
  override: MapCapturePolicyOverride | null | undefined,
  platform: MapCapturePolicy = FACTORY_MAP_CAPTURE_POLICY,
): MapCapturePolicy {
  return mapCapturePolicySchema.parse({
    ...platform,
    ...override,
    schemaVersion: MAP_CAPTURE_POLICY_SCHEMA_VERSION,
    captureScreenshots: false,
    enabled: override?.enabled ?? platform.enabled,
  })
}

export function isMapCaptureEnabled(snapshot: { mapCapturePolicy?: MapCapturePolicy }): boolean {
  return snapshot.mapCapturePolicy?.enabled === true
}

export function mapRunSourceType(kind: string | undefined): MapRunSourceType {
  return kind === 'trial' ? 'trial' : 'formal_run'
}

function technicalKey(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9:._-]/g, '-').replace(/-+/g, '-')
  return cleaned.length >= 8 ? cleaned.slice(0, 192) : `${cleaned}........`.slice(0, 8)
}

export function mapRunFactKey(input: {
  runId: string
  phase: MapObservationPhase
  attemptId?: string
  stepRunId?: string
}): string {
  if (input.phase === 'step_skipped') {
    return technicalKey(`run:${input.runId}:step:${input.stepRunId ?? 'none'}:skipped`)
  }
  return technicalKey(`run:${input.runId}:attempt:${input.attemptId ?? 'none'}:${input.phase}:0`)
}

export function mapRecordingFactKey(input: {
  recordingId: string
  sourceVersion: string
  originalEventIndex: number
}): string {
  return technicalKey(`rec:${input.recordingId}:${input.sourceVersion}:${input.originalEventIndex}`)
}

export function mapConditionSnapshot(input: {
  targetId: string
  targetAccountId?: string | null
}): MapConditionSnapshot {
  if (input.targetAccountId) {
    return {
      targetId: input.targetId,
      accountBinding: { presence: 'known', targetAccountId: input.targetAccountId },
      unknownFields: ['permissionProfile', 'workspace', 'locale', 'viewport', 'featureVersion'],
    }
  }
  return {
    targetId: input.targetId,
    accountBinding: { presence: 'unknown' },
    unknownFields: [
      'targetAccount',
      'permissionProfile',
      'workspace',
      'locale',
      'viewport',
      'featureVersion',
    ],
  }
}

export function enrichMapCondition(
  base: MapConditionSnapshot,
  extra: { locale?: string; viewport?: MapViewport },
): MapConditionSnapshot {
  const unknown = new Set(base.unknownFields)
  const next: MapConditionSnapshot = { ...base, unknownFields: [...unknown] }
  const locale = extra.locale?.trim().slice(0, 64)
  if (locale) {
    next.locale = locale
    unknown.delete('locale')
  }
  if (extra.viewport) {
    next.viewport = extra.viewport
    unknown.delete('viewport')
  }
  next.unknownFields = [...unknown]
  return mapConditionSnapshotSchema.parse(next)
}

export function mapObservationShell(input: {
  id: string
  targetId: string
  sourceType: MapSourceType
  sourceRef: MapObservation['sourceRef']
  phase: MapObservationPhase
  dedupeKey: string
  sourceEventKey?: string
  collectorVersion?: string
  observedAt?: string
  captureStatus: MapObservation['captureStatus']
  captureReason?: MapMissingReason
  missingReasons?: MapMissingReason[]
  completeness?: MapObservation['completeness']
  truncated?: boolean
  topUrlPattern?: string
  conditionSnapshot?: MapConditionSnapshot
  framePath?: MapObservation['framePath']
  originChain?: MapObservation['originChain']
  surfaceCapability?: MapObservation['surfaceCapability']
  regionRefs?: MapObservation['regionRefs']
  nodeSetKind?: MapObservation['nodeSetKind']
  stateSummary?: MapObservation['stateSummary']
  semanticSummary?: MapObservation['semanticSummary']
  structuralSummary?: MapObservation['structuralSummary']
  actionRef?: MapObservation['actionRef']
}): MapObservation {
  const missing =
    input.missingReasons ??
    (input.captureReason
      ? [input.captureReason]
      : input.captureStatus === 'missing'
        ? (['PROCESS_LOST'] as MapMissingReason[])
        : [])
  return mapObservationSchema.parse({
    id: input.id,
    schemaVersion: 1,
    targetId: input.targetId,
    dedupeKey: input.dedupeKey,
    observedAt: input.observedAt ?? new Date().toISOString(),
    collectorVersion: input.collectorVersion ?? MAP_COLLECTOR_VERSION,
    sourceType: input.sourceType,
    sourceRef: input.sourceRef,
    phase: input.phase,
    localSequence: 0,
    sourceEventKey: input.sourceEventKey ?? input.dedupeKey,
    conditionSnapshot: input.conditionSnapshot ?? mapConditionSnapshot({ targetId: input.targetId }),
    topUrlPattern: input.topUrlPattern ?? 'https://unknown.invalid/',
    framePath: input.framePath ?? [],
    originChain: input.originChain ?? [],
    surfaceCapability: input.surfaceCapability ?? {
      frames: 'unknown',
      a11y: 'unknown',
      canvas: 'unknown',
      shadow: 'unknown',
    },
    regionRefs: input.regionRefs ?? [{ key: 'action', kind: 'action_object' }],
    nodeSetKind: input.nodeSetKind ?? 'unknown',
    completeness: input.completeness ?? (input.captureStatus === 'observed' ? 'partial' : 'none'),
    truncated: input.truncated ?? input.captureStatus !== 'observed',
    missingReasons: missing,
    semanticSummary: input.semanticSummary ?? { predicates: [] },
    stateSummary: input.stateSummary ?? { regions: {} },
    structuralSummary: input.structuralSummary ?? { nodeCount: 0, truncated: true },
    evidenceRefs: [],
    captureStatus: input.captureStatus,
    ...(input.captureReason ? { captureReason: input.captureReason } : {}),
    ...(input.actionRef ? { actionRef: input.actionRef } : {}),
  })
}

export function mapGapObservation(
  input: Omit<Parameters<typeof mapObservationShell>[0], 'captureStatus'> & { reason: MapMissingReason },
): MapObservation {
  return mapObservationShell({
    ...input,
    captureStatus: input.phase === 'step_skipped' ? 'skipped' : 'missing',
    captureReason: input.reason,
    missingReasons: [input.reason],
    completeness: 'none',
    truncated: true,
  })
}

export const finishAttemptMapFactsSchema = z.array(mapFactBatchItemSchema).max(20)
export type FinishAttemptMapFact = MapFactBatchItem

export const createRecordingMapIngestSchema = z.strictObject({
  recordingDraftId: entityIdSchema,
})
