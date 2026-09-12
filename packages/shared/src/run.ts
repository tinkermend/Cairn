import { z } from 'zod'
import { evidencePolicySchema } from './evidence-policy.js'
import { secretRefSchema } from './secret-ref.js'
import { sessionPolicySchema } from './session.js'
import { contextKeySchema, executionPolicySchema, stepSchema } from './step.js'
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
  'NEEDS_REVIEW',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
export const runStatusSchema = z.enum(RUN_STATUSES)

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

/** input / context 键不得踩到原型链上的保留名。`contextKeySchema` 挡不住 `constructor`。 */
export const FORBIDDEN_CONTEXT_KEYS = [
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
] as const

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
    scenarioId: entityIdSchema,
    scenarioVersionId: entityIdSchema,
    steps: z.array(stepSchema),
    input: runInputSchema,
    createdAt: utcInstantSchema,
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
    /** 预留给 P1。摘要不能代替内嵌的 steps。 */
    digest: z.string().min(1).max(128).optional(),
  })
  .superRefine((snapshot, ctx) => {
    if (snapshot.secretRef && !snapshot.targetAccountId) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetAccountId'],
        message: '有 secretRef 时必须同时给出 targetAccountId',
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
