import { z } from 'zod'
import { permissionCodeSchema, type PermissionCode } from './rbac.js'
import {
  assistantStageSchema,
  assistantTurnSchema,
  contextItemScopeSchema,
  type AssistantCapabilityId,
  type AssistantStage,
  type AssistantTurn,
  type ContextItemScope,
} from './assistant.js'

export type CapabilityId = string
export type VersionTag = string
export type SchemaRef = string

export const capabilityDescriptorSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  label: z.string().min(1),
  purpose: z.string().min(1),
  notApplicable: z.array(z.string()),
  requiredPermissions: z.array(permissionCodeSchema),
  inputSchemaRef: z.string().min(1),
  outputSchemaRef: z.string().min(1),
  contextProfileRef: z.string().min(1),
  executionMode: z.enum(['single_turn', 'task']),
  sideEffect: z.enum(['read_only', 'draft_change', 'execution_request']),
  allowedTools: z.array(z.strictObject({ toolId: z.string(), version: z.string() })),
  policyRef: z.string().min(1),
  promptRef: z.strictObject({ id: z.string(), version: z.string() }).nullable(),
  validatorRefs: z.array(z.string()),
  intentMatchers: z.array(
    z.strictObject({
      kind: z.enum(['regex', 'keyword']),
      pattern: z.string(),
    }),
  ),
  slotBindings: z.array(
    z.strictObject({
      slot: z.string(),
      from: z.enum(['pageContext', 'question']),
      key: z.string(),
      required: z.boolean(),
    }),
  ),
  requiredContextKeys: z.array(z.string()),
  internal: z.boolean().optional(),
})
export type CapabilityDescriptor = z.infer<typeof capabilityDescriptorSchema>

export const toolDescriptorSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  paramsSchemaRef: z.string().min(1),
  resultSchemaRef: z.string().min(1),
  scope: z.enum(['platform', 'target', 'scenario', 'run']),
  category: z.enum(['read', 'draft_change', 'execution_request']),
  idempotency: z.enum(['not_required', 'key_required']),
  requiredPermissions: z.array(permissionCodeSchema),
  preconditions: z.array(z.string()),
  errorClasses: z.array(z.string()),
  resultUnknownQuery: z.string().nullable(),
})
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>

export const guardrailsSchema = z.strictObject({
  maxWallClockMs: z.number().int().positive(),
  maxRepairRetries: z.number().int().nonnegative(),
  maxNoProgressRounds: z.number().int().positive().optional(),
  maxConsecutiveToolFailures: z.number().int().positive().optional(),
  maxModelCalls: z.number().int().positive().optional(),
})
export type Guardrails = z.infer<typeof guardrailsSchema>

export const hardLimitsSchema = z.strictObject({
  contextWindowTokens: z.number().int().positive(),
  maxRequestBytes: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive(),
})
export type HardLimits = z.infer<typeof hardLimitsSchema>

export const capabilityPolicySchema = z.strictObject({
  id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  modelRoute: z.array(
    z.strictObject({
      purpose: z.string(),
      modelRef: z.string(),
    }),
  ),
  turnGuardrails: guardrailsSchema,
  taskGuardrails: guardrailsSchema.optional(),
  hardLimits: hardLimitsSchema,
  allowUserExtend: z.boolean(),
})
export type CapabilityPolicy = z.infer<typeof capabilityPolicySchema>

export const capabilityAvailabilitySchema = z.strictObject({
  id: z.string(),
  version: z.string(),
  available: z.boolean(),
  reason: z.enum(['missing_permission', 'missing_config', 'version_unsupported', 'disabled']).optional(),
  missingPermissions: z.array(permissionCodeSchema),
  requiredContextKeys: z.array(z.string()),
})
export type CapabilityAvailability = z.infer<typeof capabilityAvailabilitySchema>

export const ownerRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('assistant_turn'), turnId: z.string() }),
  z.strictObject({ kind: z.literal('assistant_task'), taskId: z.string(), turnId: z.string() }),
  z.strictObject({ kind: z.literal('analysis_attempt'), jobId: z.string(), attemptId: z.string() }),
  z.strictObject({ kind: z.literal('run_attempt'), runId: z.string(), stepRunId: z.string(), attemptId: z.string() }),
])
export type OwnerRef = z.infer<typeof ownerRefSchema>

export const invocationContextSchema = z.strictObject({
  callId: z.string(),
  ownerRef: ownerRefSchema,
  actorRef: z.strictObject({
    accountId: z.string(),
    permissions: z.array(permissionCodeSchema),
  }),
  resourceScope: z.strictObject({
    targetIds: z.array(z.string()),
    runIds: z.array(z.string()).optional(),
    scenarioIds: z.array(z.string()).optional(),
  }),
  deadlineAt: z.string(),
  remainingTurn: guardrailsSchema,
  remainingTask: guardrailsSchema.optional(),
  hardLimits: hardLimitsSchema,
  policyRevision: z.number().int(),
})
export type InvocationContext = z.infer<typeof invocationContextSchema> & {
  signal?: AbortSignal
}

export const modelInvocationRecordSchema = z.strictObject({
  callId: z.string(),
  ownerRef: ownerRefSchema,
  purpose: z.string(),
  capabilityVersion: z.string(),
  promptVersion: z.string().nullable(),
  policyRevision: z.number().int(),
  contextManifestId: z.string().nullable(),
  requestedModel: z.string(),
  actualModel: z.string().nullable(),
  route: z.string().nullable(),
  usage: z.union([
    z.strictObject({ inputTokens: z.number().optional(), outputTokens: z.number().optional() }),
    z.literal('unknown'),
  ]),
  cost: z.union([
    z.strictObject({ amount: z.number(), currency: z.string() }),
    z.literal('unknown'),
  ]),
  durationMs: z.number(),
  errorClass: z.enum(['none', 'provider_unsupported', 'timeout', 'cancelled', 'invalid_output', 'provider_error']),
  validation: z.strictObject({
    schemaOk: z.boolean(),
    grounded: z.union([z.boolean(), z.literal('not_checked')]),
    finishReason: z.string().max(64).optional(),
    issue: z.string().max(160).optional(),
  }),
  note: z.string().optional(),
})
export type ModelInvocationRecord = z.infer<typeof modelInvocationRecordSchema>

export const contextProfileSchema = z.strictObject({
  id: z.string(),
  version: z.string(),
  capabilityId: z.string(),
  allowedSources: z.array(
    z.enum([
      'run',
      'step_run',
      'attempt',
      'evidence',
      'scenario_draft',
      'scenario_version',
      'module',
      'map',
      'dataset',
      'batch',
    ]),
  ),
  requiredFacts: z.array(z.string()),
  optionalFacts: z.array(z.string()),
  selection: z.strictObject({
    strategy: z.literal('required_first'),
    rankers: z.array(z.enum(['recency', 'keyword', 'semantic'])),
  }),
  hardLimits: hardLimitsSchema,
  evidenceTools: z.array(z.string()),
})
export type ContextProfile = z.infer<typeof contextProfileSchema>

export { contextItemScopeSchema, type ContextItemScope }

export const contextFactKindSchema = z.enum([
  'observed',
  'human_confirmed',
  'inferred',
  'user_supplied_unverified',
])
export type ContextFactKind = z.infer<typeof contextFactKindSchema>

export const contextCoverageSchema = z.strictObject({
  scopeRange: z.string(),
  filterSnapshot: z.record(z.string(), z.unknown()).optional(),
  nextCursor: z.string().nullable().optional(),
  timeWindow: z
    .strictObject({
      startAt: z.string().optional(),
      endAt: z.string().optional(),
    })
    .optional(),
  status: z.enum(['complete', 'partial', 'unknown']),
  completenessBasis: z.string(),
  unreadReason: z.string().optional(),
})
export type ContextCoverage = z.infer<typeof contextCoverageSchema>

export const contextItemSchema = z.strictObject({
  sourceRef: z.strictObject({
    kind: z.string(),
    id: z.string(),
    revision: z.union([z.string(), z.number()]),
    fragment: z.string().optional(),
  }),
  scope: z.union([
    contextItemScopeSchema,
    z
      .strictObject({
        targetId: z.string(),
        runId: z.string().optional(),
        scenarioId: z.string().optional(),
      })
      .transform((s) => ({ kind: 'target' as const, ...s })),
  ]),
  factKind: contextFactKindSchema,
  observedAt: z.string().nullable().optional(),
  collectedAt: z.string(),
  validUntil: z.string().nullable().optional(),
  validity: z
    .strictObject({
      appliesTo: z.string().optional(),
      expiresAt: z.string().optional(),
    })
    .nullable(),
  sensitivity: z.enum(['public', 'business', 'restricted']),
  content: z.string(),
  evidenceRefs: z.array(z.string()),
  coverage: contextCoverageSchema.optional(),
})
export type ContextItem = z.infer<typeof contextItemSchema>

export const assistantStructuredFactSchema = z.strictObject({
  factKey: z.string().min(1),
  label: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
  unit: z.string().optional(),
  window: z
    .strictObject({
      startAt: z.string().optional(),
      endAt: z.string().optional(),
    })
    .optional(),
  scope: contextItemScopeSchema,
  sourceRef: z.strictObject({
    kind: z.string(),
    id: z.string(),
    fragment: z.string().optional(),
    revision: z.union([z.string(), z.number()]).optional(),
  }),
  observedAt: z.string().nullable().optional(),
  collectedAt: z.string(),
  validUntil: z.string().nullable().optional(),
})
export type AssistantStructuredFact = z.infer<typeof assistantStructuredFactSchema>


export const contextPackSchema = z.strictObject({
  packId: z.string(),
  revision: z.number().int().nonnegative(),
  goal: z.string(),
  confirmedSlots: z.record(z.string(), z.unknown()),
  requiredItems: z.array(contextItemSchema),
  relatedItems: z.array(contextItemSchema),
  toolSummaries: z.array(
    z.strictObject({
      toolId: z.string(),
      version: z.string(),
      purpose: z.string(),
    }),
  ),
  missing: z.array(
    z.strictObject({
      key: z.string(),
      reason: z.enum(['no_permission', 'not_found', 'over_budget', 'expired']),
    }),
  ),
})
export type ContextPack = z.infer<typeof contextPackSchema>

export const contextManifestSchema = z.strictObject({
  manifestId: z.string(),
  packId: z.string(),
  packRevision: z.number().int().nonnegative(),
  profileRef: z.strictObject({ id: z.string(), version: z.string() }),
  policyRevision: z.number().int(),
  sourceVersions: z.array(
    z.strictObject({
      kind: z.string(),
      id: z.string(),
      revision: z.union([z.string(), z.number()]),
    }),
  ),
  selectionReasons: z.array(z.strictObject({ sourceId: z.string(), reason: z.string() })),
  coverage: z.strictObject({ requiredTotal: z.number(), requiredIncluded: z.number() }),
  sizeEstimate: z.strictObject({
    method: z.enum(['chars', 'bytes', 'tokenizer']),
    estimated: z.number(),
    actual: z.number().optional(),
  }),
  dropped: z.array(z.strictObject({ sourceId: z.string(), reason: z.string() })),
  replayable: z.boolean(),
})
export type ContextManifest = z.infer<typeof contextManifestSchema>

export const assistantTaskStateSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'WAITING_INPUT',
  'WAITING_JOB',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
])
export type AssistantTaskState = z.infer<typeof assistantTaskStateSchema>

export const assistantTaskSchema = z.strictObject({
  taskId: z.string(),
  conversationId: z.string(),
  ownerAccountId: z.string(),
  capabilityId: z.string(),
  capabilityVersion: z.string(),
  goal: z.string(),
  resourceScope: invocationContextSchema.shape.resourceScope,
  frozenRefs: z.array(
    z.strictObject({
      kind: z.string(),
      id: z.string(),
      revision: z.union([z.string(), z.number()]),
    }),
  ),
  confirmedSlots: z.record(
    z.string(),
    z.strictObject({
      value: z.unknown(),
      source: z.enum(['user', 'page', 'resolved']),
      at: z.string(),
    }),
  ),
  constraints: z.array(z.string()),
  artifactRefs: z.array(z.string()),
  openQuestions: z.array(
    z.strictObject({
      key: z.string(),
      question: z.string(),
      options: z.array(z.unknown()).optional(),
    }),
  ),
  completedActions: z.array(
    z.strictObject({
      actionId: z.string(),
      toolId: z.string(),
      at: z.string(),
      resultRef: z.string().optional(),
    }),
  ),
  linkedJobs: z.array(
    z.strictObject({
      kind: z.enum(['run', 'analysis', 'suite_run']),
      id: z.string(),
    }),
  ),
  state: assistantTaskStateSchema,
  revision: z.number().int(),
  taskDeadlineAt: z.string(),
  waitingTimeoutAt: z.string().nullable(),
  eventSeq: z.number().int(),
  stage: z.union([assistantStageSchema, z.literal('queued'), z.literal('waiting')]),
  progress: z.strictObject({
    noProgressRounds: z.number().int(),
    consecutiveToolFailures: z.number().int(),
    modelCalls: z.number().int(),
  }),
  stopReason: z
    .enum([
      'completed',
      'guardrail_wall_clock',
      'guardrail_no_progress',
      'guardrail_tool_failures',
      'hard_limit_context',
      'cancelled',
      'expired_waiting',
      'error',
    ])
    .nullable(),
})
export type AssistantTask = z.infer<typeof assistantTaskSchema>

export const taskArtifactSchema = z.strictObject({
  artifactId: z.string(),
  ownerRef: z.union([
    z.strictObject({ kind: z.literal('task'), taskId: z.string() }),
    z.strictObject({ kind: z.literal('turn'), turnId: z.string() }),
  ]),
  kind: z.string(),
  schemaVersion: z.string(),
  bodyDigest: z.string(),
  body: z.union([z.unknown(), z.strictObject({ objectRef: z.string() })]),
  baseRefs: z.array(
    z.strictObject({
      kind: z.string(),
      id: z.string(),
      revision: z.union([z.string(), z.number()]),
    }),
  ),
  createdAt: z.string(),
  retainUntil: z.string().nullable(),
  supersedes: z.string().nullable(),
})
export type TaskArtifact = z.infer<typeof taskArtifactSchema>

export const submitAcceptedSchema = z.strictObject({
  turnId: z.string(),
  taskId: z.string().nullable(),
  state: z.enum(['QUEUED', 'RUNNING']),
  stage: z.union([assistantStageSchema, z.literal('queued')]),
  eventSeq: z.number().int(),
  queuePosition: z.number().int().nullable(),
})
export type SubmitAccepted = z.infer<typeof submitAcceptedSchema>

export const streamChunkSchema = z.strictObject({
  turnId: z.string(),
  callId: z.string(),
  seq: z.number().int(),
  channel: z.enum(['thinking', 'output']),
  text: z.string(),
  createdAt: z.string(),
  retainUntil: z.string(),
})
export type StreamChunk = z.infer<typeof streamChunkSchema>

export const cancelResultSchema = z.strictObject({
  turnId: z.string(),
  state: z.enum(['CANCELLED', 'COMPLETED', 'FAILED']),
})
export type CancelResult = z.infer<typeof cancelResultSchema>

export const assistantTurnSnapshotSchema = assistantTurnSchema.extend({
  stage: z.union([assistantStageSchema, z.literal('queued'), z.literal('waiting')]).optional(),
  eventSeq: z.number().int().optional(),
  queuePosition: z.number().int().nullable().optional(),
  stopReason: z.string().nullable().optional(),
})
export type AssistantTurnSnapshot = z.infer<typeof assistantTurnSnapshotSchema>

export const observeEventSchema = z.discriminatedUnion('event', [
  z.strictObject({
    event: z.literal('ready'),
    data: z.strictObject({
      realtime: z.boolean(),
      thinkingStream: z.boolean(),
    }),
  }),
  z.strictObject({
    event: z.literal('event'),
    seq: z.number().int(),
    data: z.strictObject({
      stage: z.union([assistantStageSchema, z.literal('queued'), z.literal('waiting')]),
      at: z.string(),
      note: z.string().optional(),
    }),
  }),
  z.strictObject({
    event: z.literal('thinking'),
    seq: z.number().int(),
    data: z.strictObject({
      callId: z.string(),
      delta: z.string(),
    }),
  }),
  z.strictObject({
    event: z.literal('output'),
    seq: z.number().int(),
    data: z.strictObject({
      callId: z.string(),
      delta: z.string(),
    }),
  }),
  z.strictObject({
    event: z.literal('turn'),
    data: assistantTurnSnapshotSchema,
  }),
  z.strictObject({
    event: z.literal('error'),
    data: z.strictObject({
      message: z.string(),
    }),
  }),
])
export type ObserveEvent = z.infer<typeof observeEventSchema>

const SENSITIVE_KEY_PATTERN = /password|secret|token|otp|\bpin\b|密码|口令|验证码|私钥/i

export function resolveContextSensitivity(text: string): 'public' | 'business' | 'restricted' {
  if (SENSITIVE_KEY_PATTERN.test(text)) return 'restricted'
  return 'business'
}

export interface EvaluationSample {
  id: string
  datasetVersion: string
  capabilityId: AssistantCapabilityId
  inputFactsDigest: string
  referenceContext: Record<string, unknown>
  expectedAssertions: Array<{
    path: string
    op: string
    value: unknown
  }>
  metadata: {
    tags: string[]
    holdout: boolean
  }
}
