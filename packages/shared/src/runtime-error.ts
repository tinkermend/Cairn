import { z } from 'zod'

/**
 * 执行域错误。给 Attempt / Evidence / Engine，不给 HTTP 响应。
 *
 * 浏览器看到的是 `apiErrorSchema`（code / message / requestId）。
 * 两边字段故意不对齐，避免有人把执行错误原样塞进 4xx 信封。
 */

export const EXECUTION_ERROR_CATEGORIES = [
  'VALIDATION',
  'TIMEOUT',
  'CANCELLED',
  'EXECUTOR',
  'INFRASTRUCTURE',
  'UNKNOWN',
] as const
export type ExecutionErrorCategory = (typeof EXECUTION_ERROR_CATEGORIES)[number]
export const executionErrorCategorySchema = z.enum(EXECUTION_ERROR_CATEGORIES)

/**
 * `retryable` 只是提示。耗尽重试、副作用未知、策略禁止重放，
 * 都由执行策略判断，不看这个布尔值自行重试。
 */
export const executionErrorCauseSchema = z.strictObject({
  code: z.string().min(1).max(128).optional(),
  message: z.string().min(1).max(1024).optional(),
})

export const executionErrorSchema = z.strictObject({
  code: z.string().min(1).max(128),
  category: executionErrorCategorySchema,
  retryable: z.boolean(),
  /** 可以进 Evidence 和前端的说明。内部细节只进服务端日志。 */
  safeMessage: z.string().min(1).max(2048),
  cause: executionErrorCauseSchema.optional(),
})
export type ExecutionError = z.infer<typeof executionErrorSchema>
export type ExecutionErrorCause = z.infer<typeof executionErrorCauseSchema>

/**
 * 取消请求已到达、本次尝试的结论不再采纳。
 *
 * 尝试可能已经跑完（Delay 正常返回、Echo 立即返回），但取消请求之后的成功不得写成
 * SUCCEEDED——Engine 与仓储层共用这一份，避免两处各写一个近似字面量。
 */
export const CANCELLED_ATTEMPT_ERROR: ExecutionError = Object.freeze({
  code: 'CANCELLED',
  category: 'CANCELLED',
  retryable: false,
  safeMessage: '取消请求已到达，本次尝试的结果不再采纳',
})
