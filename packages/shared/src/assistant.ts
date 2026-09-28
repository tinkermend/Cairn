import { z } from 'zod'
import { canonicalJson } from './canonical.js'
import { sha256Hex } from './internal-auth.js'
import { hasPermission, nextCursorSchema, type PermissionCode } from './rbac.js'
import { assertExpectSchema } from './browser-command.js'
import { outputFieldNameSchema } from './output-schema.js'
import { stepRunFor, stepRunsOf, type RunObservation, type RunPlacementState } from './run-api.js'
import { scenarioDocumentSchema, type CompileDiagnostic, type ScenarioDocument } from './scenario.js'
import {
  contextKeySchema,
  isAiStepType,
  stepSchema,
  type FillInput,
  type Step,
} from './step.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'
import {
  assistantAuthoringProposalSchema,
  type AssistantAuthoringProposal,
} from './authoring-proposals.js'
import {
  authoringDocumentDigest,
  type ScenarioAuthoringDocumentV2,
} from './authoring-document.js'
import {
  targetFormProposalSchema,
  type TargetFormProposal,
} from './assistant-form.js'

export const ASSISTANT_HISTORICAL_CAPABILITY_IDS = [
  'run.diagnose',
  'run.compare',
  'scenario.explain',
  'scenario.propose-step',
  'scenario.compose_with_knowledge',
  'platform.guide',
  'scenario.discover',
  'target.business-records.list',
  'operations.diagnose',
  'schedules.propose',
  'operations.action',
  'in-page.guidance',
  'knowledge.answer',
] as const
export type AssistantHistoricalCapabilityId = (typeof ASSISTANT_HISTORICAL_CAPABILITY_IDS)[number]
export const assistantHistoricalCapabilityIdSchema = z.enum(ASSISTANT_HISTORICAL_CAPABILITY_IDS)

export const ASSISTANT_PUBLISHED_CAPABILITY_IDS = [
  'run.diagnose',
  'run.compare',
  'scenario.explain',
  'scenario.propose-step',
  'scenario.compose_with_knowledge',
  'platform.guide',
  'scenario.discover',
  'target.business-records.list',
  'in-page.guidance',
  'knowledge.answer',
] as const
export type AssistantPublishedCapabilityId = (typeof ASSISTANT_PUBLISHED_CAPABILITY_IDS)[number]
export const assistantPublishedCapabilityIdSchema = z.enum(ASSISTANT_PUBLISHED_CAPABILITY_IDS)

export const ASSISTANT_CAPABILITY_IDS = ASSISTANT_PUBLISHED_CAPABILITY_IDS
export type AssistantCapabilityId = (typeof ASSISTANT_CAPABILITY_IDS)[number]
export const assistantCapabilityIdSchema = z.enum(ASSISTANT_CAPABILITY_IDS)

export const ASSISTANT_TURN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'CLARIFY',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
] as const
export type AssistantTurnStatus = (typeof ASSISTANT_TURN_STATUSES)[number]
export const assistantTurnStatusSchema = z.enum(ASSISTANT_TURN_STATUSES)

export const ASSISTANT_STAGES = [
  'accepted',
  'routing',
  'loading_facts',
  'generating',
  'validating',
  'persisting',
] as const
export type AssistantStage = (typeof ASSISTANT_STAGES)[number]
export const assistantStageSchema = z.enum(ASSISTANT_STAGES)

export const ASSISTANT_CITATION_KINDS = [
  'target',
  'run',
  'stepRun',
  'attempt',
  'evidence',
  'step',
  'occurrence',
  'schedule',
  'dataset',
  'session',
  'incident',
] as const
export type AssistantCitationKind = (typeof ASSISTANT_CITATION_KINDS)[number]

export const assistantCitationKeySchema = z
  .string()
  .regex(
    /^(target|run|stepRun|attempt|evidence|step|occurrence|schedule|dataset|session|incident):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    '引用键须为 kind:uuid',
  )
export type AssistantCitationKey = z.infer<typeof assistantCitationKeySchema>

export const ASSISTANT_NEXT_ACTION_KINDS = [
  'run.detail',
  'run.evidence',
  'run.auth',
  'run.review',
  'studio.step',
  'target.accounts',
  'target.detail',
  'worker.list',
  'schedule.edit',
  'incident.detail',
  'platform.config',
] as const
export type AssistantNextActionKind = (typeof ASSISTANT_NEXT_ACTION_KINDS)[number]
export const assistantNextActionKindSchema = z.enum(ASSISTANT_NEXT_ACTION_KINDS)

export const ASSISTANT_FOCUS = ['overview', 'failure', 'waiting', 'timing'] as const
export type AssistantFocus = (typeof ASSISTANT_FOCUS)[number]
export const assistantFocusSchema = z.enum(ASSISTANT_FOCUS)

export const ASSISTANT_PAGE_KINDS = [
  'run',
  'studio',
  'scenario',
  'target',
  'session',
  'schedule',
  'dataset',
  'home',
  'navigation',
  'platform-config',
  'other',
] as const
export type AssistantPageKind = (typeof ASSISTANT_PAGE_KINDS)[number]
export const assistantPageKindSchema = z.enum(ASSISTANT_PAGE_KINDS)

export const ASSISTANT_OBJECT_REF_KINDS = [
  'step',
  'run',
  'scenario',
  'target',
  'account',
  'session',
  'schedule',
  'dataset',
  'stepRun',
  'attempt',
] as const
export type AssistantObjectRefKind = (typeof ASSISTANT_OBJECT_REF_KINDS)[number]
export const assistantObjectRefSchema = z.strictObject({
  kind: z.enum(ASSISTANT_OBJECT_REF_KINDS),
  id: entityIdSchema,
})
export type AssistantObjectRef = z.infer<typeof assistantObjectRefSchema>

export interface AssistantRouteDescriptor {
  routeKey: string
  pageKind: AssistantPageKind
  landmarkKey?: 'studio' | 'run' | 'target' | 'platform-config'
  contextMode: 'entity' | 'collection' | 'navigation' | 'none'
  primaryRefKind?: AssistantObjectRefKind
  allowedTabs?: readonly string[]
  allowedFilters?: readonly string[]
}

export const ASSISTANT_QUOTE_TYPES = [
  'step_failure',
  'scenario_step',
  'compile_diagnostic',
  'custom',
] as const
export type AssistantQuoteType = (typeof ASSISTANT_QUOTE_TYPES)[number]
export const assistantQuoteTypeSchema = z.enum(ASSISTANT_QUOTE_TYPES)

export const assistantQuoteObjectRefSchema = z.strictObject({
  kind: z.enum(['step', 'run', 'scenario', 'target']),
  id: entityIdSchema,
})
export type AssistantQuoteObjectRef = z.infer<typeof assistantQuoteObjectRefSchema>

export const assistantQuoteContextSchema = z
  .strictObject({
    type: assistantQuoteTypeSchema,
    targetId: z.string().min(1).max(128).optional(),
    objectRef: assistantQuoteObjectRefSchema.optional(),
    title: z.string().min(1).max(200),
    summary: z.string().max(2000),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((data) => data.objectRef !== undefined || data.targetId !== undefined, {
    message: 'Quote 须提供 objectRef 或 targetId',
  })
export type AssistantQuoteContext = z.infer<typeof assistantQuoteContextSchema>

const STEP_QUOTE_TYPES = new Set<AssistantQuoteContext['type']>(['step_failure', 'scenario_step'])

/** 只有明确指向目标系统的引用才拿去作目标鉴权。步骤引用的 targetId 是步骤 ID。 */
export function quoteTargetSystemId(
  quote: Pick<AssistantQuoteContext, 'type' | 'targetId' | 'objectRef'>,
): string | undefined {
  if (quote.objectRef?.kind === 'target') return quote.objectRef.id
  if (quote.objectRef || STEP_QUOTE_TYPES.has(quote.type) || quote.type === 'compile_diagnostic') {
    return undefined
  }
  return quote.targetId
}

/** 步骤引用要聚焦的 ID。运行页可能传来步骤定义 ID，也可能仍是 StepRun ID。 */
export function quoteStepFocusId(
  quote: Pick<AssistantQuoteContext, 'type' | 'targetId' | 'objectRef'>,
): string | undefined {
  if (quote.objectRef?.kind === 'step') return quote.objectRef.id
  if (STEP_QUOTE_TYPES.has(quote.type)) return quote.targetId
  return undefined
}

/** 引用落在这次运行的某一步时，返回该步的步骤定义 ID。 */
export function quotedStepIdOnRun(
  quote: Pick<AssistantQuoteContext, 'type' | 'targetId' | 'objectRef'>,
  stepRuns: readonly { id: string; stepId: string; scopePath?: string | null }[],
): string | undefined {
  const focusId = quoteStepFocusId(quote)
  if (!focusId) return undefined
  return (stepRunFor(stepRuns, focusId) ?? stepRuns.find((step) => step.id === focusId))?.stepId
}

export const assistantPageContextV2Schema = z.strictObject({
  version: z.literal(2),
  routeKey: z.string().min(1).max(200),
  pageKind: assistantPageKindSchema,
  page: assistantPageKindSchema, // backward-compatible alias
  primaryRef: assistantObjectRefSchema.optional(),
  scopeRefs: z.array(assistantObjectRefSchema).max(5).optional(),
  versionRef: assistantObjectRefSchema.optional(),
  runId: entityIdSchema.optional(),
  scenarioId: entityIdSchema.optional(),
  stepId: entityIdSchema.optional(),
  targetId: entityIdSchema.optional(),
  versionId: entityIdSchema.optional(),
  draftRevision: z.number().int().min(1).optional(),
  view: z
    .strictObject({
      tab: z.string().max(100).optional(),
      filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      selectedRef: assistantObjectRefSchema.optional(),
    })
    .optional(),
  draft: z
    .strictObject({
      isDirty: z.boolean(),
      savedRevision: z.number().int().nonnegative().optional(),
    })
    .optional(),
  quote: assistantQuoteContextSchema.optional(),
})
export type AssistantPageContextV2 = z.infer<typeof assistantPageContextV2Schema>

export const assistantPageContextV1Schema = z.strictObject({
  version: z.literal(1).optional(),
  page: assistantPageKindSchema,
  runId: entityIdSchema.optional(),
  scenarioId: entityIdSchema.optional(),
  stepId: entityIdSchema.optional(),
  targetId: entityIdSchema.optional(),
  versionId: entityIdSchema.optional(),
  draftRevision: z.number().int().min(1).optional(),
  quote: assistantQuoteContextSchema.optional(),
})
export type AssistantPageContextV1 = z.infer<typeof assistantPageContextV1Schema>

export const assistantPageContextSchema = z.union([
  assistantPageContextV2Schema,
  assistantPageContextV1Schema,
])
export type AssistantPageContext = z.infer<typeof assistantPageContextSchema>

export function normalizeAssistantPageContext(
  raw: AssistantPageContext | null | undefined,
): AssistantPageContextV2 | null {
  if (!raw) return null
  if ('version' in raw && raw.version === 2) {
    const v2 = raw as AssistantPageContextV2
    const runId = v2.runId ?? (v2.primaryRef?.kind === 'run' ? v2.primaryRef.id : undefined)
    const scenarioId = v2.scenarioId ?? (v2.primaryRef?.kind === 'scenario' ? v2.primaryRef.id : undefined)
    const targetId =
      v2.targetId ??
      (v2.primaryRef?.kind === 'target'
        ? v2.primaryRef.id
        : v2.scopeRefs?.find((r) => r.kind === 'target')?.id)
    const stepId =
      v2.stepId ?? (v2.view?.selectedRef?.kind === 'step' ? v2.view.selectedRef.id : undefined)
    const versionId = v2.versionId ?? v2.versionRef?.id
    const draftRevision = v2.draftRevision ?? v2.draft?.savedRevision
    return {
      ...v2,
      ...(runId ? { runId } : {}),
      ...(scenarioId ? { scenarioId } : {}),
      ...(targetId ? { targetId } : {}),
      ...(stepId ? { stepId } : {}),
      ...(versionId ? { versionId } : {}),
      ...(draftRevision !== undefined ? { draftRevision } : {}),
    }
  }
  const v1 = raw as AssistantPageContextV1
  let primaryRef: AssistantObjectRef | undefined
  if (v1.runId) primaryRef = { kind: 'run', id: v1.runId }
  else if (v1.scenarioId) primaryRef = { kind: 'scenario', id: v1.scenarioId }
  else if (v1.targetId) primaryRef = { kind: 'target', id: v1.targetId }

  const pageKind = v1.page === 'studio' ? 'scenario' : v1.page
  return {
    version: 2,
    routeKey: `legacy:${v1.page}`,
    pageKind,
    page: v1.page,
    ...(primaryRef ? { primaryRef } : {}),
    ...(v1.runId ? { runId: v1.runId } : {}),
    ...(v1.scenarioId ? { scenarioId: v1.scenarioId } : {}),
    ...(v1.targetId ? { targetId: v1.targetId } : {}),
    ...(v1.stepId ? { stepId: v1.stepId } : {}),
    ...(v1.versionId
      ? { versionId: v1.versionId, versionRef: { kind: 'scenario', id: v1.versionId } }
      : {}),
    ...(v1.stepId ? { view: { selectedRef: { kind: 'step', id: v1.stepId } } } : {}),
    ...(v1.draftRevision !== undefined
      ? {
          draftRevision: v1.draftRevision,
          draft: { isDirty: false, savedRevision: v1.draftRevision },
        }
      : {}),
    ...(v1.quote ? { quote: v1.quote } : {}),
  }
}

export const ASSISTANT_MAX_QUESTION_CHARS = 2000
export const ASSISTANT_MAX_FACT_CHARS = 12_000
export const ASSISTANT_PROMPT_VERSION = 'assistant-router@1'
export const ASSISTANT_POLICY_VERSION = 'assistant-phase-one@1'

export type AssistantCapabilityDef = {
  id: AssistantCapabilityId
  label: string
  requiredPermissions: readonly PermissionCode[]
  description: string
}

export const ASSISTANT_CAPABILITIES: readonly AssistantCapabilityDef[] = [
  {
    id: 'run.diagnose',
    label: '运行诊断',
    requiredPermissions: ['ai:assist', 'run:read', 'target:read'],
    description: '解释指定 Run 的状态、等待原因、失败 Attempt 与耗时',
  },
  {
    id: 'run.compare',
    label: '运行对比',
    requiredPermissions: ['ai:assist', 'run:read', 'target:read'],
    description: '对比两次 Run 的步骤、耗时与失败差异',
  },
  {
    id: 'scenario.explain',
    label: '场景解释',
    requiredPermissions: ['ai:assist', 'workflow:read', 'target:read'],
    description: '解释已保存场景版本或草稿中的步骤与引用',
  },
  {
    id: 'scenario.propose-step',
    label: '场景编排建议',
    requiredPermissions: ['ai:assist', 'workflow:read', 'workflow:write', 'target:read'],
    description: '为已保存草稿提出步骤新增、字段修改、删除与同分支移动等受限编排建议',
  },
  {
    id: 'scenario.compose_with_knowledge',
    label: '知识辅助编写',
    requiredPermissions: ['ai:assist', 'workflow:read', 'workflow:write', 'target:read', 'map:read'],
    description: '为仅含独立步骤、且必需输入齐全的已保存草稿，基于已授权知识生成可编辑建议',
  },
  {
    id: 'platform.guide',
    label: '功能导览',
    requiredPermissions: ['ai:assist'],
    description: '返回当前权限可达的控制台入口',
  },
  {
    id: 'scenario.discover',
    label: '场景发现',
    requiredPermissions: ['ai:assist', 'target:read', 'workflow:read'],
    description: '按权限发现并分页列出可见场景列表与候选',
  },
  {
    id: 'target.business-records.list',
    label: '业务数据列表',
    requiredPermissions: ['ai:assist', 'target:read', 'dataset:read'],
    description: '查询已授权的目标系统业务数据快照与字典',
  },
  {
    id: 'in-page.guidance',
    label: '页面操作指引',
    requiredPermissions: ['ai:assist'],
    description: '结合当前页面结构指引关键按钮、操作入口与交互动线',
  },
  {
    id: 'knowledge.answer',
    label: '有源开放问答',
    requiredPermissions: ['ai:assist'],
    description: '在已授权和已验证的平台知识与业务事实范围内进行有源回答',
  },
]

export function assistantCapability(id: string): AssistantCapabilityDef {
  const found = ASSISTANT_CAPABILITIES.find((item) => item.id === id)
  if (!found) throw new Error(`未知助手能力：${id}`)
  return found
}

export const ASSISTANT_WAITING_PLACEMENTS = [
  'owner_at_capacity',
  'session_not_ready',
  'owner_required',
  'session_lost',
] as const

/** Only surface actionable scheduler waits in user-facing run diagnoses. */
export function assistantWaitingPlacementDescription(state: RunPlacementState): string | null {
  switch (state) {
    case 'owner_required': return '正在等待持有该账号会话的执行节点领取运行。'
    case 'owner_at_capacity': return '账号会话所在执行节点的执行槽已满，运行正在排队。'
    case 'session_not_ready': return '账号会话尚未就绪，运行正在等待。'
    case 'session_lost': return '账号会话已失联，需先核查会话状态再继续。'
    default: return null
  }
}

export const SENSITIVE_FILL_HINT = /password|passwd|secret|token|otp|\bpin\b|密码|口令|验证码/i

export function isSensitiveFillInput(input: FillInput): boolean {
  if (input.sensitive) return true
  return SENSITIVE_FILL_HINT.test(JSON.stringify(input.target))
}

export function citationKey(kind: AssistantCitationKind, id: string): AssistantCitationKey {
  return assistantCitationKeySchema.parse(`${kind}:${id}`)
}

export const contextItemScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('platform') }),
  z.strictObject({
    kind: z.literal('target'),
    targetId: z.string(),
    runId: z.string().optional(),
    scenarioId: z.string().optional(),
  }),
])
export type ContextItemScope = z.infer<typeof contextItemScopeSchema>

export const assistantFactScopeSchema = z.union([
  z.enum(['platform', 'target']),
  contextItemScopeSchema,
])
export type AssistantFactScope = z.infer<typeof assistantFactScopeSchema>

export const assistantFactSchema = z.strictObject({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(1024),
  citations: z.array(assistantCitationKeySchema).max(16),
  factKey: z.string().optional(),
  label: z.string().optional(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  unit: z.string().optional(),
  observedAt: z.string().nullable().optional(),
  collectedAt: z.string().optional(),
  validUntil: z.string().nullable().optional(),
  scope: assistantFactScopeSchema.optional(),
})
export type AssistantFact = z.infer<typeof assistantFactSchema>

export const assistantHypothesisSchema = z.strictObject({
  text: z.string().min(1).max(1024),
  citations: z.array(assistantCitationKeySchema).max(16),
})
export type AssistantHypothesis = z.infer<typeof assistantHypothesisSchema>

export const assistantDeepLinkActionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create-account'),
    targetId: entityIdSchema,
    prefillUsername: z.string().max(128).optional(),
  }),
  z.strictObject({
    action: z.literal('inspect-step'),
    scenarioId: entityIdSchema,
    stepId: entityIdSchema,
  }),
  z.strictObject({
    action: z.literal('focus-section'),
    section: z.string().min(1).max(64),
  }),
])
export type AssistantDeepLinkAction = z.infer<typeof assistantDeepLinkActionSchema>

export const assistantNextActionSchema = z.strictObject({
  kind: assistantNextActionKindSchema,
  label: z.string().min(1).max(64),
  href: z.string().min(1).max(512),
  citations: z.array(assistantCitationKeySchema).max(8),
  deepLink: assistantDeepLinkActionSchema.optional(),
})
export type AssistantNextAction = z.infer<typeof assistantNextActionSchema>

export const DIAGNOSTIC_FOCUSES = [
  'overview',
  'failure',
  'wait',
  'duration',
  'outcome',
  'evidence_missing',
] as const
export type DiagnosticFocus = (typeof DIAGNOSTIC_FOCUSES)[number]
export const diagnosticFocusSchema = z.enum(DIAGNOSTIC_FOCUSES)

export const missingInfoReasonSchema = z.enum([
  'missing',
  'expired',
  'incomplete',
  'forbidden',
  'truncated',
])
export type MissingInfoReason = z.infer<typeof missingInfoReasonSchema>

export const assistantDiagnosisSchema = z.strictObject({
  kind: z.literal('diagnosis'),
  observedAt: utcInstantSchema,
  eventSeq: z.number().int().min(0),
  focus: diagnosticFocusSchema.optional(),
  facts: z.array(assistantFactSchema).max(24),
  hypotheses: z.array(assistantHypothesisSchema).max(8),
  missingInformation: z.array(z.string().min(1).max(256)).max(12),
  missingReasons: z
    .array(
      z.strictObject({
        reason: missingInfoReasonSchema,
        detail: z.string().min(1).max(256),
      }),
    )
    .max(12)
    .optional(),
  nextActions: z.array(assistantNextActionSchema).max(8),
})
export type AssistantDiagnosis = z.infer<typeof assistantDiagnosisSchema>

export const assistantExplanationSchema = z.strictObject({
  kind: z.literal('explanation'),
  summary: z.string().min(1).max(2048),
  stepSummary: z.string().min(1).max(1024).optional(),
  references: z.array(z.string().min(1).max(256)).max(16),
  diagnostics: z
    .array(
      z.strictObject({
        code: z.string().min(1).max(64),
        stepId: entityIdSchema.optional(),
        fieldPath: z.array(z.string()).max(8).optional(),
        message: z.string().min(1).max(512),
        baseline: z.boolean(),
      }),
    )
    .max(32),
  executable: z.boolean(),
})
export type AssistantExplanation = z.infer<typeof assistantExplanationSchema>

export const assistantStepProposalKindSchema = z.enum(['ai_instruction', 'assert_expectation', 'fill_binding'])
export type AssistantStepProposalKind = z.infer<typeof assistantStepProposalKindSchema>

export const assistantStepChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ai_instruction'),
    instruction: z.string().trim().min(1).max(4096),
  }),
  z.strictObject({
    kind: z.literal('assert_expectation'),
    expect: assertExpectSchema,
  }),
  z.strictObject({
    kind: z.literal('fill_binding'),
    from: contextKeySchema,
    fromField: outputFieldNameSchema.optional(),
  }),
])
export type AssistantStepChange = z.infer<typeof assistantStepChangeSchema>

export const assistantKnowledgeProposalSchema = z.strictObject({
  kind: z.literal('knowledge_proposal'),
  proposalId: entityIdSchema,
  status: z.enum([
    'proposed',
    'needs_input',
    'unsupported',
    'failed',
    'accepted',
    'stale',
    'rejected',
    'generating',
  ]),
  reason: z.string().min(1).max(1024),
  diffs: z
    .array(
      z.strictObject({
        fieldPath: z.array(z.string().min(1)).max(8),
        from: z.unknown().optional(),
        to: z.unknown().optional(),
      }),
    )
    .max(64),
  diagnostics: z
    .array(
      z.strictObject({
        code: z.string().min(1).max(64),
        message: z.string().min(1).max(512),
        fieldPath: z.array(z.string()).max(8).optional(),
      }),
    )
    .max(32),
  sources: z.array(z.unknown()).max(16),
  unknowns: z.array(z.string().min(1).max(256)).max(16),
  executable: z.boolean(),
  draftRevision: z.number().int().min(1),
  documentDigest: z.string().regex(/^[a-f0-9]{64}$/),
})
export type AssistantKnowledgeProposal = z.infer<typeof assistantKnowledgeProposalSchema>

export const assistantProposalStepDiffSchema = z.strictObject({
  fieldPath: z.array(z.string().min(1)).max(8),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
  changeType: z.enum(['add', 'modify', 'remove']).optional(),
})
export type AssistantProposalStepDiff = z.infer<typeof assistantProposalStepDiffSchema>

export const assistantProposalSchema = z.strictObject({
  kind: z.literal('proposal'),
  change: assistantStepChangeSchema,
  document: scenarioDocumentSchema,
  stepId: entityIdSchema,
  draftRevision: z.number().int().min(1),
  documentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().min(1).max(1024),
  diffs: z.array(assistantProposalStepDiffSchema).max(16),
  diagnostics: z
    .array(
      z.strictObject({
        code: z.string().min(1).max(64),
        stepId: entityIdSchema.optional(),
        fieldPath: z.array(z.string()).max(8).optional(),
        message: z.string().min(1).max(512),
        baseline: z.boolean(),
      }),
    )
    .max(32),
  executable: z.boolean(),
})
export type AssistantProposal = z.infer<typeof assistantProposalSchema>

export const ASSISTANT_GUIDE_TOPICS = [
  'targets',
  'accounts',
  'scenarios',
  'studio',
  'runs',
  'evidence',
  'browser',
  'platform-config',
] as const
export type AssistantGuideTopic = (typeof ASSISTANT_GUIDE_TOPICS)[number]
export const assistantGuideTopicSchema = z.enum(ASSISTANT_GUIDE_TOPICS)

export type AssistantGuideEntry = {
  topic: AssistantGuideTopic
  capabilityId: string
  title: string
  href: string | null
  requiredPermissions: readonly PermissionCode[]
  steps: string
}

export const ASSISTANT_GUIDE_CATALOG: readonly AssistantGuideEntry[] = [
  {
    topic: 'targets',
    capabilityId: 'menu.targets',
    title: '目标系统',
    href: '/targets',
    requiredPermissions: ['target:read'],
    steps: '打开工作台「目标系统」，选择要仿真的系统。',
  },
  {
    topic: 'accounts',
    capabilityId: 'menu.targets',
    title: '目标账号',
    href: '/targets',
    requiredPermissions: ['target:read'],
    steps: '进入目标系统详情，在账号表中查看或维护目标系统账号。没有 target:write 时只能查看。',
  },
  {
    topic: 'scenarios',
    capabilityId: 'menu.recordings',
    title: '录制草稿',
    href: '/recordings',
    requiredPermissions: ['target:read', 'workflow:write'],
    steps: '1. 先确认目标系统及可用账号；在「录制草稿」通过识途录制器采集操作并上传，或导入录制文件。2. 打开草稿检查步骤、敏感字段和未解析项，再点击「回填到场景」，选择「以草稿新建场景」并填写名称。',
  },
  {
    topic: 'scenarios',
    capabilityId: 'menu.scenarios',
    title: '场景编排',
    href: '/scenarios',
    requiredPermissions: ['workflow:read'],
    steps: '3. 在新场景工作区审查回填结果，补齐输入、定位方式和业务成功条件，保存草稿。4. 点击「试跑当前草稿」，按需选择目标账号，查看运行步骤、业务结果与证据；确认通过后再发布。创建、回填和保存需要场景写权限；只读账号可查看场景。',
  },
  {
    topic: 'studio',
    capabilityId: 'menu.scenarios',
    title: '场景工作区',
    href: '/scenarios',
    requiredPermissions: ['workflow:read'],
    steps: '进入场景详情编辑有序步骤。保存草稿后才能试跑或请助手生成修改建议。',
  },
  {
    topic: 'runs',
    capabilityId: 'menu.runs',
    title: '运行',
    href: '/runs',
    requiredPermissions: ['run:read'],
    steps: '打开工作台「运行」，进入详情查看步骤、Attempt 与状态。',
  },
  {
    topic: 'evidence',
    capabilityId: 'menu.evidence',
    title: '失败证据',
    href: '/evidence',
    requiredPermissions: ['run:read'],
    steps: '打开运行详情或结果与报告列表，在当前 Attempt 下查看截图、结构化证据和授权下载入口。',
  },
  {
    topic: 'browser',
    capabilityId: 'action.session.view',
    title: '受管浏览器画面',
    href: null,
    requiredPermissions: ['session:view'],
    steps: '入口在运行详情，不是独立侧栏菜单。等待认证时在该页处理目标系统登录。',
  },
  {
    topic: 'platform-config',
    capabilityId: 'menu.platform-config',
    title: '平台配置',
    href: '/platform-config',
    requiredPermissions: ['platform-config:read'],
    steps: '打开治理「平台配置」，分别管理浏览器 AI 与平台助手模型，二者不会互相回退。',
  },
]

export const assistantGuideItemSchema = z.strictObject({
  topic: assistantGuideTopicSchema,
  title: z.string().min(1).max(64),
  href: z.string().min(1).max(512).nullable(),
  steps: z.string().min(1).max(512),
  availability: z.enum(['available', 'disabled', 'forbidden', 'unsupported']),
})
export type AssistantGuideItem = z.infer<typeof assistantGuideItemSchema>

export const assistantGuideSchema = z.strictObject({
  kind: z.literal('guide'),
  // A topic can have multiple destinations (recording and editing share
  // "scenarios"), so the full authorized catalog may exceed its topic count.
  items: z.array(assistantGuideItemSchema).max(ASSISTANT_GUIDE_CATALOG.length),
})
export type AssistantGuide = z.infer<typeof assistantGuideSchema>

export const assistantClarifyOptionSchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
  kind: z.enum(['capability', 'scenario']).optional(),
  targetName: z.string().max(128).optional(),
})
export type AssistantClarifyOption = z.infer<typeof assistantClarifyOptionSchema>

export const assistantClarifySchema = z.strictObject({
  kind: z.literal('clarify'),
  question: z.string().min(1).max(512),
  missingFields: z.array(z.string().min(1).max(64)).max(8),
  options: z.array(assistantClarifyOptionSchema).max(8).optional(),
})
export type AssistantClarify = z.infer<typeof assistantClarifySchema>

export const assistantUnsupportedSchema = z.strictObject({
  kind: z.literal('unsupported'),
  reasonCode: z.string().min(1).max(64),
  message: z.string().min(1).max(512),
})
export type AssistantUnsupported = z.infer<typeof assistantUnsupportedSchema>

export const assistantInaccessibleSchema = z.strictObject({
  kind: z.literal('inaccessible'),
  message: z.string().min(1).max(256),
  reasonCode: z.enum(['ACCESS_DENIED', 'UNVERIFIED_HISTORY']).optional(),
})

export const assistantCompareSchema = z.strictObject({
  kind: z.literal('compare'),
  baseRunId: entityIdSchema,
  targetRunId: entityIdSchema,
  summary: z.string().min(1).max(2048),
  comparability: z
    .strictObject({
      comparable: z.boolean(),
      incomparableFactors: z.array(z.string()).default([]),
      alignmentBasis: z.string().optional(),
    })
    .optional(),
  differences: z
    .array(
      z.strictObject({
        dimension: z.enum(['definition', 'input', 'environment', 'execution']).optional(),
        stepId: z.string().optional(),
        stepName: z.string(),
        baseStatus: z.string().optional(),
        targetStatus: z.string().optional(),
        durationDiffMs: z.number().optional(),
        errorDiff: z.string().optional(),
        detail: z.string().optional(),
      }),
    )
    .max(64),
  hypotheses: z.array(assistantHypothesisSchema).max(8).optional(),
  missingInformation: z.array(z.string().min(1).max(256)).max(12).optional(),
  facts: z.array(assistantFactSchema).max(24),
  nextActions: z.array(assistantNextActionSchema).max(8),
})
export type AssistantCompare = z.infer<typeof assistantCompareSchema>

export const assistantDiscoveryCandidateSchema = z.strictObject({
  id: entityIdSchema,
  name: z.string().min(1).max(200),
  targetId: entityIdSchema,
  targetName: z.string().min(1).max(200),
  kind: z.string().min(1).max(64),
  versionOrRevision: z.union([z.string(), z.number()]).optional(),
  status: z.string().optional(),
  updatedAt: utcInstantSchema.optional(),
})
export type AssistantDiscoveryCandidate = z.infer<typeof assistantDiscoveryCandidateSchema>

export const assistantDiscoveryResultSchema = z.strictObject({
  kind: z.literal('discovery'),
  candidates: z.array(assistantDiscoveryCandidateSchema).max(100),
  scope: z.strictObject({
    targetId: entityIdSchema.optional(),
    targetName: z.string().optional(),
    entityType: z.string().optional(),
    filter: z.string().optional(),
  }),
  coverage: z.strictObject({
    totalVisible: z.number().int().nonnegative().optional(),
    hasMore: z.boolean(),
    nextCursor: nextCursorSchema,
    observedAt: utcInstantSchema,
  }),
  message: z.string().max(2000),
})
export type AssistantDiscoveryResult = z.infer<typeof assistantDiscoveryResultSchema>

export const assistantInPageGuidanceSchema = z.strictObject({
  kind: z.literal('in_page_guidance'),
  directAnswer: z.string().min(1).max(1024),
  visualPath: z.array(z.string().min(1).max(256)).max(8),
  shortcutHint: z.string().max(64).optional(),
  actionChip: z
    .strictObject({
      label: z.string().min(1).max(64),
      actionKey: z.string().min(1).max(64),
      params: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
})
export type AssistantInPageGuidance = z.infer<typeof assistantInPageGuidanceSchema>

export interface PageLandmarkAction {
  name: string
  trigger: string
  description: string
  shortcut?: string
  actionKey?: string
}

export interface PageLandmarkRegion {
  regionName: string
  actions: PageLandmarkAction[]
}

export interface PageLandmarkDefinition {
  page: 'studio' | 'run' | 'target' | 'platform-config'
  pageTitle: string
  regions: PageLandmarkRegion[]
}

export const PAGE_LANDMARK_MANIFESTS: Record<string, PageLandmarkDefinition> = {
  studio: {
    page: 'studio',
    pageTitle: '场景工作区 (Studio)',
    regions: [
      {
        regionName: '左侧步骤编排列表',
        actions: [
          {
            name: '添加步骤',
            trigger: '点击左侧步骤列表最下方的【+ 添加步骤】按钮',
            description: '弹出步骤类型菜单，可向当前编排追加新操作（如打开页面、点击、填写、等待、断言等）',
            actionKey: 'open-add-step-menu',
          },
          {
            name: '步骤排序',
            trigger: '按住步骤卡片左侧手柄上下拖动',
            description: '调整步骤执行的先后顺序',
          },
        ],
      },
      {
        regionName: '顶部操作栏',
        actions: [
          {
            name: '保存草稿',
            trigger: '点击顶栏右侧「保存」按钮，或使用快捷键',
            shortcut: 'Cmd/Ctrl + S',
            description: '保存当前正在编辑的本地草稿',
          },
          {
            name: '试跑验证',
            trigger: '点击顶栏右侧「试跑」按钮',
            description: '立即以无头/受管浏览器执行当前草稿并实时观测结果',
          },
        ],
      },
    ],
  },
  run: {
    page: 'run',
    pageTitle: '运行详情 (Run)',
    regions: [
      {
        regionName: '执行时间线与步骤列表',
        actions: [
          {
            name: '查看步骤证据',
            trigger: '点击具体步骤卡片，在展开详情中查看 Attempt 与截图',
            description: '定位单步执行的输入输出与失败截图证据',
          },
        ],
      },
    ],
  },
  target: {
    page: 'target',
    pageTitle: '目标系统详情 (Target)',
    regions: [
      {
        regionName: '识途助手快捷提问',
        actions: [
          {
            name: '检查账号健康度',
            trigger: '打开右侧「识途助手」面板，在新对话的「场景推荐」中点击「🔑 检查账号健康度」',
            description: '在助手模型已启用且拥有目标与会话读取权限时显示；点击后查询当前目标关联账号的认证状态与会话租约',
          },
        ],
      },
      {
        regionName: '账号与认证凭据',
        actions: [
          {
            name: '添加账号',
            trigger: '点击「+ 添加账号」按钮',
            description: '录入目标系统的登录身份与密码/凭据',
          },
          {
            name: '测试连接',
            trigger: '点击账号列表项右侧的「测试连接」',
            description: '验证账号凭据与网络连通性',
          },
        ],
      },
      {
        regionName: '受管会话与状态',
        actions: [
          {
            name: '连接会话',
            trigger: '点击会话卡片上的「连接」按钮',
            description: '打开或接管目标系统的受管浏览器会话',
          },
          {
            name: '强制回收',
            trigger: '点击会话操作项中的「释放/回收」',
            description: '清理挂起或过期的会话租约',
          },
        ],
      },
      {
        regionName: '业务数据与知识地图',
        actions: [
          {
            name: '查看知识群岛',
            trigger: '切换到「业务知识」或「知识群岛」标签页',
            description: '浏览该目标系统提取沉淀的业务实体与页面结构',
          },
          {
            name: '同步业务数据',
            trigger: '点击「同步数据」按钮',
            description: '触发外部业务数据与拓扑信息的全量/增量刷新',
          },
        ],
      },
    ],
  },
  'platform-config': {
    page: 'platform-config',
    pageTitle: '平台配置 (Platform Config)',
    regions: [
      {
        regionName: 'AI 与模型接入',
        actions: [
          {
            name: '配置平台 AI',
            trigger: '在平台 AI 卡片中填入模型提供商、Base URL、Model 与 API Key',
            description: '启用并配置赋能识途助手的底层大模型接入凭据',
          },
          {
            name: '测试 AI 连接',
            trigger: '点击「测试连通性」按钮',
            description: '验证平台 AI 提供商配置与连通状态',
          },
        ],
      },
    ],
  },
}

export const assistantKnowledgeAnswerClaimSchema = z.strictObject({
  factKind: z.enum(['observed', 'human_confirmed', 'inferred']),
  text: z.string().min(1),
  citations: z.array(z.string()).default([]),
  premises: z.array(z.string()).optional(),
})
export type AssistantKnowledgeAnswerClaim = z.infer<typeof assistantKnowledgeAnswerClaimSchema>

export const assistantKnowledgeAnswerMissingSchema = z.strictObject({
  key: z.string().min(1),
  reason: z.string().min(1),
  description: z.string().optional(),
})
export type AssistantKnowledgeAnswerMissing = z.infer<typeof assistantKnowledgeAnswerMissingSchema>

export const assistantKnowledgeAnswerResultSchema = z.strictObject({
  kind: z.literal('knowledge_answer'),
  summary: z.string().min(1),
  claims: z.array(assistantKnowledgeAnswerClaimSchema),
  missing: z.array(assistantKnowledgeAnswerMissingSchema).default([]),
  // New answers use asOf for the time the answer was assembled. Older stored
  // results may have used it for a source snapshot, so do not relabel legacy asOf in the UI.
  asOf: z.string(),
  sourceAsOf: utcInstantSchema.optional(),
  nextActions: z.array(assistantNextActionSchema).optional(),
})
export type AssistantKnowledgeAnswerResult = z.infer<typeof assistantKnowledgeAnswerResultSchema>

export const assistantResultSchema = z.discriminatedUnion('kind', [
  assistantDiagnosisSchema,
  assistantCompareSchema,
  assistantExplanationSchema,
  assistantProposalSchema,
  assistantKnowledgeProposalSchema,
  assistantAuthoringProposalSchema,
  targetFormProposalSchema,
  assistantGuideSchema,
  assistantDiscoveryResultSchema,
  assistantClarifySchema,
  assistantUnsupportedSchema,
  assistantInaccessibleSchema,
  assistantInPageGuidanceSchema,
  assistantKnowledgeAnswerResultSchema,
])
export type AssistantResult = z.infer<typeof assistantResultSchema>
export type { TargetFormProposal }

export const assistantResultEnvelopeSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  result: assistantResultSchema,
  sourceDigest: z.string().optional(),
  thinkingText: z.string().optional(),
  thinkingDurationMs: z.number().int().optional(),
})
export type AssistantResultEnvelope = z.infer<typeof assistantResultEnvelopeSchema>

export function unpackAssistantResultEnvelopeDetailed(raw: unknown): {
  result: AssistantResult
  thinkingText?: string
  thinkingDurationMs?: number
} | null {
  if (!raw || typeof raw !== 'object') return null
  if ('version' in raw && 'result' in raw) {
    const parsed = assistantResultEnvelopeSchema.safeParse(raw)
    if (parsed.success) {
      // Legacy envelopes may contain raw provider reasoning; never expose it.
      return {
        result: parsed.data.result,
        thinkingDurationMs: parsed.data.thinkingDurationMs,
      }
    }
  }
  const direct = assistantResultSchema.safeParse(raw)
  if (direct.success) return { result: direct.data }
  return null
}

export function unpackAssistantResultEnvelope(raw: unknown): AssistantResult | null {
  return unpackAssistantResultEnvelopeDetailed(raw)?.result ?? null
}

export function packAssistantResultEnvelope(
  result: AssistantResult,
  version: 1 | 2 = 2,
  sourceDigest?: string,
  _thinkingText?: string,
  thinkingDurationMs?: number,
): AssistantResultEnvelope {
  // The fourth argument remains for older DB callers, but raw reasoning is never persisted.
  return {
    version,
    result,
    ...(sourceDigest ? { sourceDigest } : {}),
    ...(thinkingDurationMs != null ? { thinkingDurationMs } : {}),
  }
}

export const assistantCapabilityStatusSchema = z.strictObject({
  id: assistantCapabilityIdSchema,
  label: z.string().min(1).max(64),
  available: z.boolean(),
  missingPermissions: z.array(z.string().min(1).max(64)).max(8),
  requiredContext: z.array(z.string().min(1).max(32)).max(8),
})
export type AssistantCapabilityStatus = z.infer<typeof assistantCapabilityStatusSchema>

export const assistantCapabilitiesResponseSchema = z.strictObject({
  items: z.array(assistantCapabilityStatusSchema).max(32),
  modelEnabled: z.boolean(),
})
export type AssistantCapabilitiesResponse = z.infer<typeof assistantCapabilitiesResponseSchema>

export const createAssistantConversationBodySchema = z.strictObject({
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{8,128}$/, 'idempotencyKey 须为 8–128 位 [A-Za-z0-9._:-]')
    .optional(),
  title: z.string().min(1).max(80).optional(),
  question: z.string().min(1).max(500).optional(),
})
export type CreateAssistantConversationBody = z.infer<typeof createAssistantConversationBodySchema>

export const assistantConversationSchema = z.strictObject({
  id: entityIdSchema,
  title: z.string().min(1).max(80),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type AssistantConversation = z.infer<typeof assistantConversationSchema>

export const assistantConversationListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type AssistantConversationListQuery = z.input<typeof assistantConversationListQuerySchema>

export const assistantConversationListSchema = z.strictObject({
  items: z.array(assistantConversationSchema),
  nextCursor: nextCursorSchema,
})
export type AssistantConversationList = z.infer<typeof assistantConversationListSchema>

export const deleteAssistantConversationResultSchema = z.strictObject({
  id: entityIdSchema,
  deleted: z.literal(true),
})
export type DeleteAssistantConversationResult = z.infer<typeof deleteAssistantConversationResultSchema>

export const createAssistantTurnBodySchema = z.strictObject({
  clientTurnId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{8,128}$/, 'clientTurnId 须为 8–128 位 [A-Za-z0-9._:-]'),
  question: z.string().trim().min(1).max(ASSISTANT_MAX_QUESTION_CHARS),
  pageContext: assistantPageContextSchema.optional(),
  replyToTurnId: entityIdSchema.optional(),
  selectedOptionId: z.string().min(1).max(128).optional(),
  taskId: entityIdSchema.optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  cancelCurrentTask: z.boolean().optional(),
  capabilityHint: assistantCapabilityIdSchema.optional(),
})
export type CreateAssistantTurnBody = z.infer<typeof createAssistantTurnBodySchema>

export const assistantTurnSchema = z.strictObject({
  id: entityIdSchema,
  conversationId: entityIdSchema,
  clientTurnId: z.string().min(8).max(128),
  parentTurnId: entityIdSchema.nullable(),
  question: z.string().min(1).max(ASSISTANT_MAX_QUESTION_CHARS),
  capabilityId: assistantHistoricalCapabilityIdSchema.nullable(),
  status: assistantTurnStatusSchema,
  deadlineAt: utcInstantSchema,
  result: assistantResultSchema.nullable(),
  stage: z.union([assistantStageSchema, z.literal('queued'), z.literal('waiting')]).optional(),
  eventSeq: z.number().int().optional(),
  queuePosition: z.number().int().nullable().optional(),
  stopReason: z.string().nullable().optional(),
  thinkingText: z.string().optional(),
  thinkingDurationMs: z.number().int().optional(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type AssistantTurn = z.infer<typeof assistantTurnSchema>

export const assistantTurnListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type AssistantTurnListQuery = z.input<typeof assistantTurnListQuerySchema>

export const assistantTurnListSchema = z.strictObject({
  items: z.array(assistantTurnSchema),
  nextCursor: nextCursorSchema,
})
export type AssistantTurnList = z.infer<typeof assistantTurnListSchema>

export const assistantRouteDecisionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('dispatch'),
    capabilityId: assistantCapabilityIdSchema,
    slots: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    type: z.literal('clarify'),
    missingFields: z.array(z.string().min(1).max(64)).max(8),
    question: z.string().min(1).max(512),
    options: z.array(assistantClarifyOptionSchema).max(8).optional(),
  }),
  z.strictObject({
    type: z.literal('unsupported'),
    reasonCode: z.string().min(1).max(64),
    message: z.string().min(1).max(512),
  }),
])
export type AssistantRouteDecision = z.infer<typeof assistantRouteDecisionSchema>

export type AssistantActor = { id: string; permissions: readonly string[] }

export function missingAssistantPermissions(
  granted: readonly string[],
  required: readonly PermissionCode[],
): PermissionCode[] {
  return required.filter((code) => !hasPermission(granted, code))
}

export function availableAssistantCapabilities(granted: readonly string[]): AssistantCapabilityStatus[] {
  return ASSISTANT_CAPABILITIES.map((capability) => {
    const missing = missingAssistantPermissions(granted, capability.requiredPermissions)
    return assistantCapabilityStatusSchema.parse({
      id: capability.id,
      label: capability.label,
      available: missing.length === 0,
      missingPermissions: missing,
      requiredContext:
        capability.id === 'run.diagnose'
          ? ['runId']
          : capability.id === 'run.compare'
            ? ['baseRunId', 'targetRunId']
          : capability.id === 'scenario.compose_with_knowledge'
            ? ['scenarioId', 'draftRevision']
          : capability.id === 'scenario.explain' || capability.id === 'scenario.propose-step'
            ? ['scenarioId']
            : [],
    })
  })
}

const IN_PAGE_GUIDANCE_QUESTION =
  /添加步骤|怎么添加|加步骤|在页面哪里|页面上哪里|按钮在哪|怎么保存|保存草稿|快捷键|怎么拖拽|怎么排序|怎么修改参数|页面怎么|(?:这个|该|当前|目标|业务)系统(?:里|内|中)?的?[^。？?]{0,30}(?:页|页面|列表)[^。？?]{0,15}(?:入口|在哪|哪里|路径|怎么进|怎么打开)/
const GUIDE_QUESTION = /功能入口|怎么看|如何配置|菜单|怎样查看|在哪.*配置|哪里.*配置|(?:如何|怎么).*从零.*(?:录制|场景)|录制.*新场景/
const RECENT_FAILED_RUN_QUESTION = /最近失败|最近一次失败|(?:最近|近)\s*(?:\d+|[一二三四五六七八九十]+)\s*天[^。？?]*失败/
const DIAGNOSE_QUESTION = /为什么失败|失败原因|一直等|慢在|诊断这次|分析本次|这次运行|最近失败|最近一次失败|(?:业务检查|业务结果|业务断言)[^。？?]{0,24}(?:没通过|未通过|不通过|失败)|(?:最近|近)\s*(?:\d+|[一二三四五六七八九十]+)\s*天[^。？?]*失败/
const COMPARE_QUESTION = /对比|比较|差异|两.?次运行|较上一次/
const RUN_ID_IN_QUESTION = /(?<![\da-f])[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}(?![\da-f])/gi
const DISCOVER_QUESTION = /有哪些.*场景|查找场景|搜索场景|列出场景|看下场景|所有场景|场景列表|(找|搜索|查找|列出|查看|看下).*(场景|工作流)|找对账/
const BUSINESS_RECORDS_QUESTION = /(?:有哪些|列出|查询|查一下|查下|查找|搜索|检索)[^。？?]{0,30}(?:厂家|制造商|供应商)|(?:厂家|制造商|供应商)[^。？?]{0,20}(?:名单|列表|有哪些)/
const EXPLAIN_QUESTION = /这个场景|这一步|在做什么|解释步骤|引用不到/
const PROPOSE_QUESTION =
  /改成|写清楚|修改建议|改用前一步|把.{1,16}改|修改这步|(在|紧接着).*(后|之后|前|之前)(加|增加|插入|新增).*步|(删掉|删除|去掉).*(步|步骤)|(移动|调换|挪动).*(步|步骤)/
const KNOWLEDGE_QUESTION = /按知识|根据术语|用做法|根据地图|知识建议|补全场景|按订单号|根据已有知识|(?:根据|基于|参考)[^。？?]{0,100}(?:已发布[^。？?]{0,60}做法|地图)/

export function cleanAssistantQuestion(question: string): string {
  return question.replace(/^⚠️[^\n]*\n+/g, '').trim()
}

/** Resolve a relative comparison only when the visible page binds the current Run. */
export function isPreviousRunComparisonQuestion(question: string): boolean {
  const cleaned = cleanAssistantQuestion(question)
  return /上一次|上次|前一次|前一条/.test(cleaned) && /对比|比较|相比|变化|差异|区别/.test(cleaned)
}

export function extractScenarioSearchKeyword(question: string): string | undefined {
  const cleaned = cleanAssistantQuestion(question)
  const trimmed = cleaned.trim().replace(/[？?！!。.\s]+$/, '')
  if (/^(现在都有哪些场景|有哪些场景|所有场景|列出场景|场景列表|看下场景|查看场景)$/i.test(trimmed)) {
    return undefined
  }
  const match = /(?:找|搜索|查找|筛选)\s*(?:名字含|包含|名称含|有关)?\s*([^\s,，。？?]+?)\s*(?:相关的?|的)?(?:场景|工作流)?$/i.exec(trimmed)
  if (match && match[1]) {
    const kw = match[1].replace(/^(名字含|包含|名称含)/, '').replace(/(场景|工作流|的)$/, '').trim()
    if (kw && kw.length > 0 && kw.length < 30) return kw
  }
  return undefined
}

const GUIDE_TOPIC_MATCHES: readonly { topic: AssistantGuideTopic; pattern: RegExp }[] = [
  { topic: 'accounts', pattern: /目标账号|账号表|登录账号/ },
  { topic: 'browser', pattern: /受管浏览器|浏览器画面|登录画面/ },
  { topic: 'evidence', pattern: /失败证据|截图|trace|证据/i },
  { topic: 'platform-config', pattern: /平台配置|平台.?AI|浏览器.?AI|模型配置/ },
  { topic: 'studio', pattern: /场景工作区|解释步骤|编写场景/ },
  { topic: 'scenarios', pattern: /场景/ },
  { topic: 'runs', pattern: /运行|诊断这次/ },
  { topic: 'targets', pattern: /目标系统|目标/ },
]

export function inferGuideTopic(question: string): AssistantGuideTopic | undefined {
  return GUIDE_TOPIC_MATCHES.find((item) => item.pattern.test(question))?.topic
}

export function inferAssistantFocus(question: string): AssistantFocus | undefined {
  if (/一直等|等待|登录|认证/.test(question)) return 'waiting'
  if (/慢在|耗时|哪里慢/.test(question)) return 'timing'
  if (/失败|为什么/.test(question)) return 'failure'
  return undefined
}

/** 业务快照的实体类型以用户明确点名的对象为准，不能猜成默认的厂家。 */
export function inferBusinessRecordEntityType(question: string): 'manufacturer' | 'supplier' | 'ambiguous' | undefined {
  const cleaned = cleanAssistantQuestion(question)
  const manufacturer = /厂家|制造商/.test(cleaned)
  const supplier = /供应商/.test(cleaned)
  if (manufacturer && supplier) return 'ambiguous'
  if (manufacturer) return 'manufacturer'
  if (supplier) return 'supplier'
  return undefined
}

export function matchAssistantCapabilities(question: string): AssistantCapabilityId[] {
  const hits: AssistantCapabilityId[] = []
  const knowledgeComposeRequest = KNOWLEDGE_QUESTION.test(question) && /(?:建议|补全|编写|生成|补充)/.test(question)
  if (IN_PAGE_GUIDANCE_QUESTION.test(question)) hits.push('in-page.guidance')
  if (COMPARE_QUESTION.test(question) || isPreviousRunComparisonQuestion(question)) hits.push('run.compare')
  if (DIAGNOSE_QUESTION.test(question)) hits.push('run.diagnose')
  if (!IN_PAGE_GUIDANCE_QUESTION.test(question) && GUIDE_QUESTION.test(question)) hits.push('platform.guide')
  if (DISCOVER_QUESTION.test(question)) hits.push('scenario.discover')
  if (BUSINESS_RECORDS_QUESTION.test(question)) hits.push('target.business-records.list')
  if (EXPLAIN_QUESTION.test(question) && !knowledgeComposeRequest) hits.push('scenario.explain')
  const hypotheticalDeletion = /(?:删掉|删除|去掉)[^。？?]{0,24}(?:会怎样|会怎么样|会不会|有什么影响|会发生什么)/.test(question)
  const orderedWaitAndCheck = /(?:等|等待)[^。；!?]{0,100}(?:再|然后|后)[^。；!?]{0,100}(?:确认|检查|断言|校验)/.test(question)
  if ((PROPOSE_QUESTION.test(question) || orderedWaitAndCheck) && !knowledgeComposeRequest && !hypotheticalDeletion) hits.push('scenario.propose-step')
  if (KNOWLEDGE_QUESTION.test(question)) hits.push('scenario.compose_with_knowledge')
  return hits
}

export function inferAssistantCapability(question: string): AssistantCapabilityId | null {
  const hits = matchAssistantCapabilities(question)
  return hits.length === 1 ? hits[0]! : null
}

/**
 * 把「路由不出能力」从硬拒答降级成带候选的澄清。
 *
 * 平台 AI 是可选项。未启用时走纯正则路径，判不出来就只能回 TASK_UNSUPPORTED，
 * 用户被挡回且拿不到任何可操作线索——只能自己猜平台听得懂什么措辞。
 * 给出当前权限可用的能力候选，用户点一下即可继续。
 * `clarify.options` 上限 8 项，能力总数 6，容得下。
 */
export function clarifyAvailableCapabilities(
  available: readonly AssistantCapabilityId[],
): AssistantRouteDecision {
  return {
    type: 'clarify',
    missingFields: ['capabilityId'],
    question: '没有识别出你想做的事，请选择一项继续。',
    options: available.slice(0, 8).map((id) => ({ id, label: assistantCapability(id).label, kind: 'capability' as const })),
  }
}

const PAGE_DEICTIC_QUESTION = /这里|这个|这一页|本页|为什么不行|怎么回事|什么问题|咋回事/
const DETERMINISTIC_STEP_HELP_QUESTION = /(?:确定性步骤|规则步骤)[^。？?]{0,80}(?:可以|能否|是否支持)[^。？?]{0,80}(?:重试|超时)|(?:确定性步骤|规则步骤)[^。？?]{0,80}(?:重试|超时)[^。？?]{0,80}(?:怎么设置|如何配置)/
const PLATFORM_KNOWLEDGE_AVAILABILITY_QUESTION = /^(?:识途(?:平台)?|平台)(?:里|内|中|上)?(?:有没有|有无|是否有|有|能否查到|能查到)[^。？?]{1,80}(?:数据|资料|知识|信息|记录)(?:吗|呢)?[？?。]?$/

/** A question about what the platform knows must reach fact lookup, even if
 * the classifier cannot name a more specialized capability. */
export function isPlatformKnowledgeAvailabilityQuestion(question: string): boolean {
  const cleaned = cleanAssistantQuestion(question)
  return PLATFORM_KNOWLEDGE_AVAILABILITY_QUESTION.test(cleaned) &&
    !/(?:删除|删掉|修改|写入|提交|导入|生成|创建)/.test(cleaned) &&
    !BUSINESS_RECORDS_QUESTION.test(cleaned)
}

/** First-use recording questions ask for a workflow guide, not a knowledge
 * summary of how scenario steps are represented internally. */
export function isRecordingOnboardingGuideQuestion(question: string): boolean {
  const cleaned = cleanAssistantQuestion(question)
  return /(?:如何|怎么|怎样|在哪里|哪儿)[^。？?]{0,100}(?:录制|创建)[^。？?]{0,60}(?:场景|工作流)/.test(cleaned) &&
    !/(?:替我|直接帮我|自动)(?:录制|创建)/.test(cleaned)
}

export function isTargetDeletionGuideQuestion(question: string): boolean {
  return /(?:删(?:除|掉)?(?:当前|这个|该)?目标|目标(?:系统)?[^。？?]{0,12}删(?:除|掉))/.test(question)
}

/** Current target account and session state is a fact lookup, even when the
 * page has an account-health button that tempts the model into page guidance. */
export function isTargetAccountFactQuestion(question: string): boolean {
  const cleaned = cleanAssistantQuestion(question)
  return !/(?:在哪|哪里|入口|按钮|菜单|路径|怎么打开|怎么进入|怎么去)/.test(cleaned) &&
    !/(?:删(?:除|掉)|修改|写入|提交|创建|启用|停用|关闭|释放|回收|接管|重置)/.test(cleaned) &&
    /(?:(?:账号|账户)[^。？?]{0,60}(?:健康|可用|就绪|认证|会话|租约)|(?:健康|认证|会话|租约)[^。？?]{0,60}(?:账号|账户))/.test(cleaned)
}

/** A question about an actual run needs Run records, not the saved scenario definition. */
export function isScenarioRunResultQuestion(question: string): boolean {
  const cleaned = cleanAssistantQuestion(question)
  return /场景|流程/.test(cleaned) &&
    /成功|通过|跑过|运行过|试跑过/.test(cleaned) &&
    /已经|刚才|最近|上次|实际|现在|目前|有没有|是否|了吗|了没|跑过/.test(cleaned) &&
    !/如何|怎么|怎样|标准|条件|规则|判断/.test(cleaned)
}

/** A multi-run failure question on a scenario page must stay in that scenario. */
export function isScenarioFailureDigestQuestion(question: string): boolean {
  const cleaned = cleanAssistantQuestion(question)
  return /场景|流程/.test(cleaned) && /失败|报错|错误/.test(cleaned) &&
    /最近|近\s*(?:\d+|[一二三四五六七八九十]+)\s*天|这些|多次|一批|归纳|汇总|聚类|主要/.test(cleaned) &&
    !/哪个按钮|在哪里|哪里看|怎么打开/.test(cleaned)
}

function pageRoutingPrior(
  page: AssistantPageContext['page'] | undefined,
): AssistantCapabilityId | null {
  if (page === 'run') return 'run.diagnose'
  if (page === 'studio') return 'scenario.explain'
  return null
}

export function routeAssistantTurn(input: {
  question: string
  capabilityHint?: AssistantCapabilityId
  pageContext?: AssistantPageContext
  available: readonly AssistantCapabilityId[]
}): AssistantRouteDecision {
  const cleanQuestion = cleanAssistantQuestion(input.question)
  const matchingHits = matchAssistantCapabilities(cleanQuestion).filter((id) => input.available.includes(id))
  const context = normalizeAssistantPageContext(input.pageContext)
  const hasRunContext = Boolean(context?.runId || cleanQuestion.match(RUN_ID_IN_QUESTION)?.length)
  const hasKnowledge = input.available.includes('knowledge.answer')
  if (!input.capabilityHint && context?.runId && input.available.includes('run.compare') &&
      isPreviousRunComparisonQuestion(cleanQuestion)) {
    return routeAssistantTurn({ ...input, capabilityHint: 'run.compare' })
  }
  if (!input.capabilityHint && context?.pageKind === 'target' &&
      input.available.includes('platform.guide') && isTargetDeletionGuideQuestion(cleanQuestion)) {
    return {
      type: 'dispatch', capabilityId: 'platform.guide',
      slots: { question: input.question, topic: 'targets', ...(context.targetId ? { targetId: context.targetId } : {}) },
    }
  }
  if (hasKnowledge && !input.capabilityHint && context?.pageKind === 'target' &&
      context.targetId && isTargetAccountFactQuestion(cleanQuestion)) {
    return { type: 'dispatch', capabilityId: 'knowledge.answer', slots: { targetId: context.targetId } }
  }
  if (hasKnowledge && !input.capabilityHint && context?.scenarioId && !context.runId &&
      isScenarioRunResultQuestion(cleanQuestion)) {
    return { type: 'dispatch', capabilityId: 'knowledge.answer', slots: { scenarioId: context.scenarioId } }
  }
  if (hasKnowledge && !input.capabilityHint && context?.scenarioId && !context.runId &&
      isScenarioFailureDigestQuestion(cleanQuestion)) {
    return { type: 'dispatch', capabilityId: 'knowledge.answer', slots: { scenarioId: context.scenarioId } }
  }
  if (hasKnowledge && !input.capabilityHint && DETERMINISTIC_STEP_HELP_QUESTION.test(cleanQuestion)) {
    return { type: 'dispatch', capabilityId: 'knowledge.answer', slots: {} }
  }
  if (hasKnowledge && !input.capabilityHint && isPlatformKnowledgeAvailabilityQuestion(cleanQuestion)) {
    return { type: 'dispatch', capabilityId: 'knowledge.answer', slots: {} }
  }
  if (!input.capabilityHint && input.available.includes('platform.guide') &&
    isRecordingOnboardingGuideQuestion(cleanQuestion)) {
    return { type: 'dispatch', capabilityId: 'platform.guide',
      slots: { question: input.question, topic: 'scenarios' } }
  }
  const mayBeRunMisroute = !input.capabilityHint ||
    input.capabilityHint === 'run.diagnose' || input.capabilityHint === 'knowledge.answer'
  const asksAboutSession = /账号|会话|登录|认证|租约|占用|排队/.test(cleanQuestion)
  const asksAboutSchedule = /调度|触发|跳过|没跑|未跑|没有跑/.test(cleanQuestion)
  const asksAboutFailureGroup = /(?:这些|这批|多次|一批|全部|所有).*(?:失败|报错|错误)|(?:失败|报错|错误).*(?:同一个|共同|归纳|汇总|聚类)/.test(cleanQuestion)
  // A status question on a session or schedule page is about that resource,
  // even if the wording also resembles a Run diagnosis. Likewise, plural
  // failures on a filtered Run list ask for an aggregate, not one Run ID.
  if (hasKnowledge && mayBeRunMisroute && !hasRunContext && (
    (context?.pageKind === 'session' && asksAboutSession) ||
    (context?.pageKind === 'schedule' && asksAboutSchedule) ||
    (context?.pageKind === 'run' && context.view?.filters?.status === 'FAILED' && asksAboutFailureGroup)
  )) {
    const slots: Record<string, unknown> = {}
    if (context?.targetId) slots.targetId = context.targetId
    if (context?.primaryRef?.kind === 'session') slots.sessionId = context.primaryRef.id
    if (context?.primaryRef?.kind === 'schedule') slots.scheduleId = context.primaryRef.id
    if (context?.view?.selectedRef?.kind === 'schedule') slots.scheduleId = context.view.selectedRef.id
    return { type: 'dispatch', capabilityId: 'knowledge.answer', slots }
  }
  const inferred = matchingHits.length === 1 ? matchingHits[0]! : null
  const hint = input.capabilityHint
  if (hint && !input.available.includes(hint)) {
    return {
      type: 'unsupported',
      reasonCode: 'CAPABILITY_FORBIDDEN',
      message: '当前权限不能使用该助手能力',
    }
  }
  if (!hint && matchingHits.length > 1) {
    return {
      type: 'clarify',
      missingFields: ['capabilityId'],
      question: '识别到多个可能的操作，请选择一项继续。',
      options: matchingHits.slice(0, 8).map((id) => ({ id, label: assistantCapability(id).label, kind: 'capability' as const })),
    }
  }
  if (hint && matchingHits.length > 0 && !matchingHits.includes(hint)) {
    const competing = matchingHits[0]!
    return {
      type: 'clarify',
      missingFields: ['capabilityId'],
      question: '这句话也可能是在请求另一项助手能力，请选择本次要执行的操作。',
      options: [
        { id: hint, label: assistantCapability(hint).label, kind: 'capability' },
        { id: competing, label: assistantCapability(competing).label, kind: 'capability' },
      ],
    }
  }
  let chosen = hint && (!inferred || inferred === hint) ? hint : inferred
  if (!chosen) {
    const prior = pageRoutingPrior(input.pageContext?.page)
    if (prior && input.available.includes(prior) && PAGE_DEICTIC_QUESTION.test(cleanQuestion)) {
      chosen = prior
    }
  }
  if (!chosen) {
    return {
      type: 'unsupported',
      reasonCode: 'TASK_UNSUPPORTED',
      message: '当前支持运行诊断、运行对比、场景解释、场景发现、业务数据列表、单步修改建议、知识辅助编写和功能导览。请选择其中一项。',
    }
  }
  if (!input.available.includes(chosen)) {
    return {
      type: 'unsupported',
      reasonCode: 'CAPABILITY_FORBIDDEN',
      message: '当前权限不能使用该助手能力',
    }
  }
  const slots: Record<string, unknown> = {}
  const ctx = context
  if (chosen === 'run.diagnose') {
    if (ctx?.runId) slots.runId = ctx.runId
    if (ctx?.stepId) slots.stepId = ctx.stepId
    if (!slots.runId && RECENT_FAILED_RUN_QUESTION.test(input.question)) {
      slots.findRecentFailed = true
    }
  }
  if (chosen === 'run.compare') {
    const explicitRunIds = [...cleanQuestion.matchAll(RUN_ID_IN_QUESTION)].map((match) => match[0]!.toLowerCase())
    const pageRunId = normalizeAssistantPageContext(ctx)?.runId
    if (explicitRunIds.length > 2) {
      return {
        type: 'clarify',
        missingFields: ['baseRunId', 'targetRunId'],
        question: '问题里有超过两个运行 ID，请明确指定要对比的两个运行。',
      }
    }
    if (explicitRunIds.length === 2) {
      slots.baseRunId = explicitRunIds[0]
      slots.targetRunId = explicitRunIds[1]
    } else {
      if (pageRunId) slots.baseRunId = pageRunId
      if (explicitRunIds[0] && explicitRunIds[0] !== pageRunId) slots.targetRunId = explicitRunIds[0]
      if (pageRunId && explicitRunIds.length === 0 && isPreviousRunComparisonQuestion(cleanQuestion)) {
        slots.comparePrevious = true
      }
    }
    if (slots.baseRunId && slots.baseRunId === slots.targetRunId) {
      return {
        type: 'clarify',
        missingFields: ['targetRunId'],
        question: '请选择另一条不同的运行进行对比。',
      }
    }
  }
  if (chosen.startsWith('scenario.') && ctx?.scenarioId) {
    slots.scenarioId = ctx.scenarioId
    if (ctx.stepId) slots.stepId = ctx.stepId
    if (ctx.draftRevision) slots.draftRevision = ctx.draftRevision
    if (ctx.versionId) slots.versionId = ctx.versionId
  }
  if (chosen === 'scenario.discover') {
    if (ctx?.targetId) slots.targetId = ctx.targetId
    const kw = extractScenarioSearchKeyword(input.question)
    if (kw) slots.filter = kw
  }
  if (chosen === 'target.business-records.list') {
    if (ctx?.targetId) slots.targetId = ctx.targetId
    const entityType = inferBusinessRecordEntityType(cleanQuestion)
    if (entityType === 'ambiguous') {
      return { type: 'clarify', missingFields: ['entityType'], question: '你想查厂家／制造商，还是供应商？请先选一种业务记录。' }
    }
    if (entityType) slots.entityType = entityType
    if (!slots.targetId) {
      return { type: 'clarify', missingFields: ['targetId'], question: '请选择要查询的目标系统。' }
    }
    if (!entityType) {
      return { type: 'clarify', missingFields: ['entityType'], question: '请明确要查厂家／制造商，还是供应商业务记录。' }
    }
  }
  if (chosen === 'run.diagnose') {
    const focus = inferAssistantFocus(input.question)
    if (focus) slots.focus = focus
  }
  if (chosen === 'scenario.explain') {
    if (ctx?.draftRevision) delete slots.versionId
  }
  if (chosen === 'platform.guide') {
    slots.question = input.question
    if (ctx?.targetId) slots.targetId = ctx.targetId
    const topic = inferGuideTopic(input.question)
    if (topic) slots.topic = topic
  }
  if (chosen === 'in-page.guidance') {
    slots.question = input.question
    if (ctx?.page) slots.page = ctx.page
    if (ctx?.targetId) slots.targetId = ctx.targetId
    if (ctx?.stepId) slots.stepId = ctx.stepId
    if (ctx?.scenarioId) slots.scenarioId = ctx.scenarioId
  }
  if (chosen === 'run.diagnose' && !slots.runId && !slots.findRecentFailed) {
    return { type: 'clarify', missingFields: ['runId'], question: '请选择要分析的一次运行。' }
  }
  if (chosen === 'run.compare' && (!slots.baseRunId || (!slots.targetRunId && !slots.comparePrevious))) {
    return {
      type: 'clarify',
      missingFields: [!slots.baseRunId ? 'baseRunId' : 'targetRunId'],
      question: '请指定要对比的两个运行。',
    }
  }
  if (chosen !== 'platform.guide' && chosen !== 'in-page.guidance' && chosen !== 'scenario.discover' && chosen !== 'target.business-records.list' && chosen.startsWith('scenario.') && !slots.scenarioId) {
    return {
      type: 'clarify',
      missingFields: ['scenarioId'],
      question: '请选择要解释或修改的场景。',
      options: input.available.includes('scenario.discover')
        ? [{ id: 'scenario.discover', label: '查看可用场景列表' }]
        : undefined,
    }
  }
  if (chosen === 'scenario.propose-step') {
    slots.changeRequest = input.question
    if (!slots.scenarioId) {
      return {
        type: 'clarify',
        missingFields: ['scenarioId'],
        question: '请先进入或指定场景后再生成编排建议。',
      }
    }
  }
  if (chosen === 'scenario.compose_with_knowledge') {
    slots.changeRequest = input.question
    if (!slots.draftRevision) {
      return {
        type: 'clarify',
        missingFields: ['draftRevision'],
        question: '请先保存草稿后再生成知识建议。',
      }
    }
  }
  return { type: 'dispatch', capabilityId: chosen, slots }
}

export async function scenarioDocumentDigest(document: ScenarioDocument): Promise<string> {
  return sha256Hex(canonicalJson(scenarioDocumentSchema.parse(document)))
}

export async function canAdoptAssistantProposal(input: {
  proposal: AssistantProposal
  revision: number
  document: ScenarioDocument
  hasFieldDrafts: boolean
  remoteConflict: boolean
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (input.hasFieldDrafts) return { ok: false, reason: '当前步骤还有未提交的字段草稿，不能覆盖' }
  if (input.remoteConflict) return { ok: false, reason: '远端草稿已变化，请基于当前草稿重新生成' }
  if (input.revision !== input.proposal.draftRevision) {
    return { ok: false, reason: '草稿版本已变化，请基于当前草稿重新生成' }
  }
  const digest = await scenarioDocumentDigest(input.document)
  if (digest !== input.proposal.documentDigest) {
    return { ok: false, reason: '本地文档与生成来源不一致，请基于当前草稿重新生成' }
  }
  return { ok: true }
}

export async function canAdoptAuthoringProposal(input: {
  proposal: AssistantAuthoringProposal
  scenarioId: string
  revision: number
  document: ScenarioAuthoringDocumentV2
  hasFieldDrafts: boolean
  remoteConflict: boolean
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (input.scenarioId !== input.proposal.scenarioId) {
    return { ok: false, reason: '这条建议属于其他场景，请打开对应场景工作区后再采纳' }
  }
  if (input.hasFieldDrafts) return { ok: false, reason: '当前步骤还有未提交的字段草稿，不能覆盖' }
  if (input.remoteConflict) return { ok: false, reason: '远端草稿已变化，请基于当前草稿重新生成' }
  if (input.revision !== input.proposal.base.draftRevision) {
    return { ok: false, reason: '草稿版本已变化，请基于当前草稿重新生成' }
  }
  const digest = await authoringDocumentDigest(input.document)
  if (digest !== input.proposal.base.documentDigest) {
    return { ok: false, reason: '本地文档与生成来源不一致，请基于当前草稿重新生成' }
  }
  return { ok: true }
}

export type StepProposalError = { code: string; message: string }

export function applyStepProposal(
  document: ScenarioDocument,
  stepId: string,
  change: AssistantStepChange,
): { ok: true; document: ScenarioDocument; diffs: AssistantProposal['diffs'] } | { ok: false; error: StepProposalError } {
  const parsed = scenarioDocumentSchema.parse(document)
  const index = parsed.steps.findIndex((step) => step.id === stepId)
  if (index < 0) return { ok: false, error: { code: 'STEP_NOT_FOUND', message: '步骤不在该草稿中' } }
  const current = parsed.steps[index]!
  if (change.kind === 'ai_instruction') {
    if (!isAiStepType(current.type)) {
      return { ok: false, error: { code: 'STEP_TYPE_MISMATCH', message: '只能改写已有 AI 步骤的指令' } }
    }
    const next = stepSchema.parse({ ...current, input: { ...current.input, instruction: change.instruction } })
    return replaceStep(parsed, index, current, next, [['input', 'instruction']])
  }
  if (change.kind === 'assert_expectation') {
    if (current.type !== 'assert') {
      return { ok: false, error: { code: 'STEP_TYPE_MISMATCH', message: '只能修改确定性断言的预期' } }
    }
    const next = stepSchema.parse({ ...current, input: { ...current.input, expect: change.expect } })
    return replaceStep(parsed, index, current, next, [['input', 'expect']])
  }
  if (current.type !== 'fill') {
    return { ok: false, error: { code: 'STEP_TYPE_MISMATCH', message: '只能为 fill 步骤绑定前序输出' } }
  }
  const input = current.input as FillInput
  const next = stepSchema.parse({
    ...current,
    input: {
      target: input.target,
      from: change.from,
      fromField: change.fromField,
      ...(input.sensitive ? { sensitive: true } : {}),
    },
  })
  return replaceStep(parsed, index, current, next, [
    ['input', 'from'],
    ['input', 'fromField'],
    ['input', 'value'],
  ])
}

function replaceStep(
  document: ScenarioDocument,
  index: number,
  current: Step,
  next: Step,
  fields: string[][],
): { ok: true; document: ScenarioDocument; diffs: AssistantProposal['diffs'] } {
  const steps = document.steps.slice()
  steps[index] = next
  const updated = scenarioDocumentSchema.parse({ ...document, steps })
  return {
    ok: true,
    document: updated,
    diffs: fields.map((fieldPath) => {
      const from = readPath(current, fieldPath)
      const to = readPath(next, fieldPath)
      const changeType: 'add' | 'modify' | 'remove' =
        from === undefined ? 'add' : to === undefined ? 'remove' : 'modify'
      return {
        fieldPath,
        from,
        to,
        changeType,
      }
    }),
  }
}

function readPath(value: unknown, path: string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

export function compareCompileDiagnostics(
  baseline: readonly CompileDiagnostic[],
  next: readonly CompileDiagnostic[],
): { added: CompileDiagnostic[]; leftover: CompileDiagnostic[] } {
  const keyOf = (item: CompileDiagnostic) =>
    `${item.code}|${item.stepId ?? ''}|${(item.fieldPath ?? []).join('.')}`
  const baselineKeys = new Set(baseline.map(keyOf))
  const nextKeys = new Set(next.map(keyOf))
  return {
    added: next.filter((item) => !baselineKeys.has(keyOf(item))),
    leftover: baseline.filter((item) => nextKeys.has(keyOf(item))),
  }
}


export type ProjectedFactPack = {
  text: string
  citations: AssistantCitationKey[]
  facts: AssistantFact[]
  missingInformation: string[]
  nextActions: AssistantNextAction[]
  truncated: boolean
}

export function projectRunFacts(
  observation: RunObservation,
  input: { stepId?: string; focus?: AssistantFocus; now?: string } = {},
): ProjectedFactPack {
  const run = observation.run
  const facts: AssistantFact[] = []
  const citations: AssistantCitationKey[] = [citationKey('run', run.id)]
  const missing: string[] = []
  const add = (id: string, text: string, keys: AssistantCitationKey[]) => {
    facts.push({ id, text, citations: keys })
    citations.push(...keys)
  }
  add('status', `运行状态为 ${run.status}，证据轴为 ${run.evidenceStatus}。`, [citationKey('run', run.id)])
  const placementDescription = assistantWaitingPlacementDescription(run.placement.state)
  if (placementDescription) add('placement', placementDescription, [citationKey('run', run.id)])
  if (run.status === 'WAITING_FOR_AUTH') {
    add('auth', '运行正在等待目标系统认证，不是步骤失败。', [citationKey('run', run.id)])
  }
  if (run.status === 'NEEDS_REVIEW') {
    add('review', '运行进入人工核查。未知副作用不得无条件重放。', [citationKey('run', run.id)])
  }
  const targetSteps = input.stepId
    ? stepRunsOf(run.stepRuns, input.stepId)
    : run.stepRuns
  if (input.stepId && targetSteps.length === 0) {
    missing.push('指定步骤不在该 Run 的 Snapshot 中')
  }
  for (const step of targetSteps) {
    const stepCite = citationKey('step', step.stepId)
    const last = step.attempts.at(-1)
    const failedThenOk =
      step.attempts.some((item) => item.status === 'FAILED') && step.status === 'SUCCEEDED'
    if (failedThenOk) {
      add(
        `step-${step.id}-retry`,
        `步骤「${step.name}」曾有失败 Attempt，后续尝试成功，不能据此把整个运行判为失败。`,
        [stepCite, citationKey('stepRun', step.id)],
      )
    }
    if (last?.error) {
      add(`step-${step.id}-error`, `步骤「${step.name}」最近错误：${last.error.code}。`, [
        stepCite,
        citationKey('attempt', last.id),
      ])
    }
    if (last && !last.finishedAt) missing.push(`步骤「${step.name}」的 Attempt 尚未结束，耗时未知`)
    if (step.startedAt && step.finishedAt) {
      const ms = Date.parse(step.finishedAt) - Date.parse(step.startedAt)
      if (Number.isFinite(ms) && (input.focus === 'timing' || input.focus === 'overview')) {
        add(`step-${step.id}-time`, `步骤「${step.name}」耗时 ${Math.max(0, ms)} 毫秒。`, [
          citationKey('stepRun', step.id),
        ])
      }
    }
  }
  if (run.evidenceStatus !== 'COMPLETE') {
    missing.push('证据不完整，不能把补证据等同于重跑业务操作')
  }
  const text = facts.map((item) => item.text).join('\n')
  const truncated = text.length > ASSISTANT_MAX_FACT_CHARS
  const kept = truncated ? facts.slice(0, Math.max(1, Math.floor(facts.length / 2))) : facts
  if (truncated) missing.push('事实包已截断，只保留部分步骤说明')
  const nextActions: AssistantNextAction[] = [
    {
      kind: 'run.detail',
      label: '打开运行详情',
      href: `/runs/${run.id}`,
      citations: [citationKey('run', run.id)],
    },
  ]
  if (observation.evidence.items.length > 0) {
    nextActions.push({
      kind: 'run.evidence',
      label: '查看运行证据',
      href: `/runs/${run.id}`,
      citations: [citationKey('run', run.id)],
    })
  }
  if (run.status === 'WAITING_FOR_AUTH') {
    nextActions.push({
      kind: 'run.auth',
      label: '处理目标系统登录',
      href: `/runs/${run.id}`,
      citations: [citationKey('run', run.id)],
    })
  }
  if (run.status === 'NEEDS_REVIEW') {
    nextActions.push({
      kind: 'run.review',
      label: '去核查页处理',
      href: `/runs/${run.id}`,
      citations: [citationKey('run', run.id)],
    })
  }
  return {
    text: kept.map((item) => item.text).join('\n'),
    citations: [...new Set(kept.flatMap((item) => item.citations))],
    facts: kept,
    missingInformation: missing,
    nextActions,
    truncated,
  }
}

export function filterGuideCatalog(
  granted: readonly string[],
  topic?: AssistantGuideTopic,
): AssistantGuideItem[] {
  return ASSISTANT_GUIDE_CATALOG.filter((entry) => !topic || entry.topic === topic)
    .filter((entry) => missingAssistantPermissions(granted, entry.requiredPermissions).length === 0)
    .map((entry) =>
      assistantGuideItemSchema.parse({
        topic: entry.topic,
        title: entry.title,
        href: entry.href,
        steps: entry.steps,
        availability: 'available',
      }),
    )
}

export function scenarioFactsForModel(document: ScenarioDocument, stepId?: string) {
  return {
    inputs: document.inputs.map((item) => ({ key: item.key, label: item.label })),
    selectedStepId: stepId ?? null,
    steps: document.steps.map((step) => {
      if (step.type !== 'fill') {
        return { id: step.id, name: step.name, type: step.type, input: step.input }
      }
      return {
        id: step.id,
        name: step.name,
        type: step.type,
        input: {
          from: step.input.from,
          fromField: step.input.fromField,
          sensitive: isSensitiveFillInput(step.input),
          hasLiteralValue: step.input.value !== undefined,
        },
      }
    }),
  }
}
