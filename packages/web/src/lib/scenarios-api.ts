import {
  createScenarioBodySchema,
  scenarioDetailSchema,
  scenarioListResponseSchema,
  type CreateScenarioBody,
  type ScenarioDetailDto,
  type ScenarioListResponse,
} from '@cairn/shared'
import { apiFetch } from '@/lib/api-client'

export function fetchScenarios(): Promise<ScenarioListResponse> {
  return apiFetch('/api/scenarios', scenarioListResponseSchema)
}

export function fetchScenario(id: string): Promise<ScenarioDetailDto> {
  return apiFetch(`/api/scenarios/${id}`, scenarioDetailSchema)
}

export function createScenario(body: CreateScenarioBody): Promise<ScenarioDetailDto> {
  return apiFetch('/api/scenarios', scenarioDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createScenarioBodySchema.parse(body)),
  })
}
