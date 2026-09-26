import {
  repairCandidateSchema,
  type AdoptRepairCandidateBody,
  type RejectRepairCandidateBody,
  type ReopenRepairCandidateBody,
  type RepairCandidate,
  type RepairCandidateStatus,
  type ValidateRepairCandidateBody,
} from '@cairn/shared'
import { z } from 'zod'
import { apiFetch, toQueryString } from './api-client'

const adoptResponseSchema = z.object({
  candidate: repairCandidateSchema,
  draftRevision: z.number(),
})

export type AdoptRepairCandidateResponse = z.infer<typeof adoptResponseSchema>

export function fetchRunRepairCandidates(runId: string): Promise<RepairCandidate[]> {
  return apiFetch(`/api/runs/${runId}/repair-candidates`, z.array(repairCandidateSchema))
}

export function fetchScenarioRepairCandidates(
  scenarioId: string,
  query?: { status?: RepairCandidateStatus },
): Promise<RepairCandidate[]> {
  return apiFetch(`/api/scenarios/${scenarioId}/repair-candidates${toQueryString(query)}`, z.array(repairCandidateSchema))
}

export function fetchRepairCandidate(id: string): Promise<RepairCandidate> {
  return apiFetch(`/api/repair-candidates/${id}`, repairCandidateSchema)
}

const validateResponseSchema = z.object({
  candidate: repairCandidateSchema,
  runId: z.string(),
})

export type ValidateRepairCandidateResponse = z.infer<typeof validateResponseSchema>

export function validateRepairCandidate(
  id: string,
  body: ValidateRepairCandidateBody = {},
): Promise<ValidateRepairCandidateResponse> {
  return apiFetch(`/api/repair-candidates/${id}/validate`, validateResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function adoptRepairCandidate(
  id: string,
  body: AdoptRepairCandidateBody,
): Promise<AdoptRepairCandidateResponse> {
  return apiFetch(`/api/repair-candidates/${id}/adopt`, adoptResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function rejectRepairCandidate(
  id: string,
  body?: RejectRepairCandidateBody,
): Promise<RepairCandidate> {
  return apiFetch(`/api/repair-candidates/${id}/reject`, repairCandidateSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

export function reopenRepairCandidate(
  id: string,
  body?: ReopenRepairCandidateBody,
): Promise<RepairCandidate> {
  return apiFetch(`/api/repair-candidates/${id}/reopen`, repairCandidateSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}
