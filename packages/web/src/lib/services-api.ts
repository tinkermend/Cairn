import { z } from 'zod'
import {
  issuedServiceCredentialSchema,
  serviceCallerSchema,
  serviceCallerDetailSchema,
  serviceCallerListSchema,
  serviceCredentialCatalogSchema,
  serviceCredentialMetadataBodySchema,
  serviceCredentialSchema,
  serviceIpWhitelistBodySchema,
  serviceOutstandingRunListSchema,
  serviceRequestLogItemSchema,
  serviceRequestLogListSchema,
  externalRunSchema,
  servicePlaygroundRunBodySchema,
  serviceWebhookDeliveryListSchema,
  serviceWebhookDeliverySchema,
  serviceWebhookSchema,
  serviceWebhookWriteSchema,
  serviceRunCancelResultSchema,
  type IssueServiceCredential,
  type ServiceCallerBody,
  type ServiceCallerQuery,
  type ServiceCredentialCatalog,
  type ServiceCredentialMetadataBody,
  type ServiceCredentialPolicy,
  type ServiceIpWhitelistBody,
  type ServicePageQuery,
  type ServiceRequestLogQuery,
  type ServicePlaygroundRunBody,
  type ServiceWebhookDeliveryQuery,
  type ServiceWebhookWrite,
} from '@cairn/shared'
import { apiFetch, apiFetchBlob } from './api-client'

const post = (body?: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
export const fetchServices = (query: Partial<ServiceCallerQuery> = {}) => {
  const params = new URLSearchParams({ limit: String(query.limit ?? 20) })
  if (query.cursor) params.set('cursor', query.cursor)
  if (query.search !== undefined) params.set('search', query.search)
  if (query.status !== undefined) params.set('status', query.status)
  if (query.sortBy !== undefined) params.set('sortBy', query.sortBy)
  if (query.sortOrder !== undefined) params.set('sortOrder', query.sortOrder)
  if (query.includeArchived !== undefined)
    params.set('includeArchived', query.includeArchived ? 'true' : 'false')
  return apiFetch(`/api/services?${params}`, serviceCallerListSchema)
}
export const fetchService = (id: string) =>
  apiFetch(`/api/services/${id}`, serviceCallerDetailSchema)
export const fetchServiceOutstandingRuns = (
  id: string,
  query: Partial<ServicePageQuery> = {}
) => {
  const params = new URLSearchParams({ limit: String(query.limit ?? 20) })
  if (query.cursor) params.set('cursor', query.cursor)
  return apiFetch(
    `/api/services/${id}/outstanding-runs?${params}`,
    serviceOutstandingRunListSchema
  )
}
export const fetchServiceRequestLogs = (
  id: string,
  query: Partial<ServiceRequestLogQuery> = {}
) => {
  const params = new URLSearchParams({ limit: String(query.limit ?? 20) })
  if (query.cursor) params.set('cursor', query.cursor)
  if (query.statusCategory) params.set('statusCategory', query.statusCategory)
  if (query.requestId) params.set('requestId', query.requestId)
  if (query.startAt) params.set('startAt', query.startAt)
  if (query.endAt) params.set('endAt', query.endAt)
  return apiFetch(
    `/api/services/${id}/logs?${params}`,
    serviceRequestLogListSchema
  )
}
export const fetchServiceRequestLog = (id: string, logId: string) =>
  apiFetch(`/api/services/${id}/logs/${logId}`, serviceRequestLogItemSchema)
export const fetchServiceWebhook = (id: string) =>
  apiFetch(`/api/services/${id}/webhook`, serviceWebhookSchema.nullable())
export const saveServiceWebhook = (id: string, body: ServiceWebhookWrite) =>
  apiFetch(
    `/api/services/${id}/webhook`,
    serviceWebhookSchema,
    post(serviceWebhookWriteSchema.parse(body))
  )
export const fetchServiceWebhookDeliveries = (
  id: string,
  query: Partial<ServiceWebhookDeliveryQuery> = {}
) => {
  const params = new URLSearchParams({ limit: String(query.limit ?? 20) })
  if (query.cursor) params.set('cursor', query.cursor)
  if (query.status) params.set('status', query.status)
  return apiFetch(
    `/api/services/${id}/webhook/deliveries?${params}`,
    serviceWebhookDeliveryListSchema
  )
}
export const retryServiceWebhookDelivery = (id: string, deliveryId: string) =>
  apiFetch(
    `/api/services/${id}/webhook/deliveries/${deliveryId}/retry`,
    serviceWebhookDeliverySchema,
    post()
  )
export const createServicePlaygroundRun = (
  id: string,
  body: ServicePlaygroundRunBody
) =>
  apiFetch(
    `/api/services/${id}/playground/runs`,
    externalRunSchema,
    post(servicePlaygroundRunBodySchema.parse(body))
  )
export const downloadServiceOpenApi = (id: string) =>
  apiFetchBlob(`/api/services/${id}/openapi.json`)
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
export const setServiceCredentialSuspended = (
  id: string,
  keyId: string,
  suspended: boolean
) =>
  apiFetch(
    `/api/services/${id}/credentials/${keyId}/${
      suspended ? 'suspend' : 'reactivate'
    }`,
    serviceCredentialSchema,
    post()
  )
export const fetchServiceCredentialCatalog = (
  id: string,
  keyId: string
): Promise<ServiceCredentialCatalog> =>
  apiFetch(
    `/api/services/${id}/credentials/${keyId}/catalog`,
    serviceCredentialCatalogSchema
  )
export const setServiceIpWhitelist = (
  id: string,
  body: ServiceIpWhitelistBody
) =>
  apiFetch(
    `/api/services/${id}/ip-whitelist`,
    serviceCallerSchema,
    post(serviceIpWhitelistBodySchema.parse(body))
  )
export const updateCredentialMetadata = (
  id: string,
  keyId: string,
  body: ServiceCredentialMetadataBody
) =>
  apiFetch(
    `/api/services/${id}/credentials/${keyId}/rename`,
    serviceCredentialSchema,
    post(serviceCredentialMetadataBodySchema.parse(body))
  )
export const setServiceStatus = (id: string, status: 'active' | 'disabled') =>
  apiFetch(`/api/services/${id}/status`, serviceCallerSchema, post({ status }))
export const archiveService = (id: string) =>
  apiFetch(`/api/services/${id}/archive`, serviceCallerSchema, post())
export const cancelServiceOutstandingRun = (id: string, runId: string) =>
  apiFetch(
    `/api/services/${id}/runs/${runId}/cancel`,
    serviceRunCancelResultSchema,
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
