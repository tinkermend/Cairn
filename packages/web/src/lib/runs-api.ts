import {
  acquireAuthControlBodySchema,
  acquireAuthControlResponseSchema,
  authControlHeartbeatResponseSchema,
  authControlInputBodySchema,
  authControlInputReceiptSchema,
  authControlTokenBodySchema,
  createRunBodySchema,
  encodeRunEventCursor,
  managedBrowserFrameSchema,
  managedBrowserMetaSchema,
  persistedRunEventSchema,
  resumeAuthBodySchema,
  reviewRunBodySchema,
  runDetailSchema,
  runEvidenceListResponseSchema,
  runListResponseSchema,
  runObservationSchema,
  runStreamControlSchema,
  type AcquireAuthControlBody,
  type AcquireAuthControlResponse,
  type AuthControlInputBody,
  type AuthControlTokenBody,
  type CreateRunBody,
  type ManagedBrowserFrame,
  type ManagedBrowserMeta,
  type PersistedRunEvent,
  type ResumeAuthBody,
  type ReviewRunBody,
  type RunDetailDto,
  type RunEvidenceListResponse,
  type RunListResponse,
  type RunObservation,
  type RunStreamControl,
} from '@cairn/shared'
import { z } from 'zod'
import { ApiRequestError, apiFetch, apiFetchBlob } from '@/lib/api-client'
import { REQUEST_ID_HEADER, apiErrorSchema } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { readSseStream } from '@/lib/sse'

export function fetchRuns(): Promise<RunListResponse> {
  return apiFetch('/api/runs', runListResponseSchema)
}

export function fetchRun(id: string): Promise<RunDetailDto> {
  return apiFetch(`/api/runs/${id}`, runDetailSchema)
}

export function fetchRunEvidence(id: string): Promise<RunEvidenceListResponse> {
  return apiFetch(`/api/runs/${id}/evidence`, runEvidenceListResponseSchema)
}

export function fetchRunObservation(id: string): Promise<RunObservation> {
  return apiFetch(`/api/runs/${id}/observation`, runObservationSchema)
}

export type RunStreamHandlers = {
  onEvent?: (event: PersistedRunEvent) => void
  onControl?: (control: RunStreamControl) => void
}

export async function subscribeRunEvents(
  id: string,
  input: { cursor: number; signal: AbortSignal; handlers: RunStreamHandlers },
): Promise<void> {
  const token = useAuthStore.getState().auth.accessToken
  const res = await fetch(`/api/runs/${id}/events`, {
    headers: {
      Accept: 'text/event-stream',
      [REQUEST_ID_HEADER]: newSseRequestId(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Last-Event-ID': encodeRunEventCursor(id, input.cursor),
    },
    signal: input.signal,
  })
  if (!res.ok) {
    if (
      res.status === 401 &&
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
          },
    )
  }
  if (!res.body) return
  await readSseStream(
    res.body,
    (frame) => {
      if (frame.event === 'ready' || frame.event === 'reset' || frame.event === 'complete' || frame.event === 'error') {
        const parsed = runStreamControlSchema.safeParse(parseJson(frame.data))
        if (parsed.success) input.handlers.onControl?.(parsed.data)
        return
      }
      const parsed = persistedRunEventSchema.safeParse(parseJson(frame.data))
      if (parsed.success) input.handlers.onEvent?.(parsed.data)
    },
    input.signal,
  )
}

function newSseRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

export function runEvidenceContentPath(runId: string, evidenceId: string): string {
  return `/api/runs/${runId}/evidence/${evidenceId}/content`
}

export function fetchEvidenceContent(runId: string, evidenceId: string) {
  return apiFetchBlob(runEvidenceContentPath(runId, evidenceId))
}

export function createRun(body: CreateRunBody): Promise<RunDetailDto> {
  return apiFetch('/api/runs', runDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createRunBodySchema.parse(body)),
  })
}

export function cancelRun(id: string): Promise<RunDetailDto> {
  return apiFetch(`/api/runs/${id}/cancel`, runDetailSchema, { method: 'POST' })
}

export function reviewRun(id: string, body: ReviewRunBody): Promise<RunDetailDto> {
  return apiFetch(`/api/runs/${id}/review`, runDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reviewRunBodySchema.parse(body)),
  })
}

export function resumeRunAuth(id: string, body: ResumeAuthBody = {}): Promise<RunDetailDto> {
  return apiFetch(`/api/runs/${id}/resume-auth`, runDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(resumeAuthBodySchema.parse(body)),
  })
}

export function fetchManagedBrowser(id: string, pageId?: string): Promise<ManagedBrowserMeta> {
  const query = pageId ? `?pageId=${encodeURIComponent(pageId)}` : ''
  return apiFetch(`/api/runs/${id}/browser${query}`, managedBrowserMetaSchema)
}

export function acquireAuthControl(id: string, body: AcquireAuthControlBody = {}): Promise<AcquireAuthControlResponse> {
  return apiFetch(`/api/runs/${id}/browser/auth-control/acquire`, acquireAuthControlResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(acquireAuthControlBodySchema.parse(body)),
  })
}

export function heartbeatAuthControl(id: string, body: AuthControlTokenBody) {
  return apiFetch(`/api/runs/${id}/browser/auth-control/heartbeat`, authControlHeartbeatResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(authControlTokenBodySchema.parse(body)),
  })
}

export function inputAuthControl(id: string, body: AuthControlInputBody) {
  return apiFetch(`/api/runs/${id}/browser/auth-control/input`, authControlInputReceiptSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(authControlInputBodySchema.parse(body)),
  })
}

export function releaseAuthControl(id: string, body: AuthControlTokenBody) {
  return apiFetch(`/api/runs/${id}/browser/auth-control/release`, z.object({ released: z.boolean() }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(authControlTokenBodySchema.parse(body)),
  })
}

export async function subscribeBrowserFrames(
  id: string,
  input: { signal: AbortSignal; pageId?: string; onFrame: (frame: ManagedBrowserFrame) => void },
): Promise<void> {
  const token = useAuthStore.getState().auth.accessToken
  const query = input.pageId ? `?pageId=${encodeURIComponent(input.pageId)}` : ''
  const res = await fetch(`/api/runs/${id}/browser/frames${query}`, {
    headers: {
      Accept: 'text/event-stream',
      [REQUEST_ID_HEADER]: newSseRequestId(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: input.signal,
  })
  if (!res.ok) {
    if (res.status === 401 && token === useAuthStore.getState().auth.accessToken) {
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
          },
    )
  }
  if (!res.body) return
  await readSseStream(
    res.body,
    (frame) => {
      if (frame.event !== 'frame') return
      const parsed = managedBrowserFrameSchema.safeParse(parseJson(frame.data))
      if (parsed.success) input.onFrame(parsed.data)
    },
    input.signal,
  )
}
