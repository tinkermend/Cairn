import {
  acceptKnowledgeProposalBodySchema,
  authoringProposalSchema,
  createKnowledgeProposalBodySchema,
  knowledgeProposalAcceptedSchema,
  analysisJobDtoSchema,
  reviewAnalysisCandidateBodySchema,
  type ReviewAnalysisCandidateBody,
  type AcceptKnowledgeProposalBody,
  type AuthoringProposal,
  type CreateKnowledgeProposalBody,
  type KnowledgeProposalAccepted,
} from '@cairn/shared'
import { apiFetch } from '@/lib/api-client'

export function reviewAnalysisCandidate(candidateId: string, body: ReviewAnalysisCandidateBody) {
  return apiFetch(`/api/knowledge-candidates/${candidateId}/review`, analysisJobDtoSchema, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reviewAnalysisCandidateBodySchema.parse(body)),
  })
}

export function createKnowledgeProposal(
  scenarioId: string,
  body: CreateKnowledgeProposalBody
): Promise<AuthoringProposal> {
  return apiFetch(
    `/api/scenarios/${scenarioId}/knowledge-proposals`,
    authoringProposalSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createKnowledgeProposalBodySchema.parse(body)),
    }
  )
}

export function fetchKnowledgeProposal(
  scenarioId: string,
  proposalId: string
): Promise<AuthoringProposal> {
  return apiFetch(
    `/api/scenarios/${scenarioId}/knowledge-proposals/${proposalId}`,
    authoringProposalSchema
  )
}

export function acceptKnowledgeProposal(
  scenarioId: string,
  proposalId: string,
  body: AcceptKnowledgeProposalBody
): Promise<KnowledgeProposalAccepted> {
  return apiFetch(
    `/api/scenarios/${scenarioId}/knowledge-proposals/${proposalId}/accept`,
    knowledgeProposalAcceptedSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(acceptKnowledgeProposalBodySchema.parse(body)),
    }
  )
}

export function rejectKnowledgeProposal(
  scenarioId: string,
  proposalId: string
): Promise<AuthoringProposal> {
  return apiFetch(
    `/api/scenarios/${scenarioId}/knowledge-proposals/${proposalId}/reject`,
    authoringProposalSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }
  )
}
