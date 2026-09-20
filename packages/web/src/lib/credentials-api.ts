import { z } from 'zod'
import {
  credentialImportResolveResponseSchema,
  type CredentialImportResolveBody,
  credentialBatchSchema,
  credentialDetailSchema,
  credentialHistoryResponseSchema,
  credentialListResponseSchema,
  credentialUsageResponseSchema,
  type CredentialBatchCreateBody,
  type CredentialBatchItemSubmitBody,
  type CredentialHistoryQuery,
  type CredentialListQuery,
  type CredentialMetadataBody,
  type CredentialRegisterBody,
  type CredentialReplaceBody,
  type CredentialRevisionBody,
} from '@cairn/shared'
import { apiFetch, toQueryString } from './api-client'

const post = (body?: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

export function fetchCredentials(query?: CredentialListQuery) {
  return apiFetch(
    `/api/credentials${toQueryString(query)}`,
    credentialListResponseSchema
  )
}

export function fetchCredential(id: string) {
  return apiFetch(`/api/credentials/${id}`, credentialDetailSchema)
}

export function resolveCredentialImport(body: CredentialImportResolveBody) {
  return apiFetch(
    '/api/credentials/import/resolve',
    credentialImportResolveResponseSchema,
    post(body)
  )
}

export function fetchCredentialOwners(id: string) {
  return apiFetch(
    `/api/credentials/${id}/owners`,
    z
      .object({
        items: z.array(z.object({ id: z.string(), name: z.string() })),
      })
      .transform((value) =>
        value.items.map((i) => ({ id: i.id, displayName: i.name }))
      )
  )
}

export function clearCredential(
  id: string,
  body: CredentialRevisionBody,
  remove = false
) {
  return apiFetch(
    `/api/credentials/${id}/${remove ? 'delete' : 'clear'}`,
    z.object({ id: z.string(), deleted: z.boolean() }),
    post(body)
  )
}

export function fetchCredentialUsages(id: string) {
  return apiFetch(
    `/api/credentials/${id}/usages`,
    credentialUsageResponseSchema
  )
}

export function fetchCredentialHistory(
  id: string,
  query?: CredentialHistoryQuery
) {
  return apiFetch(
    `/api/credentials/${id}/history${toQueryString(query)}`,
    credentialHistoryResponseSchema
  )
}

export function registerCredential(body: CredentialRegisterBody) {
  return apiFetch('/api/credentials', credentialDetailSchema, post(body))
}

export function updateCredentialMetadata(
  id: string,
  body: CredentialMetadataBody
) {
  return apiFetch(
    `/api/credentials/${id}/metadata`,
    credentialDetailSchema,
    post(body)
  )
}

export function replaceCredential(id: string, body: CredentialReplaceBody) {
  return apiFetch(
    `/api/credentials/${id}/replace`,
    credentialDetailSchema,
    post(body)
  )
}

export function disableCredential(id: string, body: CredentialRevisionBody) {
  return apiFetch(
    `/api/credentials/${id}/disable`,
    credentialDetailSchema,
    post(body)
  )
}

export function enableCredential(id: string, body: CredentialRevisionBody) {
  return apiFetch(
    `/api/credentials/${id}/enable`,
    credentialDetailSchema,
    post(body)
  )
}

export function revokeCredentialVersion(
  id: string,
  versionId: string,
  body: CredentialRevisionBody
) {
  return apiFetch(
    `/api/credentials/${id}/versions/${versionId}/revoke`,
    credentialDetailSchema,
    post(body)
  )
}

export function createCredentialBatch(body: CredentialBatchCreateBody) {
  return apiFetch('/api/credentials/batches', credentialBatchSchema, post(body))
}

export function fetchCredentialBatch(batchId: string) {
  return apiFetch(`/api/credentials/batches/${batchId}`, credentialBatchSchema)
}

export function submitCredentialBatchItem(
  batchId: string,
  itemId: string,
  body: CredentialBatchItemSubmitBody
) {
  return apiFetch(
    `/api/credentials/batches/${batchId}/items/${itemId}`,
    credentialBatchSchema,
    post(body)
  )
}
