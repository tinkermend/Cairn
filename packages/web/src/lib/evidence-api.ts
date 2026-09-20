import {
  evidenceDetailResponseSchema,
  evidenceRetentionObjectsQuerySchema,
  evidenceRetentionObjectsResponseSchema,
  evidenceRetentionSummaryResponseSchema,
  evidenceSearchQuerySchema,
  evidenceSearchResponseSchema,
  type EvidenceRetentionObjectsQuery,
  type EvidenceSearchQueryInput,
} from '@cairn/shared'
import { apiFetch, toQueryString } from './api-client'

export function fetchEvidenceSearch(query?: EvidenceSearchQueryInput) {
  const parsed = evidenceSearchQuerySchema.parse(query ?? {})
  return apiFetch(`/api/evidence${toQueryString(parsed)}`, evidenceSearchResponseSchema)
}

export function fetchEvidenceDetail(evidenceId: string) {
  return apiFetch(`/api/evidence/${evidenceId}`, evidenceDetailResponseSchema)
}

export function fetchEvidenceRetentionSummary() {
  return apiFetch('/api/evidence-retention/summary', evidenceRetentionSummaryResponseSchema)
}

export function fetchEvidenceRetentionObjects(query?: EvidenceRetentionObjectsQuery) {
  const parsed = evidenceRetentionObjectsQuerySchema.parse(query ?? {})
  return apiFetch(`/api/evidence-retention/objects${toQueryString(parsed)}`, evidenceRetentionObjectsResponseSchema)
}
