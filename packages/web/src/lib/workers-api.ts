import { z } from 'zod'
import {
  sessionDtoSchema,
  workerDetailResponseSchema,
  workerListResponseSchema,
  type DisposeSessionBody,
  type SessionDto,
  type WorkerDetailResponse,
  type WorkerListQuery,
  type WorkerListResponse,
  type WorkerSessionListQuery,
} from '@cairn/shared'
import { apiFetch, toQueryString } from '@/lib/api-client'

export function fetchWorkers(query: WorkerListQuery): Promise<WorkerListResponse> {
  return apiFetch(`/api/workers${toQueryString(query)}`, workerListResponseSchema)
}

export function fetchWorker(
  workerId: string,
  query: Partial<WorkerSessionListQuery> = {},
): Promise<WorkerDetailResponse> {
  return apiFetch(`/api/workers/${encodeURIComponent(workerId)}${toQueryString(query)}`, workerDetailResponseSchema)
}

export function disposeWorkerSession(sessionId: string, body: DisposeSessionBody = {}): Promise<SessionDto> {
  return apiFetch(`/api/browser-sessions/${sessionId}/dispose`, sessionDtoSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function disableWorker(workerId: string): Promise<unknown> {
  return apiFetch(`/api/workers/${encodeURIComponent(workerId)}/disable`, z.unknown(), {
    method: 'POST',
  })
}

export function enableWorker(workerId: string): Promise<unknown> {
  return apiFetch(`/api/workers/${encodeURIComponent(workerId)}/enable`, z.unknown(), {
    method: 'POST',
  })
}

export function removeWorker(workerId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/workers/${encodeURIComponent(workerId)}/remove`, z.object({ ok: z.boolean() }), {
    method: 'POST',
  })
}

export function purgeStaleWorkers(): Promise<{ purgedCount: number; purgedWorkerIds: string[] }> {
  return apiFetch(
    '/api/workers/purge-stale',
    z.object({ purgedCount: z.number(), purgedWorkerIds: z.array(z.string()) }),
    {
      method: 'POST',
    },
  )
}

