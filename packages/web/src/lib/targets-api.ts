import {
  cleanupStatusResponseSchema,
  createTargetAccountBodySchema,
  createTargetBodySchema,
  deletePreviewResponseSchema,
  deleteResourceBodySchema,
  deleteResourceResultSchema,
  targetAccountListResponseSchema,
  targetAccountSchema,
  targetListResponseSchema,
  targetSchema,
  updateTargetAccountBodySchema,
  updateTargetBodySchema,
  type CleanupStatusResponse,
  type CreateTargetAccountBody,
  type CreateTargetBody,
  type DeletePreviewResponse,
  type DeleteResourceBody,
  type DeleteResourceResult,
  type TargetAccountDto,
  type TargetAccountListQuery,
  type TargetAccountListResponse,
  type TargetDto,
  type TargetListQuery,
  type TargetListResponse,
  type UpdateTargetAccountBody,
  type UpdateTargetBody,
} from '@cairn/shared'
import { apiFetch, toQueryString } from '@/lib/api-client'

export function fetchTargets(query?: TargetListQuery): Promise<TargetListResponse> {
  return apiFetch(`/api/targets${toQueryString(query)}`, targetListResponseSchema)
}

export function fetchTarget(id: string): Promise<TargetDto> {
  return apiFetch(`/api/targets/${id}`, targetSchema)
}

export function createTarget(body: CreateTargetBody): Promise<TargetDto> {
  return apiFetch('/api/targets', targetSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createTargetBodySchema.parse(body)),
  })
}

export function updateTarget(id: string, body: UpdateTargetBody): Promise<TargetDto> {
  return apiFetch(`/api/targets/${id}`, targetSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateTargetBodySchema.parse(body)),
  })
}

export function previewDeleteTarget(id: string): Promise<DeletePreviewResponse> {
  return apiFetch(`/api/targets/${id}/delete-preview`, deletePreviewResponseSchema)
}

export function deleteTarget(id: string, body?: DeleteResourceBody): Promise<CleanupStatusResponse> {
  return apiFetch(`/api/targets/${id}/delete`, cleanupStatusResponseSchema, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(deleteResourceBodySchema.parse(body)) : undefined,
  })
}

export function fetchTargetCleanup(id: string): Promise<CleanupStatusResponse> {
  return apiFetch(`/api/targets/${id}/cleanup`, cleanupStatusResponseSchema)
}

export function retryTargetCleanup(id: string): Promise<CleanupStatusResponse> {
  return apiFetch(`/api/targets/${id}/cleanup/retry`, cleanupStatusResponseSchema, {
    method: 'POST',
  })
}

export function fetchTargetAccounts(
  targetId: string,
  query?: TargetAccountListQuery,
): Promise<TargetAccountListResponse> {
  return apiFetch(
    `/api/targets/${targetId}/accounts${toQueryString(query)}`,
    targetAccountListResponseSchema,
  )
}

export function createTargetAccount(
  targetId: string,
  body: CreateTargetAccountBody,
): Promise<TargetAccountDto> {
  return apiFetch(`/api/targets/${targetId}/accounts`, targetAccountSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createTargetAccountBodySchema.parse(body)),
  })
}

export function updateTargetAccount(
  targetId: string,
  accountId: string,
  body: UpdateTargetAccountBody,
): Promise<TargetAccountDto> {
  return apiFetch(`/api/targets/${targetId}/accounts/${accountId}`, targetAccountSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateTargetAccountBodySchema.parse(body)),
  })
}

export function deleteTargetAccount(
  targetId: string,
  accountId: string,
): Promise<DeleteResourceResult> {
  return apiFetch(
    `/api/targets/${targetId}/accounts/${accountId}/delete`,
    deleteResourceResultSchema,
    { method: 'POST' },
  )
}
