import { describe, expect, it, vi, beforeEach } from 'vitest'
import { handleKnowledgeAnswer } from './knowledge-answer.handler.js'
import type { AssistantCapabilityHandlerContext } from '../registry.js'

vi.mock('@cairn/db', () => ({
  authorizeTargetRequest: vi.fn().mockResolvedValue(undefined),
  getRun: vi.fn(),
  loadRunObservation: vi.fn(),
  getScenario: vi.fn(),
  getSessionDto: vi.fn(),
  getSchedule: vi.fn(),
  listScheduleOccurrences: vi.fn(async () => ({ items: [] })),
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
  authorizeTargetRequest,
  getRun,
  loadRunObservation,
  getScenario,
  getSessionDto,
  getSchedule,
  listScheduleOccurrences,
  getDataset,
} from '@cairn/db'

describe('handleKnowledgeAnswer (P0-B & Entity Boundaries CQ-03..CQ-14)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(authorizeTargetRequest).mockResolvedValue(undefined)
    vi.mocked(getRun).mockResolvedValue({ id: 'run-100' } as never)
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
              factKind: 'observed',
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
        permissions: ['ai:assist', 'target:read', 'session:read'],
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
        permissions: ['ai:assist', 'target:read', 'session:read'],
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

  it('CQ-13: loads Schedule & Occurrences facts, validates citations, and resolves skip reason nextActions', async () => {
    vi.mocked(getSchedule).mockResolvedValue({
      id: 'sched-1',
      scheduleId: 'sched-1',
      targetId: 'tgt-1',
      scenarioId: 'sc-1',
      name: '每日巡检',
      enabled: true,
      definition: { timezone: 'Asia/Shanghai' },
      nextDueAt: '2026-09-27T08:00:00.000Z',
    } as any)

    vi.mocked(listScheduleOccurrences).mockResolvedValue({
      items: [
        {
          occurrenceId: '11111111-1111-4111-8111-111111111111',
          scheduleId: 'sched-1',
          scheduleVersionId: 'v1',
          source: 'scheduled',
          localSlotKey: 'slot-1',
          occurrenceKey: null,
          localStartDate: '2026-09-27 08:00',
          windowStartUtc: null,
          windowEndUtc: null,
          startOffsetMinutes: null,
          endOffsetMinutes: null,
          timeRuleVersion: '1',
          admissionStatus: 'SKIPPED',
          reason: 'AUTH_PREPARATION_REQUIRED',
          jobId: null,
          createdAt: '2026-09-27T00:00:00.000Z',
          admittedAt: null,
        },
      ],
      nextCursor: undefined,
    } as any)

    const completeJsonMock = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        summary: '当前调度最近一次在 2026-09-27 08:00 被跳过，原因是目标系统认证尚未准备。',
        claims: [
          {
            factKind: 'observed',
            text: '调度在 08:00 准入状态为 SKIPPED，跳过原因为 AUTH_PREPARATION_REQUIRED',
            citations: ['occurrence:11111111-1111-4111-8111-111111111111'],
          },
        ],
      },
    })

    const ctx = createMockContext({
      actor: {
        id: 'user-1',
        name: 'Scheduler Admin',
        permissions: ['ai:assist', 'schedule:read'],
        targetScope: 'all',
      },
      session: {
        completeJson: completeJsonMock,
      } as any,
      body: {
        question: '这个调度昨晚为什么没跑？',
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
    // 验证 occurrence 引用通过白名单校验
    expect(result.claims[0].citations).toContain('occurrence:11111111-1111-4111-8111-111111111111')
    // 验证包含处置入口（去认证账号）与查看调度列表
    expect(result.nextActions?.some((a) => a.kind === 'target.accounts' && a.href === '/sessions/tgt-1')).toBe(true)
    expect(result.nextActions?.some((a) => a.kind === 'schedule.edit' && a.href === '/schedules')).toBe(true)

    // 验证 prompt user content 中包含了 occurrence 与汇总事实
    const callArgs = completeJsonMock.mock.calls[0]
    const userPromptContent = JSON.parse(callArgs[2][1].content)
    expect(userPromptContent.availableCitations).toContain('occurrence:11111111-1111-4111-8111-111111111111')
    expect(userPromptContent.contextFacts.some((f: any) => f.fact.includes('AUTH_PREPARATION_REQUIRED'))).toBe(true)
  })

  it('CQ-13: does not offer a skip action when the latest occurrence was admitted', async () => {
    vi.mocked(getSchedule).mockResolvedValue({
      id: 'sched-1',
      scheduleId: 'sched-1',
      targetId: 'tgt-1',
      name: '每日巡检',
      enabled: true,
      definition: { timezone: 'Asia/Shanghai' },
    } as any)

    vi.mocked(listScheduleOccurrences).mockResolvedValue({
      items: [
        {
          occurrenceId: '22222222-2222-4222-8222-222222222222',
          localStartDate: '2026-09-27 09:00',
          admissionStatus: 'ADMITTED',
          reason: null,
          runId: 'run-latest',
        },
        {
          occurrenceId: '11111111-1111-4111-8111-111111111111',
          localStartDate: '2026-09-27 08:00',
          admissionStatus: 'SKIPPED',
          reason: 'AUTH_PREPARATION_REQUIRED',
        },
      ],
      nextCursor: undefined,
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
            summary: '最近一次已准入。',
            claims: [
              {
                factKind: 'observed',
                text: '09:00 已准入',
                citations: ['occurrence:22222222-2222-4222-8222-222222222222'],
              },
            ],
          },
        }),
      } as any,
      body: {
        question: '这个调度昨晚为什么没跑？',
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
    expect(result.nextActions?.some((a) => a.kind === 'target.accounts')).toBe(false)
    expect(result.nextActions?.some((a) => a.kind === 'schedule.edit' && a.href === '/schedules')).toBe(true)
  })

  it('CQ-13: denies schedule facts when schedule:read permission is missing', async () => {
    const ctx = createMockContext({
      actor: {
        id: 'user-1',
        name: 'Guest User',
        permissions: ['ai:assist'], // No schedule:read
        targetScope: 'all',
      },
      body: {
        question: '为什么没跑？',
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
    expect(result.missing.some((m) => m.key === 'schedule' && m.reason === 'permission_denied')).toBe(true)
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

  it('模型失败时把目标实体事实标为系统观测，而非官方规则', async () => {
    const ctx = createMockContext({
      actor: {
        id: 'user-1',
        name: 'Target Viewer',
        permissions: ['ai:assist', 'target:read'],
        targetScope: 'all',
      },
      question: 'zzzzzz-no-help-match',
      body: {
        question: 'zzzzzz-no-help-match',
        pageContext: { page: 'target', targetId: 'tgt-1' },
      },
      session: { completeJson: vi.fn().mockResolvedValue({ ok: false, message: '模型暂不可用' }) } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ factKind: 'observed', citations: ['target:tgt-1'] }),
    ]))
    expect(result.claims.some((claim) => claim.factKind === 'human_confirmed')).toBe(false)
  })

  it('拒绝把实体观测伪装为官方规则或把帮助文档伪装为系统观测', async () => {
    const ctx = createMockContext({
      actor: {
        id: 'user-1',
        name: 'Target Viewer',
        permissions: ['ai:assist', 'target:read'],
        targetScope: 'all',
      },
      body: {
        question: '如何配置重试策略？',
        pageContext: { page: 'target', targetId: 'tgt-1' },
      },
      session: {
        completeJson: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            summary: '事实分类校验',
            claims: [
              { factKind: 'human_confirmed', text: '伪装的目标官方规则', citations: ['target:tgt-1'] },
              { factKind: 'observed', text: '伪装的系统观测', citations: ['help:studio-retry'] },
              { factKind: 'human_confirmed', text: '真实帮助规则', citations: ['help:studio-retry'] },
              { factKind: 'observed', text: '真实目标状态', citations: ['target:tgt-1'] },
            ],
          },
        }),
      } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.claims.map((claim) => claim.text)).toEqual(['真实帮助规则', '真实目标状态'])
    expect(result.missing.filter((item) => item.reason === 'citation_source_mismatch')).toHaveLength(2)
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

  it('CQ-06: 细粒度结构化事实解析：生成 step:<id>:selector, step:<id>:vars, step:<id>:flow 并支持在回答中精准引用', async () => {
    vi.mocked(getScenario).mockResolvedValue({
      id: 'sc-complex',
      name: '电商下单流程',
      targetId: 'tgt-1',
      steps: [
        {
          id: 'step-nav',
          name: '打开商品页',
          type: 'navigate',
          input: { url: 'https://example.com/items/1' },
          outputKey: 'itemUrl',
        },
        {
          id: 'step-decide',
          name: '检查库存状态',
          type: 'decide',
          input: { blockId: 'b-stock', condition: { kind: 'literal', value: true } },
        },
        {
          id: 'step-fill-qty',
          name: '填写购买数量',
          type: 'fill',
          input: {
            target: {
              candidates: [
                { by: 'role', value: 'spinbutton' },
                { by: 'css', value: 'input.quantity-field' },
              ],
              semantic: '商品详情页的购买数量输入框',
              framePath: [],
            },
            from: 'itemUrl',
          },
          outputKey: 'submittedQty',
        },
      ],
    } as any)

    const completeJsonMock = vi.fn().mockImplementation((name, schema, messages) => {
      const userPayload = JSON.parse(messages[1].content)
      expect(userPayload.availableCitations).toContain('step:step-fill-qty')
      expect(userPayload.availableCitations).toContain('step:step-fill-qty:selector')
      expect(userPayload.availableCitations).toContain('step:step-fill-qty:vars')
      expect(userPayload.availableCitations).toContain('step:step-fill-qty:flow')

      return Promise.resolve({
        ok: true,
        value: {
          summary: '填写购买数量步骤具有 CSS 选择器定位和变量依赖。',
          claims: [
            {
              factKind: 'observed',
              text: '定位包含 CSS 选择器 input.quantity-field',
              citations: ['step:step-fill-qty:selector'],
            },
            {
              factKind: 'observed',
              text: '引用了上游 itemUrl 变量，并将结果写入 submittedQty',
              citations: ['step:step-fill-qty:vars'],
            },
            {
              factKind: 'observed',
              text: '紧邻前置分支判定步骤 检查库存状态',
              citations: ['step:step-fill-qty:flow'],
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
        question: '这一步为什么这样写？它依赖哪个变量？定位是否稳健？',
        pageContext: {
          version: 2,
          routeKey: 'scenarios.$scenarioId',
          pageKind: 'studio',
          page: 'studio',
          scenarioId: 'sc-complex',
          stepId: 'step-fill-qty',
        },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.claims).toHaveLength(3)
    expect(result.claims.some((c) => c.citations.includes('step:step-fill-qty:selector'))).toBe(true)
    expect(result.claims.some((c) => c.citations.includes('step:step-fill-qty:vars'))).toBe(true)
    expect(result.claims.some((c) => c.citations.includes('step:step-fill-qty:flow'))).toBe(true)
  })

  it('CQ-06: 当选中的 stepId 在场景中不存在时，诚实登记 step_not_found 缺口', async () => {
    vi.mocked(getScenario).mockResolvedValue({
      id: 'sc-empty',
      name: '空场景',
      targetId: 'tgt-1',
      steps: [],
    } as any)

    const ctx = createMockContext({
      actor: {
        id: 'user-1',
        name: 'Workflow Author',
        permissions: ['ai:assist', 'workflow:read', 'target:read'],
        targetScope: 'all',
      },
      body: {
        question: '这个步骤做什么？',
        pageContext: {
          version: 2,
          routeKey: 'scenarios.$scenarioId',
          pageKind: 'studio',
          page: 'studio',
          scenarioId: 'sc-empty',
          stepId: 'missing-step-999',
        },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.missing.some((m) => m.key === 'step:missing-step-999' && m.reason === 'step_not_found')).toBe(true)
  })
})
