import { compileScenarioDocument } from '@cairn/authoring'
import { and, eq } from 'drizzle-orm'
import {
  acceptKnowledgeProposalBodySchema,
  authoringProposalSchema,
  canonicalJson,
  createKnowledgeProposalBodySchema,
  isAuthoringDocumentV2,
  knowledgeProposalAcceptedSchema,
  mapAssetRefKey,
  parseScenarioDocument,
  scenarioDocumentDigest,
  type AcceptKnowledgeProposalBody,
  type AuthoringProposal,
  type AuthoringProposalStatus,
  type CreateKnowledgeProposalBody,
  type ExecutionActor,
  type KnowledgeDiagnostic,
  type KnowledgeDiff,
  type KnowledgeSourceRef,
  type KnowledgeSuggestedBinding,
  type KnowledgeSuggestedModule,
  type KnowledgeTermCandidate,
  type ScenarioDocument,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit } from '../audit/record.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import { sha256Hex } from '../runs/digest.js'
import { badRequest, conflict } from '../runs/errors.js'
import { reconcileMapDraftBindingsTx } from '../map/references.js'
import { validateKnowledgeSources } from './sources.js'
import { requireLiveTarget, requireMapAsset } from '../map/view.js'
import {
  authoringProposalStale,
  authoringSchemaUnsupported,
  knowledgeIdempotencyConflict,
  knowledgeNotFound,
} from './errors.js'

const GENERATING_TTL_MS = 120_000

export type KnowledgeComposePersist = {
  status: Extract<AuthoringProposalStatus, 'proposed' | 'needs_input' | 'unsupported' | 'failed'>
  question: string
  document?: ScenarioDocument
  diffs: KnowledgeDiff[]
  diagnostics: KnowledgeDiagnostic[]
  sources: KnowledgeSourceRef[]
  unknowns: string[]
  termCandidates: KnowledgeTermCandidate[]
  suggestedModules: KnowledgeSuggestedModule[]
  suggestedBindings: KnowledgeSuggestedBinding[]
}

function iso(value: Date): string {
  return value.toISOString()
}

function toProposal(row: {
  id: string
  targetId: string
  scenarioId: string
  proposalStatus: AuthoringProposalStatus
  question: string
  baseline: AuthoringProposal['baseline']
  document: ScenarioDocument | null
  diffs: KnowledgeDiff[]
  diagnostics: KnowledgeDiagnostic[]
  sources: KnowledgeSourceRef[]
  unknowns: string[]
  termCandidates: KnowledgeTermCandidate[]
  suggestedModules: KnowledgeSuggestedModule[]
  suggestedBindings: KnowledgeSuggestedBinding[]
  createdAt: Date
  updatedAt: Date
}): AuthoringProposal {
  return authoringProposalSchema.parse({
    proposalId: row.id,
    targetId: row.targetId,
    scenarioId: row.scenarioId,
    proposalStatus: row.proposalStatus,
    question: row.question,
    baseline: row.baseline,
    document: row.document ?? undefined,
    diffs: row.diffs,
    diagnostics: row.diagnostics,
    sources: row.sources,
    unknowns: row.unknowns,
    termCandidates: row.termCandidates,
    suggestedModules: row.suggestedModules,
    suggestedBindings: row.suggestedBindings,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  })
}

function flattenKnowledgeDocument(value: unknown): ScenarioDocument {
  if (isAuthoringDocumentV2(value)) {
    if (value.nodes.some((node) => node.kind === 'module')) authoringSchemaUnsupported()
    return parseScenarioDocument({
      schemaVersion: value.schemaVersion,
      inputs: value.inputs,
      steps: value.nodes.filter((node) => node.kind === 'step').map((node) => node.step),
    })
  }
  if (value && typeof value === 'object' && 'authoringSchemaVersion' in value) {
    authoringSchemaUnsupported()
  }
  return parseScenarioDocument(value)
}

async function lockScenarioDraft(tx: Db, scenarioId: string, targetId: string) {
  const { scenarios, scenarioDrafts } = schemaFor(tx)
  const [scenario] = await locked(
    tx,
    tx.select().from(scenarios).where(and(eq(scenarios.id, scenarioId))),
  )
  if (!scenario || scenario.deletedAt) knowledgeNotFound('场景不存在')
  if (scenario.targetId !== targetId) knowledgeNotFound('场景不属于该目标系统')
  const [draft] = await locked(tx, tx.select().from(scenarioDrafts).where(eq(scenarioDrafts.scenarioId, scenarioId)))
  if (!draft) knowledgeNotFound('场景草稿不存在')
  return { scenario, draft }
}

export async function getKnowledgeProposal(db: Db, scenarioId: string, proposalId: string) {
  const { mapAuthoringProposals, scenarios } = schemaFor(db)
  const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1)
  if (!scenario || scenario.deletedAt) knowledgeNotFound('场景不存在')
  const [row] = await db
    .select()
    .from(mapAuthoringProposals)
    .where(and(eq(mapAuthoringProposals.id, proposalId), eq(mapAuthoringProposals.scenarioId, scenarioId)))
    .limit(1)
  if (!row) knowledgeNotFound('知识建议不存在')
  if (row.proposalStatus === 'generating' && Date.now() - row.updatedAt.getTime() > GENERATING_TTL_MS) {
    return toProposal({ ...row, proposalStatus: 'failed', diagnostics: [{ code: 'KNOWLEDGE_GENERATION_EXPIRED', message: '生成已超时，请用新的请求重新生成。' }] })
  }
  return toProposal(row)
}

export async function startKnowledgeProposal(
  db: Db,
  scenarioId: string,
  body: CreateKnowledgeProposalBody,
  actor: ExecutionActor,
  extras: {
    mapReleaseId?: string
    selectedTermRevisions: AuthoringProposal['baseline']['selectedTermRevisions']
    platformAiConfigRevision: number
    selectedModuleVersionIds?: string[]
  },
) {
  const parsed = createKnowledgeProposalBodySchema.parse(body)
  return atomic(db, async (tx) => {
    const { mapAuthoringProposals, scenarios } = schemaFor(tx)
    const [scenario] = await locked(tx, tx.select().from(scenarios).where(eq(scenarios.id, scenarioId)))
    if (!scenario || scenario.deletedAt) knowledgeNotFound('场景不存在')
    const requestDigest = sha256Hex(canonicalJson(parsed))
    const [existing] = await tx.select().from(mapAuthoringProposals).where(and(eq(mapAuthoringProposals.scenarioId, scenarioId), eq(mapAuthoringProposals.requestKey, parsed.idempotencyKey))).limit(1)
    if (existing) {
      if (existing.requestDigest !== requestDigest) knowledgeIdempotencyConflict()
      return { proposal: await getKnowledgeProposal(tx, scenarioId, existing.id), replay: true, document: undefined }
    }
    const { draft } = await lockScenarioDraft(tx, scenarioId, scenario.targetId)
    const document = flattenKnowledgeDocument(draft.document)
    if (draft.revision !== parsed.expectedDraftRevision) {
      throw conflict('SCENARIO_DRAFT_CONFLICT', '草稿已被他人更新', {
        revision: draft.revision,
        document: draft.document,
      })
    }
    const digest = await scenarioDocumentDigest(document)
    if (digest !== parsed.documentDigest) authoringProposalStale('提交的文档摘要与当前草稿不一致')
    await requireLiveTarget(tx, scenario.targetId)
    const now = await clockNow(tx)
    const baseline = {
      draftRevision: draft.revision,
      documentDigest: digest,
      mapReleaseId: parsed.mapReleaseId ?? extras.mapReleaseId,
      selectedTermRevisions: extras.selectedTermRevisions,
      selectedModuleVersionIds: extras.selectedModuleVersionIds ?? parsed.selectedModuleVersionIds,
      platformAiConfigRevision: extras.platformAiConfigRevision,
    }
    const id = newId()
    await insertRows(tx, mapAuthoringProposals, {
        id,
        targetId: scenario.targetId,
        scenarioId,
        requestKey: parsed.idempotencyKey,
        requestDigest,
        proposalStatus: 'generating',
        question: parsed.question,
        baseline,
        document: null,
        diffs: [],
        diagnostics: [],
        sources: [],
        unknowns: [],
        termCandidates: [],
        suggestedModules: [],
        suggestedBindings: [],
        actorId: actor.id,
        createdAt: now,
        updatedAt: now,
      })
    await recordAudit(tx, actor, 'knowledge.propose', 'knowledge_proposal', id, '开始生成知识建议')
    return { proposal: await getKnowledgeProposal(tx, scenarioId, id), replay: false, document }
  })
}

export async function completeKnowledgeProposal(
  db: Db,
  scenarioId: string,
  proposalId: string,
  result: KnowledgeComposePersist,
) {
  return atomic(db, async (tx) => {
    const { mapAuthoringProposals } = schemaFor(tx)
    const [row] = await locked(
      tx,
      tx.select().from(mapAuthoringProposals).where(and(eq(mapAuthoringProposals.id, proposalId), eq(mapAuthoringProposals.scenarioId, scenarioId))),
    )
    if (!row) knowledgeNotFound('知识建议不存在')
    if (row.proposalStatus !== 'generating') return toProposal(row)
    if (Date.now() - row.updatedAt.getTime() > GENERATING_TTL_MS) {
      await tx.update(mapAuthoringProposals).set({ proposalStatus: 'failed', updatedAt: await clockNow(tx) }).where(eq(mapAuthoringProposals.id, proposalId))
      return getKnowledgeProposal(tx, scenarioId, proposalId)
    }
    toProposal({ ...row, proposalStatus: result.status, ...result, document: result.document ?? null })
    await validateKnowledgeSources(tx, row.targetId, result.sources, { runRead: true, workflowRead: true, moduleRead: true, scenarioId })
    if (result.status === 'proposed') {
      if (!result.document) throw badRequest('KNOWLEDGE_INVALID_PROPOSAL', '可接受建议必须包含文档')
      const compiled = compileScenarioDocument(result.document, { mode: 'save' })
      if (!compiled.ok || compiled.diagnostics.some(item => item.code === 'SCENARIO_UNRESOLVED_REF')) throw badRequest('KNOWLEDGE_INVALID_PROPOSAL', '建议未通过编译验证')
      const stepIds = new Set(result.document.steps.map(step => step.id))
      if (result.suggestedBindings.some(binding => !stepIds.has(binding.stepId))) knowledgeNotFound('建议绑定步骤不存在')
      await validateKnowledgeSources(tx, row.targetId, result.suggestedBindings.map(binding => ({ kind: 'map_asset' as const, assetRef: binding.assetRef })))
      if (new Set(result.suggestedBindings.map(binding => binding.stepId)).size !== result.suggestedBindings.length) knowledgeNotFound('同一步骤不能接受多个对象绑定')
    }

    if (result.document && isAuthoringDocumentV2(result.document)) authoringSchemaUnsupported()
    const now = await clockNow(tx)
    await tx
      .update(mapAuthoringProposals)
      .set({
        proposalStatus: result.status,
        question: result.question,
        document: result.document ?? null,
        diffs: result.diffs,
        diagnostics: result.diagnostics,
        sources: result.sources,
        unknowns: result.unknowns,
        termCandidates: result.termCandidates,
        suggestedModules: result.suggestedModules,
        suggestedBindings: result.suggestedBindings,
        updatedAt: now,
      })
      .where(eq(mapAuthoringProposals.id, proposalId))
    return getKnowledgeProposal(tx, scenarioId, proposalId)
  })
}

async function writeAcceptedBindings(
  tx: Db,
  targetId: string,
  scenarioId: string,
  draftRevision: number,
  bindings: KnowledgeSuggestedBinding[],
  proposalId: string,
  actor: ExecutionActor,
) {
  const { mapScenarioBindings } = schemaFor(tx)
  const now = await clockNow(tx)
  for (const binding of bindings) {
    await requireMapAsset(tx, targetId, binding.assetRef)
    const { mapObjectDescriptors } = schemaFor(tx)
    const descriptors = binding.assetRef.objectId ? await tx.select().from(mapObjectDescriptors).where(eq(mapObjectDescriptors.objectId, binding.assetRef.objectId)) : []
    const descriptor = descriptors.find(item => item.implementationKey === binding.assetRef.implementationKey && item.descriptorVersion === binding.assetRef.descriptorVersion)
    const slot = `step:${binding.stepId}`
    const values = {
      targetId,
      scenarioId,
      slotKey: slot,
      stepId: binding.stepId,
      assetRefKey: mapAssetRefKey(binding.assetRef),
      pageId: binding.assetRef.pageId ?? null,
      objectId: binding.assetRef.objectId ?? null,
      implementationKey: binding.assetRef.implementationKey ?? null,
      descriptorVersion: binding.assetRef.descriptorVersion ?? null,
      basis: 'accepted_proposal' as const,
      scopeKind: 'draft' as const,
      draftRevision,
      scenarioVersionId: null,
      versionSlot: 'draft',
      descriptorDigest: sha256Hex(canonicalJson(descriptor?.features ?? binding.assetRef)),
      confirmedBy: actor.id,
      confirmedAt: now,
      resolution: 'resolved' as const,
      sourceRef: { kind: 'accepted_proposal', proposalId },
      status: 'active',
      updatedAt: now,
    }
    const [existing] = await tx
      .select()
      .from(mapScenarioBindings)
      .where(
        and(
          eq(mapScenarioBindings.targetId, targetId),
          eq(mapScenarioBindings.scenarioId, scenarioId),
          eq(mapScenarioBindings.scopeKind, 'draft'),
          eq(mapScenarioBindings.slotKey, slot),
          eq(mapScenarioBindings.versionSlot, 'draft'),
        ),
      )
      .limit(1)
    if (existing) {
      await tx.update(mapScenarioBindings).set(values).where(eq(mapScenarioBindings.id, existing.id))
    } else {
      await insertRows(tx, mapScenarioBindings, { id: newId(), ...values, createdAt: now })
    }
  }
}

export async function acceptKnowledgeProposal(
  db: Db,
  scenarioId: string,
  proposalId: string,
  body: AcceptKnowledgeProposalBody,
  actor: ExecutionActor,
) {
  const parsed = acceptKnowledgeProposalBodySchema.parse(body)
  const result = await atomic(db, async (tx) => {
    const { mapAuthoringProposals, scenarioDrafts, scenarios } = schemaFor(tx)
    const [row] = await locked(
      tx,
      tx.select().from(mapAuthoringProposals).where(and(eq(mapAuthoringProposals.id, proposalId), eq(mapAuthoringProposals.scenarioId, scenarioId))),
    )
    if (!row) knowledgeNotFound('知识建议不存在')
    if (row.proposalStatus === 'accepted') {
      if (row.acceptKey !== parsed.idempotencyKey || parsed.expectedDraftRevision !== row.baseline.draftRevision || parsed.documentDigest !== row.baseline.documentDigest) knowledgeIdempotencyConflict()
      return {
        kind: 'accepted' as const,
        value: knowledgeProposalAcceptedSchema.parse({
          proposal: toProposal(row),
          draftRevision: row.acceptedRevision ?? row.baseline.draftRevision,
        }),
      }
    }
    if (row.proposalStatus !== 'proposed' || !row.document) {
      throw badRequest('KNOWLEDGE_NOT_FOUND', '当前建议不能接受，请先处理待确认项')
    }
    const { draft } = await lockScenarioDraft(tx, scenarioId, row.targetId)
    const [usedKey] = await tx.select().from(mapAuthoringProposals).where(and(eq(mapAuthoringProposals.scenarioId, scenarioId), eq(mapAuthoringProposals.acceptKey, parsed.idempotencyKey))).limit(1)
    if (usedKey && usedKey.id !== proposalId) knowledgeIdempotencyConflict()
    let digest: string | undefined
    try { digest = await scenarioDocumentDigest(flattenKnowledgeDocument(draft.document)) }
    catch { /* A changed authoring shape also makes this flat proposal stale. */ }
    const stale =
      draft.revision !== parsed.expectedDraftRevision ||
      draft.revision !== row.baseline.draftRevision ||
      digest !== parsed.documentDigest ||
      digest !== row.baseline.documentDigest
    if (stale) {
      await tx
        .update(mapAuthoringProposals)
        .set({ proposalStatus: 'stale', updatedAt: await clockNow(tx) })
        .where(eq(mapAuthoringProposals.id, proposalId))
      return { kind: 'stale' as const }
    }
    const nextDocument = parseScenarioDocument(row.document)
    if (isAuthoringDocumentV2(nextDocument)) authoringSchemaUnsupported()
    const target = await requireLiveTarget(tx, row.targetId)
    const compiled = compileScenarioDocument(nextDocument, { mode: 'save', target: { exists: true, status: target.status } })
    if (!compiled.ok || compiled.diagnostics.some(item => item.code === 'SCENARIO_UNRESOLVED_REF')) throw badRequest('KNOWLEDGE_INVALID_PROPOSAL', '建议未通过编译验证')
    const now = await clockNow(tx)
    const nextRevision = draft.revision + 1
    await tx
      .update(scenarioDrafts)
      .set({
        revision: nextRevision,
        document: nextDocument,
        updatedByConsoleAccountId: actor.id,
        updatedAt: now,
      })
      .where(eq(scenarioDrafts.scenarioId, scenarioId))
    await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, scenarioId))
    await reconcileMapDraftBindingsTx(tx, { scenarioId, targetId: row.targetId, revision: nextRevision, document: nextDocument })
    await writeAcceptedBindings(tx, row.targetId, scenarioId, nextRevision, row.suggestedBindings, proposalId, actor)
    await tx
      .update(mapAuthoringProposals)
      .set({
        proposalStatus: 'accepted',
        acceptKey: parsed.idempotencyKey,
        acceptedRevision: nextRevision,
        updatedAt: now,
      })
      .where(eq(mapAuthoringProposals.id, proposalId))
    await recordAudit(tx, actor, 'knowledge.accept', 'knowledge_proposal', proposalId, `接受知识建议并写入草稿 r${nextRevision}`)
    return {
      kind: 'accepted' as const,
      value: knowledgeProposalAcceptedSchema.parse({
        proposal: await getKnowledgeProposal(tx, scenarioId, proposalId),
        draftRevision: nextRevision,
      }),
    }
  })
  if (result.kind === 'stale') authoringProposalStale()
  return result.value
}

export async function rejectKnowledgeProposal(
  db: Db,
  scenarioId: string,
  proposalId: string,
  actor: ExecutionActor,
) {
  return atomic(db, async (tx) => {
    const { mapAuthoringProposals } = schemaFor(tx)
    const [row] = await locked(
      tx,
      tx.select().from(mapAuthoringProposals).where(and(eq(mapAuthoringProposals.id, proposalId), eq(mapAuthoringProposals.scenarioId, scenarioId))),
    )
    if (!row) knowledgeNotFound('知识建议不存在')
    if (row.proposalStatus === 'accepted') throw badRequest('KNOWLEDGE_REVISION_CONFLICT', '已接受的建议不能拒绝')
    if (row.proposalStatus === 'rejected') return toProposal(row)
    await tx
      .update(mapAuthoringProposals)
      .set({ proposalStatus: 'rejected', updatedAt: await clockNow(tx) })
      .where(eq(mapAuthoringProposals.id, proposalId))
    await recordAudit(tx, actor, 'knowledge.propose', 'knowledge_proposal', proposalId, '拒绝知识建议')
    return getKnowledgeProposal(tx, scenarioId, proposalId)
  })
}

export async function findKnowledgeProposalRequest(db: Db, scenarioId: string, body: CreateKnowledgeProposalBody) {
  const parsed = createKnowledgeProposalBodySchema.parse(body)
  const { mapAuthoringProposals } = schemaFor(db)
  const [row] = await db.select().from(mapAuthoringProposals).where(and(eq(mapAuthoringProposals.scenarioId, scenarioId), eq(mapAuthoringProposals.requestKey, parsed.idempotencyKey))).limit(1)
  if (!row) return undefined
  if (row.requestDigest !== sha256Hex(canonicalJson(parsed))) knowledgeIdempotencyConflict()
  return getKnowledgeProposal(db, scenarioId, row.id)
}
