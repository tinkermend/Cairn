import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ScenarioAuthoringDocumentV2,
  type ScenarioDetailDto,
} from '@cairn/shared'

vi.mock('@cairn/db', () => ({
  getScenario: vi.fn(),
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

import { getScenario } from '@cairn/db'
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
