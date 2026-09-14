import { REQUEST_ID_HEADER } from '@cairn/shared'
import { loadCairnSession } from './session'

export const CAIRN_API = 'cairnApi'

export type CairnApiCall = {
  event?: typeof CAIRN_API
  path: string
  method?: string
  headers?: Record<string, string>
  body?: string
  skipAuth?: boolean
}

export type CairnApiResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: string }

function newRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function formatTransportError(error: unknown, apiOrigin?: string): string {
  const fallback = apiOrigin ? `连不上 ${apiOrigin}` : '连不上平台 API'
  if (error instanceof TypeError) {
    return `${fallback}。控制台已登录不能代替插件登录，请确认本地 API 已启动。`
  }
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

export async function performCairnRequest(
  call: CairnApiCall,
  deps: {
    loadSession?: () => Promise<{ apiOrigin: string; accessToken: string }>
    fetchImpl?: typeof fetch
  } = {},
): Promise<CairnApiResult> {
  const loadSession = deps.loadSession ?? loadCairnSession
  const fetchImpl = deps.fetchImpl ?? fetch
  let apiOrigin = ''
  try {
    const session = await loadSession()
    apiOrigin = session.apiOrigin
    const headers: Record<string, string> = {
      Accept: 'application/json',
      [REQUEST_ID_HEADER]: newRequestId(),
      ...call.headers,
    }
    if (!call.skipAuth && session.accessToken) {
      headers.Authorization = `Bearer ${session.accessToken}`
    }
    const res = await fetchImpl(`${session.apiOrigin}${call.path}`, {
      method: call.method ?? 'GET',
      headers,
      body: call.body,
    })
    const body: unknown = await res.json().catch(() => null)
    return { ok: true, status: res.status, body }
  } catch (error) {
    return { ok: false, error: formatTransportError(error, apiOrigin) }
  }
}

export function handleCairnApiMessage(message: CairnApiCall): Promise<CairnApiResult> {
  return performCairnRequest(message)
}
