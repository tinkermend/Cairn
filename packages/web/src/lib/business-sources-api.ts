import { z } from 'zod'
import {
  targetBusinessSourceDtoSchema,
  targetBusinessSourceSnapshotDtoSchema,
  previewBusinessSourceResponseSchema,
  businessRecordsResponseSchema,
  type TargetBusinessSourceDto,
  type TargetBusinessSourceSnapshotDto,
  type PreviewBusinessSourceBody,
  type PreviewBusinessSourceResponse,
  type CreateBusinessSourceCandidateBody,
  type ApproveCandidateBody,
  type RevokeSourceBody,
  type BusinessRecordsListQuery,
  type BusinessRecordsResponse,
} from '@cairn/shared'
import { apiFetch, toQueryString } from './api-client'

export function fetchBusinessSource(
  targetId: string,
  entityType = 'manufacturer',
): Promise<TargetBusinessSourceDto | null> {
  return apiFetch(
    `/api/targets/${targetId}/business-sources${toQueryString({ entityType })}`,
    targetBusinessSourceDtoSchema.nullable(),
  )
}

export function previewBusinessSource(
  targetId: string,
  body: PreviewBusinessSourceBody,
): Promise<PreviewBusinessSourceResponse> {
  return apiFetch(`/api/targets/${targetId}/business-sources/preview`, previewBusinessSourceResponseSchema, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function createBusinessSourceCandidate(
  targetId: string,
  body: CreateBusinessSourceCandidateBody,
): Promise<{ sourceBindingId: string; candidateId: string; bindingRevision: number }> {
  return apiFetch(
    `/api/targets/${targetId}/business-sources/candidates`,
    z.object({
      sourceBindingId: z.string(),
      candidateId: z.string(),
      bindingRevision: z.number(),
    }),
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  )
}

export function fetchBusinessSourceCandidate(
  targetId: string,
  candidateId: string,
): Promise<TargetBusinessSourceSnapshotDto> {
  return apiFetch(
    `/api/targets/${targetId}/business-sources/candidates/${candidateId}`,
    targetBusinessSourceSnapshotDtoSchema,
  )
}

export function approveBusinessSourceCandidate(
  targetId: string,
  candidateId: string,
  body: ApproveCandidateBody,
): Promise<{ bindingRevision: number; currentSnapshotId: string }> {
  return apiFetch(
    `/api/targets/${targetId}/business-sources/candidates/${candidateId}/approve`,
    z.object({
      bindingRevision: z.number(),
      currentSnapshotId: z.string(),
    }),
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  )
}

export function revokeBusinessSource(
  targetId: string,
  body: RevokeSourceBody,
): Promise<{ bindingRevision: number }> {
  return apiFetch(
    `/api/targets/${targetId}/business-sources/revoke`,
    z.object({
      bindingRevision: z.number(),
    }),
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  )
}

export function fetchBusinessRecords(
  targetId: string,
  query?: BusinessRecordsListQuery,
): Promise<BusinessRecordsResponse> {
  return apiFetch(
    `/api/targets/${targetId}/business-records${toQueryString(query as Record<string, unknown>)}`,
    businessRecordsResponseSchema,
  )
}
