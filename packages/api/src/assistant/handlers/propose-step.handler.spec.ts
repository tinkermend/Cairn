import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ScenarioAuthoringDocumentV2,
  type ScenarioDetailDto,
} from '@cairn/shared'

vi.mock('@cairn/db', () => ({
  getScenario: vi.fn(),
  getTargetKnowledgeContext: vi.fn(),
  getMapAssetDetail: vi.fn(),
  newId: vi.fn(() => crypto.randomUUID()),
  DomainError: class DomainError extends Error {
    constructor(public kind: string, public code: string, message: string) {
      super(message)
    }
  },
}))

vi.mock('./common.js', () => ({
  requireVisibleTarget: vi.fn().mockResolvedValue(undefined),
}))

import { getMapAssetDetail, getScenario, getTargetKnowledgeContext } from '@cairn/db'
import { handleScenarioProposeStep } from './propose-step.handler.js'
import type { AssistantCapabilityHandlerContext } from '../registry.js'

function sampleScenarioV2(overrides: Partial<ScenarioDetailDto> = {}): ScenarioDetailDto {
  const v2Doc: ScenarioAuthoringDocumentV2 = {
    authoringSchemaVersion: 2,
    schemaVersion: 1,
    inputs: [{ key: 'orderId', label: '订单号', type: 'string', required: true }],
    nodes: [
      {
        kind: 'step',
        step: {
          id: '11111111-1111-4111-8111-111111111111',
          name: '打开订单页面',
          type: 'navigate',
          effectType: 'READ_ONLY',
          input: { url: 'https://example.com/orders' },
        },
      },
      {
        kind: 'step',
        step: {
          id: '22222222-2222-4222-8222-222222222222',
          name: '点击搜索按钮',
          type: 'click',
          effectType: 'IDEMPOTENT',
          input: {
            target: {
              semantic: '搜索按钮',
              candidates: [{ by: 'css', value: '#search-btn' }],
            },
          },
        },
      },
    ],
    scenarioOutcomes: [
      {
        id: '55555555-5555-4555-8555-555555555555',
        scope: 'scenario',
        meaning: '页面打开',
        severity: 'MUST',
        onViolation: 'halt',
        provenance: 'manual',
        rule: { kind: 'deterministic', expect: { kind: 'visible' } },
      },
    ],
  }

  return {
    id: '33333333-3333-4333-8333-333333333333',
    name: '订单查询场景',
    status: 'draft',
    targetId: '44444444-4444-4444-8444-444444444444',
    authoringDocument: v2Doc,
    draft: {
      revision: 2,
      savedAt: '2026-09-26T00:00:00.000Z',
    },
    ...overrides,
  } as any
}

function mockContext(overrides: Partial<AssistantCapabilityHandlerContext> = {}): AssistantCapabilityHandlerContext {
  const scenario = sampleScenarioV2()
  return {
    db: {} as any,
    actor: {
      id: 'user-001',
      displayName: 'Author',
      email: 'author@example.com',
      status: 'active',
      roles: [],
      permissions: ['ai:assist', 'workflow:write', 'target:read'],
    },
    slots: {
      scenarioId: scenario.id,
      draftRevision: 2,
    },
    question: '在搜索按钮前加一步输入订单号',
    body: { question: '在搜索按钮前加一步输入订单号' },
    session: null,
    platformConfig: {} as any,
    targets: {} as any,
    models: {} as any,
    onProgress: vi.fn(),
    ...overrides,
  }
}

describe('propose-step.handler 场景编排结构化提议', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getScenario).mockResolvedValue(sampleScenarioV2())
    vi.mocked(getMapAssetDetail).mockRejectedValue(new Error('地图详情不可用'))
  })

  it('将真实地图定位与资产引用传给编排模型，并拒绝伪造的引用', async () => {
    const targetKnowledge = {
      targetId: '44444444-4444-4444-8444-444444444444', releaseId: null,
      generatedAt: '2026-09-27T00:00:00.000Z', menuTree: [], truncated: false,
      pages: [{ pageKey: 'page:tokens', menuPath: ['令牌'], title: '令牌列表', urlPattern: 'https://example.com/tokens',
        views: [{ viewStateKey: 'view:tokens', label: 'default', elements: [{
          assetRef: 'p:page:o:button:i:default:d:1', category: 'action_button', name: '搜索', stability: 'high',
          locator: { framePath: [], candidates: [{ by: 'role', value: 'button', name: '搜索' }] },
        }] }] }],
    }
    vi.mocked(getTargetKnowledgeContext).mockResolvedValue(targetKnowledge as never)
    const generated = vi.fn(async () => ({ operations: [{
      kind: 'insert_step', id: 'temp', step: { id: 'step', name: '点击搜索', type: 'click',
        input: { target: { assetRef: 'p:invented:o:button:i:default:d:1', framePath: [],
          candidates: [{ by: 'role', value: 'button', name: '搜索' }] } } },
    }] }))
    const base = mockContext()
    const result = await handleScenarioProposeStep(mockContext({
      actor: { ...base.actor, permissions: [...base.actor.permissions, 'map:read'] },
      session: { generateScenarioAuthoringProposal: generated } as never,
    }))
    expect(getTargetKnowledgeContext).toHaveBeenCalledWith(expect.anything(), targetKnowledge.targetId,
      expect.objectContaining({ maxPages: 3 }))
    expect(generated).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ targetKnowledge }), undefined)
    expect(result).toMatchObject({ kind: 'unsupported', reasonCode: 'MAP_ASSET_UNKNOWN' })
  })

  it.each([
    ['添加未观测候选', { framePath: [], candidates: [
      { by: 'role', value: 'link', name: '删除' },
      { by: 'role', value: 'button', name: '搜索' },
    ] }],
    ['改写 iframe 路径', { framePath: [{ name: '其它窗口' }], candidates: [
      { by: 'role', value: 'button', name: '搜索' },
    ] }],
    ['添加未观测语义定位', { framePath: [], candidates: [
      { by: 'role', value: 'button', name: '搜索' },
    ], semantic: '删除当前记录' }],
  ])('地图引用真实但%s时仍拒绝提案', async (_name, locator) => {
    const assetRef = 'p:page:o:button:i:default:d:1'
    vi.mocked(getTargetKnowledgeContext).mockResolvedValue({
      targetId: '44444444-4444-4444-8444-444444444444', releaseId: null,
      generatedAt: '2026-09-27T00:00:00.000Z', menuTree: [], truncated: false,
      pages: [{ pageKey: 'page:tokens', menuPath: ['令牌'], title: '令牌列表', urlPattern: 'https://example.com/tokens',
        views: [{ viewStateKey: 'view:tokens', label: 'default', elements: [{
          assetRef, category: 'action_button', name: '搜索', stability: 'high',
          locator: { framePath: [], candidates: [{ by: 'role', value: 'button', name: '搜索' }] },
        }] }] }],
    } as never)
    const base = mockContext()
    const result = await handleScenarioProposeStep(mockContext({
      actor: { ...base.actor, permissions: [...base.actor.permissions, 'map:read'] },
      session: { generateScenarioAuthoringProposal: vi.fn(async () => ({ operations: [{
        kind: 'insert_step', id: 'temp', step: { id: 'step', name: '点击搜索', type: 'click',
          input: { target: { assetRef, ...locator } } },
      }] })) } as never,
    }))
    expect(result).toMatchObject({ kind: 'unsupported', reasonCode: 'MAP_ASSET_UNKNOWN' })
  })

  it('用户明确指定页面与表格列时使用已观测资产生成只读断言提议', async () => {
    const assetRef = 'p:page:o:column:i:default:d:1'
    vi.mocked(getTargetKnowledgeContext).mockResolvedValue({
      targetId: '44444444-4444-4444-8444-444444444444', releaseId: null,
      generatedAt: '2026-09-27T00:00:00.000Z', menuTree: [], truncated: false,
      pages: [{ pageKey: 'page:keys', menuPath: ['API Keys'], title: 'API Keys',
        urlPattern: 'https://example.com/keys', views: [{ viewStateKey: 'view:keys', label: 'default',
          elements: [{ assetRef, category: 'table_column', name: 'API Key', stability: 'medium',
            locator: { framePath: [], candidates: [{ by: 'role', value: 'columnheader', name: 'API Key' }] } }] }] }],
    } as never)
    const model = { generateScenarioAuthoringProposal: vi.fn() }
    const base = mockContext()
    const result = await handleScenarioProposeStep(mockContext({
      actor: { ...base.actor, permissions: [...base.actor.permissions, 'map:read'] },
      slots: { ...base.slots, stepId: '11111111-1111-4111-8111-111111111111' },
      question: '在当前步骤之后增加一个断言步骤，确认 API Keys 页面表格存在 API Key 列。',
      session: model as never,
    }))
    expect(result.kind).toBe('authoring_proposal')
    if (result.kind === 'authoring_proposal') expect(result.operations[0]).toMatchObject({
      kind: 'insert_step', anchorStepId: '11111111-1111-4111-8111-111111111111',
      step: { type: 'assert', effectType: 'READ_ONLY', input: {
        target: { assetRef, candidates: [{ by: 'role', value: 'columnheader', name: 'API Key' }] },
        expect: { kind: 'exists' },
      } },
    })
    expect(model.generateScenarioAuthoringProposal).not.toHaveBeenCalled()
  })

  it('等待后再校验表格列时生成有序的两个操作，不把单个断言冒充完整提案', async () => {
    const assetRef = 'p:page:o:column:i:default:d:1'
    vi.mocked(getMapAssetDetail).mockResolvedValue({
      assetRefKey: assetRef, name: 'API Key', evidenceAvailability: 'unavailable',
      observationCoverage: 'unknown', applicability: 'unknown',
    } as never)
    vi.mocked(getTargetKnowledgeContext).mockResolvedValue({
      targetId: '44444444-4444-4444-8444-444444444444',
      releaseId: '66666666-6666-4666-8666-666666666666',
      generatedAt: '2026-09-27T00:00:00.000Z', menuTree: [], truncated: false,
      pages: [{ pageKey: 'page:keys', menuPath: ['API Keys'], title: 'API Keys',
        urlPattern: 'https://example.com/keys', views: [{ viewStateKey: 'view:keys', label: 'default',
          elements: [{ assetRef, category: 'table_column', name: 'API Key', stability: 'medium',
            locator: { framePath: [], candidates: [{ by: 'role', value: 'columnheader', name: 'API Key' }] } }] }] }],
    } as never)
    const base = mockContext()
    const anchorStepId = '11111111-1111-4111-8111-111111111111'
    const result = await handleScenarioProposeStep(mockContext({
      actor: { ...base.actor, permissions: [...base.actor.permissions, 'map:read'] },
      slots: { ...base.slots, stepId: anchorStepId },
      question: '在 API Keys 页面，查完后等表格出现，再确认表格有 API Key 列。',
      session: { generateScenarioAuthoringProposal: vi.fn() } as never,
    }))
    expect(result.kind).toBe('authoring_proposal')
    if (result.kind !== 'authoring_proposal') return
    expect(result.operations).toHaveLength(2)
    const [wait, check] = result.operations
    expect(wait).toMatchObject({ kind: 'insert_step', anchorStepId,
      step: { type: 'wait', input: { kind: 'visible', target: { assetRef } } } })
    expect(check).toMatchObject({ kind: 'insert_step', step: { type: 'assert', input: {
      target: { assetRef }, expect: { kind: 'exists' },
    } } })
    expect(check?.kind === 'insert_step' && wait?.kind === 'insert_step' && check.anchorStepId).toBe(wait?.kind === 'insert_step' ? wait.step.id : undefined)
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'MAP_SOURCE_NEEDS_REVIEW', severity: 'warning',
      message: expect.stringContaining('原始证据不可回看'),
    })]))
    expect(getMapAssetDetail).toHaveBeenCalledWith(expect.anything(),
      '44444444-4444-4444-8444-444444444444', 'column',
      expect.objectContaining({ releaseId: '66666666-6666-4666-8666-666666666666' }))
  })

  it('缺少结果区定位时不调用模型猜测，也不生成等待加校验的半成品提案', async () => {
    vi.mocked(getTargetKnowledgeContext).mockResolvedValue({
      targetId: '44444444-4444-4444-8444-444444444444', releaseId: null,
      generatedAt: '2026-09-27T00:00:00.000Z', menuTree: [], truncated: false,
      pages: [{ pageKey: 'page:orders', menuPath: ['订单'], title: '订单',
        urlPattern: 'https://example.com/orders', views: [{ viewStateKey: 'view:orders', label: 'default',
          elements: [{ assetRef: 'p:orders:o:status:i:default:d:1', category: 'display', name: '状态',
            stability: 'medium', locator: { framePath: [], candidates: [{ by: 'label', value: '状态' }] } }] }] }],
    } as never)
    const generate = vi.fn(async () => ({ operations: [{ kind: 'insert_step', id: 'temp',
      step: { id: 'step', name: '检查状态', type: 'assert', effectType: 'READ_ONLY',
        input: { target: { framePath: [], candidates: [{ by: 'label', value: '状态' }] },
          expect: { kind: 'text_contains', value: '成功' } } } }] }))
    const result = await handleScenarioProposeStep(mockContext({
      actor: { ...mockContext().actor, permissions: ['ai:assist', 'workflow:write', 'target:read', 'map:read'] },
      slots: { scenarioId: '33333333-3333-4333-8333-333333333333', draftRevision: 2,
        stepId: '22222222-2222-4222-8222-222222222222' },
      question: '查完订单后等结果区出现，再检查状态是成功。',
      session: { generateScenarioAuthoringProposal: generate } as never,
    }))
    expect(generate).not.toHaveBeenCalled()
    expect(result).toMatchObject({ kind: 'clarify', missingFields: ['waitTarget', 'assertTarget'] })
  })

  it('其它业务页面的结果区与状态定位不能冒充订单页事实', async () => {
    vi.mocked(getTargetKnowledgeContext).mockResolvedValue({
      targetId: '44444444-4444-4444-8444-444444444444', releaseId: null,
      generatedAt: '2026-09-27T00:00:00.000Z', menuTree: [], truncated: false,
      pages: [{ pageKey: 'page:invoice', menuPath: ['发票'], title: '发票查询',
        urlPattern: 'https://example.com/invoices', views: [{ viewStateKey: 'view:invoice', label: 'default',
          elements: [
            { assetRef: null, category: 'display', name: '结果区', stability: 'medium',
              locator: { framePath: [], candidates: [{ by: 'css', value: '#results' }] } },
            { assetRef: null, category: 'display', name: '状态', stability: 'medium',
              locator: { framePath: [], candidates: [{ by: 'css', value: '#status' }] } },
          ] }] }],
    } as never)
    const generate = vi.fn()
    const result = await handleScenarioProposeStep(mockContext({
      actor: { ...mockContext().actor, permissions: ['ai:assist', 'workflow:write', 'target:read', 'map:read'] },
      slots: { scenarioId: '33333333-3333-4333-8333-333333333333', draftRevision: 2,
        stepId: '22222222-2222-4222-8222-222222222222' },
      question: '查完订单后等结果区出现，再检查状态是成功。',
      session: { generateScenarioAuthoringProposal: generate } as never,
    }))
    expect(result).toMatchObject({ kind: 'clarify', missingFields: ['waitTarget', 'assertTarget'] })
    expect(generate).not.toHaveBeenCalled()
  })

  it('对非英文列名也按唯一的已观测资产生成断言', async () => {
    const assetRef = 'p:orders:o:order-number:i:default:d:1'
    vi.mocked(getTargetKnowledgeContext).mockResolvedValue({
      targetId: '44444444-4444-4444-8444-444444444444', releaseId: null,
      generatedAt: '2026-09-27T00:00:00.000Z', menuTree: [], truncated: false,
      pages: [{ pageKey: 'page:orders', menuPath: ['订单'], title: '订单列表',
        urlPattern: 'https://example.com/orders', views: [{ viewStateKey: 'view:orders', label: 'default',
          elements: [{ assetRef, category: 'table_column', name: '订单号', stability: 'medium',
            locator: { framePath: [], candidates: [{ by: 'role', value: 'columnheader', name: '订单号' }] } }] }] }],
    } as never)
    const base = mockContext()
    const result = await handleScenarioProposeStep(mockContext({
      actor: { ...base.actor, permissions: [...base.actor.permissions, 'map:read'] },
      slots: { ...base.slots, stepId: '11111111-1111-4111-8111-111111111111' },
      question: '在当前步骤之后确认订单表格包含订单号列。',
      session: { generateScenarioAuthoringProposal: vi.fn() } as never,
    }))
    expect(result).toMatchObject({ kind: 'authoring_proposal', operations: [{
      step: { type: 'assert', effectType: 'READ_ONLY', input: { target: { assetRef }, expect: { kind: 'exists' } } },
    }] })
  })

  it('明确指定的页面没有该列时不借用其他页面的同名列', async () => {
    vi.mocked(getTargetKnowledgeContext).mockResolvedValue({
      targetId: '44444444-4444-4444-8444-444444444444', releaseId: null,
      generatedAt: '2026-09-27T00:00:00.000Z', menuTree: [], truncated: false,
      pages: [
        { pageKey: 'page:orders', menuPath: ['订单'], title: '订单列表',
          urlPattern: 'https://example.com/orders', views: [] },
        { pageKey: 'page:customers', menuPath: ['客户'], title: '客户列表',
          urlPattern: 'https://example.com/customers', views: [{ viewStateKey: 'view:customers', label: 'default',
            elements: [{ assetRef: 'p:customers:o:order-number:i:default:d:1', category: 'table_column',
              name: '订单号', stability: 'medium',
              locator: { framePath: [], candidates: [{ by: 'role', value: 'columnheader', name: '订单号' }] } }] }] },
      ],
    } as never)
    const generate = vi.fn()
    const base = mockContext()
    const result = await handleScenarioProposeStep(mockContext({
      actor: { ...base.actor, permissions: [...base.actor.permissions, 'map:read'] },
      slots: { ...base.slots, stepId: '11111111-1111-4111-8111-111111111111' },
      question: '确认订单列表的表格包含订单号列。',
      session: { generateScenarioAuthoringProposal: generate } as never,
    }))
    expect(generate).not.toHaveBeenCalled()
    expect(result).toMatchObject({ kind: 'unsupported', reasonCode: 'MAP_COLUMN_NOT_OBSERVED' })
  })

  it('多个页面有同名列且问句未指定页面时不猜测资产', async () => {
    const column = (assetRef: string) => ({ assetRef, category: 'table_column', name: '状态',
      stability: 'medium', locator: { framePath: [], candidates: [{ by: 'role', value: 'columnheader', name: '状态' }] } })
    vi.mocked(getTargetKnowledgeContext).mockResolvedValue({
      targetId: '44444444-4444-4444-8444-444444444444', releaseId: null,
      generatedAt: '2026-09-27T00:00:00.000Z', menuTree: [], truncated: false,
      pages: [
        { pageKey: 'page:orders', menuPath: ['订单'], title: '订单列表', urlPattern: 'https://example.com/orders',
          views: [{ viewStateKey: 'view:orders', label: 'default', elements: [column('p:orders:o:status:i:default:d:1')] }] },
        { pageKey: 'page:customers', menuPath: ['客户'], title: '客户列表', urlPattern: 'https://example.com/customers',
          views: [{ viewStateKey: 'view:customers', label: 'default', elements: [column('p:customers:o:status:i:default:d:1')] }] },
      ],
    } as never)
    const generate = vi.fn()
    const base = mockContext()
    const result = await handleScenarioProposeStep(mockContext({
      actor: { ...base.actor, permissions: [...base.actor.permissions, 'map:read'] },
      slots: { ...base.slots, stepId: '11111111-1111-4111-8111-111111111111' },
      question: '确认表格包含状态列。',
      session: { generateScenarioAuthoringProposal: generate } as never,
    }))
    expect(generate).not.toHaveBeenCalled()
    expect(result).toMatchObject({ kind: 'unsupported', reasonCode: 'MAP_COLUMN_AMBIGUOUS' })
  })

  it('缺少 workflow:write 权限时诚实拒绝并说明', async () => {
    const ctx = mockContext({
      actor: {
        id: 'user-002',
        displayName: 'Viewer',
        email: 'viewer@example.com',
        status: 'active',
        roles: [],
        permissions: ['ai:assist', 'target:read'],
      },
    })

    const result = await handleScenarioProposeStep(ctx)
    expect(result.kind).toBe('unsupported')
    if (result.kind === 'unsupported') {
      expect(result.reasonCode).toBe('PERMISSION_DENIED')
      expect(result.message).toContain('workflow:write')
    }
  })

  it('模糊问句（如“写清楚”）触发 Clarify，不机械生成字面名为“写清楚”的步骤 (N01)', async () => {
    const ctx = mockContext({
      question: '把这条指令写清楚',
      body: { question: '把这条指令写清楚' },
    })

    const result = await handleScenarioProposeStep(ctx)
    expect(result.kind).toBe('clarify')
    if (result.kind === 'clarify') {
      expect(result.question).toContain('业务目标')
      expect(result.missingFields).toContain('intent')
    }
  })

  it('空泛问句（如“优化一下”）触发 Clarify (N01)', async () => {
    const ctx = mockContext({
      question: '帮我优化一下',
      body: { question: '帮我优化一下' },
    })

    const result = await handleScenarioProposeStep(ctx)
    expect(result.kind).toBe('clarify')
    if (result.kind === 'clarify') {
      expect(result.missingFields).toContain('intent')
    }
  })

  it('目标步骤重名产生歧义时触发 Clarify (N02)', async () => {
    const scenario = sampleScenarioV2()
    // 添加同名步骤
    scenario.authoringDocument.nodes.push({
      kind: 'step',
      step: {
        id: '55555555-5555-4555-8555-555555555555',
        name: '点击搜索按钮',
        type: 'click',
        effectType: 'IDEMPOTENT',
        input: { target: { semantic: '搜索按钮 2' } },
      },
    })
    vi.mocked(getScenario).mockResolvedValue(scenario)

    const ctx = mockContext({
      question: '在点击搜索按钮后面加一个等待',
      body: { question: '在点击搜索按钮后面加一个等待' },
    })

    const result = await handleScenarioProposeStep(ctx)
    expect(result.kind).toBe('clarify')
    if (result.kind === 'clarify') {
      expect(result.question).toContain('存在多个同名步骤')
      expect(result.options?.length).toBe(2)
    }
  })

  it.each([
    '添加输入密码步骤，密码是 PlainTextPassword123',
    '把这一步的密码直接写成 DummyTestPassword123!，给我修改建议。',
  ])('敏感密码明文字面量提议应被拦截且不回显 (%s)', async (question) => {
    const mockModelSession = {
      generateScenarioAuthoringProposal: vi.fn(async () => ({
        operations: [
          {
            kind: 'insert_step',
            id: 'temp-1',
            step: {
              id: 'temp-step-1',
              name: '输入密码',
              type: 'fill',
              input: { target: { semantic: '密码输入框' }, value: 'PlainTextPassword123' },
            },
          },
        ],
      })),
    }

    const ctx = mockContext({
      session: mockModelSession as any,
      question,
    })

    const result = await handleScenarioProposeStep(ctx)
    expect(result.kind).toBe('unsupported')
    if (result.kind === 'unsupported') {
      expect(result.reasonCode).toBe('SENSITIVE_LITERAL_FORBIDDEN')
      expect(result.message).toContain('不能把明文口令或凭据写入场景步骤')
      expect(result.message).not.toMatch(/PlainTextPassword123|DummyTestPassword123/)
    }
    expect(mockModelSession.generateScenarioAuthoringProposal).not.toHaveBeenCalled()
  })

  it('成功在 V2 结构化文档上生成编排候选，保留顶层属性与 scenarioOutcomes，输出 diff 与静态预检', async () => {
    vi.mocked(getTargetKnowledgeContext).mockResolvedValue({
      targetId: '44444444-4444-4444-8444-444444444444', releaseId: null,
      generatedAt: '2026-09-27T00:00:00.000Z', menuTree: [], truncated: false,
      pages: [{ pageKey: 'page:orders', menuPath: ['订单'], title: '订单页面',
        urlPattern: 'https://example.com/orders', views: [{ viewStateKey: 'view:orders', label: 'default',
          elements: [{ assetRef: null, category: 'input', name: '订单号输入框', stability: 'medium',
            locator: { framePath: [], semantic: '订单号输入框',
              candidates: [{ by: 'css', value: '#order-input' }] } }] }] }],
    } as never)
    const mockModelSession = {
      generateScenarioAuthoringProposal: vi.fn(async () => ({
        operations: [
          {
            kind: 'insert_step',
            id: 'temp-1',
            step: {
              id: 'temp-step-1',
              name: '输入订单号',
              type: 'fill',
              input: {
                target: {
                  semantic: '订单号输入框',
                  candidates: [{ by: 'css', value: '#order-input' }],
                },
                from: 'orderId',
              },
            },
            anchorStepId: '11111111-1111-4111-8111-111111111111',
          },
        ],
      })),
    }

    const base = mockContext()
    const ctx = mockContext({
      actor: { ...base.actor, permissions: [...base.actor.permissions, 'map:read'] },
      session: mockModelSession as any,
      question: '在打开订单页面后添加输入订单号步骤',
    })

    const result = await handleScenarioProposeStep(ctx)
    if (result.kind === 'unsupported') {
      throw new Error(`Unexpected unsupported: ${result.reasonCode} - ${result.message}`)
    }
    expect(result.kind).toBe('authoring_proposal')
    if (result.kind === 'authoring_proposal') {
      expect(result.operations).toHaveLength(1)
      expect(result.operations[0].kind).toBe('insert_step')
      expect(result.diffs.length).toBeGreaterThan(0)
      expect(result.diffs[0].type).toBe('add')
      expect(result.executable).toBe(true)
      expect(result.validation.compiler).toBe('passed')
      expect(result.candidateDigest).toBeDefined()
    }
  })

  it('模型没有地图或用户选择器依据时不接受猜测的 CSS 定位', async () => {
    const result = await handleScenarioProposeStep(mockContext({
      question: '在打开订单页面后添加输入订单号步骤',
      session: { generateScenarioAuthoringProposal: vi.fn(async () => ({ operations: [{
        kind: 'insert_step', id: 'temp-1', anchorStepId: '11111111-1111-4111-8111-111111111111',
        step: { id: 'temp-step-1', name: '输入订单号', type: 'fill',
          input: { target: { candidates: [{ by: 'css', value: '#order-input' }] }, from: 'orderId' } },
      }] })) } as never,
    }))
    expect(result).toMatchObject({ kind: 'clarify', missingFields: ['targetLocator'] })
  })

  it('用户明确提供未观测 CSS 时允许可审查提案并标明定位未验证', async () => {
    const result = await handleScenarioProposeStep(mockContext({
      question: '在打开订单页面后用 #order-input 输入订单号',
      session: { generateScenarioAuthoringProposal: vi.fn(async () => ({ operations: [{
        kind: 'insert_step', id: 'temp-1', anchorStepId: '11111111-1111-4111-8111-111111111111',
        step: { id: 'temp-step-1', name: '输入订单号', type: 'fill',
          input: { target: { candidates: [{ by: 'css', value: '#order-input' }] }, from: 'orderId' } },
      }] })) } as never,
    }))
    expect(result.kind).toBe('authoring_proposal')
    if (result.kind !== 'authoring_proposal') return
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'MAP_SOURCE_USER_SELECTOR_UNVERIFIED', severity: 'warning',
    })]))
  })
})
