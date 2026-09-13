import {
  createScenarioBodySchema,
  publishScenarioBodySchema,
  runDetailSchema,
  saveScenarioDraftBodySchema,
  scenarioCapabilitiesSchema,
  scenarioDetailSchema,
  scenarioListResponseSchema,
  trialRunBodySchema,
  updateScenarioBodySchema,
  type CreateScenarioBody,
  type PublishScenarioBody,
  type RunDetailDto,
  type SaveScenarioDraftBody,
  type ScenarioCapabilities,
  type ScenarioDetailDto,
  type ScenarioListResponse,
  type TrialRunBody,
  type UpdateScenarioBody,
} from '@cairn/shared'
import { apiFetch } from '@/lib/api-client'

export function fetchScenarios(): Promise<ScenarioListResponse> {
  return apiFetch('/api/scenarios', scenarioListResponseSchema)
}

export function fetchScenario(id: string): Promise<ScenarioDetailDto> {
  return apiFetch(`/api/scenarios/${id}`, scenarioDetailSchema)
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
