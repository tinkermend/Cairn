import {
  type AssistantKnowledgeProposal,
  type ScenarioDocument,
  isAuthoringDocumentV2,
  parseScenarioDocument,
  scenarioDocumentDigest,
} from '@cairn/shared'
import { DomainError, getScenario } from '@cairn/db'
import { redactKnowledgeQuestion } from '@cairn/map'
import type { AssistantCapabilityHandlerContext } from '../registry'
import { composeScenarioKnowledge } from '../../scenarios/knowledge-operations'
import { requireVisibleTarget } from './common'

function requireFlatDocument(document: unknown): ScenarioDocument {
  if (isAuthoringDocumentV2(document)) {
    return parseScenarioDocument({
      schemaVersion: document.schemaVersion,
      inputs: document.inputs,
      steps: document.nodes.flatMap((n) => (n.kind === 'step' ? [n.step] : [])),
    })
  }
  return parseScenarioDocument(document)
}

export async function handleComposeKnowledge(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantKnowledgeProposal> {
  const { actor, slots, question, db, targets, platformConfig, onProgress } = ctx
  await onProgress?.('loading_facts', '正在检索草稿与已授权术语...')

  const scenarioId = String(slots.scenarioId ?? '')
  const draftRevision = Number(slots.draftRevision)

  if (!scenarioId) {
    throw new DomainError('bad_request', 'MISSING_SLOT', '缺少必需参数 scenarioId')
  }

  const detail = await getScenario(db, scenarioId)
  await requireVisibleTarget(actor, detail.targetId, targets, db)

  if (!detail.draft || detail.draft.revision !== draftRevision) {
    throw new DomainError('conflict', 'ASSISTANT_DRAFT_STALE', '请基于当前已保存草稿重新生成')
  }

  const document = requireFlatDocument(detail.draft.document)
  const digest = await scenarioDocumentDigest(document)
  const config = await platformConfig.get()

  await onProgress?.('generating', '正在调用知识操作生成建议草稿...')
  const composed = await composeScenarioKnowledge(
    db,
    scenarioId,
    {
      idempotencyKey: `asst-${crypto.randomUUID()}`,
      question: redactKnowledgeQuestion(question),
      expectedDraftRevision: draftRevision,
      documentDigest: digest,
    },
    actor,
    config.revision,
  )

  await onProgress?.('validating', '正在验证生成的知识建议差异...')

  return {
    kind: 'knowledge_proposal',
    proposalId: composed.proposalId,
    status:
      composed.proposalStatus === 'requested' || composed.proposalStatus === 'cancelled'
        ? 'failed'
        : composed.proposalStatus,
    reason: composed.diagnostics[0]?.message ?? '已生成知识建议，采纳后才会写入草稿。',
    diffs: composed.diffs,
    diagnostics: composed.diagnostics.map((item) => ({
      code: item.code,
      message: item.message,
      fieldPath: item.fieldPath,
    })),
    sources: composed.sources,
    unknowns: composed.unknowns,
    executable: composed.proposalStatus === 'proposed',
    draftRevision,
    documentDigest: digest,
  }
}
