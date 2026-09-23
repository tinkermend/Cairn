import { and, eq } from 'drizzle-orm'
import {
  canonicalJson, diffKnowledgeDocuments, reviewAnalysisCandidateBodySchema, type AnalysisCandidateReview,
  type ExecutionActor, type KnowledgeSourceRef, type ReviewAnalysisCandidateBody,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import { newId } from '../id.js'
import { badRequest, conflict, notFound } from '../runs/errors.js'
import { recordAudit } from '../audit/record.js'
import { assertTargetPermission, lockConsoleAuthorization, targetScopeFor } from '../console/target-authorization.js'
import { appendJobEvent, assertAnalysisAccess, getAnalysisJob } from '../analysis/jobs.js'
import { requireLiveTarget } from '../map/view.js'
import { getSchedule } from '../schedules/schedules.js'
import { completeKnowledgeProposal, startKnowledgeProposal } from './proposals.js'
import { createTerminology, getTerminology, updateTerminology } from './terms.js'
import { validateKnowledgeSources } from './sources.js'

/** Candidate decision and its real knowledge destination commit together. */
export async function reviewAnalysisCandidate(db: Db, candidateId: string, input: ReviewAnalysisCandidateBody, actor: ExecutionActor) {
  const body = reviewAnalysisCandidateBodySchema.parse(input)
  return atomic(db, async tx => {
    await lockConsoleAuthorization(tx, actor.id)
    const { analysisCandidates, analysisJobs, analysisCommands, mapAuthoringProposals, scenarios } = schemaFor(tx)
    const [candidate] = await locked(tx, tx.select().from(analysisCandidates).where(eq(analysisCandidates.id, candidateId)))
    if (!candidate) throw notFound('KNOWLEDGE_NOT_FOUND', '分析候选不存在')
    const [job] = await locked(tx, tx.select().from(analysisJobs).where(eq(analysisJobs.id, candidate.jobId)))
    if (!job || job.status !== 'SUCCEEDED') throw conflict('ANALYSIS_NOT_COMPLETE', '分析尚未完成')
    await requireLiveTarget(tx, candidate.targetId)
    await assertAnalysisAccess(tx, actor.id, candidate.targetId, job.mode)
    await assertTargetPermission(tx, actor.id, candidate.targetId, body.kind === 'proposal' ? 'workflow:write' : body.kind === 'map_refresh' ? 'schedule:write' : 'map:review')
    await assertTargetPermission(tx, actor.id, candidate.targetId, 'map:read')
    const commandKey = `candidate:${candidateId}:${body.idempotencyKey}`
    const [previous] = await tx.select().from(analysisCommands).where(eq(analysisCommands.commandKey, commandKey)).limit(1)
    if (previous) {
      if (canonicalJson(previous.payload) !== canonicalJson(body)) throw conflict('KNOWLEDGE_IDEMPOTENCY_CONFLICT', '同一请求编号不能提交不同内容')
      return getAnalysisJob(tx, job.id, actor.id)
    }
    if (body.expectedRevision !== candidate.revision) throw conflict('KNOWLEDGE_REVISION_CONFLICT', '候选已被处理，请刷新后检查最新结果')
    // A stale/rejected proposal may be replaced against a fresh draft. Its old
    // proposal and audit remain available; an accepted destination is immutable.
    let replaceable = candidate.status === 'pending'
    if (candidate.review?.destination.kind === 'proposal') {
      const [prior] = await tx.select().from(mapAuthoringProposals).where(eq(mapAuthoringProposals.id, candidate.review.destination.proposalId)).limit(1)
      replaceable = Boolean(prior && ['stale', 'rejected', 'failed'].includes(prior.proposalStatus))
    }
    if (!replaceable) throw conflict('KNOWLEDGE_REVISION_CONFLICT', '候选已处理，请打开关联知识继续审阅')
    const now = await clockNow(tx)
    const source: KnowledgeSourceRef = { kind: 'analysis_candidate', jobId: job.id, candidateId }
    let destination: AnalysisCandidateReview['destination']
    if (body.kind === 'proposal') {
      const [scenario] = await tx.select().from(scenarios).where(and(eq(scenarios.id, body.scenarioId), eq(scenarios.targetId, candidate.targetId))).limit(1)
      if (!scenario || scenario.deletedAt) throw notFound('KNOWLEDGE_NOT_FOUND', '请选择同一目标系统的场景')
      const question = `${candidate.title}\n${candidate.summary}`.slice(0, 2000)
      const started = await startKnowledgeProposal(tx, body.scenarioId, {
        idempotencyKey: `analysis:${candidateId}:${candidate.revision}`, question,
        expectedDraftRevision: body.expectedDraftRevision, documentDigest: body.documentDigest,
      }, actor, { selectedTermRevisions: [], platformAiConfigRevision: 0 })
      const before = started.document!
      const diffs = diffKnowledgeDocuments(before, body.document)
      if (!diffs.length) throw badRequest('KNOWLEDGE_INVALID_PROPOSAL', '请先根据候选结论修改步骤或输入，不能创建没有差异的建议')
      await completeKnowledgeProposal(tx, body.scenarioId, started.proposal.proposalId, {
        status: 'proposed', question, document: body.document, diffs, sources: [source],
        diagnostics: [], unknowns: [], termCandidates: [], suggestedModules: [], suggestedBindings: [],
      })
      destination = { kind: 'proposal', scenarioId: body.scenarioId, proposalId: started.proposal.proposalId }
    } else if (body.kind === 'term') {
      const prior = body.existingTerm ? await getTerminology(tx, candidate.targetId, body.existingTerm.termId) : undefined
      if (prior) {
        const allowed = async (permission: string) => { const scope = await targetScopeFor(tx, actor.id, permission); return scope.all || scope.ids.includes(candidate.targetId) }
        await validateKnowledgeSources(tx, candidate.targetId, prior.sources, { actorId: actor.id, mapAnalyze: true, mapRead: true,
          runRead: await allowed('run:read'), workflowRead: await allowed('workflow:read'), moduleRead: await allowed('module:read') })
      }
      const sources = [...(prior?.sources ?? []), source]
      if (sources.length > 8) throw badRequest('KNOWLEDGE_INVALID_PROPOSAL', '术语来源已达上限，请先在术语维护中整理来源')
      const content = { canonicalName: body.canonicalName, aliases: body.aliases, meaning: body.meaning, sources, termStatus: 'confirmed' as const }
      const term = body.existingTerm ? await updateTerminology(tx, candidate.targetId, body.existingTerm.termId, { ...content, expectedRevision: body.existingTerm.expectedRevision }, actor)
        : await createTerminology(tx, candidate.targetId, { ...content, idempotencyKey: `analysis:${candidateId}` }, actor)
      destination = { kind: 'term', termId: term.termId, revision: term.revision }
    } else if (body.kind === 'map_refresh') {
      if (candidate.kind !== 'map_refresh_suggestion') throw badRequest('KNOWLEDGE_INVALID_PROPOSAL', '只有地图复查建议可关联知识地图采集计划')
      const plan = await getSchedule(tx, body.scheduleId, actor.id)
      if (plan.targetId !== candidate.targetId || plan.consumerKey !== 'map_refresh') throw badRequest('KNOWLEDGE_INVALID_PROPOSAL', '请选择同一目标系统的知识地图采集计划')
      if (plan.revision !== body.expectedScheduleRevision) throw conflict('KNOWLEDGE_REVISION_CONFLICT', '调度已更新，请重新检查复查范围')
      destination = { kind: 'map_refresh', scheduleId: plan.scheduleId, revision: plan.revision }
    } else {
      destination = { kind: 'reject', reason: body.reason }
    }
    const review: AnalysisCandidateReview = { actorId: actor.id, reviewedAt: now.toISOString(), destination }
    await tx.update(analysisCandidates).set({ review, revision: candidate.revision + 1,
      status: body.kind === 'reject' ? 'rejected' : body.kind === 'term' ? 'accepted' : 'proposed',
    }).where(eq(analysisCandidates.id, candidateId))
    await insertRows(tx, analysisCommands, { id: newId(), commandKey, payload: body, result: { candidateId, review }, createdAt: now })
    await recordAudit(tx, actor, 'knowledge.propose', 'analysis_candidate', candidateId, `分析候选人工处理：${body.kind}`)
    await appendJobEvent(tx, job.id, 'candidate.reviewed', { candidateId, revision: candidate.revision + 1, destination }, now)
    return getAnalysisJob(tx, job.id, actor.id)
  })
}
