import {
  createSuiteBodySchema,
  createSuiteRunBodySchema,
  deletePreviewResponseSchema,
  deleteResourceBodySchema,
  deleteResourceResultSchema,
  publishSuiteBodySchema,
  saveSuiteDraftBodySchema,
  suiteDetailSchema,
  suiteListResponseSchema,
  suiteRunListResponseSchema,
  suiteRunObservationSchema,
  suiteRunPreviewResponseSchema,
  suiteValidateResponseSchema,
  updateSuiteEnabledBodySchema,
  type CreateSuiteBody,
  type CreateSuiteRunBody,
  type DeleteResourceBody,
  type PublishSuiteBody,
  type SaveSuiteDraftBody,
  type SuiteListQuery,
  type SuiteRunListQuery,
  type UpdateSuiteEnabledBody,
} from '@cairn/shared'
import { z } from 'zod'
import { apiFetch, toQueryString } from '@/lib/api-client'

const createSuiteRunResponseSchema = z.object({
  observation: suiteRunObservationSchema,
  created: z.boolean(),
})

export function fetchSuites(query?: SuiteListQuery) {
  return apiFetch(`/api/suites${toQueryString(query)}`, suiteListResponseSchema)
}

export function fetchSuite(suiteId: string) {
  return apiFetch(`/api/suites/${suiteId}`, suiteDetailSchema)
}

export function createSuite(body: CreateSuiteBody) {
  return apiFetch('/api/suites', suiteDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createSuiteBodySchema.parse(body)),
  })
}

export function saveSuiteDraft(suiteId: string, body: SaveSuiteDraftBody) {
  return apiFetch(`/api/suites/${suiteId}/draft`, suiteDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(saveSuiteDraftBodySchema.parse(body)),
  })
}

export function validateSuite(suiteId: string) {
  return apiFetch(`/api/suites/${suiteId}/validate`, suiteValidateResponseSchema, { method: 'POST' })
}

export function publishSuite(suiteId: string, body: PublishSuiteBody) {
  return apiFetch(`/api/suites/${suiteId}/publish`, suiteDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(publishSuiteBodySchema.parse(body)),
  })
}

export function updateSuiteEnabled(suiteId: string, body: UpdateSuiteEnabledBody) {
  return apiFetch(`/api/suites/${suiteId}/enabled`, suiteDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateSuiteEnabledBodySchema.parse(body)),
  })
}

export function previewDeleteSuite(suiteId: string) {
  return apiFetch(`/api/suites/${suiteId}/delete-preview`, deletePreviewResponseSchema, { method: 'POST' })
}

export function deleteSuite(suiteId: string, body?: DeleteResourceBody) {
  return apiFetch(`/api/suites/${suiteId}/delete`, deleteResourceResultSchema, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(deleteResourceBodySchema.parse(body)) : undefined,
  })
}

export function fetchSuiteRuns(query?: SuiteRunListQuery) {
  return apiFetch(`/api/suite-runs${toQueryString(query)}`, suiteRunListResponseSchema)
}

export function previewSuiteRun(body: CreateSuiteRunBody) {
  return apiFetch('/api/suite-runs/preview', suiteRunPreviewResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createSuiteRunBodySchema.parse(body)),
  })
}

export function createSuiteRun(body: CreateSuiteRunBody) {
  return apiFetch('/api/suite-runs', createSuiteRunResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createSuiteRunBodySchema.parse(body)),
  })
}

export function fetchSuiteRun(suiteRunId: string) {
  return apiFetch(`/api/suite-runs/${suiteRunId}/observation`, suiteRunObservationSchema)
}

export function cancelSuiteRun(suiteRunId: string) {
  return apiFetch(`/api/suite-runs/${suiteRunId}/cancel`, suiteRunObservationSchema, { method: 'POST' })
}
