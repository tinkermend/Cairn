import { describe, expect, it } from 'vitest'
import {
  SYSTEM_ROLE_DEFINITIONS,
  applyStepProposal,
  availableAssistantCapabilities,
  canAdoptAssistantProposal,
  canAdoptAuthoringProposal,
  authoringDocumentDigest,
  citationKey,
  assistantCitationKeySchema,
  filterGuideCatalog,
  inferAssistantCapability,
  inferAssistantFocus,
  inferBusinessRecordEntityType,
  inferGuideTopic,
  isTargetAccountFactQuestion,
  isScenarioRunResultQuestion,
  isScenarioFailureDigestQuestion,
  isPreviousRunComparisonQuestion,
  isSensitiveFillInput,
  scenarioFactsForModel,
  projectRunFacts,
  quoteStepFocusId,
  quoteTargetSystemId,
  quotedStepIdOnRun,
  routeAssistantTurn,
  scenarioDocumentDigest,
  toAuthoringDocumentV2,
  createAssistantTurnBodySchema,
  assistantQuoteContextSchema,
  assistantPageContextSchema,
  PAGE_LANDMARK_MANIFESTS,
  packAssistantResultEnvelope,
  unpackAssistantResultEnvelopeDetailed,
  type FillInput,
  type AssistantAuthoringProposal,
  type RunObservation,
  type ScenarioDocument,
  type Step,
} from '../index.js'

describe('助手公开结果边界', () => {
  it('相同修订与内容摘要的两个场景也不能互相采纳结构化提案', async () => {
    const document = toAuthoringDocumentV2({ schemaVersion: 1, inputs: [],
      steps: [fillStep({ target: fillTarget, value: 'example' })] })
    const digest = await authoringDocumentDigest(document)
    const proposal = {
      kind: 'authoring_proposal',
      scenarioId: '33333333-3333-4333-8333-333333333333',
      base: { draftRevision: 1, documentDigest: digest, dependencyFingerprint: 'same-draft' },
      operations: [], diffs: [], diagnostics: [], intentCoverage: [],
      proposalId: '44444444-4444-4444-8444-444444444444', candidateDigest: digest,
      executable: true,
      validation: { schema: 'passed', expansion: 'passed', compiler: 'passed' },
    } as AssistantAuthoringProposal
    const common = { proposal, revision: 1, document, hasFieldDrafts: false, remoteConflict: false }
    expect(await canAdoptAuthoringProposal({ ...common,
      scenarioId: '55555555-5555-4555-8555-555555555555' }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('其他场景') })
    expect(await canAdoptAuthoringProposal({ ...common,
      scenarioId: proposal.scenarioId })).toEqual({ ok: true })
  })

  it('目标系统引用键必须指向 UUID，可用于有权限的账号深链', () => {
    expect(citationKey('target', '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a')).toBe('target:7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a')
    expect(assistantCitationKeySchema.safeParse('target:not-an-id').success).toBe(false)
  })

  it('旧轮次中的原始思考文本不进入公开结果，新结果也不再写入', () => {
    const result = { kind: 'unsupported' as const, reasonCode: 'TASK_UNSUPPORTED', message: '暂不支持' }
    const legacy = unpackAssistantResultEnvelopeDetailed({
      version: 2,
      result,
      thinkingText: '内部模型推理原文',
      thinkingDurationMs: 1234,
    })
    expect(legacy?.thinkingText).toBeUndefined()
    expect(legacy?.thinkingDurationMs).toBe(1234)
    expect(packAssistantResultEnvelope(result, 2, undefined, '内部模型推理原文', 1234)).toEqual({
      version: 2,
      result,
      thinkingDurationMs: 1234,
    })
  })

  it('仅为已注册页面监听器的动作提供快捷按钮', () => {
    const actions = Object.values(PAGE_LANDMARK_MANIFESTS).flatMap((page) =>
      page.regions.flatMap((region) => region.actions),
    )
    expect(actions.filter((action) => action.actionKey).map((action) => action.actionKey)).toEqual([
      'open-add-step-menu',
    ])
  })
})

const fillTarget = {
  framePath: [],
  candidates: [{ by: 'css' as const, value: '#amount' }],
}

function fillStep(input: FillInput): Step {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: '填写金额',
    type: 'fill',
    effectType: 'SIDE_EFFECT',
    input,
  }
}

const document: ScenarioDocument = {
  schemaVersion: 1,
  inputs: [{ key: 'amount', label: '金额' }],
  steps: [
    fillStep({ target: fillTarget, value: '12.00' }),
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: '判断成功',
      type: 'ai_assert',
      effectType: 'READ_ONLY',
      input: { instruction: '页面出现成功' },
    },
  ],
}

const observation: RunObservation = {
  run: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    status: 'SUCCEEDED',
    cancelRequested: false,
    targetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    targetName: '演示',
    targetAccountId: null,
    targetAccountName: null,
    scenarioId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    scenarioName: '下单',
    scenarioVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    createdAt: '2026-09-14T00:00:00.000Z',
    startedAt: '2026-09-14T00:00:01.000Z',
    finishedAt: '2026-09-14T00:00:10.000Z',
    evidenceStatus: 'COMPLETE',
    snapshot: {
      schemaVersion: 1,
      scenarioId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      scenarioVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      targetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      steps: document.steps,
    } as RunObservation['run']['snapshot'],
    context: { amount: 'should-not-appear' },
    stepRuns: [
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        stepId: '11111111-1111-4111-8111-111111111111',
        name: '填写金额',
        type: 'fill',
        ordinal: 0,
        status: 'SUCCEEDED',
        startedAt: '2026-09-14T00:00:01.000Z',
        finishedAt: '2026-09-14T00:00:02.000Z',
        attempts: [
          {
            id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            attemptNo: 1,
            status: 'FAILED',
            startedAt: '2026-09-14T00:00:01.000Z',
            finishedAt: '2026-09-14T00:00:01.500Z',
            output: { secret: 'hidden' },
            error: { code: 'TIMEOUT', category: 'TIMEOUT', retryable: true, safeMessage: 'timeout' },
          },
          {
            id: '99999999-9999-4999-8999-999999999999',
            attemptNo: 2,
            status: 'SUCCEEDED',
            startedAt: '2026-09-14T00:00:01.600Z',
            finishedAt: '2026-09-14T00:00:02.000Z',
            output: { ok: true },
            error: null,
          },
        ],
      },
    ],
    lease: null,
    debugMode: 'runThrough',
    placement: {
      state: 'claimed',
      sessionId: null,
      ownerWorkerId: null,
      sessionStatus: null,
      waitReason: null,
      occupyingRunId: null,
      occupyingOperationId: null,
      targetWorkerId: null,
      profileAffinityUntil: null,
      generation: null,
      acquireReason: null,
      profileFallback: null,
    },
  },
  evidence: { items: [] },
  eventSeq: 3,
  earliestEventSeq: 1,
}

describe('助手权限先行', () => {
  it('四类系统角色都有 ai:assist，只读没有写和执行', () => {
    for (const key of ['admin', 'author', 'operator', 'viewer'] as const) {
      expect(SYSTEM_ROLE_DEFINITIONS[key].permissions).toContain('ai:assist')
    }
    expect(SYSTEM_ROLE_DEFINITIONS.viewer.permissions).not.toContain('workflow:write')
    expect(SYSTEM_ROLE_DEFINITIONS.viewer.permissions).not.toContain('run:execute')
  })

  it('没有 target:read 不能诊断或改步骤', () => {
    const items = availableAssistantCapabilities(['ai:assist', 'run:read', 'workflow:read'])
    expect(items.find((item) => item.id === 'run.diagnose')?.available).toBe(false)
    expect(items.find((item) => item.id === 'scenario.propose-step')?.available).toBe(false)
    expect(items.find((item) => item.id === 'platform.guide')?.available).toBe(true)
  })

  it('场景发现无需预先知道场景 ID，解释和编排仍需具体场景', () => {
    const items = availableAssistantCapabilities(SYSTEM_ROLE_DEFINITIONS.admin.permissions)
    expect(items.find((item) => item.id === 'scenario.discover')?.requiredContext).toEqual([])
    expect(items.find((item) => item.id === 'scenario.explain')?.requiredContext).toEqual(['scenarioId'])
    expect(items.find((item) => item.id === 'scenario.propose-step')?.requiredContext).toEqual(['scenarioId'])
  })

  it('只读不能生成单步候选，但可以导览已授权入口', () => {
    const items = availableAssistantCapabilities(SYSTEM_ROLE_DEFINITIONS.viewer.permissions)
    expect(items.find((item) => item.id === 'scenario.propose-step')?.available).toBe(false)
    expect(items.find((item) => item.id === 'run.diagnose')?.available).toBe(true)
    const guide = filterGuideCatalog(SYSTEM_ROLE_DEFINITIONS.viewer.permissions)
    expect(guide.find((item) => item.topic === 'platform-config')).toBeUndefined()
    expect(guide.find((item) => item.topic === 'browser')).toBeUndefined()
    expect(guide.find((item) => item.topic === 'runs')?.availability).toBe('available')
    expect(filterGuideCatalog(['ai:assist'], 'accounts')).toEqual([])
  })

  it('导览按问句匹配入口，且不返回无权名称', () => {
    const accounts = filterGuideCatalog(['ai:assist', 'target:read'], inferGuideTopic('在哪里配置目标账号'))
    expect(accounts.map((item) => item.topic)).toEqual(['accounts'])
    expect(filterGuideCatalog(['ai:assist'], inferGuideTopic('在哪里配置目标账号'))).toEqual([])
  })

  it('录制到新场景的导览给出采集、回填、保存和试跑顺序', () => {
    const question = '在识途平台中，如何从零录制并编排一个新场景？'
    const granted = ['ai:assist', 'target:read', 'workflow:read', 'workflow:write']
    const items = filterGuideCatalog(granted, inferGuideTopic(question))
    expect(items.map((item) => item.href)).toEqual(['/recordings', '/scenarios'])
    expect(items.map((item) => item.steps).join(' ')).toMatch(/录制器.*回填到场景.*保存草稿.*试跑当前草稿/)
    expect(filterGuideCatalog(['ai:assist', 'workflow:read'], 'scenarios').map((item) => item.href)).toEqual(['/scenarios'])
    for (const capabilityHint of [undefined, 'platform.guide' as const]) {
      expect(routeAssistantTurn({
        question,
        capabilityHint,
        available: ['platform.guide', 'scenario.propose-step'],
      })).toMatchObject({ type: 'dispatch', capabilityId: 'platform.guide', slots: { topic: 'scenarios' } })
    }
  })
})

describe('运行对比参数绑定', () => {
  const baseRunId = '11111111-1111-4111-8111-111111111111'
  const targetRunId = '22222222-2222-4222-8222-222222222222'
  const available = ['run.compare' as const]

  it('从 Run 页面上下文和问句中的另一条 Run ID 绑定两侧', () => {
    expect(routeAssistantTurn({
      question: `把这次运行和 ${targetRunId} 对比一下`,
      pageContext: { page: 'run', runId: baseRunId },
      available,
    })).toEqual({
      type: 'dispatch', capabilityId: 'run.compare',
      slots: { baseRunId, targetRunId },
    })
    expect(routeAssistantTurn({
      question: `把这次运行和 ${targetRunId} 对比一下`,
      pageContext: {
        version: 2, routeKey: 'run.detail', pageKind: 'run', page: 'run',
        primaryRef: { kind: 'run', id: baseRunId },
      },
      available,
    })).toMatchObject({ type: 'dispatch', slots: { baseRunId, targetRunId } })
  })

  it('全局问句里的两条显式 Run ID 按提及顺序绑定，不使用页面里的第三条', () => {
    expect(routeAssistantTurn({
      question: `比较 ${baseRunId} 与 ${targetRunId} 两次运行`,
      pageContext: { page: 'run', runId: '33333333-3333-4333-8333-333333333333' },
      available,
    })).toEqual({
      type: 'dispatch', capabilityId: 'run.compare',
      slots: { baseRunId, targetRunId },
    })
  })

  it('运行详情页的“和上一次相比”只绑定当前运行并请求查同场景上一条', () => {
    const question = '这次运行和上一次相比有什么变化？'
    expect(isPreviousRunComparisonQuestion(question)).toBe(true)
    expect(routeAssistantTurn({
      question,
      pageContext: { version: 2, routeKey: 'run.detail', pageKind: 'run', page: 'run',
        primaryRef: { kind: 'run', id: baseRunId } },
      available: [...available, 'run.diagnose'],
    })).toEqual({
      type: 'dispatch', capabilityId: 'run.compare',
      slots: { baseRunId, comparePrevious: true },
    })
    expect(routeAssistantTurn({ question, available }).type).toBe('clarify')
  })

  it('没有足够上下文、重复或超过两个 ID 时不猜测比较对象', () => {
    for (const question of [
      `比较 ${targetRunId} 和上一次`,
      `比较 ${baseRunId} 和 ${baseRunId}`,
      `比较 ${baseRunId}、${targetRunId}、33333333-3333-4333-8333-333333333333`,
    ]) {
      expect(routeAssistantTurn({ question, available }).type).toBe('clarify')
    }
  })
})

describe('步骤引用', () => {
  const stepRuns = [
    { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', stepId: '11111111-1111-4111-8111-111111111111' },
  ]

  it('步骤引用不把 StepRun ID 当成目标系统 ID', () => {
    const quote = {
      type: 'step_failure' as const,
      targetId: stepRuns[0]!.id,
      title: '步骤 #1',
      summary: 'TIMEOUT',
    }
    expect(quoteTargetSystemId(quote)).toBeUndefined()
    expect(quoteStepFocusId(quote)).toBe(stepRuns[0]!.id)
    expect(quotedStepIdOnRun(quote, stepRuns)).toBe(stepRuns[0]!.stepId)
  })

  it('objectRef 指向步骤定义时直接对上该步', () => {
    const quote = {
      type: 'step_failure' as const,
      targetId: stepRuns[0]!.stepId,
      objectRef: { kind: 'step' as const, id: stepRuns[0]!.stepId },
      title: '步骤 #1',
      summary: 'TIMEOUT',
    }
    expect(quotedStepIdOnRun(quote, stepRuns)).toBe(stepRuns[0]!.stepId)
    expect(quoteTargetSystemId({ ...quote, objectRef: { kind: 'target' as const, id: observation.run.targetId } })).toBe(
      observation.run.targetId,
    )
  })

  it('不属于这次运行的步骤引用对不上', () => {
    const quote = {
      type: 'step_failure' as const,
      targetId: '99999999-9999-4999-8999-999999999999',
      objectRef: { kind: 'step' as const, id: '99999999-9999-4999-8999-999999999999' },
      title: '别的步骤',
      summary: '不属于这次运行',
    }
    expect(quotedStepIdOnRun(quote, stepRuns)).toBeUndefined()
  })
})

describe('助手路由', () => {
  it('会话和调度页的状态问题不要求选择一次运行', () => {
    const targetId = observation.run.targetId
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const scheduleId = '22222222-2222-4222-8222-222222222222'
    const available = ['run.diagnose' as const, 'knowledge.answer' as const]
    expect(routeAssistantTurn({
      question: '这个账号为什么一直等登录？现在谁占着会话？',
      capabilityHint: 'run.diagnose',
      pageContext: {
        version: 2, routeKey: 'sessions.detail', pageKind: 'session', page: 'session',
        primaryRef: { kind: 'session', id: sessionId },
        scopeRefs: [{ kind: 'target', id: targetId }],
      },
      available,
    })).toEqual({ type: 'dispatch', capabilityId: 'knowledge.answer', slots: { targetId, sessionId } })
    expect(routeAssistantTurn({
      question: '这个账号为什么一直等登录？现在谁占着会话？',
      capabilityHint: 'knowledge.answer',
      pageContext: {
        version: 2, routeKey: 'sessions.detail', pageKind: 'session', page: 'session',
        primaryRef: { kind: 'session', id: sessionId },
        scopeRefs: [{ kind: 'target', id: targetId }],
      },
      available,
    })).toMatchObject({ type: 'dispatch', capabilityId: 'knowledge.answer' })
    expect(routeAssistantTurn({
      question: '昨晚这条调度怎么没跑？',
      capabilityHint: 'run.diagnose',
      pageContext: {
        version: 2, routeKey: 'schedules.index', pageKind: 'schedule', page: 'schedule',
        primaryRef: { kind: 'schedule', id: scheduleId },
      },
      available,
    })).toEqual({ type: 'dispatch', capabilityId: 'knowledge.answer', slots: { scheduleId } })
  })

  it('运行列表的复数失败问题分析筛选集合，单次运行仍走诊断', () => {
    const available = ['run.diagnose' as const, 'knowledge.answer' as const]
    expect(routeAssistantTurn({
      question: '这些失败是同一个原因吗？',
      capabilityHint: 'run.diagnose',
      pageContext: {
        version: 2, routeKey: 'runs.list', pageKind: 'run', page: 'run',
        view: { filters: { status: 'FAILED' } },
      },
      available,
    })).toEqual({ type: 'dispatch', capabilityId: 'knowledge.answer', slots: {} })
    expect(routeAssistantTurn({
      question: '这次运行为什么失败？',
      capabilityHint: 'run.diagnose',
      pageContext: { page: 'run', runId: observation.run.id },
      available,
    })).toMatchObject({ type: 'dispatch', capabilityId: 'run.diagnose', slots: { runId: observation.run.id } })
  })

  it('目标页操作指引把目标 ID 留在持久化槽位供历史回答重新鉴权', () => {
    const targetId = observation.run.targetId
    expect(routeAssistantTurn({
      question: '这个系统的订单页入口在哪里？',
      pageContext: { page: 'target', targetId },
      available: ['in-page.guidance', 'platform.guide', 'knowledge.answer'],
    })).toMatchObject({ type: 'dispatch', capabilityId: 'in-page.guidance',
      slots: { targetId, page: 'target' } })
    expect(routeAssistantTurn({
      question: '这个系统的数据库实例列表入口在哪里？',
      capabilityHint: 'in-page.guidance',
      pageContext: { page: 'target', targetId },
      available: ['in-page.guidance'],
    })).toMatchObject({
      type: 'dispatch', capabilityId: 'in-page.guidance',
      slots: { targetId, page: 'target' },
    })
  })

  it('目标页账号状态普通问法读取事实，寻找按钮仍走页面指引', () => {
    const targetId = observation.run.targetId
    const pageContext = { page: 'target' as const, targetId }
    const available = ['knowledge.answer', 'in-page.guidance', 'platform.guide'] as const
    for (const question of [
      '检查这个目标系统的账号健康度，哪些账号现在可用？',
      '该目标的账号认证状态和会话租约怎样？',
    ]) {
      expect(isTargetAccountFactQuestion(question)).toBe(true)
      expect(routeAssistantTurn({ question, pageContext, available })).toEqual({
        type: 'dispatch', capabilityId: 'knowledge.answer', slots: { targetId },
      })
    }
    const where = '这个目标系统的账号健康度按钮在哪？'
    expect(isTargetAccountFactQuestion(where)).toBe(false)
    expect(routeAssistantTurn({ question: where, pageContext, available })).toMatchObject({
      type: 'dispatch', capabilityId: 'in-page.guidance',
    })
    expect(isTargetAccountFactQuestion('请停用这个目标的账号并释放会话')).toBe(false)
  })

  it('场景实际运行结果问法读取运行事实，保存定义的成功标准仍走场景解释', () => {
    const scenarioId = observation.run.scenarioId
    const pageContext = { page: 'studio' as const, scenarioId }
    const available = ['knowledge.answer', 'scenario.explain', 'run.diagnose'] as const
    for (const question of ['这个场景已经跑成功了吗？', '刚才这个场景运行通过了吗？']) {
      expect(isScenarioRunResultQuestion(question)).toBe(true)
      expect(routeAssistantTurn({ question, pageContext, available })).toEqual({
        type: 'dispatch', capabilityId: 'knowledge.answer', slots: { scenarioId },
      })
    }
    expect(isScenarioRunResultQuestion('这个场景如何判断成功？')).toBe(false)
    expect(isScenarioRunResultQuestion('分析当前场景最近 7 天的失败运行记录和原因')).toBe(false)
    expect(routeAssistantTurn({ question: '这个场景如何判断成功？', pageContext, available })).toMatchObject({
      type: 'dispatch', capabilityId: 'scenario.explain',
    })
  })

  it('当前场景失败归并不路由到全局最近失败运行', () => {
    const scenarioId = observation.run.scenarioId
    const question = '分析当前场景最近 7 天内的失败运行记录，归纳主要失败原因。'
    expect(isScenarioFailureDigestQuestion(question)).toBe(true)
    expect(routeAssistantTurn({
      question,
      pageContext: { page: 'studio', scenarioId, stepId: observation.run.stepRuns[0]?.stepId },
      available: ['knowledge.answer', 'run.diagnose'],
    })).toEqual({ type: 'dispatch', capabilityId: 'knowledge.answer', slots: { scenarioId } })
  })

  it('业务记录查询区分供应商和厂家，并要求混合问句明确实体', () => {
    const pageContext = { page: 'target' as const, targetId: observation.run.targetId }
    const available = ['target.business-records.list' as const]
    expect(routeAssistantTurn({
      question: '这个目标里有哪些供应商？', pageContext, available,
    })).toMatchObject({
      type: 'dispatch', capabilityId: 'target.business-records.list',
      slots: { targetId: observation.run.targetId, entityType: 'supplier' },
    })
    expect(routeAssistantTurn({
      question: '这个厂家名单全给我。', pageContext, available,
    })).toMatchObject({
      type: 'dispatch', capabilityId: 'target.business-records.list',
      slots: { entityType: 'manufacturer' },
    })
    expect(routeAssistantTurn({
      question: '把厂家和供应商名单都给我。', capabilityHint: 'target.business-records.list',
      pageContext, available,
    })).toMatchObject({ type: 'clarify', missingFields: ['entityType'] })
    expect(inferBusinessRecordEntityType('供应商名单')).toBe('supplier')
  })

  it('普通问法按目标名称找场景时进入场景发现', () => {
    for (const question of [
      '有哪些关于智慧运维管理平台的场景？',
      '列出智慧运维管理平台的场景，方便我找到要查看的场景。',
      '智慧运维管理平台下面有哪些场景？',
    ]) {
      const decision = routeAssistantTurn({ question, available: ['scenario.discover'] })
      expect(decision).toMatchObject({ type: 'dispatch', capabilityId: 'scenario.discover' })
    }
  })

  it('运行页快捷入口问导览问题时澄清，不按 hint 诊断', () => {
    const decision = routeAssistantTurn({
      question: '目标账号在哪里配置？',
      capabilityHint: 'run.diagnose',
      pageContext: { page: 'run', runId: observation.run.id },
      available: ['run.diagnose', 'platform.guide'],
    })
    expect(decision.type).toBe('clarify')
  })

  it('缺 runId 时要求选择运行', () => {
    const decision = routeAssistantTurn({
      question: '这次为什么失败？',
      available: ['run.diagnose'],
    })
    expect(decision).toMatchObject({ type: 'clarify', missingFields: ['runId'] })
  })

  it('没有权限的 hint 被拒绝', () => {
    const decision = routeAssistantTurn({
      question: '把指令写清楚',
      capabilityHint: 'scenario.propose-step',
      available: ['run.diagnose'],
    })
    expect(decision).toMatchObject({ type: 'unsupported', reasonCode: 'CAPABILITY_FORBIDDEN' })
  })

  it('识别四类问句', () => {
    expect(inferAssistantCapability('在哪里配置目标账号')).toBe('platform.guide')
    expect(inferAssistantCapability('这次为什么失败')).toBe('run.diagnose')
    expect(inferAssistantCapability('这个场景在做什么')).toBe('scenario.explain')
    expect(inferAssistantCapability('这一步用的 customerId 从哪来？删掉前一步会怎样？')).toBe('scenario.explain')
    expect(inferAssistantCapability('查完订单后等结果区出现，再检查状态是成功。')).toBe('scenario.propose-step')
    expect(routeAssistantTurn({
      question: '这一步用的 customerId 从哪来？删掉前一步会怎样？',
      pageContext: {
        version: 2, routeKey: 'scenarios.$scenarioId.studio', pageKind: 'studio', page: 'studio',
        primaryRef: { kind: 'scenario', id: '11111111-1111-4111-8111-111111111111' },
        view: { selectedRef: { kind: 'step', id: '22222222-2222-4222-8222-222222222222' } },
      },
      available: ['scenario.explain', 'scenario.propose-step'],
    })).toMatchObject({ type: 'dispatch', capabilityId: 'scenario.explain',
      slots: { scenarioId: '11111111-1111-4111-8111-111111111111', stepId: '22222222-2222-4222-8222-222222222222' } })
    expect(inferAssistantCapability('把指令写清楚')).toBe('scenario.propose-step')
  })

  it('知识辅助编写需要已保存草稿', () => {
    expect(inferAssistantCapability('根据已有知识补全场景')).toBe('scenario.compose_with_knowledge')
    const decision = routeAssistantTurn({
      question: '根据地图按订单号查询状态',
      capabilityHint: 'scenario.compose_with_knowledge',
      pageContext: { page: 'studio', scenarioId: observation.run.scenarioId },
      available: ['scenario.compose_with_knowledge'],
    })
    expect(decision).toMatchObject({ type: 'clarify', missingFields: ['draftRevision'] })
  })

  it('根据已发布做法为当前场景编写时尊重知识编写 hint', () => {
    const question = '请根据已发布的“异常告警智能研判与处置”做法，为这个场景给出可编辑建议，先别应用。'
    const context = { page: 'studio' as const, scenarioId: observation.run.scenarioId, draftRevision: 3 }
    const available = ['scenario.explain' as const, 'scenario.compose_with_knowledge' as const]
    const decision = routeAssistantTurn({
      question,
      capabilityHint: 'scenario.compose_with_knowledge',
      pageContext: context,
      available,
    })
    expect(decision).toMatchObject({
      type: 'dispatch', capabilityId: 'scenario.compose_with_knowledge',
      slots: { scenarioId: observation.run.scenarioId, draftRevision: 3 },
    })
    expect(routeAssistantTurn({ question, pageContext: context, available })).toMatchObject({
      type: 'dispatch', capabilityId: 'scenario.compose_with_knowledge',
    })
  })

  it('确定性步骤重试设置的产品帮助问题进入有源问答', () => {
    expect(routeAssistantTurn({
      question: '确定性步骤可以配置重试吗？怎么设置？',
      available: ['knowledge.answer', 'scenario.explain', 'platform.guide'],
    })).toMatchObject({ type: 'dispatch', capabilityId: 'knowledge.answer' })
    expect(routeAssistantTurn({
      question: '这次运行为什么重试失败？',
      available: ['knowledge.answer', 'run.diagnose'],
      pageContext: { page: 'run', runId: observation.run.id },
    })).toMatchObject({ type: 'dispatch', capabilityId: 'run.diagnose' })
  })

  it('平台是否有某类数据的问句进入事实检索，不吞掉具体业务列表或写操作', () => {
    const available = ['knowledge.answer', 'target.business-records.list', 'scenario.discover'] as const
    for (const question of ['识途里有火星生态数据吗？', '平台有没有本周采购数据？', '平台上能查到月度经营资料吗？']) {
      expect(routeAssistantTurn({ question, available })).toMatchObject({
        type: 'dispatch', capabilityId: 'knowledge.answer',
      })
    }
    expect(routeAssistantTurn({
      question: '这个目标里有哪些供应商？', available,
    })).not.toMatchObject({ type: 'dispatch', capabilityId: 'knowledge.answer' })
    expect(routeAssistantTurn({
      question: '识途里把订单数据删除', available,
    })).not.toMatchObject({ type: 'dispatch', capabilityId: 'knowledge.answer' })
  })

  it('新手询问如何录制场景按导览处理，不把代做请求误当成教学', () => {
    const available = ['platform.guide', 'scenario.propose-step', 'knowledge.answer'] as const
    expect(routeAssistantTurn({
      question: '在识途平台中，如何从零录制并编排一个新场景？', available,
    })).toMatchObject({ type: 'dispatch', capabilityId: 'platform.guide' })
    expect(routeAssistantTurn({
      question: '我第一次用，在哪里录制一个订单查询场景并试跑？', available,
    })).toMatchObject({ type: 'dispatch', capabilityId: 'platform.guide' })
    expect(routeAssistantTurn({
      question: '如何替我录制一个场景并直接发布？', available,
    })).not.toMatchObject({ type: 'dispatch', capabilityId: 'platform.guide' })
  })

  it('目标详情询问删除支持与路径时保留当前目标并进入功能导览', () => {
    expect(routeAssistantTurn({
      question: '能直接删除当前目标吗？现在不要执行，只说明支持和路径。',
      pageContext: { page: 'target', targetId: observation.run.targetId },
      available: ['platform.guide', 'knowledge.answer'],
    })).toMatchObject({
      type: 'dispatch', capabilityId: 'platform.guide',
      slots: { topic: 'targets', targetId: observation.run.targetId },
    })
  })

  it('指代当前页面时，运行页做诊断、场景页做解释', () => {
    const run = routeAssistantTurn({
      question: '这里为什么不行',
      pageContext: { page: 'run', runId: observation.run.id },
      available: ['run.diagnose', 'scenario.explain', 'platform.guide'],
    })
    expect(run).toMatchObject({
      type: 'dispatch',
      capabilityId: 'run.diagnose',
      slots: { runId: observation.run.id },
    })

    const studio = routeAssistantTurn({
      question: '这里为什么不行',
      pageContext: {
        page: 'studio',
        scenarioId: observation.run.scenarioId,
        draftRevision: 2,
        stepId: '11111111-1111-4111-8111-111111111111',
      },
      available: ['run.diagnose', 'scenario.explain', 'scenario.propose-step'],
    })
    expect(studio).toMatchObject({
      type: 'dispatch',
      capabilityId: 'scenario.explain',
      slots: { scenarioId: observation.run.scenarioId, draftRevision: 2 },
    })
  })

  it('只有没有 runId 时，最近失败才会去找运行', () => {
    const stale = routeAssistantTurn({
      question: '分析最近失败的运行',
      pageContext: { page: 'run', runId: observation.run.id },
      available: ['run.diagnose'],
    })
    expect(stale).toMatchObject({
      type: 'dispatch',
      capabilityId: 'run.diagnose',
      slots: { runId: observation.run.id },
    })
    if (stale.type === 'dispatch') expect(stale.slots.findRecentFailed).toBeUndefined()

    const fresh = routeAssistantTurn({
      question: '分析最近失败的运行',
      available: ['run.diagnose'],
    })
    expect(fresh).toMatchObject({
      type: 'dispatch',
      slots: { findRecentFailed: true },
    })
  })

  it('普通用户问最近 7 天是否有失败运行时直接按时间范围查询', () => {
    const decision = routeAssistantTurn({
      question: '最近 7 天有失败运行吗？没有请明确数据范围。',
      available: ['run.diagnose', 'knowledge.answer'],
    })
    expect(decision).toMatchObject({
      type: 'dispatch',
      capabilityId: 'run.diagnose',
      slots: { findRecentFailed: true },
    })
  })

  it('运行页上的闲聊不会被页面先验改成诊断', () => {
    const decision = routeAssistantTurn({
      question: '今天天气怎么样',
      pageContext: { page: 'run', runId: observation.run.id },
      available: ['run.diagnose', 'scenario.explain'],
    })
    expect(decision).toMatchObject({ type: 'unsupported', reasonCode: 'TASK_UNSUPPORTED' })
  })

  it('诊断问句带上 focus，解释优先用草稿 revision', () => {
    expect(inferAssistantFocus('为什么一直等登录')).toBe('waiting')
    const explain = routeAssistantTurn({
      question: '这个场景在做什么',
      pageContext: {
        page: 'studio',
        scenarioId: observation.run.scenarioId,
        draftRevision: 2,
        versionId: observation.run.scenarioVersionId,
      },
      available: ['scenario.explain'],
    })
    expect(explain).toMatchObject({
      type: 'dispatch',
      capabilityId: 'scenario.explain',
      slots: { scenarioId: observation.run.scenarioId, draftRevision: 2 },
    })
    expect(explain.type === 'dispatch' && 'versionId' in explain.slots).toBe(false)
  })
})

describe('运行事实投影', () => {
  it('区分失败 Attempt 后成功，不把 Context 原值送出', () => {
    const pack = projectRunFacts(observation, { focus: 'overview' })
    expect(pack.facts.some((item) => item.text.includes('不能据此把整个运行判为失败'))).toBe(true)
    expect(pack.text).not.toContain('should-not-appear')
    expect(pack.text).not.toContain('hidden')
    expect(pack.nextActions.map((item) => item.kind)).toEqual(['run.detail'])
  })

  it('资源等待按 placement 解释', () => {
    const waiting = structuredClone(observation)
    waiting.run.status = 'QUEUED'
    waiting.run.placement.state = 'owner_at_capacity'
    const pack = projectRunFacts(waiting, { focus: 'waiting' })
    expect(pack.facts.some((item) => item.text.includes('执行槽已满，运行正在排队'))).toBe(true)
    expect(pack.text).not.toContain('owner_at_capacity')
  })

  it('已完成运行不展示不适用的调度状态', () => {
    const finished = structuredClone(observation)
    finished.run.placement.state = 'not_applicable'
    const pack = projectRunFacts(finished)
    expect(pack.facts.some((item) => item.id === 'placement')).toBe(false)
    expect(pack.text).not.toContain('not_applicable')
  })
})

describe('单步候选构造', () => {
  it('fill 绑定去掉 value 并保留敏感标记', async () => {
    const sensitiveDoc: ScenarioDocument = {
      ...document,
        steps: [
          fillStep({
            target: { framePath: [], candidates: [{ by: 'css', value: 'input[type=password]' }] },
            value: 'secret',
            sensitive: true,
          }),
        ],
    }
    const applied = applyStepProposal(sensitiveDoc, sensitiveDoc.steps[0]!.id, {
      kind: 'fill_binding',
      from: 'amount',
    })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    const fill = applied.document.steps[0]!
    expect(fill.type).toBe('fill')
    if (fill.type !== 'fill') return
    expect(fill.input.value).toBeUndefined()
    expect(fill.input.from).toBe('amount')
    expect(fill.input.sensitive).toBe(true)
    expect(isSensitiveFillInput(fill.input)).toBe(true)
    expect(await scenarioDocumentDigest(applied.document)).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(scenarioFactsForModel(sensitiveDoc))).not.toContain('secret')
  })

  it('拒绝改写不受支持的步骤类型', () => {
    const applied = applyStepProposal(document, document.steps[0]!.id, {
      kind: 'ai_instruction',
      instruction: '点击确定',
    })
    expect(applied).toMatchObject({ ok: false, error: { code: 'STEP_TYPE_MISMATCH' } })
  })

  it('引用键格式闭合', () => {
    expect(citationKey('run', observation.run.id)).toBe(`run:${observation.run.id}`)
    expect(() => citationKey('run', 'not-a-uuid')).toThrow()
  })

  it('采纳前核对 revision 和文档摘要，脏草稿不能覆盖', async () => {
    const applied = applyStepProposal(document, document.steps[1]!.id, {
      kind: 'ai_instruction',
      instruction: '判断页面出现已完成',
    })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    const proposal = {
      kind: 'proposal' as const,
      change: { kind: 'ai_instruction' as const, instruction: '判断页面出现已完成' },
      document: applied.document,
      stepId: document.steps[1]!.id,
      draftRevision: 2,
      documentDigest: await scenarioDocumentDigest(document),
      reason: '测试',
      diffs: applied.diffs,
      diagnostics: [],
      executable: true,
    }
    expect(
      await canAdoptAssistantProposal({
        proposal,
        revision: 2,
        document,
        hasFieldDrafts: false,
        remoteConflict: false,
      }),
    ).toEqual({ ok: true })
    expect(
      (await canAdoptAssistantProposal({
        proposal,
        revision: 1,
        document,
        hasFieldDrafts: false,
        remoteConflict: false,
      })).ok,
    ).toBe(false)
    expect(
      (await canAdoptAssistantProposal({
        proposal,
        revision: 2,
        document,
        hasFieldDrafts: true,
        remoteConflict: false,
      })).ok,
    ).toBe(false)
  })

  it('validates assistantPageContext with structured quote and createAssistantTurnBodySchema', () => {
    const validBody = {
      clientTurnId: 'turn-12345678',
      question: '请分析这一步报错',
      pageContext: {
        page: 'run' as const,
        runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        stepId: '11111111-1111-4111-8111-111111111111',
        quote: {
          type: 'step_failure' as const,
          targetId: '11111111-1111-4111-8111-111111111111',
          title: '步骤 #1: 填写金额',
          summary: 'locator.fill: Timeout waiting for element',
          metadata: { stepType: 'fill' },
        },
      },
    }
    const parsed = createAssistantTurnBodySchema.safeParse(validBody)
    expect(parsed.success).toBe(true)

    // Rejects invalid quote type
    const invalidQuote = {
      ...validBody,
      pageContext: {
        ...validBody.pageContext,
        quote: {
          ...validBody.pageContext.quote,
          type: 'unknown_type',
        },
      },
    }
    expect(createAssistantTurnBodySchema.safeParse(invalidQuote).success).toBe(false)
  })

  it('正确将“添加步骤在页面哪里”路由至 in-page.guidance 而非 platform.guide', () => {
    const decision = routeAssistantTurn({
      question: '添加步骤在页面哪里？',
      pageContext: { page: 'studio', scenarioId: '11111111-1111-4111-8111-111111111111' },
      available: ['in-page.guidance', 'platform.guide', 'scenario.explain'],
    })
    expect(decision.type).toBe('dispatch')
    if (decision.type === 'dispatch') {
      expect(decision.capabilityId).toBe('in-page.guidance')
      expect(decision.slots.page).toBe('studio')
    }
  })
})
