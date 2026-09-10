import { z } from 'zod'

/**
 * 全平台统一的错误响应形状。
 *
 * 定在这里而非各自实现，是因为每个接口都会依赖它——形状定晚了，
 * 已写的前端错误处理要全部回头改。web 用同一个 schema 解析错误体，
 * 与成功响应走同一套契约机制。
 */
export const apiErrorSchema = z.object({
  /** 稳定的机器可读代码，前端据此分支；文案可变，代码不变 */
  code: z.string().min(1),
  /** 面向人的说明，可直接展示 */
  message: z.string().min(1),
  /** 关联到服务端日志的同一次请求 */
  requestId: z.string().min(1),
  /** 仅校验类错误携带，逐字段列出原因 */
  issues: z
    .array(
      z.object({
        path: z.string(),
        code: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
})

export type ApiError = z.infer<typeof apiErrorSchema>

/** HTTP 状态码到稳定错误代码的映射。未列出的按状态码归入两大类。 */
export const ERROR_CODE_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
}

export function errorCodeForStatus(status: number): string {
  return ERROR_CODE_BY_STATUS[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED')
}

/** 贯穿前端、api、worker 与日志的关联 ID。与 pino 的 runId 同源。 */
export const REQUEST_ID_HEADER = 'x-cairn-run-id'
