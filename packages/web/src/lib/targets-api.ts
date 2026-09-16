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
  publishTargetAuthProfileBodySchema,
  startAuthProfileValidationBodySchema,
  observeAuthProfileValidationBodySchema,
  targetAccessPolicyDtoSchema,
  targetAccessPolicyUpdateBodySchema,
  targetAuthProfileViewSchema,
  authValidationOperationSchema,
  startAuthProfileValidationResponseSchema,
  updateTargetAccountIdentityBodySchema,
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
  type AuthValidationOperation,
  type ObserveAuthProfileValidationBody,
  type PublishTargetAuthProfileBody,
  type StartAuthProfileValidationBody,
  type TargetAccessPolicyDto,
  type TargetAccessPolicyUpdateBody,
  type TargetAuthProfileView,
  type UpdateTargetAccountIdentityBody,
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

export function fetchTargetAccessPolicy(targetId: string): Promise<TargetAccessPolicyDto> {
  return apiFetch(`/api/targets/${targetId}/access-policy`, targetAccessPolicyDtoSchema)
}

export function updateTargetAccessPolicy(
  targetId: string,
  body: TargetAccessPolicyUpdateBody,
): Promise<TargetAccessPolicyDto> {
  return apiFetch(`/api/targets/${targetId}/access-policy`, targetAccessPolicyDtoSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(targetAccessPolicyUpdateBodySchema.parse(body)),
  })
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

export function fetchTargetAuthProfile(targetId: string): Promise<TargetAuthProfileView> {
  return apiFetch(`/api/targets/${targetId}/auth-profile`, targetAuthProfileViewSchema)
}

export function publishTargetAuthProfile(
  targetId: string,
  body: PublishTargetAuthProfileBody,
): Promise<TargetAuthProfileView> {
  return apiFetch(`/api/targets/${targetId}/auth-profile`, targetAuthProfileViewSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(publishTargetAuthProfileBodySchema.parse(body)),
  })
}

export function updateTargetAccountIdentity(
  targetId: string,
  accountId: string,
  body: UpdateTargetAccountIdentityBody,
): Promise<TargetAccountDto> {
  return apiFetch(`/api/targets/${targetId}/accounts/${accountId}/identity`, targetAccountSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateTargetAccountIdentityBodySchema.parse(body)),
  })
}

export function startAuthProfileValidation(
  targetId: string,
  body: StartAuthProfileValidationBody,
): Promise<{ operation: AuthValidationOperation; created: boolean }> {
  return apiFetch(
    `/api/targets/${targetId}/auth-profile/validations`,
    startAuthProfileValidationResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(startAuthProfileValidationBodySchema.parse(body)),
    },
  )
}

export function fetchAuthProfileValidation(
  targetId: string,
  operationId: string,
): Promise<AuthValidationOperation> {
  return apiFetch(
    `/api/targets/${targetId}/auth-profile/validations/${operationId}`,
    authValidationOperationSchema,
  )
}

export function observeAuthProfileValidation(
  targetId: string,
  operationId: string,
  body: ObserveAuthProfileValidationBody,
): Promise<AuthValidationOperation> {
  return apiFetch(
    `/api/targets/${targetId}/auth-profile/validations/${operationId}/observe`,
    authValidationOperationSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(observeAuthProfileValidationBodySchema.parse(body)),
    },
  )
}
