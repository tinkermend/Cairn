import { DomainError, validateKnowledgeSources, type DbHandle } from '@cairn/db'
import { hasPermission, type KnowledgeSourceRef, type AuthoringProposal, type TerminologyEntry } from '@cairn/shared'
import type { RequestAccount } from '../common/request-account'

export function knowledgeAccess(account: RequestAccount, scenarioId?: string) {
  return { runRead: hasPermission(account.permissions, 'run:read'), workflowRead: hasPermission(account.permissions, 'workflow:read'), moduleRead: hasPermission(account.permissions, 'module:read'), mapAnalyze: hasPermission(account.permissions, 'map:analyze'), mapRead: hasPermission(account.permissions, 'map:read'), actorId: account.id, scenarioId }
}

export async function visibleKnowledgeSources(db: DbHandle, targetId: string, sources: KnowledgeSourceRef[], account: RequestAccount) {
  const visible: KnowledgeSourceRef[] = []
  for (const source of sources) {
    try { await validateKnowledgeSources(db, targetId, [source], knowledgeAccess(account)); visible.push(source) }
    catch (error) { if (!(error instanceof DomainError) || !['not_found', 'bad_request'].includes(error.kind)) throw error }
  }
  return visible
}

export async function requireProposalAccess(db: DbHandle, proposal: AuthoringProposal, account: RequestAccount) {
  // A proposal contains copied module bodies and historical term text; hiding only its source IDs is insufficient.
  await validateKnowledgeSources(db, proposal.targetId, proposal.sources, knowledgeAccess(account, proposal.scenarioId))
  if (!hasPermission(account.permissions, 'module:read') && (proposal.suggestedModules.length || proposal.baseline.selectedModuleVersionIds.length)) {
    throw new DomainError('not_found', 'KNOWLEDGE_NOT_FOUND', '知识建议不存在')
  }
  for (const term of proposal.baseline.selectedTermRevisions) {
    await validateKnowledgeSources(db, proposal.targetId, [{ kind: 'term', ...term }], knowledgeAccess(account))
  }
  return proposal
}

export async function visibleTerms(db: DbHandle, targetId: string, items: TerminologyEntry[], account: RequestAccount) {
  const visible: TerminologyEntry[] = []
  for (const item of items) {
    try {
      // The meaning itself copies analysis content. Hiding only IDs would leak it.
      await validateKnowledgeSources(db, targetId, item.sources.filter(source => source.kind === 'analysis_candidate'), knowledgeAccess(account))
      visible.push({ ...item, sources: await visibleKnowledgeSources(db, targetId, item.sources, account) })
    } catch (error) { if (!(error instanceof DomainError) || !['not_found', 'bad_request'].includes(error.kind)) throw error }
  }
  return visible
}
