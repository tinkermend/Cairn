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
  previewScenarioExpansionBodySchema,
  previewScenarioExpansionResponseSchema,
  inlineScenarioModuleInvocationBodySchema,
  type DeletePreviewResponse,
  type DeleteResourceBody,
  type DeleteResourceResult,
  type PreviewScenarioExpansionBody,
  type PreviewScenarioExpansionResponse,
  type InlineScenarioModuleInvocationBody,
  actionModuleDetailSchema,
  moduleExtractBodySchema,
  moduleExtractPreviewBodySchema,
  moduleExtractProposalSchema,
  moduleReplaceBodySchema,
  moduleReplacePreviewBodySchema,
  moduleReplacePreviewResponseSchema,
  moduleUpgradeBodySchema,
  moduleUpgradePreviewBodySchema,
  moduleUpgradePreviewResponseSchema,
  type ActionModuleDetail,
  type ModuleExtractBody,
  type ModuleExtractPreviewBody,
  type ModuleExtractProposal,
  type ModuleReplaceBody,
  type ModuleReplacePreviewBody,
  type ModuleReplacePreviewResponse,
  type ModuleUpgradeBody,
  type ModuleUpgradePreviewBody,
  type ModuleUpgradePreviewResponse,
  moduleResolveAcceptBodySchema,
  moduleResolveAcceptResponseSchema,
  type ModuleResolveAcceptBody,
  type ModuleResolveAcceptResponse,
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

export function previewScenarioExpansion(
  scenarioId: string,
  body: PreviewScenarioExpansionBody,
): Promise<PreviewScenarioExpansionResponse> {
  return apiFetch(
    `/api/scenarios/${scenarioId}/module-expansion-preview`,
    previewScenarioExpansionResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(previewScenarioExpansionBodySchema.parse(body)),
    },
  )
}

export function inlineScenarioModuleInvocation(
  scenarioId: string,
  invocationId: string,
  body: InlineScenarioModuleInvocationBody,
): Promise<ScenarioDetailDto> {
  return apiFetch(
    `/api/scenarios/${scenarioId}/nodes/${invocationId}/inline`,
    scenarioDetailSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inlineScenarioModuleInvocationBodySchema.parse(body)),
    },
  )
}

export function previewScenarioModuleUpgrade(
  scenarioId: string,
  body: ModuleUpgradePreviewBody,
): Promise<ModuleUpgradePreviewResponse> {
  return apiFetch(
    `/api/scenarios/${scenarioId}/module-upgrade-preview`,
    moduleUpgradePreviewResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(moduleUpgradePreviewBodySchema.parse(body)),
    },
  )
}

export function upgradeScenarioModule(
  scenarioId: string,
  body: ModuleUpgradeBody,
): Promise<ScenarioDetailDto> {
  return apiFetch(`/api/scenarios/${scenarioId}/module-upgrade`, scenarioDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(moduleUpgradeBodySchema.parse(body)),
  })
}

export function previewScenarioModuleExtract(
  scenarioId: string,
  body: ModuleExtractPreviewBody,
): Promise<ModuleExtractProposal> {
  return apiFetch(
    `/api/scenarios/${scenarioId}/module-extract-preview`,
    moduleExtractProposalSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(moduleExtractPreviewBodySchema.parse(body)),
    },
  )
}

export function extractScenarioModule(
  scenarioId: string,
  body: ModuleExtractBody,
): Promise<ActionModuleDetail> {
  return apiFetch(`/api/scenarios/${scenarioId}/module-extract`, actionModuleDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(moduleExtractBodySchema.parse(body)),
  })
}

export function previewScenarioModuleReplace(
  scenarioId: string,
  body: ModuleReplacePreviewBody,
): Promise<ModuleReplacePreviewResponse> {
  return apiFetch(
    `/api/scenarios/${scenarioId}/module-replace-preview`,
    moduleReplacePreviewResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(moduleReplacePreviewBodySchema.parse(body)),
    },
  )
}

export function replaceScenarioModule(
  scenarioId: string,
  body: ModuleReplaceBody,
): Promise<ScenarioDetailDto> {
  return apiFetch(`/api/scenarios/${scenarioId}/module-replace`, scenarioDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(moduleReplaceBodySchema.parse(body)),
  })
}

const acceptModuleResolutionResponseSchema = moduleResolveAcceptResponseSchema.extend({
  scenario: scenarioDetailSchema,
})

export function acceptModuleResolution(
  scenarioId: string,
  requestId: string,
  body: ModuleResolveAcceptBody,
): Promise<ModuleResolveAcceptResponse & { scenario: ScenarioDetailDto }> {
  return apiFetch(
    `/api/scenarios/${scenarioId}/module-resolutions/${requestId}/accept`,
    acceptModuleResolutionResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(moduleResolveAcceptBodySchema.parse(body)),
    },
  )
}
