import {
  createRunBodySchema,
  resumeAuthBodySchema,
  reviewRunBodySchema,
  runDetailSchema,
  runEvidenceListResponseSchema,
  runListResponseSchema,
  type CreateRunBody,
  type ResumeAuthBody,
  type ReviewRunBody,
  type RunDetailDto,
  type RunEvidenceListResponse,
  type RunListResponse,
} from '@cairn/shared'
import { apiFetch } from '@/lib/api-client'

export function fetchRuns(): Promise<RunListResponse> {
  return apiFetch('/api/runs', runListResponseSchema)
}

export function fetchRun(id: string): Promise<RunDetailDto> {
  return apiFetch(`/api/runs/${id}`, runDetailSchema)
}

export function fetchRunEvidence(id: string): Promise<RunEvidenceListResponse> {
  return apiFetch(`/api/runs/${id}/evidence`, runEvidenceListResponseSchema)
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
