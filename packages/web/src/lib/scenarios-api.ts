import {
  applyRecordingImportBodySchema,
  createRecordingBindingBodySchema,
  createScenarioBodySchema,
  previewRecordingImportBodySchema,
  publishScenarioBodySchema,
  recordingBindingCreatedSchema,
  recordingImportListResponseSchema,
  recordingImportPreviewSchema,
  recordingImportReceiptSchema,
  runDetailSchema,
  saveScenarioDraftBodySchema,
  scenarioCapabilitiesSchema,
  scenarioDetailSchema,
  scenarioListResponseSchema,
  trialRunBodySchema,
  updateScenarioBodySchema,
  type ApplyRecordingImportBody,
  type CreateRecordingBindingBody,
  type CreateScenarioBody,
  type PreviewRecordingImportBody,
  type PublishScenarioBody,
  type RecordingBindingCreated,
  type RecordingImportListResponse,
  type RecordingImportPreview,
  type RecordingImportReceipt,
  type RunDetailDto,
  type SaveScenarioDraftBody,
  type ScenarioCapabilities,
  type ScenarioDetailDto,
  type ScenarioListQuery,
  type ScenarioListResponse,
  type TrialRunBody,
  type UpdateScenarioBody,
  deletePreviewResponseSchema,
  deleteResourceBodySchema,
  deleteResourceResultSchema,
  type DeletePreviewResponse,
  type DeleteResourceBody,
  type DeleteResourceResult,
} from '@cairn/shared'
import { z } from 'zod'
import { apiFetch, toQueryString } from '@/lib/api-client'

const applyRecordingImportResponseSchema = z.object({
  receipt: recordingImportReceiptSchema,
  scenario: scenarioDetailSchema,
})

export function fetchScenarios(query?: ScenarioListQuery): Promise<ScenarioListResponse> {
  return apiFetch(`/api/scenarios${toQueryString(query)}`, scenarioListResponseSchema)
}

export function fetchScenario(id: string): Promise<ScenarioDetailDto> {
  return apiFetch(`/api/scenarios/${id}`, scenarioDetailSchema)
}

export function previewDeleteScenario(id: string): Promise<DeletePreviewResponse> {
  return apiFetch(`/api/scenarios/${id}/delete-preview`, deletePreviewResponseSchema)
}

export function deleteScenario(id: string, body?: DeleteResourceBody): Promise<DeleteResourceResult> {
  return apiFetch(`/api/scenarios/${id}/delete`, deleteResourceResultSchema, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(deleteResourceBodySchema.parse(body)) : undefined,
  })
}

export function fetchScenarioCapabilities(): Promise<ScenarioCapabilities> {
  return apiFetch('/api/scenarios/capabilities', scenarioCapabilitiesSchema)
}

export function createScenario(body: CreateScenarioBody): Promise<ScenarioDetailDto> {
  return apiFetch('/api/scenarios', scenarioDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createScenarioBodySchema.parse(body)),
  })
}

export function updateScenario(id: string, body: UpdateScenarioBody): Promise<ScenarioDetailDto> {
  return apiFetch(`/api/scenarios/${id}`, scenarioDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateScenarioBodySchema.parse(body)),
  })
}

export function saveScenarioDraft(id: string, body: SaveScenarioDraftBody): Promise<ScenarioDetailDto> {
  return apiFetch(`/api/scenarios/${id}/draft`, scenarioDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(saveScenarioDraftBodySchema.parse(body)),
  })
}

export function publishScenario(id: string, body: PublishScenarioBody): Promise<ScenarioDetailDto> {
  return apiFetch(`/api/scenarios/${id}/publish`, scenarioDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(publishScenarioBodySchema.parse(body)),
  })
}

export function trialScenario(id: string, body: TrialRunBody): Promise<RunDetailDto> {
  return apiFetch(`/api/scenarios/${id}/trial`, runDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(trialRunBodySchema.parse(body)),
  })
}

export function createRecordingBinding(
  id: string,
  body: CreateRecordingBindingBody,
): Promise<RecordingBindingCreated> {
  return apiFetch(`/api/scenarios/${id}/recording-bindings`, recordingBindingCreatedSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createRecordingBindingBodySchema.parse(body)),
  })
}

export function fetchRecordingImports(id: string): Promise<RecordingImportListResponse> {
  return apiFetch(`/api/scenarios/${id}/recording-imports`, recordingImportListResponseSchema)
}

export function previewRecordingImport(
  id: string,
  body: PreviewRecordingImportBody,
): Promise<RecordingImportPreview> {
  return apiFetch(`/api/scenarios/${id}/recording-imports/preview`, recordingImportPreviewSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(previewRecordingImportBodySchema.parse(body)),
  })
}

export function applyRecordingImport(
  id: string,
  body: ApplyRecordingImportBody,
): Promise<{ receipt: RecordingImportReceipt; scenario: ScenarioDetailDto }> {
  return apiFetch(`/api/scenarios/${id}/recording-imports/apply`, applyRecordingImportResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(applyRecordingImportBodySchema.parse(body)),
  })
}
