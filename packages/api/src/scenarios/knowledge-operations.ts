import {
  DomainError, completeKnowledgeProposal, findKnowledgeProposalRequest, getScenario,
  listPublishedModuleKnowledge, listTerminologyForCompose, loadKnowledgeMapContext,
  newId, startKnowledgeProposal, validateKnowledgeSources, type DbHandle,
} from '@cairn/db'
import { composeKnowledgeSuggestion, matchPublishedModules, matchTerminologyCandidates, redactKnowledgeQuestion } from '@cairn/map'
import { hasPermission, type CreateKnowledgeProposalBody } from '@cairn/shared'
import type { RequestAccount } from '../common/request-account'
import { knowledgeAccess, requireProposalAccess } from '../map/knowledge-access'

export async function composeScenarioKnowledge(db: DbHandle, scenarioId: string, input: CreateKnowledgeProposalBody, account: RequestAccount, configRevision: number) {
  const body = { ...input, question: redactKnowledgeQuestion(input.question) }
  const replay = await findKnowledgeProposalRequest(db, scenarioId, body)
  if (replay) return requireProposalAccess(db, replay, account)
  const detail = await getScenario(db, scenarioId)
  const access = knowledgeAccess(account, scenarioId)
  if (body.attemptId) await validateKnowledgeSources(db, detail.targetId, [{ kind: 'attempt', attemptId: body.attemptId }], access)
  const allTerms = await listTerminologyForCompose(db, detail.targetId)
  const terms = [] as typeof allTerms
  for (const term of allTerms) {
    try { await validateKnowledgeSources(db, detail.targetId, term.sources, access); terms.push(term) }
    catch (error) { if (!(error instanceof DomainError) || error.kind !== 'not_found') throw error }
  }
  const selectedTermIds = body.selectedTermIds ?? []
  if (selectedTermIds.some(id => !terms.some(term => term.termId === id))) throw new DomainError('not_found', 'KNOWLEDGE_NOT_FOUND', '选定术语不存在或未确认')
  const modules = hasPermission(account.permissions, 'module:read')
    ? await listPublishedModuleKnowledge(db, detail.targetId, body.selectedModuleVersionIds ?? []) : []
  if ((body.selectedModuleVersionIds ?? []).some(id => !modules.some(module => module.moduleVersionId === id))) throw new DomainError('not_found', 'KNOWLEDGE_NOT_FOUND', '选定做法不可用')
  const mapContext = await loadKnowledgeMapContext(db, detail.targetId, body.mapReleaseId)
  const matchedTerms = selectedTermIds.length ? terms.filter(term => selectedTermIds.includes(term.termId)) : matchTerminologyCandidates(body.question, terms)
  const matchedModules = body.selectedModuleVersionIds?.length ? modules : matchPublishedModules(body.question, modules)
  const started = await startKnowledgeProposal(db, scenarioId, body, { kind: 'console', id: account.id }, {
    mapReleaseId: mapContext.publishedReleaseId,
    selectedTermRevisions: matchedTerms.slice(0, 16).map(term => ({ termId: term.termId, revision: term.revision })),
    selectedModuleVersionIds: matchedModules.slice(0, 8).map(module => module.moduleVersionId),
    platformAiConfigRevision: configRevision,
  })
  if (started.replay) return requireProposalAccess(db, started.proposal, account)
  try {
    const composed = composeKnowledgeSuggestion({ question: input.question, targetId: detail.targetId, draft: started.document!, terms, modules, mapAssets: mapContext.assets, selectedTermIds, selectedModuleVersionIds: body.selectedModuleVersionIds, mapReleaseId: mapContext.publishedReleaseId, nextId: newId })
    if (body.attemptId) composed.sources = [...composed.sources, { kind: 'attempt', attemptId: body.attemptId }]
    return await completeKnowledgeProposal(db, scenarioId, started.proposal.proposalId, composed)
  } catch (error) {
    return await completeKnowledgeProposal(db, scenarioId, started.proposal.proposalId, {
      status: 'failed', question: body.question, diffs: [], diagnostics: [{ code: 'KNOWLEDGE_GENERATION_FAILED', message: '建议未通过验证，请检查已选择知识与草稿。' }], sources: [], unknowns: [], termCandidates: [], suggestedModules: [], suggestedBindings: [],
    })
  }
}
