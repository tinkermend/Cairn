import { z } from 'zod'

export const RELIABILITY_SIGNAL_KINDS = [
  'resolution_fallback',
  'resolution_slow',
  'resolution_drift',
  'invariant_violation',
  'outcome_failure',
  'session_fault',
  'input_invalid',
  'structure_candidate',
] as const
export type ReliabilitySignalKind = (typeof RELIABILITY_SIGNAL_KINDS)[number]
export const reliabilitySignalKindSchema = z.enum(RELIABILITY_SIGNAL_KINDS)

export const RELIABILITY_SIGNAL_SEVERITIES = ['INFO', 'WARN', 'ERROR', 'CRITICAL'] as const
export type ReliabilitySignalSeverity = (typeof RELIABILITY_SIGNAL_SEVERITIES)[number]
export const reliabilitySignalSeveritySchema = z.enum(RELIABILITY_SIGNAL_SEVERITIES)

export const reliabilitySignalDtoSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  kind: reliabilitySignalKindSchema,
  severity: reliabilitySignalSeveritySchema,
  subjectRef: z.object({
    kind: z.enum(['map_object', 'module_step', 'scenario_step', 'run', 'outcome']),
    id: z.string(),
    objectId: z.string().optional(),
    stepId: z.string().optional(),
    moduleId: z.string().optional(),
    scenarioId: z.string().optional(),
  }),
  sourceRef: z.object({
    kind: z.enum(['run', 'attempt', 'map_observation', 'validation']),
    id: z.string(),
    runId: z.string().optional(),
    attemptId: z.string().optional(),
    stepRunId: z.string().optional(),
    revision: z.string().optional(),
  }),
  occurredAt: z.string(),
  commitPosition: z.number().optional(),
  value: z.number().optional(),
  unit: z.string().optional(),
  scopeDigest: z.string(),
  groupingKey: z.string().optional(),
  availability: z.enum(['available', 'missing', 'truncated']),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
})
export type ReliabilitySignalDto = z.infer<typeof reliabilitySignalDtoSchema>

export const FEATURE_WINDOW_TYPES = ['hourly', 'sliding_30_runs'] as const
export type FeatureWindowType = (typeof FEATURE_WINDOW_TYPES)[number]
export const featureWindowTypeSchema = z.enum(FEATURE_WINDOW_TYPES)

export const featureWindowDtoSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  scopeDigest: z.string(),
  windowType: featureWindowTypeSchema,
  windowStart: z.string(),
  windowEnd: z.string(),
  metricVersion: z.string(),
  sampleCount: z.number(),
  primaryHitCount: z.number(),
  fallbackCount: z.number(),
  retryStepCount: z.number(),
  ewmaLatencyMs: z.number(),
  ewmaSuccessRate: z.number(),
  stats: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
})
export type FeatureWindowDto = z.infer<typeof featureWindowDtoSchema>

export const BASELINE_KINDS = ['structural', 'behavioral', 'business', 'input_quality'] as const
export type BaselineKind = (typeof BASELINE_KINDS)[number]
export const baselineKindSchema = z.enum(BASELINE_KINDS)

export const baselineRevisionDtoSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  scopeDigest: z.string(),
  baselineKind: baselineKindSchema,
  algorithmVersion: z.string(),
  sampleFloor: z.number(),
  stats: z.record(z.string(), z.unknown()),
  status: z.enum(['ready', 'insufficient', 'unavailable']),
  excludedReasons: z.array(z.string()).optional(),
  createdAt: z.string(),
})
export type BaselineRevisionDto = z.infer<typeof baselineRevisionDtoSchema>

export const watermarkVectorSchema = z.object({
  runCompletedSeq: z.number(),
  mapCommittedSeq: z.number(),
  validationSeq: z.number(),
})
export type WatermarkVector = z.infer<typeof watermarkVectorSchema>

export const reliabilityEvaluationDtoSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  scopeDigest: z.string(),
  watermarkVector: watermarkVectorSchema,
  generation: z.number(),
  rulesEvaluated: z.number(),
  breachesCount: z.number(),
  result: z.record(z.string(), z.unknown()),
  coverageGaps: z.array(z.string()),
  createdAt: z.string(),
})
export type ReliabilityEvaluationDto = z.infer<typeof reliabilityEvaluationDtoSchema>

export const MAP_CHANGE_CANDIDATE_STATUSES = ['pending', 'confirmed', 'rejected', 'inconclusive', 'superseded'] as const
export type MapChangeCandidateStatus = (typeof MAP_CHANGE_CANDIDATE_STATUSES)[number]
export const mapChangeCandidateStatusSchema = z.enum(MAP_CHANGE_CANDIDATE_STATUSES)

export const mapChangeCandidateDtoSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  assetRef: z.record(z.string(), z.unknown()),
  beforeRef: z.record(z.string(), z.unknown()).optional(),
  afterRef: z.record(z.string(), z.unknown()).optional(),
  changeLevel: z.enum(['L1_structure', 'L2_object', 'L3_route']),
  conditions: z.record(z.string(), z.unknown()),
  observationsCount: z.number(),
  status: mapChangeCandidateStatusSchema,
  evidenceScore: z.number().optional(),
  counterEvidenceScore: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type MapChangeCandidateDto = z.infer<typeof mapChangeCandidateDtoSchema>

export const INCIDENT_STATUSES = [
  'DETECTED',
  'DIAGNOSING',
  'ACTION_REQUIRED',
  'VERIFYING',
  'OBSERVING',
  'RESOLVED',
  'DISMISSED',
] as const
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number]
export const incidentStatusSchema = z.enum(INCIDENT_STATUSES)

export const INCIDENT_SEVERITIES = ['P1', 'P2', 'P3', 'P4'] as const
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number]
export const incidentSeveritySchema = z.enum(INCIDENT_SEVERITIES)

export const evidenceScoresSchema = z.object({
  supportingScore: z.number(),
  counterScore: z.number(),
  supportingFactors: z.array(z.string()),
  counterFactors: z.array(z.string()),
})
export type EvidenceScores = z.infer<typeof evidenceScoresSchema>

export const incidentLineageSchema = z.object({
  mergedFrom: z.array(z.string()).optional(),
  splitFrom: z.string().optional(),
  parentIncidentId: z.string().optional(),
  targetId: z.string().optional(),
  targetName: z.string().optional(),
  scenarioId: z.string().optional(),
  scenarioName: z.string().optional(),
  stepId: z.string().optional(),
  stepName: z.string().optional(),
})
export type IncidentLineage = z.infer<typeof incidentLineageSchema>

export const reliabilityIncidentDtoSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  groupingKey: z.string(),
  scopeDigest: z.string(),
  severity: incidentSeveritySchema,
  status: incidentStatusSchema,
  actionRequiredReason: z.string().optional(),
  memberCount: z.number(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  title: z.string(),
  summary: z.string(),
  rootCauseHypothesis: z.string().optional(),
  evidenceScores: evidenceScoresSchema,
  silencedUntil: z.string().optional(),
  dismissedReason: z.string().optional(),
  lineage: incidentLineageSchema.optional(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ReliabilityIncidentDto = z.infer<typeof reliabilityIncidentDtoSchema>

export const reliabilityIncidentMemberDtoSchema = z.object({
  id: z.string(),
  incidentId: z.string(),
  memberRef: z.string(),
  memberType: z.string(),
  joinedAt: z.string(),
})
export type ReliabilityIncidentMemberDto = z.infer<typeof reliabilityIncidentMemberDtoSchema>

export const reliabilityPolicyDtoSchema = z.object({
  minComparableSamples: z.number().default(10),
  observationWindowDays: z.number().default(14),
  ewmaAlpha: z.number().default(0.2),
  primaryHitRateThreshold: z.number().default(0.85),
  fallbackRateThreshold: z.number().default(0.15),
  latencyIncreaseRatioThreshold: z.number().default(1.5),
})
export type ReliabilityPolicyDto = z.infer<typeof reliabilityPolicyDtoSchema>

export const DEFAULT_RELIABILITY_POLICY: ReliabilityPolicyDto = {
  minComparableSamples: 10,
  observationWindowDays: 14,
  ewmaAlpha: 0.2,
  primaryHitRateThreshold: 0.85,
  fallbackRateThreshold: 0.15,
  latencyIncreaseRatioThreshold: 1.5,
}

export const RELIABILITY_ERROR_CODES = {
  INCIDENT_NOT_FOUND: 'INCIDENT_NOT_FOUND',
  INCIDENT_REVISION_CONFLICT: 'INCIDENT_REVISION_CONFLICT',
  INCIDENT_INVALID_STATUS_TRANSITION: 'INCIDENT_INVALID_STATUS_TRANSITION',
  EVALUATION_ACTIVE_EXISTS: 'EVALUATION_ACTIVE_EXISTS',
  EVALUATION_LEASE_EXPIRED: 'EVALUATION_LEASE_EXPIRED',
  INSUFFICIENT_SAMPLES: 'INSUFFICIENT_SAMPLES',
  UPGRADE_JOB_NOT_FOUND: 'UPGRADE_JOB_NOT_FOUND',
  NO_UPGRADEABLE_SCENARIOS: 'NO_UPGRADEABLE_SCENARIOS',
} as const

export const reliabilityIncidentListQuerySchema = z.object({
  targetId: z.string().uuid().optional(),
  status: incidentStatusSchema.optional(),
  severity: incidentSeveritySchema.optional(),
  assetKind: z.enum(['scenario', 'action_module']).optional(),
  assetId: z.string().optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type ReliabilityIncidentListQuery = z.infer<typeof reliabilityIncidentListQuerySchema>

export const reliabilityIncidentListResponseSchema = z.object({
  items: z.array(reliabilityIncidentDtoSchema),
  nextCursor: z.string().nullable().optional(),
  total: z.number().optional(),
})
export type ReliabilityIncidentListResponse = z.infer<typeof reliabilityIncidentListResponseSchema>

export const incidentSignalsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type IncidentSignalsQuery = z.infer<typeof incidentSignalsQuerySchema>

export const incidentSignalsListResponseSchema = z.object({
  items: z.array(reliabilitySignalDtoSchema),
  nextCursor: z.string().nullable().optional(),
  total: z.number().optional(),
})
export type IncidentSignalsListResponse = z.infer<typeof incidentSignalsListResponseSchema>

export const ASSET_RELIABILITY_STATUSES = ['healthy', 'degraded', 'insufficient_data'] as const
export type AssetReliabilityStatus = (typeof ASSET_RELIABILITY_STATUSES)[number]
export const assetReliabilityStatusSchema = z.enum(ASSET_RELIABILITY_STATUSES)

export const assetReliabilityItemSchema = z.object({
  assetId: z.string(),
  assetType: z.enum(['scenario', 'action_module']),
  assetName: z.string(),
  targetId: z.string(),
  targetName: z.string(),
  sampleCount: z.number(),
  ewmaSuccessRate: z.number().nullable(),
  p95DurationMs: z.number().nullable(),
  activeIncidentsCount: z.number(),
  highestSeverity: incidentSeveritySchema.nullable(),
  lastEvaluatedAt: z.string(),
  status: assetReliabilityStatusSchema,
})
export type AssetReliabilityItemDto = z.infer<typeof assetReliabilityItemSchema>

export const assetReliabilityQuerySchema = z.object({
  targetId: z.string().uuid().optional(),
  assetType: z.enum(['scenario', 'action_module']).optional(),
  status: assetReliabilityStatusSchema.optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type AssetReliabilityQuery = z.infer<typeof assetReliabilityQuerySchema>

export const assetReliabilityListResponseSchema = z.object({
  items: z.array(assetReliabilityItemSchema),
  nextCursor: z.string().nullable().optional(),
  total: z.number().optional(),
})
export type AssetReliabilityListResponse = z.infer<typeof assetReliabilityListResponseSchema>

export const mergeIncidentBodySchema = z.object({
  targetIncidentId: z.string().uuid(),
})
export type MergeIncidentBody = z.infer<typeof mergeIncidentBodySchema>

export const splitIncidentBodySchema = z.object({
  memberIds: z.array(z.string()).min(1),
  newTitle: z.string().min(1).optional(),
})
export type SplitIncidentBody = z.infer<typeof splitIncidentBodySchema>

export const dismissIncidentBodySchema = z.object({
  reason: z.string().min(1),
})
export type DismissIncidentBody = z.infer<typeof dismissIncidentBodySchema>

export const silenceIncidentBodySchema = z.object({
  durationHours: z.number().int().min(1).max(720),
  reason: z.string().min(1),
})
export type SilenceIncidentBody = z.infer<typeof silenceIncidentBodySchema>

export const resolveIncidentBodySchema = z.object({
  reason: z.string().min(1, '请输入解决/归档原因'),
  expectedRevision: z.number().int().optional(),
})
export type ResolveIncidentBody = z.infer<typeof resolveIncidentBodySchema>

export const triggerEvaluationBodySchema = z.object({
  policy: reliabilityPolicyDtoSchema.optional(),
})
export type TriggerEvaluationBody = z.infer<typeof triggerEvaluationBodySchema>

// ==================== RI-03 Phase 3.1: 依赖影响分析与集中维护 ====================

export const impactedAssetSchema = z.object({
  assetKind: z.enum(['scenario', 'action_module']),
  assetId: z.string(),
  assetName: z.string(),
  targetId: z.string(),
  moduleId: z.string(),
  moduleName: z.string(),
  currentBindingVersionId: z.string(),
  currentBindingVersionNo: z.number(),
  targetVersionId: z.string(),
  targetVersionNo: z.number(),
  relation: z.enum(['confirmed', 'possible', 'coverage_gap']),
  gapReason: z.enum(['legacy_missing_manifest', 'unsupported_structure', 'scan_truncated']).optional(),
  upgradeStatus: z.enum(['upgradeable', 'blocked', 'already_latest', 'conflict']),
  blockerReason: z.string().optional(),
  invocationLocations: z.array(
    z.object({
      invocationId: z.string(),
      stepId: z.string().optional(),
      stepName: z.string().optional(),
    }),
  ),
})
export type ImpactedAssetDto = z.infer<typeof impactedAssetSchema>

export const incidentImpactRunSchema = z.object({
  runId: z.string(),
  stepRunId: z.string().optional(),
  attemptId: z.string().optional(),
  occurredAt: z.string(),
  executionStatus: z.string(),
  failureReason: z.string().optional(),
})
export type IncidentImpactRunDto = z.infer<typeof incidentImpactRunSchema>

export const incidentImpactSummarySchema = z.object({
  totalScenarios: z.number(),
  confirmedCount: z.number(),
  possibleCount: z.number(),
  gapsCount: z.number(),
  upgradeableCount: z.number(),
  blockedCount: z.number(),
  alreadyLatestCount: z.number(),
})
export type IncidentImpactSummaryDto = z.infer<typeof incidentImpactSummarySchema>

export const incidentImpactSnapshotSchema = z.object({
  incidentId: z.string(),
  targetId: z.string(),
  calculatedAt: z.string(),
  impactedRuns: z.array(incidentImpactRunSchema),
  affectedAssets: z.array(impactedAssetSchema),
  summary: incidentImpactSummarySchema,
})
export type IncidentImpactSnapshotDto = z.infer<typeof incidentImpactSnapshotSchema>

export const batchUpgradeBodySchema = z.object({
  moduleId: z.string().uuid(),
  toVersionId: z.string().uuid(),
  scenarioIds: z.array(z.string().uuid()).min(1),
  idempotencyKey: z.string().min(1),
})
export type BatchUpgradeBody = z.infer<typeof batchUpgradeBodySchema>

export const upgradeJobResultSchema = z.object({
  scenarioId: z.string(),
  scenarioName: z.string().optional(),
  status: z.enum(['upgraded', 'conflict', 'skipped', 'error']),
  code: z.string().optional(),
  reason: z.string().optional(),
})
export type UpgradeJobResult = z.infer<typeof upgradeJobResultSchema>

export const maintenanceUpgradeJobSchema = z.object({
  jobId: z.string(),
  incidentId: z.string(),
  targetId: z.string(),
  moduleId: z.string(),
  toVersionId: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'partial_failure']),
  results: z.array(upgradeJobResultSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type MaintenanceUpgradeJobDto = z.infer<typeof maintenanceUpgradeJobSchema>

