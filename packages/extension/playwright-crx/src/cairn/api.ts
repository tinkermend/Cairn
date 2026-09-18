import {
  apiErrorSchema,
  claimRecordingBindingBodySchema,
  createRecordingBodySchema,
  loginBodySchema,
  loginResponseSchema,
  meResponseSchema,
  openRecordingBindingResponseSchema,
  recordingBindingSchema,
  recordingDraftDetailSchema,
  recordingStudioPath,
  authoringObservationSubmitSchema,
  targetObservationSchema,
  targetListResponseSchema,
  type ClaimRecordingBindingBody,
  type CreateRecordingBody,
  type LoginBody,
  type LoginResponse,
  type MeResponse,
  type RecordingBindingDto,
  type RecordingDraftDetailDto,
  type AuthoringObservationSubmit,
  type TargetListResponse,
  type TargetObservation,
} from '@cairn/shared'
import { CAIRN_API, performCairnRequest, type CairnApiCall, type CairnApiResult } from './api-bridge'

export class CairnApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CairnApiError'
  }
}

export const RECORDING_UPLOAD_DENIED_HINT =
  '当前账号没有录制上传权限，请联系管理员分配编写者角色'

export function formatCairnError(error: unknown): string {
  if (error instanceof CairnApiError) return error.message
  if (error instanceof Error && error.message.trim()) return error.message
  return '请求失败'
}

export function formatRecordingUploadError(error: unknown): string {
  if (error instanceof CairnApiError && (error.status === 403 || error.code === 'FORBIDDEN')) {
    return RECORDING_UPLOAD_DENIED_HINT
  }
  return formatCairnError(error)
}

async function dispatchApi(call: CairnApiCall): Promise<CairnApiResult> {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      const result = (await chrome.runtime.sendMessage({ event: CAIRN_API, ...call })) as
        | CairnApiResult
        | undefined
      if (result && typeof result === 'object' && 'ok' in result) return result
    }
  } catch {
    // Side Panel 消息失败时退回页内 fetch；CORS 已放行 chrome-extension://。
  }
  return performCairnRequest(call)
}

async function cairnFetch<T>(
  path: string,
  schema: { parse: (value: unknown) => T },
  init?: RequestInit,
  skipAuth = false,
): Promise<T> {
  const extraHeaders = init?.headers
  const headers =
    extraHeaders && !Array.isArray(extraHeaders) && !(extraHeaders instanceof Headers)
      ? (extraHeaders as Record<string, string>)
      : undefined
  const result = await dispatchApi({
    path,
    method: init?.method ?? 'GET',
    headers,
    body: typeof init?.body === 'string' ? init.body : undefined,
    skipAuth,
  })
  if (!result.ok) {
    throw new CairnApiError(0, 'NETWORK', result.error)
  }
  if (result.status < 200 || result.status >= 300) {
    const parsed = apiErrorSchema.safeParse(result.body)
    throw new CairnApiError(
      result.status,
      parsed.success ? parsed.data.code : 'REQUEST_FAILED',
      parsed.success ? parsed.data.message : `请求失败（HTTP ${result.status}）`,
    )
  }
  try {
    return schema.parse(result.body)
  } catch {
    throw new CairnApiError(result.status, 'INVALID_RESPONSE', '平台返回的数据无法识别')
  }
}

export function login(body: LoginBody): Promise<LoginResponse> {
  return cairnFetch(
    '/api/auth/login',
    loginResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginBodySchema.parse(body)),
    },
    true,
  )
}

export function fetchMe(): Promise<MeResponse> {
  return cairnFetch('/api/me', meResponseSchema)
}

export function fetchTargets(query?: {
  search?: string
  limit?: number
  status?: 'active' | 'disabled'
}): Promise<TargetListResponse> {
  const params = new URLSearchParams()
  if (query?.search) params.set('search', query.search)
  if (query?.limit) params.set('limit', String(query.limit))
  if (query?.status) params.set('status', query.status)
  const qs = params.toString()
  return cairnFetch(`/api/targets${qs ? `?${qs}` : ''}`, targetListResponseSchema)
}

export function submitAuthoringObservation(body: AuthoringObservationSubmit): Promise<TargetObservation> {
  return cairnFetch('/api/authoring/observations', targetObservationSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(authoringObservationSubmitSchema.parse(body)),
  })
}

export function uploadRecording(body: CreateRecordingBody): Promise<RecordingDraftDetailDto> {
  return cairnFetch('/api/recordings', recordingDraftDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createRecordingBodySchema.parse(body)),
  })
}

export async function fetchOpenRecordingBinding(): Promise<RecordingBindingDto | null> {
  const response = await cairnFetch('/api/recording-bindings/open', openRecordingBindingResponseSchema)
  return response.binding
}

export function claimRecordingBinding(body: ClaimRecordingBindingBody): Promise<RecordingBindingDto> {
  return cairnFetch('/api/recording-bindings/claim', recordingBindingSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(claimRecordingBindingBodySchema.parse(body)),
  })
}

export function studioReturnUrl(apiOrigin: string, binding: RecordingBindingDto): string {
  const webOrigin = apiOrigin.includes(':3030') ? 'http://localhost:5173' : apiOrigin
  return `${webOrigin.replace(/\/+$/, '')}${recordingStudioPath(binding.scenarioId, binding.recordingDraftId ?? undefined)}`
}

export async function ensureHostPermission(apiOrigin: string): Promise<void> {
  const origin = apiOrigin.replace(/\/+$/, '')
  const pattern = `${origin}/*`
  if (origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost')) return
  const granted = await chrome.permissions.request({ origins: [pattern] })
  if (!granted) throw new Error('未授权访问该 API 地址')
}
