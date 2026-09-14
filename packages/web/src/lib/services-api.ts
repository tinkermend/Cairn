import { z } from 'zod'
import {
  issuedServiceCredentialSchema,
  serviceCallerDetailSchema,
  serviceCallerListSchema,
  serviceCredentialSchema,
  type IssueServiceCredential,
  type ServiceCallerBody,
  type ServiceCredentialPolicy,
} from '@cairn/shared'
import { apiFetch } from './api-client'

const post = (body?: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
export const fetchServices = (cursor?: string) =>
  apiFetch(
    `/api/services?limit=20${cursor ? `&cursor=${cursor}` : ''}`,
    serviceCallerListSchema
  )
export const fetchService = (id: string) =>
  apiFetch(`/api/services/${id}`, serviceCallerDetailSchema)
export const saveService = (id: string | null, body: ServiceCallerBody) =>
  apiFetch(
    id ? `/api/services/${id}/update` : '/api/services',
    serviceCallerDetailSchema,
    post(body)
  )
export const issueCredential = (id: string, body: IssueServiceCredential) =>
  apiFetch(
    `/api/services/${id}/credentials`,
    issuedServiceCredentialSchema,
    post(body)
  )
export const updateCredential = (
  id: string,
  keyId: string,
  body: ServiceCredentialPolicy
) =>
  apiFetch(
    `/api/services/${id}/credentials/${keyId}/update`,
    serviceCredentialSchema,
    post(body)
  )
export const revokeCredential = (id: string, keyId: string) =>
  apiFetch(
    `/api/services/${id}/credentials/${keyId}/revoke`,
    serviceCredentialSchema,
    post()
  )
export const releaseEvidence = (
  runId: string,
  evidenceId: string,
  allowed: boolean
) =>
  apiFetch(
    `/api/services/evidence/${runId}/${evidenceId}/release`,
    z.object({ id: z.string(), externalAccess: z.boolean() }),
    post({ allowed })
  )
