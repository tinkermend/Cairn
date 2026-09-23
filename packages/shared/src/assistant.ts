import { z } from 'zod'
import { canonicalJson } from './canonical.js'
import { sha256Hex } from './internal-auth.js'
import { hasPermission, nextCursorSchema, type PermissionCode } from './rbac.js'
import { assertExpectSchema } from './browser-command.js'
import { outputFieldNameSchema } from './output-schema.js'
import { type RunObservation } from './run-api.js'
import { scenarioDocumentSchema, type CompileDiagnostic, type ScenarioDocument } from './scenario.js'
import {
  contextKeySchema,
  isAiStepType,
  stepSchema,
  type FillInput,
  type Step,
} from './step.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

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

export const ASSISTANT_CITATION_KINDS = ['run', 'stepRun', 'attempt', 'evidence', 'step'] as const
export type AssistantCitationKind = (typeof ASSISTANT_CITATION_KINDS)[number]

export const assistantCitationKeySchema = z
  .string()
  .regex(
    /^(run|stepRun|attempt|evidence|step):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
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
  'platform.config',
] as const
export type AssistantNextActionKind = (typeof ASSISTANT_NEXT_ACTION_KINDS)[number]
export const assistantNextActionKindSchema = z.enum(ASSISTANT_NEXT_ACTION_KINDS)

export const ASSISTANT_FOCUS = ['overview', 'failure', 'waiting', 'timing'] as const
export type AssistantFocus = (typeof ASSISTANT_FOCUS)[number]
export const assistantFocusSchema = z.enum(ASSISTANT_FOCUS)

export const ASSISTANT_PAGE_KINDS = ['run', 'studio', 'target', 'home', 'other'] as const

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
  stepRuns: readonly { id: string; stepId: string }[],
): string | undefined {
  const focusId = quoteStepFocusId(quote)
  if (!focusId) return undefined
  return stepRuns.find((step) => step.stepId === focusId || step.id === focusId)?.stepId
}

export const assistantPageContextSchema = z.strictObject({
  page: z.enum(ASSISTANT_PAGE_KINDS),
  runId: entityIdSchema.optional(),
  scenarioId: entityIdSchema.optional(),
  stepId: entityIdSchema.optional(),
  targetId: entityIdSchema.optional(),
  versionId: entityIdSchema.optional(),
  draftRevision: z.number().int().min(1).optional(),
  quote: assistantQuoteContextSchema.optional(),
})
export type AssistantPageContext = z.infer<typeof assistantPageContextSchema>

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
    label: '单步修改建议',
    requiredPermissions: ['ai:assist', 'workflow:read', 'workflow:write', 'target:read'],
    description: '为已保存草稿中的现有步骤生成受限候选',
  },
  {
    id: 'scenario.compose_with_knowledge',
    label: '知识辅助编写',
    requiredPermissions: ['ai:assist', 'workflow:read', 'workflow:write', 'target:read', 'map:read'],
    description: '基于已授权术语、地图与已发布做法生成可编辑草稿建议',
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
    capabilityId: 'menu.scenarios',
    title: '场景编排',
    href: '/scenarios',
    requiredPermissions: ['workflow:read'],
    steps: '打开「编写」分组下的「场景编排」，选择已绑定目标的场景。',
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
  items: z.array(assistantGuideItemSchema).max(8),
})
export type AssistantGuide = z.infer<typeof assistantGuideSchema>

export const assistantClarifySchema = z.strictObject({
  kind: z.literal('clarify'),
  question: z.string().min(1).max(512),
  missingFields: z.array(z.string().min(1).max(64)).max(8),
  options: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(128),
      }),
    )
    .max(8)
    .optional(),
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
}

export const assistantResultSchema = z.discriminatedUnion('kind', [
  assistantDiagnosisSchema,
  assistantCompareSchema,
  assistantExplanationSchema,
  assistantProposalSchema,
  assistantKnowledgeProposalSchema,
  assistantGuideSchema,
  assistantDiscoveryResultSchema,
  assistantClarifySchema,
  assistantUnsupportedSchema,
  assistantInaccessibleSchema,
  assistantInPageGuidanceSchema,
])
export type AssistantResult = z.infer<typeof assistantResultSchema>

export const assistantResultEnvelopeSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  result: assistantResultSchema,
  sourceDigest: z.string().optional(),
})
export type AssistantResultEnvelope = z.infer<typeof assistantResultEnvelopeSchema>

export function unpackAssistantResultEnvelope(raw: unknown): AssistantResult | null {
  if (!raw || typeof raw !== 'object') return null
  if ('version' in raw && 'result' in raw) {
    const parsed = assistantResultEnvelopeSchema.safeParse(raw)
    if (parsed.success) return parsed.data.result
  }
  const direct = assistantResultSchema.safeParse(raw)
  if (direct.success) return direct.data
  return null
}

export function packAssistantResultEnvelope(
  result: AssistantResult,
  version: 1 | 2 = 2,
  sourceDigest?: string,
): AssistantResultEnvelope {
  return {
    version,
    result,
    ...(sourceDigest ? { sourceDigest } : {}),
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

export const createAssistantTurnBodySchema = z.strictObject({
  clientTurnId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{8,128}$/, 'clientTurnId 须为 8–128 位 [A-Za-z0-9._:-]'),
  question: z.string().trim().min(1).max(ASSISTANT_MAX_QUESTION_CHARS),
  pageContext: assistantPageContextSchema.optional(),
  replyToTurnId: entityIdSchema.optional(),
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
    options: z
      .array(z.strictObject({ id: z.string().min(1).max(64), label: z.string().min(1).max(128) }))
      .max(8)
      .optional(),
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
          : capability.id.startsWith('scenario.')
            ? ['scenarioId']
            : [],
    })
  })
}

const IN_PAGE_GUIDANCE_QUESTION =
  /添加步骤|怎么添加|加步骤|在页面哪里|页面上哪里|按钮在哪|怎么保存|保存草稿|快捷键|怎么拖拽|怎么排序|怎么修改参数|页面怎么/
const GUIDE_QUESTION = /功能入口|怎么看|如何配置|菜单|怎样查看|在哪配置|哪里配置/
const DIAGNOSE_QUESTION = /为什么失败|失败原因|一直等|慢在|诊断这次|分析本次|这次运行|最近失败|最近一次失败/
const COMPARE_QUESTION = /对比|比较|差异|两.?次运行|较上一次/
const DISCOVER_QUESTION = /有哪些场景|查找场景|搜索场景|列出场景|看下场景|所有场景|场景列表|(找|搜索|查找|列出|查看|看下).*(场景|工作流)|找对账/
const BUSINESS_RECORDS_QUESTION = /有哪些(厂家|制造商|供应商)|查询(厂家|制造商|供应商)|(厂家|制造商|供应商)列表/
const EXPLAIN_QUESTION = /这个场景|这一步|在做什么|解释步骤|引用不到/
const PROPOSE_QUESTION = /改成|写清楚|修改建议|改用前一步|把.{1,16}改/
const KNOWLEDGE_QUESTION = /按知识|根据术语|用做法|根据地图|知识建议|补全场景|按订单号|根据已有知识/

export function cleanAssistantQuestion(question: string): string {
  return question.replace(/^⚠️[^\n]*\n+/g, '').trim()
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

export function matchAssistantCapabilities(question: string): AssistantCapabilityId[] {
  const hits: AssistantCapabilityId[] = []
  if (IN_PAGE_GUIDANCE_QUESTION.test(question)) hits.push('in-page.guidance')
  if (COMPARE_QUESTION.test(question)) hits.push('run.compare')
  if (DIAGNOSE_QUESTION.test(question)) hits.push('run.diagnose')
  if (!IN_PAGE_GUIDANCE_QUESTION.test(question) && (GUIDE_QUESTION.test(question) || /在哪|哪里/.test(question))) hits.push('platform.guide')
  if (DISCOVER_QUESTION.test(question)) hits.push('scenario.discover')
  if (BUSINESS_RECORDS_QUESTION.test(question)) hits.push('target.business-records.list')
  if (EXPLAIN_QUESTION.test(question)) hits.push('scenario.explain')
  if (PROPOSE_QUESTION.test(question)) hits.push('scenario.propose-step')
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
    options: available.slice(0, 8).map((id) => ({ id, label: assistantCapability(id).label })),
  }
}

const PAGE_DEICTIC_QUESTION = /这里|这个|这一页|本页|为什么不行|怎么回事|什么问题|咋回事/

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
      options: matchingHits.slice(0, 8).map((id) => ({ id, label: assistantCapability(id).label })),
    }
  }
  if (hint && matchingHits.length > 0 && !matchingHits.includes(hint)) {
    const competing = matchingHits[0]!
    return {
      type: 'clarify',
      missingFields: ['capabilityId'],
      question: '本次要做运行诊断，还是查找功能入口？请选一项后继续。',
      options: [
        { id: hint, label: assistantCapability(hint).label },
        { id: competing, label: assistantCapability(competing).label },
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
  const ctx = input.pageContext
  if (chosen === 'run.diagnose') {
    if (ctx?.runId) slots.runId = ctx.runId
    if (ctx?.stepId) slots.stepId = ctx.stepId
    if (!slots.runId && /最近失败|最近一次失败/.test(input.question)) {
      slots.findRecentFailed = true
    }
  }
  if (chosen === 'run.compare') {
    if (ctx?.runId) slots.baseRunId = ctx.runId
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
    slots.entityType = 'manufacturer'
    if (!slots.targetId) {
      return { type: 'clarify', missingFields: ['targetId'], question: '请选择要查询的目标系统。' }
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
    const topic = inferGuideTopic(input.question)
    if (topic) slots.topic = topic
  }
  if (chosen === 'in-page.guidance') {
    slots.question = input.question
    if (ctx?.page) slots.page = ctx.page
    if (ctx?.stepId) slots.stepId = ctx.stepId
    if (ctx?.scenarioId) slots.scenarioId = ctx.scenarioId
  }
  if (chosen === 'run.diagnose' && !slots.runId && !slots.findRecentFailed) {
    return { type: 'clarify', missingFields: ['runId'], question: '请选择要分析的一次运行。' }
  }
  if (chosen === 'run.compare' && (!slots.baseRunId || !slots.targetRunId)) {
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
    if (!slots.draftRevision || !slots.stepId) {
      return {
        type: 'clarify',
        missingFields: [!slots.stepId ? 'stepId' : 'draftRevision'],
        question: '请先保存草稿并选中要修改的步骤。',
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
  add(
    'placement',
    `调度位置为 ${run.placement.state}${run.placement.sessionStatus ? `，会话 ${run.placement.sessionStatus}` : ''}。`,
    [citationKey('run', run.id)],
  )
  if (run.status === 'WAITING_FOR_AUTH') {
    add('auth', '运行正在等待目标系统认证，不是步骤失败。', [citationKey('run', run.id)])
  }
  if ((ASSISTANT_WAITING_PLACEMENTS as readonly string[]).includes(run.placement.state)) {
    add('resource', `运行因 ${run.placement.state} 等待资源或原 Worker，主状态仍可能是 ${run.status}。`, [
      citationKey('run', run.id),
    ])
  }
  if (run.status === 'NEEDS_REVIEW') {
    add('review', '运行进入人工核查。未知副作用不得无条件重放。', [citationKey('run', run.id)])
  }
  const targetSteps = input.stepId
    ? run.stepRuns.filter((item) => item.stepId === input.stepId)
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
