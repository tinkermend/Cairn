import { describe, expect, it } from 'vitest'
import {
  SYSTEM_ROLE_DEFINITIONS,
  applyStepProposal,
  availableAssistantCapabilities,
  canAdoptAssistantProposal,
  citationKey,
  filterGuideCatalog,
  inferAssistantCapability,
  inferAssistantFocus,
  inferGuideTopic,
  isSensitiveFillInput,
  scenarioFactsForModel,
  projectRunFacts,
  quoteStepFocusId,
  quoteTargetSystemId,
  quotedStepIdOnRun,
  routeAssistantTurn,
  scenarioDocumentDigest,
  createAssistantTurnBodySchema,
  assistantQuoteContextSchema,
  assistantPageContextSchema,
  type FillInput,
  type RunObservation,
  type ScenarioDocument,
  type Step,
} from '../index.js'

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
    expect(pack.facts.some((item) => item.text.includes('owner_at_capacity'))).toBe(true)
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

