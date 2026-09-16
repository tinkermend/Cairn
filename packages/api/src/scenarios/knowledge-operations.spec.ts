import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DomainError } from '@cairn/db'
import { composeScenarioKnowledge } from './knowledge-operations'
import { requireProposalAccess } from '../map/knowledge-access'

const mocks = vi.hoisted(() => ({ find: vi.fn(), scenario: vi.fn(), terms: vi.fn(), modules: vi.fn(), context: vi.fn(), start: vi.fn(), complete: vi.fn(), validate: vi.fn(), id: vi.fn() }))
vi.mock('@cairn/db', async importOriginal => ({
  ...await importOriginal<typeof import('@cairn/db')>(),
  findKnowledgeProposalRequest: mocks.find, getScenario: mocks.scenario,
  listTerminologyForCompose: mocks.terms, listPublishedModuleKnowledge: mocks.modules,
  loadKnowledgeMapContext: mocks.context, startKnowledgeProposal: mocks.start,
  completeKnowledgeProposal: mocks.complete, validateKnowledgeSources: mocks.validate, newId: mocks.id,
}))
const targetId = '11111111-1111-4111-8111-111111111111'
const scenarioId = '22222222-2222-4222-8222-222222222222'
const proposalId = '33333333-3333-4333-8333-333333333333'
const stepId = '44444444-4444-4444-8444-444444444444'
const account = { id: 'reader', displayName: '读者', email: null, status: 'active' as const, roles: [], permissions: ['target:read', 'map:read', 'workflow:write', 'ai:assist'] as any }
const document = { schemaVersion: 1, inputs: [], steps: [{ id: stepId, name: '基线', type: 'echo', effectType: 'READ_ONLY', input: { value: '基线' } }] }
const body = { idempotencyKey: 'request-one', question: 'password="a secret" 查询订单', expectedDraftRevision: 1, documentDigest: 'a'.repeat(64) }
const db = {} as any

describe('知识编排 API 边界', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.find.mockResolvedValue(undefined)
    mocks.scenario.mockResolvedValue({ targetId })
    mocks.terms.mockResolvedValue([])
    mocks.modules.mockResolvedValue([])
    mocks.context.mockResolvedValue({ assets: [], publishedReleaseId: undefined })
    mocks.start.mockResolvedValue({ replay: false, proposal: { proposalId }, document })
    mocks.complete.mockImplementation(async (_db, _scenario, _proposal, result) => ({ ...result, proposalStatus: result.status }))
    mocks.validate.mockResolvedValue(undefined)
    mocks.id.mockReturnValue('55555555-5555-4555-8555-555555555555')
  })

  it('保存生成中状态之前脱敏，无模块权限时不读取做法', async () => {
    const result = await composeScenarioKnowledge(db, scenarioId, body, account, 8)
    expect(JSON.stringify(mocks.start.mock.calls)).not.toContain('a secret')
    expect(JSON.stringify(result)).not.toContain('a secret')
    expect(mocks.modules).not.toHaveBeenCalled()
    expect(result.proposalStatus).toBe('unsupported')
  })

  it('幂等回放先于知识上下文加载，不随最新配置重新生成', async () => {
    const saved = { targetId, scenarioId, sources: [], baseline: { selectedModuleVersionIds: [], selectedTermRevisions: [] }, suggestedModules: [] }
    mocks.find.mockResolvedValue(saved)
    expect(await composeScenarioKnowledge(db, scenarioId, body, account, 99)).toEqual(saved)
    expect(mocks.context).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('试跑修复来源必须验证同一场景与 run 权限，失败不创建建议', async () => {
    mocks.validate.mockRejectedValue(new DomainError('not_found', 'KNOWLEDGE_NOT_FOUND', '不可见'))
    await expect(composeScenarioKnowledge(db, scenarioId, { ...body, attemptId: stepId }, account, 0)).rejects.toMatchObject({ code: 'KNOWLEDGE_NOT_FOUND' })
    expect(mocks.validate).toHaveBeenCalledWith(db, targetId, [{ kind: 'attempt', attemptId: stepId }], expect.objectContaining({ scenarioId, runRead: false }))
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('已存建议包含做法正文时，失去模块权限后不能通过 GET/接受绕过', async () => {
    await expect(requireProposalAccess(db, { targetId, scenarioId, sources: [], suggestedModules: [{}], baseline: { selectedModuleVersionIds: [], selectedTermRevisions: [] } } as any, account)).rejects.toMatchObject({ code: 'KNOWLEDGE_NOT_FOUND' })
  })

  it('生成使用事务返回的冻结草稿，并保存实际匹配模块版本', async () => {
    const version = '66666666-6666-4666-8666-666666666666'
    mocks.modules.mockResolvedValue([{ moduleId: stepId, moduleVersionId: version, name: '查询订单', key: 'order.query', aliases: [], intentExamples: [], tags: [], contentDigest: 'b'.repeat(64), publicationStatus: 'published', steps: [{ ...document.steps[0], name: '新增', outputKey: 'value' }], postconditions: [] }])
    const result = await composeScenarioKnowledge(db, scenarioId, body, { ...account, permissions: [...account.permissions, 'module:read'] }, 3)
    expect(result.document!.steps).toHaveLength(2)
    expect(mocks.start.mock.calls[0]![4]).toMatchObject({ selectedModuleVersionIds: [version], platformAiConfigRevision: 3 })
  })
})
