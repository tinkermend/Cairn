import { z } from 'zod'
import { secretRefSchema } from './secret-ref.js'
import { executionPolicySchema, stepSchema } from './step.js'
import {
  entityIdSchema,
  jsonValueSchema,
  RUNTIME_SCHEMA_VERSION,
  runtimeSchemaVersionSchema,
  utcInstantSchema,
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
    input: z.record(z.string(), jsonValueSchema),
    createdAt: utcInstantSchema,
    policy: executionPolicySchema.optional(),
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
