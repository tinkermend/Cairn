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
