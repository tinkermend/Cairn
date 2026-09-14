import type { ZodType } from 'zod'
import { apiErrorSchema, REQUEST_ID_HEADER, type ApiError } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'

/** 携带服务端 requestId 的错误，便于把前端报错与后端日志对上 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly payload: ApiError
  ) {
    super(payload.message)
    this.name = 'ApiRequestError'
  }

  get requestId(): string {
    return this.payload.requestId
  }
}

/**
 * 前端侧生成关联 ID。
 *
 * 不能直接用 `crypto.randomUUID`：它只在安全上下文可用，而识途控制台在私有化
 * 交付里恰恰常跑在 LAN 的明文 HTTP 上（开发期走 localhost / Vite 代理，
 * 属于安全上下文，测不出这个洞）。那里 `randomUUID` 是 undefined，
 * 直接调用会让每个请求在发出前就抛错——比拿不到关联 ID 严重得多。
 * `getRandomValues` 不受该限制。
 */
function newRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
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
  init?: RequestInit
): Promise<T> {
  const token = useAuthStore.getState().auth.accessToken
  const res = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      // 前端主动生成并送出自有请求 ID，浏览器与服务端日志因此能对上。
      // 失败时仍以错误体里的 requestId 为准——服务端可能另有上游来源。
      [REQUEST_ID_HEADER]: newRequestId(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })

  if (res.status === 204) {
    return undefined as T
  }

  const body: unknown = await res.json().catch(() => null)

  if (!res.ok) {
    // 旧请求晚到的 401 不能使刚建立的新会话失效。
    if (
      res.status === 401 &&
      path !== '/api/auth/login' &&
      token === useAuthStore.getState().auth.accessToken
    ) {
      useAuthStore.getState().auth.reset()
    }
    const parsed = apiErrorSchema.safeParse(body)
    throw new ApiRequestError(
      res.status,
      parsed.success
        ? parsed.data
        : {
            code: 'REQUEST_FAILED',
            message: `请求失败（HTTP ${res.status}）`,
            requestId: res.headers.get(REQUEST_ID_HEADER) ?? 'unknown',
          }
    )
  }

  return schema.parse(body)
}

/** 授权下载对象正文。Bearer 不会跟 `<img src>`，必须先拿 blob 再建 Object URL。 */
export async function apiFetchBlob(
  path: string
): Promise<{ blob: Blob; contentType: string }> {
  const token = useAuthStore.getState().auth.accessToken
  const res = await fetch(path, {
    headers: {
      Accept: '*/*',
      [REQUEST_ID_HEADER]: newRequestId(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })

  if (!res.ok) {
    if (
      res.status === 401 &&
      path !== '/api/auth/login' &&
      token === useAuthStore.getState().auth.accessToken
    ) {
      useAuthStore.getState().auth.reset()
    }
    const body: unknown = await res.json().catch(() => null)
    const parsed = apiErrorSchema.safeParse(body)
    throw new ApiRequestError(
      res.status,
      parsed.success
        ? parsed.data
        : {
            code: 'REQUEST_FAILED',
            message: `请求失败（HTTP ${res.status}）`,
            requestId: res.headers.get(REQUEST_ID_HEADER) ?? 'unknown',
          }
    )
  }

  return {
    blob: await res.blob(),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
  }
}
