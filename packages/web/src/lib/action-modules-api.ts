import {
  scenarioCapabilitiesSchema,
  actionModuleDetailSchema,
  actionModuleVersionDtoSchema,
  createModuleBodySchema,
  deleteResourceResultSchema,
  disableAffectedScenariosBodySchema,
  disableAffectedScenariosResponseSchema,
  moduleBatchUpgradeBodySchema,
  moduleBatchUpgradeResponseSchema,
  moduleDeletePreviewResponseSchema,
  moduleListResponseSchema,
  modulePublicationBodySchema,
  moduleReferenceListResponseSchema,
  moduleVersionListResponseSchema,
  publishModuleBodySchema,
  saveModuleDraftBodySchema,
  updateModuleMetaBodySchema,
  moduleTrialRunBodySchema,
  moduleResolveRequestSchema,
  moduleResolveResultSchema,
  moduleResolveCloseBodySchema,
  moduleQualityQuerySchema,
  moduleQualityResponseSchema,
  moduleInvocationListQuerySchema,
  moduleInvocationListResponseSchema,
  runDetailSchema,
  type ActionModuleDetail,
  type ActionModuleVersionDto,
  type CreateModuleBody,
  type DeleteResourceResult,
  type DisableAffectedScenariosBody,
  type DisableAffectedScenariosResponse,
  type ModuleBatchUpgradeBody,
  type ModuleBatchUpgradeResponse,
  type ModuleDeletePreviewResponse,
  type ModuleListQuery,
  type ModuleListResponse,
  type ModulePublicationBody,
  type ModuleReferenceListQuery,
  type ModuleReferenceListResponse,
  type ModuleVersionListResponse,
  type PublishModuleBody,
  type SaveModuleDraftBody,
  type UpdateModuleMetaBody,
  type ModuleTrialRunBody,
  type ModuleResolveRequest,
  type ModuleResolveResult,
  type ModuleResolveCloseBody,
  type ModuleQualityQuery,
  type ModuleQualityResponse,
  type ModuleInvocationListQuery,
  type ModuleInvocationListResponse,
  type RunDetailDto,
} from '@cairn/shared'
import { apiFetch, toQueryString } from '@/lib/api-client'

export function fetchActionModules(
  query?: ModuleListQuery
): Promise<ModuleListResponse> {
  return apiFetch(
    `/api/action-modules${toQueryString(query)}`,
    moduleListResponseSchema
  )
}

export function fetchActionModule(id: string): Promise<ActionModuleDetail> {
  return apiFetch(`/api/action-modules/${id}`, actionModuleDetailSchema)
}

export function createActionModule(
  body: CreateModuleBody
): Promise<ActionModuleDetail> {
  createModuleBodySchema.parse(body)
  return apiFetch('/api/action-modules', actionModuleDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function updateActionModuleMeta(
  id: string,
  body: UpdateModuleMetaBody
): Promise<ActionModuleDetail> {
  updateModuleMetaBodySchema.parse(body)
  return apiFetch(`/api/action-modules/${id}`, actionModuleDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function saveActionModuleDraft(
  id: string,
  body: SaveModuleDraftBody
): Promise<ActionModuleDetail> {
  saveModuleDraftBodySchema.parse(body)
  return apiFetch(`/api/action-modules/${id}/draft`, actionModuleDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function publishActionModule(
  id: string,
  body: PublishModuleBody
): Promise<ActionModuleDetail> {
  publishModuleBodySchema.parse(body)
  return apiFetch(
    `/api/action-modules/${id}/publish`,
    actionModuleDetailSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  )
}

export function fetchActionModuleVersions(
  id: string
): Promise<ModuleVersionListResponse> {
  return apiFetch(
    `/api/action-modules/${id}/versions`,
    moduleVersionListResponseSchema
  )
}

export function fetchActionModuleVersion(
  id: string,
  versionId: string
): Promise<ActionModuleVersionDto> {
  return apiFetch(
    `/api/action-modules/${id}/versions/${versionId}`,
    actionModuleVersionDtoSchema
  )
}

export function fetchActionModuleReferences(
  id: string,
  query?: ModuleReferenceListQuery
): Promise<ModuleReferenceListResponse> {
  return apiFetch(
    `/api/action-modules/${id}/references${toQueryString(query)}`,
    moduleReferenceListResponseSchema
  )
}

export function fetchActionModuleDeletePreview(
  id: string
): Promise<ModuleDeletePreviewResponse> {
  return apiFetch(
    `/api/action-modules/${id}/delete-preview`,
    moduleDeletePreviewResponseSchema
  )
}

export function batchUpgradeActionModuleDrafts(
  id: string,
  body: ModuleBatchUpgradeBody
): Promise<ModuleBatchUpgradeResponse> {
  return apiFetch(
    `/api/action-modules/${id}/batch-upgrade-drafts`,
    moduleBatchUpgradeResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(moduleBatchUpgradeBodySchema.parse(body)),
    }
  )
}

export function updateActionModulePublication(
  id: string,
  versionId: string,
  body: ModulePublicationBody
): Promise<ActionModuleVersionDto> {
  return apiFetch(
    `/api/action-modules/${id}/versions/${versionId}/publication`,
    actionModuleVersionDtoSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modulePublicationBodySchema.parse(body)),
    }
  )
}

export function disableAffectedScenarios(
  id: string,
  body: DisableAffectedScenariosBody
): Promise<DisableAffectedScenariosResponse> {
  return apiFetch(
    `/api/action-modules/${id}/disable-affected-scenarios`,
    disableAffectedScenariosResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(disableAffectedScenariosBodySchema.parse(body)),
    }
  )
}

export function deleteActionModule(id: string): Promise<DeleteResourceResult> {
  return apiFetch(`/api/action-modules/${id}/delete`, deleteResourceResultSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
}

export function fetchModuleCapabilities() {
  return apiFetch(
    '/api/action-modules/capabilities',
    scenarioCapabilitiesSchema
  )
}

export function trialActionModule(
  id: string,
  body: ModuleTrialRunBody
): Promise<RunDetailDto> {
  return apiFetch(`/api/action-modules/${id}/trial`, runDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(moduleTrialRunBodySchema.parse(body)),
  })
}

export function resolveActionModules(body: ModuleResolveRequest): Promise<ModuleResolveResult> {
  return apiFetch('/api/action-modules/resolve', moduleResolveResultSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(moduleResolveRequestSchema.parse(body)),
  })
}

export function fetchModuleResolution(requestId: string): Promise<ModuleResolveResult> {
  return apiFetch(`/api/action-modules/resolutions/${requestId}`, moduleResolveResultSchema)
}

export function fetchActionModuleQuality(
  id: string,
  query?: ModuleQualityQuery,
): Promise<ModuleQualityResponse> {
  return apiFetch(
    `/api/action-modules/${id}/quality${toQueryString(moduleQualityQuerySchema.parse(query ?? {}))}`,
    moduleQualityResponseSchema,
  )
}

export function fetchModuleInvocations(
  id: string,
  query?: ModuleInvocationListQuery,
): Promise<ModuleInvocationListResponse> {
  return apiFetch(
    `/api/action-modules/${id}/invocations${toQueryString(moduleInvocationListQuerySchema.parse(query ?? {}))}`,
    moduleInvocationListResponseSchema,
  )
}

export function closeModuleResolution(
  requestId: string,
  body: ModuleResolveCloseBody,
): Promise<ModuleResolveResult> {
  return apiFetch(
    `/api/action-modules/resolutions/${requestId}/close`,
    moduleResolveResultSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(moduleResolveCloseBodySchema.parse(body)),
    },
  )
}

