import {
  autoMapBodySchema,
  autoMapResultSchema,
  createDatasetBodySchema,
  datasetDetailSchema,
  datasetListResponseSchema,
  datasetProfileSchema,
  datasetRowsResponseSchema,
  deleteDatasetBodySchema,
  deleteDatasetResponseSchema,
  preflightDatasetBodySchema,
  preflightResultSchema,
  type AutoMapBody,
  type CreateDatasetBody,
  type DatasetListQuery,
  type DatasetRowsQuery,
  type PreflightDatasetBody,
} from '@cairn/shared'
import { apiFetch, toQueryString } from '@/lib/api-client'

export function fetchDatasets(query?: DatasetListQuery) {
  return apiFetch(`/api/datasets${toQueryString(query)}`, datasetListResponseSchema)
}

export function fetchDataset(datasetId: string) {
  return apiFetch(`/api/datasets/${datasetId}`, datasetDetailSchema)
}

export function createDataset(body: CreateDatasetBody) {
  return apiFetch('/api/datasets', datasetDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createDatasetBodySchema.parse(body)),
  })
}

export function deleteDataset(datasetId: string) {
  return apiFetch(`/api/datasets/${datasetId}/delete`, deleteDatasetResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(deleteDatasetBodySchema.parse({ confirmation: datasetId })),
  })
}

export function fetchDatasetRows(datasetId: string, query?: DatasetRowsQuery) {
  return apiFetch(`/api/datasets/${datasetId}/rows${toQueryString(query)}`, datasetRowsResponseSchema)
}

export function preflightDataset(datasetId: string, body: PreflightDatasetBody) {
  return apiFetch(`/api/datasets/${datasetId}/preflight`, preflightResultSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preflightDatasetBodySchema.parse(body)),
  })
}

export function autoMapDataset(datasetId: string, body: AutoMapBody) {
  return apiFetch(`/api/datasets/${datasetId}/auto-map`, autoMapResultSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(autoMapBodySchema.parse(body)),
  })
}

export function fetchDatasetProfile(datasetId: string) {
  return apiFetch(`/api/datasets/${datasetId}/profile`, datasetProfileSchema)
}

