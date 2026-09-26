import { z } from 'zod'
import { canonicalJson } from './canonical.js'
import { syncSha256 } from './sha256-sync.js'
import { locatorCandidateSchema } from './target-descriptor.js'
import { relativeAnchorSchema } from './target-descriptor.js'
import { entityIdSchema, jsonValueSchema } from './wire.js'
import { keyComboSchema, type Step } from './step.js'

export const AI_TASK_EVENT_PHASES = ['prepared', 'completed', 'failed', 'interrupted', 'unknown'] as const
export type AiTaskEventPhase = (typeof AI_TASK_EVENT_PHASES)[number]

export const AI_ELEMENT_BINDING_STATUSES = ['bound', 'unbound', 'not_applicable'] as const
export type AiElementBindingStatus = (typeof AI_ELEMENT_BINDING_STATUSES)[number]

export const AI_VALUE_PROVENANCE_KINDS = ['input', 'context', 'redacted', 'ambiguous', 'literal', 'none'] as const
export type AiValueProvenanceKind = (typeof AI_VALUE_PROVENANCE_KINDS)[number]

export const SOLIDIFIABLE_LEVELS = ['full', 'partial', 'blocked'] as const
export type SolidifiableLevel = (typeof SOLIDIFIABLE_LEVELS)[number]

export const TRACE_INTEGRITY_STATES = ['complete', 'partial', 'none'] as const
export type TraceIntegrityState = (typeof TRACE_INTEGRITY_STATES)[number]

export const AI_CALL_INTENTS = ['ai_act', 'ai_atomic', 'ai_locate', 'ai_extract', 'ai_assert'] as const
export type AiCallIntent = (typeof AI_CALL_INTENTS)[number]
export const aiCallIntentSchema = z.enum(AI_CALL_INTENTS)

export const AI_CALL_ROUTES = ['vision', 'aria_text'] as const
export type AiCallRoute = (typeof AI_CALL_ROUTES)[number]
export const aiCallRouteSchema = z.enum(AI_CALL_ROUTES)

/** 单个 Attempt 最多记录的动作数（按动作序号计，不按事件行计）。 */
export const MAX_AI_TASK_EVENTS_PER_ATTEMPT = 200

export const aiElementFingerprintSchema = z.strictObject({
  tag: z.string().min(1).max(64),
  role: z.string().max(64).nullable().optional(),
  accessibleName: z.string().max(256).nullable().optional(),
  texts: z.array(z.string().max(80)).max(3).default([]),
})
export type AiElementFingerprint = z.infer<typeof aiElementFingerprintSchema>

/**
 * 派发前的元素绑定。bound 必须带至少一个已验证候选；anchor 只是候选的作用域（行），
 * 单靠 anchor 不能定位到元素，不算已绑定。
 */
export const aiElementBindingSchema = z
  .strictObject({
    status: z.enum(AI_ELEMENT_BINDING_STATUSES),
    reason: z.string().max(128).nullable().optional(),
    redirected: z.boolean().default(false),
    candidates: z.array(locatorCandidateSchema).max(5).default([]),
    anchor: relativeAnchorSchema.nullable().optional(),
    dataDependent: z.boolean().default(false),
    fingerprint: aiElementFingerprintSchema.nullable().optional(),
  })
  .refine((binding) => binding.status !== 'bound' || binding.candidates.length > 0, {
    message: 'bound 绑定必须至少包含一个已验证候选',
    path: ['candidates'],
  })
export type AiElementBinding = z.infer<typeof aiElementBindingSchema>

export const aiValueProvenanceSchema = z.strictObject({
  kind: z.enum(AI_VALUE_PROVENANCE_KINDS),
  source: z.string().max(256).nullable().optional(),
  value: z.string().max(1024).nullable().optional(),
})
export type AiValueProvenance = z.infer<typeof aiValueProvenanceSchema>

export const aiPageObservationSchema = z.strictObject({
  url: z.string().max(2048),
  urlPattern: z.string().max(512),
  documentEpoch: z.number().int().nonnegative(),
  readyState: z.string().max(32),
  timestamp: z.string(),
})
export type AiPageObservation = z.infer<typeof aiPageObservationSchema>

export const aiTaskEventSchema = z.strictObject({
  id: entityIdSchema.optional(),
  attemptId: entityIdSchema,
  runId: entityIdSchema,
  stepRunId: entityIdSchema,
  agentInstanceId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative(),
  phase: z.enum(AI_TASK_EVENT_PHASES),
  source: z.literal('action_edge'),
  actionName: z.string().min(1).max(64),
  sdkVersion: z.string().min(1).max(64),
  elementDescription: z.string().max(256).nullable().optional(),
  binding: aiElementBindingSchema,
  valueProvenance: aiValueProvenanceSchema,
  paramsSummary: z.record(z.string(), jsonValueSchema).nullable().optional(),
  pageBefore: aiPageObservationSchema,
  /** 动作完成且 SDK 等待导航与网络空闲之后的页面观察；只在 completed 事件上出现。 */
  pageAfter: aiPageObservationSchema.nullable().optional(),
  writeSignalCount: z.number().int().nonnegative().default(0),
  writeSignalPaths: z.array(z.string().max(256)).max(5).default([]),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  errorCode: z.string().max(128).nullable().optional(),
  timestamp: z.string(),
})
export type AiTaskEvent = z.infer<typeof aiTaskEventSchema>

export const aiPathObservationSchema = z.strictObject({
  attemptId: entityIdSchema,
  runId: entityIdSchema,
  stepRunId: entityIdSchema,
  stepId: entityIdSchema,
  scenarioId: entityIdSchema,
  scenarioVersion: z.number().int().positive().nullable().optional(),
  targetId: entityIdSchema,
  /** 未绑定账号的 Run 为 null，不拿其他 id 冒充。 */
  targetAccountId: entityIdSchema.nullable(),
  stepDefinitionDigest: z.string().length(64),
  namespaceDigest: z.string().length(64),
  signature: z.string().length(64).nullable(),
  actionCount: z.number().int().nonnegative(),
  solidifiableLevel: z.enum(SOLIDIFIABLE_LEVELS),
  solidifiableReasons: z.array(z.string().max(256)),
  traceIntegrity: z.enum(TRACE_INTEGRITY_STATES),
  modelCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  /** AI 端口收尾时的结果；Attempt 的最终结论以 attempts 表为准，洞察读取时再核对。 */
  stepResult: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN']),
  recordedAt: z.string(),
})
export type AiPathObservation = z.infer<typeof aiPathObservationSchema>

export const AI_TASK_EVIDENCE_PROTOCOL = 'snapshot.aiTaskEvidence@1'

export const aiTaskEvidenceSnapshotSchema = z.strictObject({
  actionEdge: z.enum(['off', 'record']),
  maxEventsPerAttempt: z.number().int().positive().optional(),
})
export type AiTaskEvidenceSnapshot = z.infer<typeof aiTaskEvidenceSnapshotSchema>

/** Target 级采集开关：inherit 沿用平台配置，off 表示该目标系统不采集。 */
export const AI_ACTION_TRACE_TARGET_MODES = ['inherit', 'off'] as const
export type AiActionTraceTargetMode = (typeof AI_ACTION_TRACE_TARGET_MODES)[number]
export const aiActionTraceTargetModeSchema = z.enum(AI_ACTION_TRACE_TARGET_MODES)
export const targetAiActionTraceBodySchema = z.strictObject({ mode: aiActionTraceTargetModeSchema })
export type TargetAiActionTraceBody = z.infer<typeof targetAiActionTraceBodySchema>

export const platformAiPathLearningSchema = z.strictObject({
  /** 是否为含 ai_action 的新 Run 冻结 AI 动作事实采集。出厂关闭。 */
  actionTrace: z.boolean(),
})
export type PlatformAiPathLearning = z.infer<typeof platformAiPathLearningSchema>
export const FACTORY_AI_PATH_LEARNING: PlatformAiPathLearning = { actionTrace: false }

/**
 * 建 Run 时决定是否冻结动作事实采集。只在平台开启、Target 未关闭、且确有 ai_action 时返回 record；
 * 其余情况返回 undefined，快照不写该字段，与未启用本能力前逐字节一致。
 */
export function resolveAiTaskEvidence(input: {
  platform: PlatformAiPathLearning | undefined
  targetMode: AiActionTraceTargetMode | null | undefined
  steps: readonly Pick<Step, 'type'>[]
}): AiTaskEvidenceSnapshot | undefined {
  if (!input.platform?.actionTrace) return undefined
  if (input.targetMode === 'off') return undefined
  if (!input.steps.some((step) => step.type === 'ai_action')) return undefined
  return { actionEdge: 'record', maxEventsPerAttempt: MAX_AI_TASK_EVENTS_PER_ATTEMPT }
}

/** 游标分页：每页只含完整的动作序号；cursorOrdinal 为下一页的起始序号（含）。 */
export const aiTaskListQuerySchema = z.strictObject({
  cursorOrdinal: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type AiTaskListQuery = z.infer<typeof aiTaskListQuerySchema>

export const aiTaskListResponseSchema = z.strictObject({
  events: z.array(aiTaskEventSchema),
  nextCursor: z.number().int().nonnegative().optional(),
  observation: aiPathObservationSchema.nullable().optional(),
})
export type AiTaskListResponse = z.infer<typeof aiTaskListResponseSchema>

export const aiPathInsightsQuerySchema = z.strictObject({
  windowDays: z.coerce.number().int().min(1).max(90).default(30),
})
export type AiPathInsightsQuery = z.infer<typeof aiPathInsightsQuerySchema>

export const stepAiPathInsightSchema = z.strictObject({
  stepId: entityIdSchema,
  attemptsCount: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  topSignatureRatio: z.number().min(0).max(1),
  solidifiableLevelDistribution: z.record(z.enum(SOLIDIFIABLE_LEVELS), z.number().int().nonnegative()),
  medianCalls: z.number().int().nonnegative(),
  medianTokens: z.number().int().nonnegative(),
  medianDurationMs: z.number().int().nonnegative(),
  /** 样本少于 AI_PATH_INSIGHT_MIN_SAMPLES 时为 true，界面显示“数据不足”，不做推断。 */
  insufficientData: z.boolean(),
  latestEligibleAttempt: z
    .strictObject({
      attemptId: entityIdSchema,
      runId: entityIdSchema,
      signature: z.string().nullable(),
      solidifiableLevel: z.enum(SOLIDIFIABLE_LEVELS),
      recordedAt: z.string(),
    })
    .nullable(),
})
export type StepAiPathInsight = z.infer<typeof stepAiPathInsightSchema>

export const aiPathInsightsResponseSchema = z.array(stepAiPathInsightSchema)
export type AiPathInsightsResponse = z.infer<typeof aiPathInsightsResponseSchema>

export const AI_PATH_INSIGHT_MIN_SAMPLES = 3
/** 洞察读取的观察行上限（按时间倒序取最近的），避免窗口内全量加载。 */
export const AI_PATH_INSIGHT_MAX_ROWS = 2000

/**
 * 规范化步骤中影响执行的关键字段取摘要。
 * 不包含名称（name）或显示用元数据。
 */
export function computeStepDefinitionDigest(step: Step): string {
  const normalized = {
    type: step.type,
    effectType: step.effectType,
    input: step.input,
    contextBindings: 'contextBindings' in step && Array.isArray((step as any).contextBindings)
      ? (step as any).contextBindings
      : undefined,
    policy: step.policy ? {
      timeoutMs: step.policy.timeoutMs,
      retryLimit: step.policy.retryLimit,
      resolution: (step.policy as any).resolution,
    } : undefined,
  }
  return syncSha256(canonicalJson(normalized))
}

export interface NamespaceDigestInput {
  targetId: string
  targetAccountId: string | null
  scenarioId: string
  stepId: string
  stepDefinitionDigest: string
  knowledgeContextDigest?: string | null
  sdkVersion: string
  modelName: string
  modelFamily: string
}

export function computeNamespaceDigest(input: NamespaceDigestInput): string {
  const normalized = {
    targetId: input.targetId,
    targetAccountId: input.targetAccountId ?? null,
    scenarioId: input.scenarioId,
    stepId: input.stepId,
    stepDefinitionDigest: input.stepDefinitionDigest,
    knowledgeContextDigest: input.knowledgeContextDigest ?? null,
    sdkVersion: input.sdkVersion,
    model: {
      name: input.modelName,
      family: input.modelFamily,
    },
  }
  return syncSha256(canonicalJson(normalized))
}

const SIGNATURE_IGNORED_ACTIONS = new Set(['Scroll', 'Sleep', 'CursorMove'])

/**
 * 每个动作取最终事件：终态优先于 prepared，终态之间 completed 优先。
 * 按 agentInstanceId + ordinal 聚合，保持输入顺序（调用方按 ordinal、时间排序）。
 */
export function finalAiTaskEvents(events: readonly AiTaskEvent[]): AiTaskEvent[] {
  const byAction = new Map<string, AiTaskEvent>()
  for (const event of events) {
    const key = `${event.agentInstanceId}:${event.ordinal}`
    const existing = byAction.get(key)
    if (!existing) {
      byAction.set(key, event)
      continue
    }
    if (existing.phase === 'completed') continue
    if (event.phase === 'completed' || existing.phase === 'prepared') byAction.set(key, event)
  }
  return Array.from(byAction.values()).sort((a, b) => a.ordinal - b.ordinal)
}

function valueForSignature(event: AiTaskEvent) {
  return {
    kind: event.valueProvenance.kind,
    source: event.valueProvenance.source ?? null,
    digest: event.valueProvenance.value ? syncSha256(event.valueProvenance.value).slice(0, 16) : null,
  }
}

/**
 * 计算 Attempt 的路径签名 aiPathSignature@1。
 * 规范：按动作执行顺序取（规范化动作类型、首个已验证候选及其行作用域、值来源引用/字面量摘要、派发前 URL 模式）。
 * Scroll、Sleep、CursorMove 不进入签名；坐标与耗时不进入签名。
 * 需要目标元素但没有已验证候选时签名为空；无需目标（not_applicable）的动作以自身净化后的参数参与签名。
 */
export function computeAiPathSignature(events: readonly AiTaskEvent[]): string | null {
  const finals = finalAiTaskEvents(events)
  if (finals.length === 0) return null

  const items: unknown[] = []
  for (const event of finals) {
    if (SIGNATURE_IGNORED_ACTIONS.has(event.actionName)) continue

    if (event.binding.status === 'not_applicable') {
      items.push({
        action: event.actionName,
        params: event.paramsSummary ?? null,
        value: valueForSignature(event),
        urlPattern: event.pageBefore.urlPattern,
      })
      continue
    }

    const candidate = event.binding.status === 'bound' ? event.binding.candidates?.[0] : undefined
    if (!candidate) return null
    items.push({
      action: event.actionName,
      target: { candidate, anchor: event.binding.anchor ?? null },
      value: valueForSignature(event),
      urlPattern: event.pageBefore.urlPattern,
    })
  }

  if (items.length === 0) return null
  return syncSha256(canonicalJson(items))
}

/**
 * 依据方案 §7.3 的动作映射判定路径的可固化等级：
 * - blocked：轨迹不完整、步骤未成功，或含没有对应确定性步骤的动作；
 * - partial：可映射但有需要人工处理或只能退成原子 AI 步骤的动作；
 * - full：全部可直接映射为确定性步骤。
 */
export function evaluateSolidifiableLevel(
  events: readonly AiTaskEvent[],
  stepResult: string = 'SUCCEEDED',
  traceIntegrity: TraceIntegrityState = 'complete',
): { level: SolidifiableLevel; reasons: string[] } {
  const blockers: string[] = []
  const partials: string[] = []

  if (traceIntegrity !== 'complete') blockers.push('TRAJECTORY_INCOMPLETE')
  if (stepResult !== 'SUCCEEDED') blockers.push('STEP_NOT_SUCCEEDED')

  for (const event of finalAiTaskEvents(events)) {
    const action = event.actionName
    const hasCandidate = event.binding.status === 'bound' && event.binding.candidates.length > 0
    const step = `STEP_${event.ordinal}`

    if (action === 'Tap' || action === 'Click') {
      if (!hasCandidate) partials.push(`TAP_UNBOUND_${step}`)
    } else if (action === 'DoubleClick' || action === 'RightClick') {
      if (!hasCandidate) partials.push(`${action.toUpperCase()}_UNBOUND_${step}`)
    } else if (action === 'Input') {
      const mode = typeof event.paramsSummary?.mode === 'string' ? event.paramsSummary.mode : 'replace'
      if (mode !== 'replace') partials.push(`INPUT_MODE_${mode}_${step}`)
      else if (!hasCandidate) partials.push(`INPUT_UNBOUND_${step}`)
    } else if (action === 'ClearInput') {
      if (!hasCandidate) partials.push(`CLEAR_INPUT_UNBOUND_${step}`)
    } else if (action === 'KeyboardPress') {
      const key = event.paramsSummary?.keyName
      if (typeof key !== 'string' || !keyComboSchema.safeParse(key).success) partials.push(`KEY_NOT_SUPPORTED_${step}`)
    } else if (action === 'Navigate' || action === 'Sleep' || action === 'Scroll') {
      // Navigate / Sleep 可直接映射；Scroll 在固化时默认放弃并提示。
    } else {
      // Hover、DragAndDrop、LongPress、CursorMove、Swipe、Pinch、Reload、GoBack、GoForward、RegisterFileChooserAccept 等
      blockers.push(`UNSUPPORTED_ACTION_${action}_${step}`)
    }
  }

  const reasons = [...blockers, ...partials]
  if (blockers.length > 0) return { level: 'blocked', reasons }
  if (partials.length > 0) return { level: 'partial', reasons }
  return { level: 'full', reasons: [] }
}
