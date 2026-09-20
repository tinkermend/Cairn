import { z } from 'zod'
import { frozenNotificationPolicySchema } from './notifications.js'
import { aiExecutionConfigSchema } from './ai-runtime.js'
import { evidencePolicySchema } from './evidence-policy.js'
import { pageRefSchema } from './managed-browser.js'
import { frozenTargetAuthSchema } from './platform-config.js'
import { mapCapturePolicySchema } from './map-capture.js'
import { frozenMapConsumptionSchema } from './map-consumption.js'
import { frozenMapJobSchema, frozenTargetAccessPolicySchema } from './map-jobs.js'
import { frozenAuthVerificationSchema } from './session-auth.js'
import { platformRunAuthRecoverySchema } from './session-auth-recovery.js'
import { candidateGroupsSchema, moduleManifestSchema, type ModuleManifest } from './authoring-document.js'
import { IMPORTED_OUTCOME_PROTOCOL, outcomeManifestSchema, type OutcomeManifest } from './outcome.js'
import { runtimeInvariantManifestSchema, type RuntimeInvariantManifest } from './runtime-invariant.js'
import { frozenCredentialBindingSchema } from './credentials.js'
import { secretRefSchema } from './secret-ref.js'
import { sessionPolicySchema } from './session.js'
import {
  contextKeySchema,
  AI_ATOMIC_ACTIONS_PROTOCOL,
  executionPolicySchema,
  FORBIDDEN_CONTEXT_KEYS,
  hasAiSteps,
  stepSchema,
} from './step.js'
import { targetDescriptorSchema } from './target-descriptor.js'
import {
  entityIdSchema,
  jsonValueSchema,
  RUNTIME_SCHEMA_VERSION,
  runtimeSchemaVersionSchema,
  utcInstantSchema,
  type JsonValue,
} from './wire.js'

/**
 * Run / StepRun / Attempt 状态词表。
 *
 * 只冻合法取值。谁能迁到谁，由 Engine 与条件更新卡住——Zod 画状态机
 * 既验不了并发，也会在 P3 恢复路径一改就逼所有调用方升契约。
 *
 * 取消请求单独记录，不把 CANCELLING 做成主状态：确认前不能伪装成已终止。
 */
export const RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'RECOVERING',
  'WAITING_FOR_AUTH',
  'HOLDING',
  'NEEDS_REVIEW',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
export const runStatusSchema = z.enum(RUN_STATUSES)

export const ACTIVE_RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'RECOVERING',
  'WAITING_FOR_AUTH',
  'HOLDING',
  'NEEDS_REVIEW',
] as const
export type ActiveRunStatus = (typeof ACTIVE_RUN_STATUSES)[number]

export const DEBUG_MODES = ['holdOnFailure', 'holdAfterEach', 'runThrough'] as const
export type DebugMode = (typeof DEBUG_MODES)[number]
export const debugModeSchema = z.enum(DEBUG_MODES)

export const debugCheckpointReasonSchema = z.enum(['step_failed', 'step_succeeded', 'author_pause'])
export type DebugCheckpointReason = z.infer<typeof debugCheckpointReasonSchema>

export const debugCheckpointSchema = z.strictObject({
  mode: z.enum(['holdOnFailure', 'holdAfterEach']),
  reason: debugCheckpointReasonSchema,
  stepId: entityIdSchema,
  stepOrdinal: z.number().int().nonnegative(),
  pageRef: pageRefSchema.optional(),
  url: z.string().optional(),
  contextKeys: z.array(z.string()),
  sessionGeneration: z.number().int().nonnegative(),
  fencingToken: z.string(),
  overlayRevision: z.number().int().nonnegative(),
})
export type DebugCheckpoint = z.infer<typeof debugCheckpointSchema>

export const debugOverlaySchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  stepOverrides: z.record(
    z.string(),
    z.strictObject({
      target: targetDescriptorSchema,
    }),
  ),
})
export type DebugOverlay = z.infer<typeof debugOverlaySchema>

export const TERMINAL_RUN_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number]

export const STEP_RUN_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
] as const
export type StepRunStatus = (typeof STEP_RUN_STATUSES)[number]
export const stepRunStatusSchema = z.enum(STEP_RUN_STATUSES)

export const ATTEMPT_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number]
export const attemptStatusSchema = z.enum(ATTEMPT_STATUSES)

/**
 * 领取 / Engine / 迟到 finishAttempt：不得再自动推进。
 * NEEDS_REVIEW 在此集合内，但还不是最终结论。
 */
export const HALTED_RUN_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'] as const
export type HaltedRunStatus = (typeof HALTED_RUN_STATUSES)[number]

/** review / 取消幂等 / 控制台「还能不能操作」：已经有最终结论。 */
export const FINISHED_RUN_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const
export type FinishedRunStatus = (typeof FINISHED_RUN_STATUSES)[number]

const HALTED_RUN = new Set<string>(HALTED_RUN_STATUSES)
const FINISHED_RUN = new Set<string>(FINISHED_RUN_STATUSES)

export function isHaltedRunStatus(status: RunStatus): boolean {
  return HALTED_RUN.has(status)
}

export function isFinishedRunStatus(status: RunStatus): boolean {
  return FINISHED_RUN.has(status)
}

export { FORBIDDEN_CONTEXT_KEYS }

export const MAX_RUN_INPUT_KEYS = 64

export const runInputKeySchema = contextKeySchema.refine(
  (key) => !(FORBIDDEN_CONTEXT_KEYS as readonly string[]).includes(key),
  'input 键不得使用对象保留名',
)

/**
 * 不用 `z.record`：Zod 读键时会丢掉 JSON 的 `__proto__` 自有属性，验收要求必须拒掉。
 * 用 `getOwnPropertyNames` 才能看到这个键。
 */
export const runInputSchema = z.unknown().transform((raw, ctx) => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    ctx.addIssue({ code: 'custom', message: 'input 必须是对象' })
    return z.NEVER
  }
  const keys = Object.getOwnPropertyNames(raw)
  if (keys.length > MAX_RUN_INPUT_KEYS) {
    ctx.addIssue({ code: 'custom', message: `input 最多 ${MAX_RUN_INPUT_KEYS} 个键` })
    return z.NEVER
  }
  const out: Record<string, JsonValue> = {}
  for (const key of keys) {
    const keyOk = runInputKeySchema.safeParse(key)
    if (!keyOk.success) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: keyOk.error.issues[0]?.message ?? '非法 input 键',
      })
      continue
    }
    const value = Object.getOwnPropertyDescriptor(raw, key)?.value
    const valOk = jsonValueSchema.safeParse(value)
    if (!valOk.success) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: valOk.error.issues[0]?.message ?? '非法 input 值',
      })
      continue
    }
    out[key] = valOk.data
  }
  return out
})
export type RunInput = z.infer<typeof runInputSchema>

export const runSnapshotSchema = z
  .strictObject({
    schemaVersion: runtimeSchemaVersionSchema,
    runId: entityIdSchema,
    /** 未绑定 Target 的 Snapshot 不得执行。缺这个字段在这里就失败。 */
    targetId: entityIdSchema,
    targetAccountId: entityIdSchema.optional(),
    secretRef: secretRefSchema.optional(),
    /**
     * 冻结的凭据版本与登录名配对。可选：旧快照无此字段仍可解析，
     * 不能证明配对时不得用当前用户名猜配。
     */
    credentialBinding: frozenCredentialBindingSchema.optional(),
    scenarioId: entityIdSchema,
    scenarioVersionId: entityIdSchema,
    steps: z.array(stepSchema),
    input: runInputSchema,
    createdAt: utcInstantSchema,
    deadlineAt: utcInstantSchema.optional(),
    policy: executionPolicySchema.optional(),
    /**
     * 解析后的会话策略。可选：既有快照无此字段仍可解析；
     * 新 Run 创建时必须写入完整值（历史 Run 可解释当时怎么执行）。
     */
    sessionPolicy: sessionPolicySchema.optional(),
    /**
     * 冻结的证据策略。可选：存量快照没有它仍可解析，缺省走平台默认。
     * 新 Run 创建时写入解析后的完整值。
     */
    evidencePolicy: evidencePolicySchema.optional(),
    executorVersions: z.record(z.string().min(1), z.string().min(1).max(64)).optional(),
    /**
     * 冻结的 Target 页面源。新 Run 必写；存量快照缺字段时回落实时查询。
     */
    allowedOrigins: z.array(z.string().min(1).max(256)).max(16).optional(),
    loginOrigin: z.string().min(1).max(256).optional(),
    loginPath: z.string().max(2048).optional(),
    /**
     * 冻结的浏览器 AI 执行配置。含 AI Step 时必须存在；确定性历史快照可缺省。
     */
    aiExecution: aiExecutionConfigSchema.optional(),
    aiAtomicActionsProtocol: z.literal(AI_ATOMIC_ACTIONS_PROTOCOL).optional(),
    importedOutcomeProtocol: z.literal(IMPORTED_OUTCOME_PROTOCOL).optional(),
    /** 创建时读取的平台配置修订。旧快照可缺省。 */
    platformConfigRevision: z.number().int().positive().optional(),
    notificationPolicy: frozenNotificationPolicySchema.optional(),
    /**
     * 冻结的 Target 认证解释。新 Run 必写；旧快照缺字段时 Worker 仍读当前行。
     */
    targetAuth: frozenTargetAuthSchema.optional(),
    /**
     * 冻结的核验规则与能力等级。缺省按 LEGACY 解释，旧快照仍可解码。
     */
    authVerification: frozenAuthVerificationSchema.optional(),
    /**
     * 冻结的运行中认证恢复次数。旧快照缺字段按 0/0（不恢复）。
     */
    runAuthRecovery: platformRunAuthRecoverySchema.optional(),
    /**
     * 冻结的地图被动采集策略。旧快照无字段按关闭解释。
     */
    mapCapturePolicy: mapCapturePolicySchema.optional(),
    /**
     * 冻结的地图运行消费。旧快照无字段按 off；新 Run 明确写入 off 或启用配置。
     */
    mapConsumption: frozenMapConsumptionSchema.optional(),
    /**
     * 冻结的 Target 授权修订。新 Run 必写；旧快照缺字段仍按 allowedOrigins 解释。
     */
    accessPolicy: frozenTargetAccessPolicySchema.optional(),
    /**
     * 地图作业分片。旧快照和无字段表示用户 Run。
     */
    mapJob: frozenMapJobSchema.optional(),
    /**
     * 集合成员准入协议。旧快照和无字段表示独立 Run。
     */
    suiteAdmission: z
      .strictObject({
        protocol: z.literal('suite-admission@1'),
        suiteRunId: entityIdSchema,
        memberId: z.string().trim().min(1).max(64),
      })
      .optional(),
    /**
     * 冻结的动作模块引用清册。可选：旧快照没有此字段表示无动作模块。
     */
    moduleManifest: moduleManifestSchema.optional(),
    /**
     * 冻结的只读回退候选组。可选：旧快照和无字段表示 pinned / 无回退。
     */
    candidateGroups: candidateGroupsSchema.optional(),
    /**
     * 冻结的成功条件清册。可选：旧快照没有此字段表示当时未定义成功条件。
     * 严禁增加 .default()，避免存量快照重算 digest 漂移。
     */
    outcomeManifest: outcomeManifestSchema.optional(),
    /**
     * 冻结的运行期约束清册。可选：旧快照没有此字段表示当时未声明运行期约束。
     * 严禁增加 .default()，避免存量快照重算 digest 漂移。
     */
    runtimeInvariantManifest: runtimeInvariantManifestSchema.optional(),
    /** 预留给 P1。摘要不能代替内嵌的 steps。 */
    digest: z.string().min(1).max(128).optional(),
  })
  .superRefine((snapshot, ctx) => {
    if (snapshot.steps.some((step) => step.type === 'ai_action' && 'operation' in step.input) && !snapshot.aiAtomicActionsProtocol) {
      ctx.addIssue({ code: 'custom', path: ['aiAtomicActionsProtocol'], message: '原子 AI 操作必须声明执行协议能力' })
    }
    if (snapshot.outcomeManifest?.entries.some((entry) => entry.provenance === 'imported') && !snapshot.importedOutcomeProtocol) {
      ctx.addIssue({ code: 'custom', path: ['importedOutcomeProtocol'], message: '导入成功条件必须声明执行协议能力' })
    }
    if (snapshot.secretRef && !snapshot.targetAccountId) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetAccountId'],
        message: '有 secretRef 时必须同时给出 targetAccountId',
      })
    }
    if (hasAiSteps(snapshot.steps) && !snapshot.aiExecution) {
      ctx.addIssue({
        code: 'custom',
        path: ['aiExecution'],
        message: '含 AI 步骤的运行必须冻结 AI 执行配置',
      })
    }

    const stepIds = new Set<string>()
    const outputKeys = new Set<string>()
    for (const [index, step] of snapshot.steps.entries()) {
      if (stepIds.has(step.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'id'],
          message: '同一 Snapshot 内 step.id 不能重复',
        })
      }
      stepIds.add(step.id)

      if (step.outputKey) {
        if (outputKeys.has(step.outputKey)) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', index, 'outputKey'],
            message: '同一 Snapshot 内 outputKey 不能重复',
          })
        }
        outputKeys.add(step.outputKey)
      }
    }
  })
export type RunSnapshot = z.infer<typeof runSnapshotSchema>

export { RUNTIME_SCHEMA_VERSION }
