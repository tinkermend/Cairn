import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ScenarioAuthoringDocumentV2,
  type ScenarioDetailDto,
} from '@cairn/shared'

vi.mock('@cairn/db', () => ({
  getScenario: vi.fn(),
  getTargetKnowledgeContext: vi.fn(),
  newId: vi.fn(() => '99999999-9999-4999-8999-999999999999'),
  DomainError: class DomainError extends Error {
    constructor(public kind: string, public code: string, message: string) {
      super(message)
    }
  },
}))

vi.mock('./common.js', () => ({
  requireVisibleTarget: vi.fn().mockResolvedValue(undefined),
}))

import { getScenario, getTargetKnowledgeContext } from '@cairn/db'
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

  it('敏感密码明文字面量提议应被拦截 (N08)', async () => {
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
      question: '添加输入密码步骤，密码是 PlainTextPassword123',
    })

    const result = await handleScenarioProposeStep(ctx)
    expect(result.kind).toBe('unsupported')
    if (result.kind === 'unsupported') {
      expect(result.reasonCode).toBe('TASK_UNSUPPORTED')
      expect(result.message).toContain('密码或凭据不能以明文字符串字面量填入')
    }
  })

  it('成功在 V2 结构化文档上生成编排候选，保留顶层属性与 scenarioOutcomes，输出 diff 与静态预检', async () => {
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

    const ctx = mockContext({
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
})
