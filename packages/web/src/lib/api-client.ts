import { apiErrorSchema, REQUEST_ID_HEADER, type ApiError } from '@cairn/shared'
import type { ZodType } from 'zod'

/** 携带服务端 requestId 的错误，便于把前端报错与后端日志对上 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly payload: ApiError,
  ) {
    super(payload.message)
    this.name = 'ApiRequestError'
  }

  get requestId(): string {
    return this.payload.requestId
  }
}

/**
 * 所有后端调用的唯一入口。
 *
 * 响应用 @cairn/shared 的 schema 解析——与 api 序列化时用的是同一批
 * schema 对象，契约漂移会在此处立刻暴露，而不是等到某个字段渲染成
 * undefined 才被发现。
 */
export async function apiFetch<T>(
  path: string,
  schema: ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...init?.headers },
  })

  const body: unknown = await res.json().catch(() => null)

  if (!res.ok) {
    const parsed = apiErrorSchema.safeParse(body)
    throw new ApiRequestError(
      res.status,
      parsed.success
        ? parsed.data
        : {
            code: 'REQUEST_FAILED',
            message: `请求失败（HTTP ${res.status}）`,
            requestId: res.headers.get(REQUEST_ID_HEADER) ?? 'unknown',
          },
    )
  }

  return schema.parse(body)
}
