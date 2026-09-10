import {
  createTargetAccountBodySchema,
  createTargetBodySchema,
  targetAccountListResponseSchema,
  targetAccountSchema,
  targetListResponseSchema,
  targetSchema,
  updateTargetAccountBodySchema,
  updateTargetBodySchema,
  type CreateTargetAccountBody,
  type CreateTargetBody,
  type TargetAccountDto,
  type TargetAccountListResponse,
  type TargetDto,
  type TargetListResponse,
  type UpdateTargetAccountBody,
  type UpdateTargetBody,
} from '@cairn/shared'
import { apiFetch } from '@/lib/api-client'

export function fetchTargets(): Promise<TargetListResponse> {
  return apiFetch('/api/targets', targetListResponseSchema)
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

export function deleteTarget(id: string): Promise<void> {
  return apiFetch(`/api/targets/${id}/delete`, targetSchema, { method: 'POST' }).then(
    () => undefined,
  )
}

export function fetchTargetAccounts(targetId: string): Promise<TargetAccountListResponse> {
  return apiFetch(`/api/targets/${targetId}/accounts`, targetAccountListResponseSchema)
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

export function deleteTargetAccount(targetId: string, accountId: string): Promise<void> {
  return apiFetch(
    `/api/targets/${targetId}/accounts/${accountId}/delete`,
    targetSchema,
    { method: 'POST' },
  ).then(() => undefined)
}
