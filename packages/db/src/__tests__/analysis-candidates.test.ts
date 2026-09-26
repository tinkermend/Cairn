import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authoringSteps, isAuthoringDocumentV2, scenarioDocumentDigest, scenarioDocumentSchema, type ReviewAnalysisCandidateBody } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { insertRows, schemaFor } from '../native.js'
import { newId } from '../id.js'
import { acceptKnowledgeProposal, createScenarioWithVersion, createTerminology, getAnalysisJob, getKnowledgeProposal, getScenario, getTerminology,
  listSchedules, reviewAnalysisCandidate, saveScenarioDraft, updateTerminology, validateKnowledgeSources, writeSchedule, type NativeHandle } from '../test-entry.js'

describe.each(DRIVERS)('%s 分析候选人工采纳', { timeout: 60_000 }, driver => {
  let handle: NativeHandle
  let actorId: string
  const actor = () => ({ kind: 'console' as const, id: actorId })
  beforeAll(async () => {
    handle = await openContractDb(driver, `cand_${Date.now().toString(36)}`)
    const { consoleAccounts, consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    actorId = newId()
    await insertRows(handle.db, consoleAccounts, { id: actorId, displayName: 'reviewer', email: `${actorId}@test.invalid`, status: 'active' })
    const [role] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db.insert(consoleAccountRoles).values({ consoleAccountId: actorId, consoleRoleId: role.id, targetScopeMode: 'all' })
  })
  afterAll(async () => { await handle?.close() })

  async function fixture() {
    const { targets, analysisJobs, analysisCandidates } = schemaFor(handle.db)
    const targetId = newId(), jobId = newId(), candidateId = newId()
    await insertRows(handle.db, targets, { id: targetId, code: `candidate-${targetId}`, name: '候选测试', entryUrl: 'https://example.com' })
    const scenario = await createScenarioWithVersion(handle.db, { targetId, name: '核对订单', actor: actor(), steps: [{ id: newId(), name: '回声', type: 'echo', effectType: 'READ_ONLY', input: { value: 'before' } }] })
    await insertRows(handle.db, analysisJobs, { id: jobId, targetId, mode: 'map_quality', status: 'SUCCEEDED', sourceScope: { includeFailures: true }, strategyVersion: 'analysis-strategy@1', budget: { maxItems: 50, useAi: false }, coverageGaps: [], authorizedActorId: actorId })
    await insertRows(handle.db, analysisCandidates, { id: candidateId, jobId, targetId, kind: 'experience', title: '检查订单结果', summary: '结果需要保留订单状态。', sources: [{ kind: 'map', targetId }], payload: {}, status: 'pending' })
    return { targetId, jobId, candidateId, scenario }
  }

  async function proposalBody(scenarioId: string, expectedRevision = 1): Promise<Extract<ReviewAnalysisCandidateBody, { kind: 'proposal' }>> {
    const scenario = await getScenario(handle.db, scenarioId)
    const draft = scenario.draft!
    const document = isAuthoringDocumentV2(draft.document) ? scenarioDocumentSchema.parse({ schemaVersion: 1, inputs: draft.document.inputs, steps: authoringSteps(draft.document) }) : scenarioDocumentSchema.parse(draft.document)
    return { kind: 'proposal', idempotencyKey: newId(), expectedRevision, scenarioId, expectedDraftRevision: draft.revision,
      documentDigest: await scenarioDocumentDigest(document), document: { ...document, steps: document.steps.map(step => ({ ...step, name: `${step.name}（已审阅）` })) } }
  }

  it('保存真实建议、幂等重试、接受只修改草稿，并可追溯原分析', async () => {
    const { candidateId, jobId, scenario } = await fixture()
    const body = await proposalBody(scenario.id)
    const reviewed = await reviewAnalysisCandidate(handle.db, candidateId, body, actor())
    const candidate = reviewed.candidates![0]
    expect(candidate.status).toBe('proposed')
    const destination = candidate.review!.destination
    if (destination.kind !== 'proposal') throw new Error('proposal expected')
    const proposal = await getKnowledgeProposal(handle.db, scenario.id, destination.proposalId)
    expect(proposal.sources).toEqual([{ kind: 'analysis_candidate', jobId, candidateId }])
    expect(proposal.diffs).toHaveLength(1)
    expect((await getScenario(handle.db, scenario.id)).draft!.revision).toBe(body.expectedDraftRevision)
    expect((await reviewAnalysisCandidate(handle.db, candidateId, body, actor())).candidates![0].review).toEqual(candidate.review)
    await expect(reviewAnalysisCandidate(handle.db, candidateId, { ...body, document: { ...body.document, steps: body.document.steps.map(step => ({ ...step, name: 'changed' })) } }, actor())).rejects.toMatchObject({ code: 'KNOWLEDGE_IDEMPOTENCY_CONFLICT' })
    await acceptKnowledgeProposal(handle.db, scenario.id, destination.proposalId, { idempotencyKey: newId(), expectedDraftRevision: body.expectedDraftRevision, documentDigest: body.documentDigest }, actor())
    const updated = await getScenario(handle.db, scenario.id)
    expect(updated.latestVersionId).toBe(scenario.latestVersionId)
    expect(updated.draft!.revision).toBe(body.expectedDraftRevision + 1)
    expect((await getAnalysisJob(handle.db, jobId, actorId)).candidates![0].status).toBe('accepted')
    await expect(reviewAnalysisCandidate(handle.db, candidateId, { kind: 'reject', expectedRevision: 2, idempotencyKey: newId(), reason: 'late' }, actor())).rejects.toMatchObject({ code: 'KNOWLEDGE_REVISION_CONFLICT' })
  })

  it('草稿冲突保留原建议，允许基于新草稿再提出；跨目标和空差异不能写入', async () => {
    const f = await fixture(), other = await fixture()
    await expect(reviewAnalysisCandidate(handle.db, f.candidateId, await proposalBody(other.scenario.id), actor())).rejects.toMatchObject({ code: 'KNOWLEDGE_NOT_FOUND' })
    const body = await proposalBody(f.scenario.id)
    const result = await reviewAnalysisCandidate(handle.db, f.candidateId, body, actor())
    const destination = result.candidates![0].review!.destination
    if (destination.kind !== 'proposal') throw new Error('proposal expected')
    await saveScenarioDraft(handle.db, f.scenario.id, { revision: body.expectedDraftRevision, document: body.document, actor: actor() })
    await expect(acceptKnowledgeProposal(handle.db, f.scenario.id, destination.proposalId, { idempotencyKey: newId(), expectedDraftRevision: body.expectedDraftRevision, documentDigest: body.documentDigest }, actor())).rejects.toMatchObject({ code: 'AUTHORING_PROPOSAL_STALE' })
    const next = await reviewAnalysisCandidate(handle.db, f.candidateId, await proposalBody(f.scenario.id, 2), actor())
    expect(next.candidates![0].revision).toBe(3)
    expect((await getKnowledgeProposal(handle.db, f.scenario.id, destination.proposalId)).proposalStatus).toBe('stale')
    const fresh = await fixture(), noDiff = await proposalBody(fresh.scenario.id)
    noDiff.document.steps[0].name = '回声'
    await expect(reviewAnalysisCandidate(handle.db, fresh.candidateId, noDiff, actor())).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID_PROPOSAL' })
    expect((await getAnalysisJob(handle.db, fresh.jobId)).candidates![0].status).toBe('pending')
  })

  it('并发处理只创建一份术语，来源受权限及目标隔离保护', async () => {
    const f = await fixture()
    const body = { kind: 'term' as const, expectedRevision: 1, canonicalName: '订单状态', aliases: [], meaning: '订单的当前处理状态' }
    const results = await Promise.allSettled([1, 2].map(() => reviewAnalysisCandidate(handle.db, f.candidateId, { ...body, idempotencyKey: newId() }, actor())))
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    const candidate = (await getAnalysisJob(handle.db, f.jobId)).candidates![0]
    const destination = candidate.review!.destination
    if (destination.kind !== 'term') throw new Error('term expected')
    const term = await getTerminology(handle.db, f.targetId, destination.termId)
    expect(term.termStatus).toBe('confirmed')
    expect(term.sources).toEqual([{ kind: 'analysis_candidate', jobId: f.jobId, candidateId: f.candidateId }])
    await expect(validateKnowledgeSources(handle.db, f.targetId, term.sources, { runRead: true, workflowRead: true, moduleRead: true, mapRead: true, mapAnalyze: false })).rejects.toMatchObject({ code: 'KNOWLEDGE_NOT_FOUND' })
    await expect(validateKnowledgeSources(handle.db, (await fixture()).targetId, term.sources)).rejects.toMatchObject({ code: 'KNOWLEDGE_NOT_FOUND' })
    const { consoleAccounts, consoleRoles, consoleRolePermissions, consoleAccountRoles } = schemaFor(handle.db)
    const viewer = newId()
    await insertRows(handle.db, consoleAccounts, { id: viewer, email: `${viewer}@test.invalid`, displayName: 'no-grants', status: 'active' })
    await expect(reviewAnalysisCandidate(handle.db, (await fixture()).candidateId, { ...body, idempotencyKey: newId() }, { kind: 'console', id: viewer })).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    const roleId = newId()
    await insertRows(handle.db, consoleRoles, { id: roleId, key: `analysis-reader-${roleId}`, name: '分析只读', kind: 'custom' })
    await handle.db.insert(consoleRolePermissions).values(['target:read', 'map:read', 'map:analyze'].map(permission => ({ consoleRoleId: roleId, permission })))
    await handle.db.insert(consoleAccountRoles).values({ consoleAccountId: viewer, consoleRoleId: roleId, targetScopeMode: 'all' })
    expect((await getAnalysisJob(handle.db, f.jobId, viewer)).analysisJobId).toBe(f.jobId)
    await expect(reviewAnalysisCandidate(handle.db, (await fixture()).candidateId, { ...body, idempotencyKey: newId() }, { kind: 'console', id: viewer })).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
  })

  it('术语旧修订不能覆盖人工修改，失败不会消耗候选', async () => {
    const f = await fixture()
    const term = await createTerminology(handle.db, f.targetId, { idempotencyKey: newId(), canonicalName: '状态', meaning: '原含义' }, actor())
    await updateTerminology(handle.db, f.targetId, term.termId, { expectedRevision: 1, meaning: '人工修改' }, actor())
    const body = { kind: 'term' as const, idempotencyKey: newId(), expectedRevision: 1, canonicalName: '状态', aliases: [], meaning: '审阅后的含义', existingTerm: { termId: term.termId, expectedRevision: 1 } }
    await expect(reviewAnalysisCandidate(handle.db, f.candidateId, body, actor())).rejects.toMatchObject({ code: 'KNOWLEDGE_REVISION_CONFLICT' })
    expect((await getAnalysisJob(handle.db, f.jobId)).candidates![0].status).toBe('pending')
    expect((await getTerminology(handle.db, f.targetId, term.termId)).meaning).toBe('人工修改')
    const result = await reviewAnalysisCandidate(handle.db, f.candidateId, { ...body, existingTerm: { ...body.existingTerm, expectedRevision: 2 } }, actor())
    expect(result.candidates![0].review!.destination).toEqual({ kind: 'term', termId: term.termId, revision: 3 })
  })

  it('拒绝记录原因且幂等，不能与采纳相互覆盖', async () => {
    const f = await fixture()
    const body = { kind: 'reject' as const, idempotencyKey: newId(), expectedRevision: 1, reason: '证据不足' }
    await reviewAnalysisCandidate(handle.db, f.candidateId, body, actor())
    expect((await reviewAnalysisCandidate(handle.db, f.candidateId, body, actor())).candidates![0]).toMatchObject({ status: 'rejected', revision: 2, review: { destination: { kind: 'reject', reason: '证据不足' } } })
    await expect(reviewAnalysisCandidate(handle.db, f.candidateId, await proposalBody(f.scenario.id, 2), actor())).rejects.toMatchObject({ code: 'KNOWLEDGE_REVISION_CONFLICT' })
  })

  it('按对象先筛选再分页，编辑仍使用原 scheduleId', async () => {
    const f = await fixture()
    const second = await createScenarioWithVersion(handle.db, { targetId: f.targetId, name: '另一场景', actor: actor(), steps: [{ id: newId(), name: '回声', type: 'echo', effectType: 'READ_ONLY', input: { value: 'ok' } }] })
    const definition = (scenario: typeof second) => ({ timezone: 'UTC', weekdays: [1 as const], windowStart: '02:00', windowEnd: '03:00', misfire: 'skip' as const, timeRule: { kind: 'interval' as const, intervalMs: 300000, anchorUtc: new Date().toISOString(), misfire: 'skip' as const }, consumer: { type: 'scenario_run' as const, targetId: f.targetId, scenarioId: scenario.id, scenarioVersionId: scenario.latestVersionId, accountBinding: {}, input: {} } })
    const plan = await writeSchedule(handle.db, { expectedRevision: 0, idempotencyKey: newId(), definition: definition(f.scenario) }, actor())
    await writeSchedule(handle.db, { expectedRevision: 0, idempotencyKey: newId(), definition: definition(second) }, actor())
    const listed = await listSchedules(handle.db, { targetId: f.targetId, scenarioId: f.scenario.id, limit: 1 }, actorId)
    expect(listed.items.map(item => item.scheduleId)).toEqual([plan.schedule.scheduleId])
    expect(listed.nextCursor).toBeUndefined()
    expect((await listSchedules(handle.db, { suiteId: f.scenario.id, limit: 1 }, actorId)).items).toEqual([])
    const updated = await writeSchedule(handle.db, { expectedRevision: plan.schedule.revision, idempotencyKey: newId(), definition: { ...definition(f.scenario), name: '改名' } }, actor(), plan.schedule.scheduleId)
    expect(updated.schedule.scheduleId).toBe(plan.schedule.scheduleId)
  })

})
