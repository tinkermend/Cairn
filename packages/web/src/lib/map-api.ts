import {
  mapAssetDetailSchema,
  mapAssetListResponseSchema,
  mapBindingRemoveBodySchema,
  mapBindingRemovedSchema,
  mapChangeListResponseSchema,
  mapGovernanceCommandBodySchema,
  mapGovernanceCommandSchema,
  mapGovernancePreviewBodySchema,
  mapGovernancePreviewResponseSchema,
  mapImpactListResponseSchema,
  mapPublicationBodySchema,
  mapRebuildResponseSchema,
  mapReferenceListResponseSchema,
  mapReleaseListResponseSchema,
  mapReleasePublicationSchema,
  mapRunCluesResponseSchema,
  mapScanStartResponseSchema,
  mapScenarioBindingBodySchema,
  mapScenarioBindingSchema,
  mapSealPublishBodySchema,
  mapConsumptionPolicyDtoSchema,
  mapConsumptionPolicyUpdateBodySchema,
  mapJobPolicyDtoSchema,
  mapJobPolicyUpdateBodySchema,
  mapSafeEntryCreateBodySchema,
  mapSafeEntryDtoSchema,
  mapSafeEntryListResponseSchema,
  mapJobPreviewRequestSchema,
  mapJobPreviewResponseSchema,
  mapJobCreateBodySchema,
  mapJobCreateResponseSchema,
  mapJobDtoSchema,
  explorationPolicyDtoSchema,
  explorationPolicyUpdateBodySchema,
  explorationPreviewRequestSchema,
  explorationCreateBodySchema,
  mapSummaryResponseSchema,
  createTerminologyBodySchema,
  retireTerminologyBodySchema,
  terminologyEntrySchema,
  terminologyListResponseSchema,
  terminologyMatchResponseSchema,
  updateTerminologyBodySchema,
  type MapAssetDetail,
  type MapAssetListResponse,
  type MapBindingRemoveBody,
  type MapBindingRemoved,
  type MapChangeListResponse,
  type MapGovernanceCommandBody,
  type MapGovernanceCommandDto,
  type MapGovernancePreviewBody,
  type MapGovernancePreviewResponse,
  type MapImpactListResponse,
  type MapImpactQuery,
  type MapListQuery,
  type MapPublicationBody,
  type MapReferenceListResponse,
  type MapReleaseListResponse,
  type MapReleasePublication,
  type MapRunCluesResponse,
  type MapScanStartResponse,
  type MapScenarioBindingBody,
  type MapScenarioBindingDto,
  type MapSealPublishBody,
  type MapConsumptionPolicyDto,
  type MapConsumptionPolicyUpdateBody,
  type MapJobPolicyDto,
  type MapJobPolicyUpdateBody,
  type MapSafeEntryCreateBody,
  type MapSafeEntryDto,
  type MapJobPreviewRequest,
  type MapJobPreviewResponse,
  type MapJobCreateBody,
  type MapJobCreateResponse,
  type MapJobDto,
  type ExplorationPolicyDto,
  type ExplorationPolicyUpdateBody,
  type ExplorationPreviewRequest,
  type ExplorationCreateBody,
  type MapSummaryResponse,
  type CreateTerminologyBody,
  type RetireTerminologyBody,
  type TerminologyEntry,
  type TerminologyListQuery,
  type TerminologyListResponse,
  type TerminologyMatchResponse,
  type UpdateTerminologyBody,
} from '@cairn/shared'
import { apiFetch, toQueryString } from '@/lib/api-client'

function mapQueryString(query?: Record<string, unknown>): string {
  return toQueryString(query ? {
    ...query,
    conditionSnapshot: query.conditionSnapshot ? JSON.stringify(query.conditionSnapshot) : undefined,
  } : undefined)
}


export function fetchMapSummary(targetId: string, query?: MapListQuery): Promise<MapSummaryResponse> {
  return apiFetch(`/api/targets/${targetId}/map/summary${mapQueryString(query)}`, mapSummaryResponseSchema)
}

export function fetchMapObjects(targetId: string, query?: MapListQuery): Promise<MapAssetListResponse> {
  return apiFetch(`/api/targets/${targetId}/map/objects${mapQueryString(query)}`, mapAssetListResponseSchema)
}

export function fetchMapPages(targetId: string, query?: MapListQuery): Promise<MapAssetListResponse> {
  return apiFetch(`/api/targets/${targetId}/map/pages${mapQueryString(query)}`, mapAssetListResponseSchema)
}

export function fetchMapObject(
  targetId: string,
  objectId: string,
  query?: MapListQuery,
): Promise<MapAssetDetail> {
  return apiFetch(`/api/targets/${targetId}/map/objects/${objectId}${mapQueryString(query)}`, mapAssetDetailSchema)
}

export function fetchMapChanges(targetId: string, query?: MapListQuery): Promise<MapChangeListResponse> {
  return apiFetch(`/api/targets/${targetId}/map/changes${mapQueryString(query)}`, mapChangeListResponseSchema)
}

export function fetchMapReferences(targetId: string, query?: MapListQuery): Promise<MapReferenceListResponse> {
  return apiFetch(`/api/targets/${targetId}/map/references${mapQueryString(query)}`, mapReferenceListResponseSchema)
}

export function fetchMapImpacts(targetId: string, query?: MapImpactQuery): Promise<MapImpactListResponse> {
  return apiFetch(`/api/targets/${targetId}/map/impacts${mapQueryString(query)}`, mapImpactListResponseSchema)
}

export function fetchMapReleases(targetId: string, query?: MapListQuery): Promise<MapReleaseListResponse> {
  return apiFetch(`/api/targets/${targetId}/map/releases${mapQueryString(query)}`, mapReleaseListResponseSchema)
}

export function previewMapGovernance(
  targetId: string,
  body: MapGovernancePreviewBody,
): Promise<MapGovernancePreviewResponse> {
  return apiFetch(`/api/targets/${targetId}/map/governance/preview`, mapGovernancePreviewResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mapGovernancePreviewBodySchema.parse(body)),
  })
}

export function submitMapGovernance(
  targetId: string,
  body: MapGovernanceCommandBody,
): Promise<MapGovernanceCommandDto> {
  return apiFetch(`/api/targets/${targetId}/map/governance/commands`, mapGovernanceCommandSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mapGovernanceCommandBodySchema.parse(body)),
  })
}

export function publishMapRelease(targetId: string, body: MapSealPublishBody): Promise<MapReleasePublication> {
  return apiFetch(`/api/targets/${targetId}/map/releases`, mapReleasePublicationSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mapSealPublishBodySchema.parse(body)),
  })
}

export function withdrawMapRelease(
  targetId: string,
  releaseId: string,
  body: MapPublicationBody,
): Promise<MapReleasePublication> {
  return apiFetch(`/api/targets/${targetId}/map/releases/${releaseId}/withdraw`, mapReleasePublicationSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mapPublicationBodySchema.parse(body)),
  })
}

export function bindMapScenario(
  targetId: string,
  body: MapScenarioBindingBody,
): Promise<MapScenarioBindingDto> {
  return apiFetch(`/api/targets/${targetId}/map/scenario-bindings`, mapScenarioBindingSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mapScenarioBindingBodySchema.parse(body)),
  })
}

export function removeMapBinding(
  targetId: string,
  bindingId: string,
  body: MapBindingRemoveBody,
): Promise<MapBindingRemoved> {
  return apiFetch(`/api/targets/${targetId}/map/scenario-bindings/${bindingId}/remove`, mapBindingRemovedSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mapBindingRemoveBodySchema.parse(body)),
  })
}

export function startMapScan(targetId: string): Promise<MapScanStartResponse> {
  return apiFetch(`/api/targets/${targetId}/map/reference-scans`, mapScanStartResponseSchema, { method: 'POST' })
}

export function rebuildMapProjection(targetId: string) {
  return apiFetch(`/api/targets/${targetId}/map/projections/rebuild`, mapRebuildResponseSchema, { method: 'POST' })
}

export function fetchMapRunClues(targetId: string, runId: string): Promise<MapRunCluesResponse> {
  return apiFetch(`/api/targets/${targetId}/map/runs/${runId}/clues`, mapRunCluesResponseSchema)
}

export function fetchMapTerms(targetId: string, query?: TerminologyListQuery): Promise<TerminologyListResponse> {
  return apiFetch(`/api/targets/${targetId}/map/terms${mapQueryString(query)}`, terminologyListResponseSchema)
}

export function matchMapTerms(targetId: string, alias: string): Promise<TerminologyMatchResponse> {
  return apiFetch(`/api/targets/${targetId}/map/terms/match${toQueryString({ alias })}`, terminologyMatchResponseSchema)
}

export function createMapTerm(targetId: string, body: CreateTerminologyBody): Promise<TerminologyEntry> {
  return apiFetch(`/api/targets/${targetId}/map/terms`, terminologyEntrySchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createTerminologyBodySchema.parse(body)),
  })
}

export function updateMapTerm(targetId: string, termId: string, body: UpdateTerminologyBody): Promise<TerminologyEntry> {
  return apiFetch(`/api/targets/${targetId}/map/terms/${termId}/update`, terminologyEntrySchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateTerminologyBodySchema.parse(body)),
  })
}

export function fetchMapConsumptionPolicy(targetId: string): Promise<MapConsumptionPolicyDto> {
  return apiFetch(`/api/targets/${targetId}/map/consumption-policy`, mapConsumptionPolicyDtoSchema)
}

export function fetchMapJobPolicy(targetId: string): Promise<MapJobPolicyDto> {
  return apiFetch(`/api/targets/${targetId}/map/job-policy`, mapJobPolicyDtoSchema)
}

export function updateMapJobPolicy(targetId: string, body: MapJobPolicyUpdateBody): Promise<MapJobPolicyDto> {
  return apiFetch(`/api/targets/${targetId}/map/job-policy`, mapJobPolicyDtoSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mapJobPolicyUpdateBodySchema.parse(body)),
  })
}

export function fetchMapSafeEntries(targetId: string): Promise<{ items: MapSafeEntryDto[] }> {
  return apiFetch(`/api/targets/${targetId}/map/safe-entries`, mapSafeEntryListResponseSchema)
}

export function createMapSafeEntry(targetId: string, body: MapSafeEntryCreateBody): Promise<MapSafeEntryDto> {
  return apiFetch(`/api/targets/${targetId}/map/safe-entries`, mapSafeEntryDtoSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mapSafeEntryCreateBodySchema.parse(body)),
  })
}

export function previewMapJob(targetId: string, body: MapJobPreviewRequest): Promise<MapJobPreviewResponse> {
  return apiFetch(`/api/targets/${targetId}/map/jobs/preview`, mapJobPreviewResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mapJobPreviewRequestSchema.parse(body)),
  })
}

export function fetchExplorationPolicy(targetId: string): Promise<ExplorationPolicyDto> {
  return apiFetch(`/api/targets/${targetId}/map/exploration-policy`, explorationPolicyDtoSchema)
}

export function updateExplorationPolicy(
  targetId: string,
  body: ExplorationPolicyUpdateBody,
): Promise<ExplorationPolicyDto> {
  return apiFetch(`/api/targets/${targetId}/map/exploration-policy`, explorationPolicyDtoSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(explorationPolicyUpdateBodySchema.parse(body)),
  })
}

export function previewExploration(
  targetId: string,
  body: ExplorationPreviewRequest,
): Promise<MapJobPreviewResponse> {
  return apiFetch(`/api/targets/${targetId}/map/explorations/preview`, mapJobPreviewResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(explorationPreviewRequestSchema.parse(body)),
  })
}

export function createExploration(targetId: string, body: ExplorationCreateBody): Promise<MapJobCreateResponse> {
  return apiFetch(`/api/targets/${targetId}/map/explorations`, mapJobCreateResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(explorationCreateBodySchema.parse(body)),
  })
}

export function createMapJob(targetId: string, body: MapJobCreateBody): Promise<MapJobCreateResponse> {
  return apiFetch(`/api/targets/${targetId}/map/jobs`, mapJobCreateResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mapJobCreateBodySchema.parse(body)),
  })
}

export function fetchMapJob(jobId: string): Promise<MapJobDto> {
  return apiFetch(`/api/map-jobs/${jobId}`, mapJobDtoSchema)
}

export function cancelMapJob(jobId: string): Promise<MapJobDto> {
  return apiFetch(`/api/map-jobs/${jobId}/cancel`, mapJobDtoSchema, { method: 'POST' })
}

export function updateMapConsumptionPolicy(
  targetId: string,
  body: MapConsumptionPolicyUpdateBody,
): Promise<MapConsumptionPolicyDto> {
  return apiFetch(`/api/targets/${targetId}/map/consumption-policy`, mapConsumptionPolicyDtoSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mapConsumptionPolicyUpdateBodySchema.parse(body)),
  })
}

export function retireMapTerm(targetId: string, termId: string, body: RetireTerminologyBody): Promise<TerminologyEntry> {
  return apiFetch(`/api/targets/${targetId}/map/terms/${termId}/retire`, terminologyEntrySchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(retireTerminologyBodySchema.parse(body)),
  })
}
