import { z } from 'zod'
import {
  applyDemonstrationBodySchema,
  createDemonstrationBodySchema,
  demonstrationDetailSchema,
  demonstrationPreviewSchema,
  previewDemonstrationBodySchema,
  recordingImportReceiptSchema,
  scenarioDetailSchema,
  scenarioValidationSchema,
  type ApplyDemonstrationBody,
  type CreateDemonstrationBody,
  type PreviewDemonstrationBody,
} from '@cairn/shared'
import { apiFetch, apiFetchBlob } from './api-client'

export function newDemonstrationId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const s = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
export const createDemonstration = (body: CreateDemonstrationBody) =>
  apiFetch(
    '/api/recordings/demonstrations',
    demonstrationDetailSchema,
    json(createDemonstrationBodySchema.parse(body))
  )
export const fetchDemonstration = (id: string) =>
  apiFetch(`/api/recordings/${id}/demonstration`, demonstrationDetailSchema)
export const previewDemonstrationImport = (
  id: string,
  body: PreviewDemonstrationBody
) =>
  apiFetch(
    `/api/scenarios/${id}/recording-imports/preview`,
    demonstrationPreviewSchema,
    json(previewDemonstrationBodySchema.parse(body))
  )
export const applyDemonstrationImport = (
  id: string,
  body: ApplyDemonstrationBody
) =>
  apiFetch(
    `/api/scenarios/${id}/recording-imports/apply`,
    z.object({
      receipt: recordingImportReceiptSchema,
      scenario: scenarioDetailSchema,
    }),
    json(applyDemonstrationBodySchema.parse(body))
  )
export const fetchScenarioValidation = (id: string) =>
  apiFetch(`/api/scenarios/${id}/validation`, scenarioValidationSchema)
export const uploadDemonstrationImage = (
  id: string,
  artifactId: string,
  generation: string,
  body: Blob
) =>
  apiFetch(
    `/api/recordings/${id}/artifacts/${artifactId}/content`,
    demonstrationDetailSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': body.type, 'X-Upload-Generation': generation },
      body,
    }
  )
export const fetchDemonstrationImage = (id: string, artifactId: string) =>
  apiFetchBlob(`/api/recordings/${id}/artifacts/${artifactId}/content`)
