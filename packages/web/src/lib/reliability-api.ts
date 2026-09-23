import {
  type AssetReliabilityListResponse,
  type AssetReliabilityQuery,
  type BatchUpgradeBody,
  type IncidentImpactSnapshotDto,
  type IncidentSignalsListResponse,
  type IncidentSignalsQuery,
  type MaintenanceUpgradeJobDto,
  type ReliabilityIncidentDto,
  type ReliabilityIncidentListQuery,
  type ReliabilityIncidentListResponse,
  type ReliabilityIncidentMemberDto,
  assetReliabilityListResponseSchema,
  incidentImpactSnapshotSchema,
  incidentSignalsListResponseSchema,
  maintenanceUpgradeJobSchema,
  reliabilityIncidentDtoSchema,
  reliabilityIncidentListResponseSchema,
} from '@cairn/shared'
import { z } from 'zod'
import { apiFetch, toQueryString } from '@/lib/api-client'

export function fetchIncidents(query?: ReliabilityIncidentListQuery): Promise<ReliabilityIncidentListResponse> {
  return apiFetch(`/api/reliability/incidents${toQueryString(query)}`, reliabilityIncidentListResponseSchema)
}

const incidentDetailResponseSchema = z.object({
  incident: reliabilityIncidentDtoSchema,
  members: z.array(z.any()),
})

export function fetchIncidentDetail(incidentId: string): Promise<{
  incident: ReliabilityIncidentDto
  members: ReliabilityIncidentMemberDto[]
}> {
  return apiFetch(`/api/reliability/incidents/${incidentId}`, incidentDetailResponseSchema)
}

export function fetchIncidentSignals(
  incidentId: string,
  query?: IncidentSignalsQuery,
): Promise<IncidentSignalsListResponse> {
  return apiFetch(
    `/api/reliability/incidents/${incidentId}/signals${toQueryString(query)}`,
    incidentSignalsListResponseSchema,
  )
}

export function fetchAssetReliability(query?: AssetReliabilityQuery): Promise<AssetReliabilityListResponse> {
  return apiFetch(`/api/reliability/assets${toQueryString(query)}`, assetReliabilityListResponseSchema)
}

export function dismissIncident(incidentId: string, reason: string): Promise<ReliabilityIncidentDto> {
  return apiFetch(`/api/reliability/incidents/${incidentId}/dismiss`, reliabilityIncidentDtoSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  })
}

export function silenceIncident(
  incidentId: string,
  durationHours: number,
  reason: string,
): Promise<ReliabilityIncidentDto> {
  return apiFetch(`/api/reliability/incidents/${incidentId}/silence`, reliabilityIncidentDtoSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ durationHours, reason }),
  })
}

export function resolveIncident(
  incidentId: string,
  reason: string,
  expectedRevision?: number,
): Promise<ReliabilityIncidentDto> {
  return apiFetch(`/api/reliability/incidents/${incidentId}/resolve`, reliabilityIncidentDtoSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason, expectedRevision }),
  })
}

export function mergeIncident(
  incidentId: string,
  targetIncidentId: string,
): Promise<ReliabilityIncidentDto> {
  return apiFetch(`/api/reliability/incidents/${incidentId}/merge`, reliabilityIncidentDtoSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetIncidentId }),
  })
}

export function splitIncident(
  incidentId: string,
  memberIds: string[],
  newTitle?: string,
): Promise<{ sourceIncident: ReliabilityIncidentDto; newIncident: ReliabilityIncidentDto }> {
  const splitResponseSchema = z.object({
    sourceIncident: reliabilityIncidentDtoSchema,
    newIncident: reliabilityIncidentDtoSchema,
  })
  return apiFetch(`/api/reliability/incidents/${incidentId}/split`, splitResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberIds, newTitle }),
  })
}

export function fetchIncidentImpact(incidentId: string): Promise<IncidentImpactSnapshotDto> {
  return apiFetch(`/api/reliability/incidents/${incidentId}/impact`, incidentImpactSnapshotSchema)
}

export function executeBatchUpgrade(
  incidentId: string,
  body: BatchUpgradeBody,
): Promise<MaintenanceUpgradeJobDto> {
  return apiFetch(
    `/api/reliability/incidents/${incidentId}/batch-upgrade`,
    maintenanceUpgradeJobSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
}

export function fetchUpgradeJob(jobId: string): Promise<MaintenanceUpgradeJobDto> {
  return apiFetch(`/api/reliability/upgrade-jobs/${jobId}`, maintenanceUpgradeJobSchema)
}
