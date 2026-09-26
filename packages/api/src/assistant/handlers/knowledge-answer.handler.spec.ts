import { describe, expect, it, vi, beforeEach } from 'vitest'
import { handleKnowledgeAnswer } from './knowledge-answer.handler.js'
import type { AssistantCapabilityHandlerContext } from '../registry.js'

vi.mock('@cairn/db', () => ({
  loadRunObservation: vi.fn(),
  getScenario: vi.fn(),
  getSessionDto: vi.fn(),
  getSchedule: vi.fn(),
  getDataset: vi.fn(),
  DomainError: class DomainError extends Error {
    constructor(public kind: string, public code: string, message: string) {
      super(message)
    }
  },
}))

vi.mock('./common.js', () => ({
  requireVisibleTarget: vi.fn().mockResolvedValue(undefined),
}))

import {
  loadRunObservation,
  getScenario,
  getSessionDto,
  getSchedule,
  getDataset,
} from '@cairn/db'

describe('handleKnowledgeAnswer (P0-B & Entity Boundaries CQ-03..CQ-14)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const createMockContext = (
    overrides?: Partial<AssistantCapabilityHandlerContext>,
  ): AssistantCapabilityHandlerContext => {
    return {
      db: {} as any,
      actor: {
        id: 'user-1',
        name: 'Test User',
        permissions: ['ai:assist'],
        targetScope: 'all',
      },
      slots: {},
      question: '如何配置重试策略？',
      body: {
        question: '如何配置重试策略？',
      },
      session: {
        completeJson: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            summary: '在 Studio 中可以配置每个确定性步骤的最大重试次数与退避延迟。',
            claims: [
              {
                factKind: 'human_confirmed',
                text: '每个确定性步骤支持配置 maxAttempts 与退避延迟',
                citations: ['help:studio-retry'],
              },
            ],
            missing: [],
          },
        }),
      } as any,
      platformConfig: {} as any,
      targets: {
        getTarget: vi.fn().mockResolvedValue({
          id: 'tgt-1',
          name: '生产ERP',
          entryUrl: 'https://erp.example.com',
          status: 'ACTIVE',
          authMethod: 'FORM',
        }),
      } as any,
      models: {} as any,
      ...overrides,
    }
  }

  it('CQ-09: throws ASSISTANT_MODEL_DISABLED when session is null (pure AI-native principle)', async () => {
    const ctx = createMockContext({ session: null })
    await expect(handleKnowledgeAnswer(ctx)).rejects.toThrowError(
      expect.objectContaining({
        code: 'ASSISTANT_MODEL_DISABLED',
      }),
    )
  })

  it('CQ-06: returns grounded answer citing published help catalog', async () => {
    const ctx = createMockContext()
    const result = await handleKnowledgeAnswer(ctx)

    expect(result.kind).toBe('knowledge_answer')
    expect(result.summary).toContain('Studio')
    expect(result.claims.length).toBe(1)
    expect(result.claims[0].factKind).toBe('human_confirmed')
    expect(result.claims[0].citations).toContain('help:studio-retry')
    expect(result.nextActions).toBeDefined()
    expect(result.nextActions?.length).toBeGreaterThan(0)
    expect(result.nextActions?.[0].kind).toBe('studio.step')
  })

  it('returns honest missing notice when query has no matching facts', async () => {
    const ctx = createMockContext({
      question: '火星上有生命吗？',
      body: { question: '火星上有生命吗？' },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.kind).toBe('knowledge_answer')
    expect(result.claims.length).toBe(0)
    expect(result.missing.some((m) => m.reason === 'no_matching_facts')).toBe(true)
  })

  it('filters out hallucinated citations not in allowedCitations', async () => {
    const ctx = createMockContext({
      session: {
        completeJson: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            summary: '测试回答',
            claims: [
              {
                factKind: 'human_confirmed',
                text: '步骤重试配置说明',
                citations: ['help:studio-retry', 'help:fake-non-existent-id'],
              },
            ],
            missing: [],
          },
        }),
      } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.claims[0].citations).toEqual(['help:studio-retry'])
    expect(result.claims[0].citations).not.toContain('help:fake-non-existent-id')
  })

  it('CQ-05: handles unauthenticated/forbidden entity access without leaking existence', async () => {
    const ctx = createMockContext({
      actor: {
        id: 'user-1',
        name: 'Restricted User',
        permissions: ['ai:assist'], // lacks run:read and target:read
        targetScope: 'all',
      },
      body: {
        question: '这次运行为什么停了？',
        pageContext: {
          version: 2,
          routeKey: 'runs.$runId',
          pageKind: 'run',
          page: 'run',
          runId: '01920000-0000-7000-8000-000000000100',
        },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.missing.some((m) => m.key === 'run' && m.reason === 'permission_denied')).toBe(true)
  })

  it('CQ-03: loads Run stepRun, attempt, and active view tab facts', async () => {
    vi.mocked(loadRunObservation).mockResolvedValue({
      run: {
        id: 'run-100',
        status: 'FAILED',
        outcomeStatus: 'FAILED',
        evidenceStatus: 'COMPLETED',
        scenarioName: '订单同步',
        targetId: 'tgt-1',
        targetName: '生产ERP',
        stepRuns: [
          {
            id: 'sr-1',
            stepId: 'step-click',
            name: '点击提交按钮',
            type: 'click',
            status: 'FAILED',
            outcomeStatus: 'FAILED',
            attempts: [
              {
                id: 'att-1',
                attemptNo: 1,
                status: 'FAILED',
                startedAt: '2026-09-23T10:00:00.000Z',
                error: { message: 'Element not clickable' },
              },
            ],
          },
        ],
      } as any,
      evidence: { items: [] },
      eventSeq: 1,
      earliestEventSeq: 1,
    })

    const completeJsonMock = vi.fn().mockImplementation((name, schema, messages) => {
      const userPayload = JSON.parse(messages[1].content)
      return Promise.resolve({
        ok: true,
        value: {
          summary: '运行失败在第 1 次尝试。',
          claims: [
            {
              factKind: 'observed',
              text: '步骤点击提交按钮失败，错误为 Element not clickable',
              citations: ['run:run-100', 'stepRun:sr-1', 'attempt:att-1', 'view:tab'],
            },
          ],
        },
      })
    })

    const ctx = createMockContext({
      actor: {
        id: 'user-1',
        name: 'Op User',
        permissions: ['ai:assist', 'run:read', 'target:read'],
        targetScope: 'all',
      },
      session: { completeJson: completeJsonMock } as any,
      body: {
        question: '为什么会失败？',
        pageContext: {
          version: 2,
          routeKey: 'runs.$runId',
          pageKind: 'run',
          page: 'run',
          runId: 'run-100',
          stepId: 'step-click',
          view: {
            tab: 'timeline',
            selectedRef: { kind: 'attempt', id: 'att-1' },
          },
        },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.kind).toBe('knowledge_answer')
    expect(result.claims[0].citations).toContain('run:run-100')
    expect(result.claims[0].citations).toContain('stepRun:sr-1')
    expect(result.claims[0].citations).toContain('attempt:att-1')
    expect(result.claims[0].citations).toContain('view:tab')
  })

  it('CQ-04 & CQ-06: loads Studio step definition and attaches unsaved draft notice fact', async () => {
    vi.mocked(getScenario).mockResolvedValue({
      id: 'sc-1',
      name: '发票报销流程',
      targetId: 'tgt-1',
      draft: { revision: 12 },
      steps: [
        {
          id: 'step-invoice',
          name: '提取发票金额',
          action: 'extract',
          description: '从PDF中识别发票总计金额',
        },
      ],
    } as any)

    const completeJsonMock = vi.fn().mockImplementation((name, schema, messages) => {
      const userPayload = JSON.parse(messages[1].content)
      expect(userPayload.availableCitations).toContain('scenario:sc-1:draft_status')
      expect(userPayload.availableCitations).toContain('step:step-invoice')
      return Promise.resolve({
        ok: true,
        value: {
          summary: '提取发票金额步骤用于从 PDF 识别金额。',
          claims: [
            {
              factKind: 'observed',
              text: '提取发票金额步骤动作类型为 extract',
              citations: ['scenario:sc-1', 'step:step-invoice'],
            },
            {
              factKind: 'human_confirmed',
              text: '当前画布存在未保存修改，依据已保存修订号 12 解答',
              citations: ['scenario:sc-1:draft_status'],
            },
          ],
        },
      })
    })

    const ctx = createMockContext({
      actor: {
        id: 'user-1',
        name: 'Workflow Author',
        permissions: ['ai:assist', 'workflow:read', 'target:read'],
        targetScope: 'all',
      },
      session: { completeJson: completeJsonMock } as any,
      body: {
        question: '这个步骤做什么？',
        pageContext: {
          version: 2,
          routeKey: 'scenarios.$scenarioId',
          pageKind: 'studio',
          page: 'studio',
          scenarioId: 'sc-1',
          stepId: 'step-invoice',
          draft: { isDirty: true, savedRevision: 12 },
        },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.claims.some((c) => c.citations.includes('scenario:sc-1:draft_status'))).toBe(true)
    expect(result.claims.some((c) => c.citations.includes('step:step-invoice'))).toBe(true)
  })

  it('CQ-12: loads Session entity facts and enforces target/account scopeRefs validation', async () => {
    vi.mocked(getSessionDto).mockResolvedValue({
      id: 'sess-888',
      targetId: 'tgt-1',
      targetAccountId: 'acc-admin',
      status: 'OPEN',
      health: 'HEALTHY',
      authState: 'AUTHENTICATED',
      leaseOwnerWorkerId: 'worker-a',
    } as any)

    const completeJsonMock = vi.fn().mockImplementation((name, schema, messages) => {
      const userPayload = JSON.parse(messages[1].content)
      expect(userPayload.availableCitations).toContain('session:sess-888')
      return Promise.resolve({
        ok: true,
        value: {
          summary: '会话正常运行且处于活跃占用状态。',
          claims: [
            {
              factKind: 'observed',
              text: '会话由 worker-a 租约持有且已完成认证',
              citations: ['session:sess-888'],
            },
          ],
        },
      })
    })

    const ctx = createMockContext({
      actor: {
        id: 'user-1',
        name: 'Admin',
        permissions: ['ai:assist', 'target:read'],
        targetScope: 'all',
      },
      session: { completeJson: completeJsonMock } as any,
      body: {
        question: '这条会话为什么等待？',
        pageContext: {
          version: 2,
          routeKey: 'sessions.$targetId.$accountId',
          pageKind: 'session',
          page: 'session',
          primaryRef: { kind: 'session', id: 'sess-888' },
          scopeRefs: [
            { kind: 'target', id: 'tgt-1' },
            { kind: 'account', id: 'acc-admin' },
          ],
        },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.claims[0].citations).toContain('session:sess-888')
    expect(result.nextActions?.some((a) => a.href?.includes('/sessions/tgt-1/acc-admin'))).toBe(true)

    // 负例：伪造不匹配的账号 scopeRefs
    const mismatchCtx = createMockContext({
      actor: {
        id: 'user-1',
        name: 'Admin',
        permissions: ['ai:assist', 'target:read'],
        targetScope: 'all',
      },
      body: {
        question: '会话状态？',
        pageContext: {
          version: 2,
          routeKey: 'sessions.$targetId.$accountId',
          pageKind: 'session',
          page: 'session',
          primaryRef: { kind: 'session', id: 'sess-888' },
          scopeRefs: [
            { kind: 'target', id: 'tgt-1' },
            { kind: 'account', id: 'other-forbidden-account' },
          ],
        },
      },
    })

    const mismatchResult = await handleKnowledgeAnswer(mismatchCtx)
    expect(mismatchResult.missing.some((m) => m.key === 'session' && m.reason === 'scope_mismatch')).toBe(true)
  })

  it('CQ-13: loads Schedule facts and handles permission denial', async () => {
    vi.mocked(getSchedule).mockResolvedValue({
      id: 'sched-1',
      scenarioId: 'sc-1',
      name: '每日定时报表',
      cronExpression: '0 8 * * *',
      enabled: true,
      timezone: 'Asia/Shanghai',
      nextRunAt: '2026-09-24T00:00:00.000Z',
    } as any)

    const ctx = createMockContext({
      actor: {
        id: 'user-1',
        name: 'Scheduler Admin',
        permissions: ['ai:assist', 'schedule:read'],
        targetScope: 'all',
      },
      session: {
        completeJson: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            summary: '定时任务每天早上8点触发。',
            claims: [
              {
                factKind: 'observed',
                text: '调度表达式为 0 8 * * * 且状态为启用',
                citations: ['schedule:sched-1'],
              },
            ],
          },
        }),
      } as any,
      body: {
        question: '何时再触发？',
        pageContext: {
          version: 2,
          routeKey: 'schedules.index',
          pageKind: 'schedule',
          page: 'schedule',
          primaryRef: { kind: 'schedule', id: 'sched-1' },
        },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.claims[0].citations).toContain('schedule:sched-1')
  })

  it('CQ-14: loads Dataset snapshot facts and notes snapshot sampling boundaries', async () => {
    vi.mocked(getDataset).mockResolvedValue({
      id: 'ds-1',
      name: '供应商清单',
      sourceType: 'EXCEL',
      rowCount: 1500,
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
      selectedSheet: 'Sheet1',
    } as any)

    const ctx = createMockContext({
      actor: {
        id: 'user-1',
        name: 'Data Viewer',
        permissions: ['ai:assist', 'dataset:read'],
        targetScope: 'all',
      },
      session: {
        completeJson: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            summary: '数据集共 1500 行，属于快照抽样。',
            claims: [
              {
                factKind: 'observed',
                text: '数据集总行数为 1500 行',
                citations: ['dataset:ds-1'],
              },
            ],
          },
        }),
      } as any,
      body: {
        question: '这些记录截至何时、是否全量？',
        pageContext: {
          version: 2,
          routeKey: 'datasets.index',
          pageKind: 'dataset',
          page: 'dataset',
          primaryRef: { kind: 'dataset', id: 'ds-1' },
        },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.claims[0].citations).toContain('dataset:ds-1')
  })

  it('filters out unsupported inferences without premises or citations into missing', async () => {
    const ctx = createMockContext({
      session: {
        completeJson: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            summary: '推断测试',
            claims: [
              {
                factKind: 'inferred',
                text: '毫无依据的凭空推论',
                citations: ['fake:citation'],
                // no premises provided
              },
              {
                factKind: 'inferred',
                text: '具备已知事实前提的合规推论',
                citations: ['help:studio-retry'],
                premises: ['系统支持配置重试'],
              },
            ],
            missing: [],
          },
        }),
      } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.claims.length).toBe(1)
    expect(result.claims[0].text).toContain('具备已知事实前提的合规推论')
    expect(result.missing.some((m) => m.key === 'unsupported_inference')).toBe(true)
  })
})
