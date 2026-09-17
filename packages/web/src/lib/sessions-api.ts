import { z } from 'zod'
import { useAuthStore } from '@/stores/auth-store'
import { readSseStream } from '@/lib/sse'
import type { BrowserTransport } from '@/features/runs/browser-view'
import {
  acquireAuthControlResponseSchema,
  authControlHeartbeatResponseSchema,
  authControlInputReceiptSchema,
  managedBrowserMetaSchema,
  managedBrowserFrameSchema,
  sessionEventDtoSchema,
  sessionOperationDtoSchema,
  type SessionEventDto,
} from '@cairn/shared'
import {
  accountSessionDetailSchema,
  requestSessionOperationBodySchema,
  sessionEventListResponseSchema,
  sessionOperationAcceptedSchema,
  sessionOverviewQuerySchema,
  sessionOverviewResponseSchema,
  sessionSystemOverviewQuerySchema,
  sessionSystemOverviewResponseSchema,
  sessionRetentionBodySchema,
  utcInstantSchema,
  type AccountSessionDetail,
  type RequestSessionOperationBody,
  type SessionEventListResponse,
  type SessionOperationAccepted,
  type SessionOverviewQuery,
  type SessionOverviewResponse,
  type SessionSystemOverviewQuery,
  type SessionSystemOverviewResponse,
  type SessionRetentionBody,
} from '@cairn/shared'
import { apiFetch, toQueryString } from '@/lib/api-client'

export function fetchSessionOverview(query?: SessionOverviewQuery): Promise<SessionOverviewResponse> {
  return apiFetch(
    `/api/browser-sessions/overview${toQueryString(sessionOverviewQuerySchema.parse(query ?? {}))}`,
    sessionOverviewResponseSchema,
  )
}

export function fetchSessionSystemOverview(
  query?: SessionSystemOverviewQuery,
): Promise<SessionSystemOverviewResponse> {
  return apiFetch(
    `/api/browser-sessions/systems${toQueryString(sessionSystemOverviewQuerySchema.parse(query ?? {}))}`,
    sessionSystemOverviewResponseSchema,
  )
}

export function fetchAccountSession(targetId: string, accountId: string): Promise<AccountSessionDetail> {
  return apiFetch(`/api/targets/${targetId}/accounts/${accountId}/session`, accountSessionDetailSchema)
}

export function requestAccountSessionOperation(
  targetId: string,
  accountId: string,
  body: RequestSessionOperationBody,
): Promise<SessionOperationAccepted> {
  return apiFetch(
    `/api/targets/${targetId}/accounts/${accountId}/session/operations`,
    sessionOperationAcceptedSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestSessionOperationBodySchema.parse(body)),
    },
  )
}

const retentionResultSchema = z.object({
  retainUntil: utcInstantSchema.nullable(),
  revision: z.number().int().positive().optional(),
})

export function setAccountSessionRetention(
  targetId: string,
  accountId: string,
  body: SessionRetentionBody,
): Promise<{ retainUntil: string | null }> {
  return apiFetch(`/api/targets/${targetId}/accounts/${accountId}/session/retention`, retentionResultSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sessionRetentionBodySchema.parse(body)),
  })
}

export function fetchSessionEvents(sessionId: string, cursor?: string): Promise<SessionEventListResponse> {
  return apiFetch(
    `/api/browser-sessions/${sessionId}/events${toQueryString({ cursor })}`,
    sessionEventListResponseSchema,
  )
}

export function newSessionIdempotencyKey(kind: string): string {
  const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}`
  return `session-${kind}-${id}`
}

export function fetchAccountSessionEvents(targetId: string, accountId: string, cursor?: string) {
  return apiFetch(
    `/api/targets/${targetId}/accounts/${accountId}/session/events${toQueryString({ cursor })}`,
    sessionEventListResponseSchema,
  )
}
export function fetchSessionOperation(id: string) {
  return apiFetch(`/api/session-operations/${id}`, sessionOperationDtoSchema)
}
export function cancelSessionOperation(id: string) {
  return apiFetch(`/api/session-operations/${id}/cancel`, sessionOperationDtoSchema, { method: 'POST' })
}

async function subscribeSessionStream(
  path: string,
  signal: AbortSignal,
  onFrame: Parameters<typeof readSseStream>[1],
) {
  const token = useAuthStore.getState().auth.accessToken
  const res = await fetch(path, {
    headers: { Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal,
  })
  if (!res.ok) throw new Error(`连接失败（${res.status}）`)
  if (res.body) await readSseStream(res.body, onFrame, signal)
}
export function sessionObserveQuery(input: {
  targetId?: string
  accountId?: string
  cursor?: string
}) {
  const scoped = Boolean(input.targetId) && Boolean(input.accountId)
  return {
    ...(scoped ? { targetId: input.targetId, accountId: input.accountId } : {}),
    cursor: input.cursor,
  }
}

export async function subscribeSessionEvents(input: {
  targetId?: string
  accountId?: string
  cursor?: string
  signal: AbortSignal
  onEvent: (event: SessionEventDto, cursor: string) => void
  onReady: () => void
}) {
  await subscribeSessionStream(
    `/api/browser-sessions/observe${toQueryString(sessionObserveQuery(input))}`,
    input.signal,
    (frame) => {
      input.onReady()
      if (frame.event === 'session')
        input.onEvent(sessionEventDtoSchema.parse(JSON.parse(frame.data)), frame.id ?? '')
    },
  )
}
export function sessionBrowserTransport(kind: 'operation' | 'session'): BrowserTransport {
  const base = (id: string) =>
    kind === 'operation' ? `/api/session-operations/${id}` : `/api/browser-sessions/${id}`
  const post = (body: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return {
    fetchManagedBrowser: (id, pageId) =>
      apiFetch(`${base(id)}/browser${toQueryString({ pageId })}`, managedBrowserMetaSchema),
    acquireAuthControl: (id, body = {}) =>
      apiFetch(`${base(id)}/auth-control/acquire`, acquireAuthControlResponseSchema, post(body)),
    heartbeatAuthControl: (id, body) =>
      apiFetch(`${base(id)}/auth-control/heartbeat`, authControlHeartbeatResponseSchema, post(body)),
    inputAuthControl: (id, body) =>
      apiFetch(`${base(id)}/auth-control/input`, authControlInputReceiptSchema, post(body)),
    releaseAuthControl: (id, body) =>
      apiFetch(`${base(id)}/auth-control/release`, z.object({ released: z.boolean() }), post(body)),
    resumeRunAuth: (id, body) => apiFetch(`${base(id)}/complete-auth`, z.unknown(), post(body)),
    subscribeBrowserFrames: (id, input) =>
      subscribeSessionStream(
        `${base(id)}/browser/frames${toQueryString({ pageId: input.pageId })}`,
        input.signal,
        (frame) => {
          if (frame.event === 'frame') input.onFrame(managedBrowserFrameSchema.parse(JSON.parse(frame.data)))
        },
      ),
  }
}
