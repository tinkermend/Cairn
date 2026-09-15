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
  /** 领域错误附加体，例如编译诊断或冲突草稿 */
  details: z.unknown().optional(),
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

/**
 * 平台自有的请求关联 ID 头。出站只写这一个，不接受旧称 `x-cairn-run-id`。
 *
 * 它与 `runId` 是两条线：这里的值标识「一次 HTTP 请求」，
 * `runId` / `stepRunId` / `attemptId` 标识执行链路上的 Run，见宪法「可观测性」。
 */
export const REQUEST_ID_HEADER = 'x-cairn-request-id'

/** 网关/入口层通用的请求 ID 头。平台私有头缺失时沿用，避免两边日志拼不起来。 */
export const UPSTREAM_REQUEST_ID_HEADER = 'x-request-id'

export type RequestIdHeaders = Record<string, string | string[] | undefined>

/**
 * 可采纳的关联 ID 形状：ASCII 可见子集，最长 128。
 *
 * 上游给的值会原样进响应头、错误体和每一行日志。CRLF 注入由 Node 的 HTTP 解析器
 * 挡着，但长度不设上限意味着任何调用方都能让日志按行膨胀；形状不设约束则让
 * 「同一个 ID 串起三处」这条保证依赖对端的自觉。不合形状的值当作没给。
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

export const requestIdValueSchema = z
  .string()
  .regex(REQUEST_ID_PATTERN, 'requestId 须为 ASCII [A-Za-z0-9._:-]，最长 128')

export function isRequestId(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value)
}

/**
 * 入站请求 ID 取值优先级：平台私有头 → 网关通用头 → undefined（由调用方自生成）。
 * 每一层都要过形状校验，不合规的头视为缺失并继续向下找。
 */
export function resolveRequestId(headers: RequestIdHeaders): string | undefined {
  for (const name of [REQUEST_ID_HEADER, UPSTREAM_REQUEST_ID_HEADER]) {
    const raw = headers[name]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (value && isRequestId(value)) return value
  }
  return undefined
}
