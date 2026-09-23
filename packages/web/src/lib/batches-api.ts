import {
  batchDetailSchema,
  batchExportResponseSchema,
  batchItemListResponseSchema,
  batchListResponseSchema,
  cancelBatchBodySchema,
  createBatchBodySchema,
  pauseBatchBodySchema,
  type BatchItemListQuery,
  type BatchListQuery,
  type CancelBatchBody,
  type CreateBatchBody,
  type PauseBatchBody,
} from '@cairn/shared'
import { apiFetch, toQueryString } from '@/lib/api-client'

export function fetchBatches(query?: BatchListQuery) {
  return apiFetch(`/api/batches${toQueryString(query)}`, batchListResponseSchema)
}

export function fetchBatch(batchId: string) {
  return apiFetch(`/api/batches/${batchId}`, batchDetailSchema)
}

export function createBatch(body: CreateBatchBody) {
  return apiFetch('/api/batches', batchDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createBatchBodySchema.parse(body)),
  })
}

export function fetchBatchItems(batchId: string, query?: BatchItemListQuery) {
  return apiFetch(`/api/batches/${batchId}/items${toQueryString(query)}`, batchItemListResponseSchema)
}

export function pauseBatch(batchId: string, body?: PauseBatchBody) {
  return apiFetch(`/api/batches/${batchId}/pause`, batchDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pauseBatchBodySchema.parse(body ?? {})),
  })
}

export function resumeBatch(batchId: string) {
  return apiFetch(`/api/batches/${batchId}/resume`, batchDetailSchema, {
    method: 'POST',
  })
}

export function cancelBatch(batchId: string, body?: CancelBatchBody) {
  return apiFetch(`/api/batches/${batchId}/cancel`, batchDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cancelBatchBodySchema.parse(body ?? {})),
  })
}

export function retryFailedBatchItems(batchId: string) {
  return apiFetch(`/api/batches/${batchId}/retry-failed`, batchDetailSchema, {
    method: 'POST',
  })
}

export function exportBatchResults(batchId: string) {
  return apiFetch(`/api/batches/${batchId}/export`, batchExportResponseSchema, {
    method: 'POST',
  })
}
