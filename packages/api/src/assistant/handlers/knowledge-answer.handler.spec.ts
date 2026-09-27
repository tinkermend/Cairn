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
  readAccountSessionCap: vi.fn(async () => ({ mode: 'exclusive', maxConcurrentSessions: 1, effectiveCap: 1 })),
  findLiveSessions: vi.fn(async () => []),
  listQueuedRunsForAccount: vi.fn(async () => []),
  getAccountSessionDetail: vi.fn(),
  listRuns: vi.fn(async () => ({ items: [], nextCursor: null })),
  loadRunFailureSummaries: vi.fn(async () => []),
  listIncidents: vi.fn(async () => ({ items: [], total: 0 })),
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
  readAccountSessionCap,
  findLiveSessions,
  listQueuedRunsForAccount,
  getAccountSessionDetail,
  listRuns,
  loadRunFailureSummaries,
  listIncidents,
} from '@cairn/db'

function shanghaiLocalDate(offsetDays: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
  const d = new Date(`${today}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

const SC_UUID = '5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c'
const TGT_UUID = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a'

describe('handleKnowledgeAnswer (P0-B & Entity Boundaries CQ-03..CQ-14)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(authorizeTargetRequest).mockResolvedValue(undefined)
    vi.mocked(getRun).mockResolvedValue({ id: 'run-100' } as never)
  })

  const createMockContext = (
    overrides?: Partial<AssistantCapabilityHandlerContext>,
  ): AssistantCapabilityHandlerContext => {
    const q = overrides?.question ?? overrides?.body?.question ?? '如何配置重试策略？'
    return {
      db: {} as any,
      actor: {
        id: 'user-1',
        name: 'Test User',
        permissions: ['ai:assist'],
        targetScope: 'all',
      },
      slots: {},
      question: q,
      body: {
        question: q,
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
        outcomeStatus: 'FAIL',
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
            outcomeStatus: 'FAIL',
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

  it('does not load run observation when the actor lacks run scope for the target', async () => {
    vi.mocked(getRun).mockRejectedValueOnce(new Error('RUN_NOT_FOUND'))
    const ctx = createMockContext({
      actor: {
        id: 'user-1',
        name: 'Scoped User',
        permissions: ['ai:assist', 'run:read', 'target:read'],
        targetScope: 'all',
      },
      body: {
        question: '这次运行发生了什么？',
        pageContext: {
          version: 2,
          routeKey: 'runs.$runId',
          pageKind: 'run',
          page: 'run',
          runId: 'run-out-of-scope',
        },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.missing).toContainEqual(expect.objectContaining({
      key: 'run',
      reason: 'access_denied_or_not_found',
    }))
    expect(loadRunObservation).not.toHaveBeenCalled()
  })

  it('does not load scenario or session facts after target-scoped permission is denied', async () => {
    const actor = {
      id: 'user-1', name: 'Scoped User',
      permissions: ['ai:assist', 'target:read', 'workflow:read', 'session:read'],
      targetScope: 'all',
    }
    vi.mocked(authorizeTargetRequest).mockRejectedValueOnce(new Error('TARGET_NOT_FOUND'))
    const scenario = await handleKnowledgeAnswer(createMockContext({
      actor,
      body: { question: '场景是什么？', pageContext: {
        version: 2, routeKey: 'scenarios.$scenarioId', pageKind: 'studio', page: 'studio', scenarioId: 'sc-denied',
      } },
    }))
    expect(getScenario).not.toHaveBeenCalled()
    expect(scenario.missing).toContainEqual(expect.objectContaining({ key: 'scenario', reason: 'access_denied_or_not_found' }))

    vi.mocked(authorizeTargetRequest).mockRejectedValueOnce(new Error('TARGET_NOT_FOUND'))
    const session = await handleKnowledgeAnswer(createMockContext({
      actor,
      body: { question: '会话是什么？', pageContext: {
        version: 2, routeKey: 'sessions.$targetId.$accountId', pageKind: 'session', page: 'session',
        primaryRef: { kind: 'session', id: 'sess-denied' },
      } },
    }))
    expect(getSessionDto).not.toHaveBeenCalled()
    expect(session.missing).toContainEqual(expect.objectContaining({ key: 'session', reason: 'access_denied_or_not_found' }))
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

  it('CQ-12: 会话租约占用排查 - 输出运行 ID、占用时长与 run.detail 处置入口', async () => {
    const runId = '00000000-0000-0000-0000-000000000999'
    vi.mocked(getSessionDto).mockResolvedValue({
      id: 'sess-888',
      targetId: 'tgt-1',
      targetAccountId: 'acc-admin',
      status: 'OPEN',
      health: 'HEALTHY',
      authState: 'AUTHENTICATED',
      ownerWorkerId: 'worker-w1',
      activeLease: {
        id: 'lease-1',
        purpose: 'EXECUTION',
        ownerKind: 'RUN',
        runId,
        holderWorkerId: 'worker-w1',
        acquiredAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    } as any)

    let capturedPayload: any = null
    const completeJsonMock = vi.fn().mockImplementation((name, schema, messages) => {
      capturedPayload = JSON.parse(messages[1].content)
      return Promise.resolve({
        ok: true,
        value: {
          summary: '会话被运行占用。',
          claims: [{ factKind: 'observed', text: '会话正被运行占用中', citations: [`run:${runId}`] }],
        },
      })
    })

    const ctx = createMockContext({
      actor: {
        id: 'user-1',
        name: 'Admin',
        permissions: ['ai:assist', 'target:read', 'session:read', 'run:read'],
        targetScope: 'all',
      },
      session: { completeJson: completeJsonMock } as any,
      body: {
        question: '这条会话被谁占用了？',
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
    const factsText = capturedPayload.contextFacts?.map((f: any) => f.fact).join('\n') ?? ''
    expect(capturedPayload.availableCitations).toContain(`run:${runId}`)
    expect(capturedPayload.availableCitations).toContain('session:sess-888')
    expect(factsText).toContain(`租约已被占用: Worker worker-w1，运行 ID ${runId}`)
    expect(factsText).toContain('已占用约 15 分钟')

    const runAction = result.nextActions?.find((a) => a.kind === 'run.detail')
    expect(runAction).toBeDefined()
    expect(runAction?.href).toBe(`/runs/${runId}`)
    expect(runAction?.citations).toContain(`run:${runId}`)
  })

  it('CQ-12: 会话认证失败排查 - 输出最近报错代码、人机可读释义与重试入口', async () => {
    vi.mocked(getSessionDto).mockResolvedValue({
      id: 'sess-888',
      targetId: 'tgt-1',
      targetAccountId: 'acc-admin',
      status: 'OPEN',
      health: 'DEGRADED',
      authState: 'STALE',
      ownerWorkerId: 'worker-w1',
      lastAuthError: 'LOGIN_PAGE_UNREACHABLE',
      lastAuthCheckedAt: '2026-09-27T10:00:00.000Z',
      lastAuthSuccessAt: '2026-09-26T10:00:00.000Z',
    } as any)

    let capturedPayload: any = null
    const completeJsonMock = vi.fn().mockImplementation((name, schema, messages) => {
      capturedPayload = JSON.parse(messages[1].content)
      return Promise.resolve({
        ok: true,
        value: {
          summary: '会话认证失败，登录页打不开。',
          claims: [{ factKind: 'observed', text: '登录页无法访问', citations: ['session:sess-888'] }],
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
        question: '为什么一直登录失效？',
        pageContext: {
          version: 2,
          routeKey: 'sessions.$targetId.$accountId',
          pageKind: 'session',
          page: 'session',
          primaryRef: { kind: 'session', id: 'sess-888' },
        },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    const factsText = capturedPayload.contextFacts?.map((f: any) => f.fact).join('\n') ?? ''
    expect(factsText).toContain('最近认证失败: 错误代码 LOGIN_PAGE_UNREACHABLE (目标登录页打不开)')
    expect(factsText).toContain('检查于 2026-09-27T10:00:00.000Z')
    expect(factsText).toContain('上次成功认证: 2026-09-26T10:00:00.000Z')

    const authAction = result.nextActions?.find((a) => a.kind === 'target.accounts')
    expect(authAction).toBeDefined()
    expect(authAction?.label).toBe('前往账号重新认证')
  })

  it('CQ-12: 会话并发上限与排队运行诊断 - 输出模式、配额及排队运行阻塞归因', async () => {
    const runQ1 = '11111111-1111-1111-1111-111111111111'
    const runQ2 = '22222222-2222-2222-2222-222222222222'

    vi.mocked(readAccountSessionCap).mockResolvedValueOnce({
      mode: 'exclusive',
      maxConcurrentSessions: 1,
      effectiveCap: 1,
    })
    vi.mocked(findLiveSessions).mockResolvedValueOnce([{ id: 'sess-888' } as any])
    vi.mocked(listQueuedRunsForAccount).mockResolvedValueOnce([
      { id: runQ1, status: 'QUEUED', createdAt: new Date() },
      { id: runQ2, status: 'QUEUED', createdAt: new Date() },
    ])
    vi.mocked(getSessionDto).mockResolvedValue({
      id: 'sess-888',
      targetId: 'tgt-1',
      targetAccountId: 'acc-admin',
      status: 'OPEN',
      health: 'HEALTHY',
      authState: 'AUTHENTICATED',
      ownerWorkerId: 'worker-w1',
      activeLease: {
        id: 'lease-1',
        purpose: 'EXECUTION',
        ownerKind: 'RUN',
        runId: '00000000-0000-0000-0000-000000000999',
        holderWorkerId: 'worker-w1',
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
      },
    } as any)

    let capturedPayload: any = null
    const completeJsonMock = vi.fn().mockImplementation((name, schema, messages) => {
      capturedPayload = JSON.parse(messages[1].content)
      return Promise.resolve({
        ok: true,
        value: {
          summary: '账号为独占模式，配额已满，排队中。',
          claims: [{ factKind: 'observed', text: '排队等待中', citations: [`run:${runQ1}`] }],
        },
      })
    })

    const ctx = createMockContext({
      actor: {
        id: 'user-1',
        name: 'Admin',
        permissions: ['ai:assist', 'target:read', 'session:read', 'run:read'],
        targetScope: 'all',
      },
      session: { completeJson: completeJsonMock } as any,
      body: {
        question: '为什么一直在等会话？',
        pageContext: {
          version: 2,
          routeKey: 'sessions.$targetId.$accountId',
          pageKind: 'session',
          page: 'session',
          primaryRef: { kind: 'session', id: 'sess-888' },
        },
      },
    })

    await handleKnowledgeAnswer(ctx)
    const factsText = capturedPayload.contextFacts?.map((f: any) => f.fact).join('\n') ?? ''
    expect(factsText).toContain('账号会话模式: exclusive (独占单活)，最大有效并发实例上限: 1，当前活跃会话数: 1')
    expect(factsText).toContain('排队等待运行: 该账号下有 2 条运行排队中')
    expect(factsText).toContain('可能原因（根据当前占用与认证状态推断）: 当前会话正被其他运行独占占用')
    expect(capturedPayload.availableCitations).toContain(`run:${runQ1}`)
    expect(capturedPayload.availableCitations).toContain(`run:${runQ2}`)
  })

  it('CQ-12: 账号无存活实例场景 - 回退基于账号级装配事实', async () => {
    const runWait = '33333333-3333-3333-3333-333333333333'
    vi.mocked(getAccountSessionDetail).mockResolvedValueOnce({
      targetId: 'tgt-1',
      targetName: '仿真电商',
      targetAccountId: 'acc-empty',
      accountDisplayName: '空实例账号',
      accountUsername: 'empty_user',
      accountStatus: 'active',
      hasPassword: true,
      expectedIdentity: null,
      authCapability: 'INTERACTIVE_ONLY',
      lastAuthError: 'credential',
      status: 'needs_login',
      retained: false,
      session: null,
      instances: [],
      liveCount: 0,
      effectiveCap: 1,
      occupancy: null,
      retention: null,
      currentOperation: null,
      actions: ['LOGIN'],
      asOf: new Date().toISOString(),
    })
    vi.mocked(listQueuedRunsForAccount).mockResolvedValueOnce([
      { id: runWait, status: 'QUEUED', createdAt: new Date() },
    ])

    let capturedPayload: any = null
    const completeJsonMock = vi.fn().mockImplementation((name, schema, messages) => {
      capturedPayload = JSON.parse(messages[1].content)
      return Promise.resolve({
        ok: true,
        value: {
          summary: '当前账号无活跃会话，需要先登录。',
          claims: [{ factKind: 'observed', text: '需要登录', citations: ['target:tgt-1'] }],
        },
      })
    })

    const ctx = createMockContext({
      actor: {
        id: 'user-1',
        name: 'Admin',
        permissions: ['ai:assist', 'target:read', 'session:read', 'run:read'],
        targetScope: 'all',
      },
      session: { completeJson: completeJsonMock } as any,
      body: {
        question: '为什么这个账号开跑一直在等会话？',
        pageContext: {
          version: 2,
          routeKey: 'sessions.$targetId.$accountId',
          pageKind: 'session',
          page: 'session',
          targetId: 'tgt-1',
          scopeRefs: [
            { kind: 'target', id: 'tgt-1' },
            { kind: 'account', id: 'acc-empty' },
          ],
        },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    const factsText = capturedPayload.contextFacts?.map((f: any) => `${f.label}: ${f.fact}`).join('\n') ?? ''
    expect(factsText).toContain('账号会话事实 (空实例账号)')
    expect(factsText).toContain('最近认证失败: 错误代码 credential (账号或密码未通过核验)')
    expect(factsText).toContain('排队运行: 该账号当前有 1 条运行处于排队中')
    expect(factsText).toContain('可能原因（根据实例数与认证状态推断）: 账号最近认证失败，会话尚未就绪')
    expect(factsText).not.toContain('账号尚无活跃就绪的会话实例')
    expect(result.nextActions?.some((a) => a.href?.includes('/sessions/tgt-1/acc-empty'))).toBe(true)
  })

  it('CQ-12: 零信任权限隔离 - 缺少 run:read 时不泄露排队运行引用与 run.detail 处置', async () => {
    const runId = '00000000-0000-0000-0000-000000000999'
    vi.mocked(getSessionDto).mockResolvedValue({
      id: 'sess-888',
      targetId: 'tgt-1',
      targetAccountId: 'acc-admin',
      status: 'OPEN',
      health: 'HEALTHY',
      authState: 'AUTHENTICATED',
      ownerWorkerId: 'worker-w1',
      activeLease: {
        id: 'lease-1',
        purpose: 'EXECUTION',
        ownerKind: 'RUN',
        runId,
        holderWorkerId: 'worker-w1',
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
      },
    } as any)

    let capturedPayload: any = null
    const completeJsonMock = vi.fn().mockImplementation((name, schema, messages) => {
      capturedPayload = JSON.parse(messages[1].content)
      return Promise.resolve({
        ok: true,
        value: {
          summary: '会话被占用。',
          claims: [{ factKind: 'observed', text: '会话被占用', citations: ['session:sess-888'] }],
        },
      })
    })

    // 用户缺少 run:read
    const ctx = createMockContext({
      actor: {
        id: 'user-1',
        name: 'Admin',
        permissions: ['ai:assist', 'target:read', 'session:read'],
        targetScope: 'all',
      },
      session: { completeJson: completeJsonMock } as any,
      body: {
        question: '会话状态？',
        pageContext: {
          version: 2,
          routeKey: 'sessions.$targetId.$accountId',
          pageKind: 'session',
          page: 'session',
          primaryRef: { kind: 'session', id: 'sess-888' },
        },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(capturedPayload.availableCitations).not.toContain(`run:${runId}`)
    expect(result.nextActions?.some((a) => a.kind === 'run.detail')).toBe(false)
  })


  it('CQ-13: loads Schedule & Occurrences facts, validates citations, and resolves skip reason nextActions', async () => {
    const yesterday = shanghaiLocalDate(-1)
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
          localStartDate: yesterday,
          windowStartUtc: `${yesterday}T00:00:00.000Z`,
          windowEndUtc: `${yesterday}T01:00:00.000Z`,
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
    // 触发记录带出调度时区下的具体时刻，统计按「昨天」范围
    expect(userPromptContent.contextFacts.some((f: any) => f.fact.includes('应触发时刻:') && f.fact.includes('08:00') && f.fact.includes('(Asia/Shanghai)'))).toBe(true)
    expect(userPromptContent.contextFacts.some((f: any) => f.fact.includes(`昨天（${yesterday} 至 ${yesterday}`) && f.fact.includes('已跳过 1 次'))).toBe(true)
  })

  it('CQ-13: 按问题时间范围筛选触发记录，范围外记录不作为事实', async () => {
    const today = shanghaiLocalDate(0)
    const threeDaysAgo = shanghaiLocalDate(-3)
    vi.mocked(getSchedule).mockResolvedValue({
      scheduleId: 'sched-2',
      targetId: 'tgt-1',
      name: '高频巡检',
      enabled: true,
      definition: { timezone: 'Asia/Shanghai' },
    } as any)
    const base = {
      scheduleId: 'sched-2', scheduleVersionId: 'v1', source: 'scheduled', localSlotKey: 'slot', occurrenceKey: null,
      windowEndUtc: null, startOffsetMinutes: null, endOffsetMinutes: null, timeRuleVersion: '1', jobId: null, admittedAt: null,
    }
    vi.mocked(listScheduleOccurrences).mockResolvedValue({
      items: [
        { ...base, occurrenceId: '21111111-1111-4111-8111-111111111111', localStartDate: today, windowStartUtc: `${today}T02:00:00.000Z`, admissionStatus: 'ADMITTED', reason: null, createdAt: `${today}T02:00:00.000Z` },
        { ...base, occurrenceId: '31111111-1111-4111-8111-111111111111', localStartDate: threeDaysAgo, windowStartUtc: null, admissionStatus: 'SKIPPED', reason: 'WORKER_UNAVAILABLE', createdAt: `${threeDaysAgo}T02:00:00.000Z` },
      ],
      nextCursor: 'more',
    } as any)
    let captured: any = null
    const ctx = createMockContext({
      actor: { id: 'user-1', name: 'Scheduler Admin', permissions: ['ai:assist', 'schedule:read'], targetScope: 'all' },
      session: {
        completeJson: vi.fn().mockImplementation((_n: string, _s: unknown, messages: any[]) => {
          captured = JSON.parse(messages[1].content)
          return Promise.resolve({ ok: true, value: { summary: 'ok', claims: [] } })
        }),
      } as any,
      body: {
        question: '今天这个调度跑了吗？',
        pageContext: { version: 2, routeKey: 'schedules', pageKind: 'schedule', page: 'schedule', primaryRef: { kind: 'schedule', id: 'sched-2' } },
      },
    })
    await handleKnowledgeAnswer(ctx)
    expect(listScheduleOccurrences).toHaveBeenCalledWith(expect.anything(), 'sched-2', { limit: 60 })
    expect(captured.availableCitations).toContain('occurrence:21111111-1111-4111-8111-111111111111')
    expect(captured.availableCitations).not.toContain('occurrence:31111111-1111-4111-8111-111111111111')
    const summary = captured.contextFacts.find((f: any) => f.label === '调度触发汇总统计')
    expect(summary.fact).toContain(`今天（${today} 至 ${today}`)
    expect(summary.fact).toContain('已准入 1 次')
    // 读到的最早一条已早于范围起点，范围内没有遗漏，不应提示截断
    expect(summary.fact).not.toContain('可能还有更早的记录')
  })

  it('CQ-13: 未指定时间范围且还有更早记录时，注明只分析了最近 20 次', async () => {
    const today = shanghaiLocalDate(0)
    vi.mocked(getSchedule).mockResolvedValue({
      scheduleId: 'sched-3', targetId: 'tgt-1', name: '巡检', enabled: true, definition: { timezone: 'Asia/Shanghai' },
    } as any)
    vi.mocked(listScheduleOccurrences).mockResolvedValue({
      items: [{
        occurrenceId: '41111111-1111-4111-8111-111111111111', scheduleId: 'sched-3', scheduleVersionId: 'v1', source: 'manual',
        localSlotKey: 'manual', occurrenceKey: null, localStartDate: today, windowStartUtc: null, windowEndUtc: null,
        startOffsetMinutes: null, endOffsetMinutes: null, timeRuleVersion: '1', admissionStatus: 'ADMITTED', reason: null,
        jobId: null, createdAt: `${today}T02:00:00.000Z`, admittedAt: null,
      }],
      nextCursor: 'more',
    } as any)
    let captured: any = null
    const ctx = createMockContext({
      actor: { id: 'user-1', name: 'Scheduler Admin', permissions: ['ai:assist', 'schedule:read'], targetScope: 'all' },
      session: {
        completeJson: vi.fn().mockImplementation((_n: string, _s: unknown, messages: any[]) => {
          captured = JSON.parse(messages[1].content)
          return Promise.resolve({ ok: true, value: { summary: 'ok', claims: [] } })
        }),
      } as any,
      body: {
        question: '这个调度最近情况怎么样？',
        pageContext: { version: 2, routeKey: 'schedules', pageKind: 'schedule', page: 'schedule', primaryRef: { kind: 'schedule', id: 'sched-3' } },
      },
    })
    await handleKnowledgeAnswer(ctx)
    expect(listScheduleOccurrences).toHaveBeenCalledWith(expect.anything(), 'sched-3', { limit: 20 })
    const summary = captured.contextFacts.find((f: any) => f.label === '调度触发汇总统计')
    expect(summary.fact).toContain('仅分析最近 20 次触发')
    const occ = captured.contextFacts.find((f: any) => f.citation === 'occurrence:41111111-1111-4111-8111-111111111111')
    expect(occ.fact).toContain('（未记录具体时刻）')
    expect(occ.fact).toContain('来源: 手动触发')
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

  describe('CQ-16: 运行失败归并与可靠性背景融合 (Run Failure Digest & Reliability Incidents)', () => {
    it('现场确定性聚类：将同一步骤同一报错的 3 次失败与另一报错的 1 次失败归并为 2 组，并注册引用与处置入口', async () => {
      const mockRuns = [
        {
          id: '11111111-1111-1111-1111-111111111111',
          scenarioId: 'sc-1',
          scenarioName: '订单创建',
          targetId: 'tgt-1',
          status: 'FAILED',
          createdAt: '2026-09-27T10:00:00.000Z',
        },
        {
          id: '22222222-2222-2222-2222-222222222222',
          scenarioId: 'sc-1',
          scenarioName: '订单创建',
          targetId: 'tgt-1',
          status: 'FAILED',
          createdAt: '2026-09-27T10:05:00.000Z',
        },
        {
          id: '33333333-3333-3333-3333-333333333333',
          scenarioId: 'sc-1',
          scenarioName: '订单创建',
          targetId: 'tgt-1',
          status: 'FAILED',
          createdAt: '2026-09-27T10:10:00.000Z',
        },
        {
          id: '44444444-4444-4444-4444-444444444444',
          scenarioId: 'sc-1',
          scenarioName: '订单创建',
          targetId: 'tgt-1',
          status: 'FAILED',
          createdAt: '2026-09-27T10:15:00.000Z',
        },
      ]

      const mockSummaries = [
        {
          runId: '11111111-1111-1111-1111-111111111111',
          stepName: '填写地址',
          errorCode: 'TIMEOUT_WAITING_FOR_SELECTOR',
          finishedAt: '2026-09-27T10:00:10.000Z',
        },
        {
          runId: '22222222-2222-2222-2222-222222222222',
          stepName: '填写地址',
          errorCode: 'TIMEOUT_WAITING_FOR_SELECTOR',
          finishedAt: '2026-09-27T10:05:10.000Z',
        },
        {
          runId: '33333333-3333-3333-3333-333333333333',
          stepName: '填写地址',
          errorCode: 'TIMEOUT_WAITING_FOR_SELECTOR',
          finishedAt: '2026-09-27T10:10:10.000Z',
        },
        {
          runId: '44444444-4444-4444-4444-444444444444',
          stepName: '提交订单',
          errorCode: 'BUTTON_NOT_INTERACTABLE',
          finishedAt: '2026-09-27T10:15:10.000Z',
        },
      ]

      vi.mocked(listRuns).mockResolvedValue({ items: mockRuns as any, nextCursor: null })
      vi.mocked(loadRunFailureSummaries).mockResolvedValue(mockSummaries as any)

      let capturedPayload: any = null
      const completeJsonMock = vi.fn().mockImplementation((name, schema, messages) => {
        capturedPayload = JSON.parse(messages[1].content)
        return Promise.resolve({
          ok: true,
          value: {
            summary: '经分析，这 4 次失败主要归并在 2 个原因。其中 3 次发生在填写地址步骤的超时，1 次发生在提交订单步骤。',
            claims: [
              {
                factKind: 'observed',
                text: '填写地址步骤因 TIMEOUT_WAITING_FOR_SELECTOR 失败 3 次',
                citations: ['run:11111111-1111-1111-1111-111111111111'],
              },
              {
                factKind: 'observed',
                text: '提交订单步骤因 BUTTON_NOT_INTERACTABLE 失败 1 次',
                citations: ['run:44444444-4444-4444-4444-444444444444'],
              },
            ],
          },
        })
      })

      const ctx = createMockContext({
        actor: {
          id: 'user-1',
          name: 'Ops',
          permissions: ['ai:assist', 'run:read'],
          targetScope: 'all',
        },
        session: { completeJson: completeJsonMock } as any,
        body: {
          question: '请帮我分析当前筛选出的这些失败运行，它们是同一个原因导致的吗？',
          pageContext: {
            version: 2,
            routeKey: 'runs',
            pageKind: 'run',
            page: 'run',
            view: {
              filters: {
                status: 'FAILED',
              },
            },
          },
        },
      })

      const result = await handleKnowledgeAnswer(ctx)

      expect(listRuns).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: 'FAILED', limit: 50 }),
        'user-1',
      )
      expect(loadRunFailureSummaries).toHaveBeenCalledWith(expect.anything(), [
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
        '44444444-4444-4444-4444-444444444444',
      ])

      // 验证上下文事实
      expect(capturedPayload).not.toBeNull()
      const contextFacts = capturedPayload.contextFacts
      expect(contextFacts.some((f: any) => f.label.includes('总览') && f.fact.includes('4 条失败运行记录') && f.fact.includes('分组为 2 组'))).toBe(true)
      expect(contextFacts.some((f: any) => f.label.includes('填写地址 (3次)') && f.fact.includes('TIMEOUT_WAITING_FOR_SELECTOR'))).toBe(true)
      expect(contextFacts.some((f: any) => f.label.includes('提交订单 (1次)') && f.fact.includes('BUTTON_NOT_INTERACTABLE'))).toBe(true)

      // 验证引用键
      expect(capturedPayload.availableCitations).toContain('run:11111111-1111-1111-1111-111111111111')
      expect(capturedPayload.availableCitations).toContain('run:44444444-4444-4444-4444-444444444444')

      // 验证处置动作
      expect(result.nextActions).toBeDefined()
      expect(result.nextActions?.some((a) => a.kind === 'run.detail' && a.href === '/runs/11111111-1111-1111-1111-111111111111')).toBe(true)
      expect(result.nextActions?.some((a) => a.kind === 'run.detail' && a.href === '/runs/44444444-4444-4444-4444-444444444444')).toBe(true)
      expect(result.claims).toHaveLength(2)
    })

    it('可靠性背景关联：具备 reliability:read 权限且存在活跃事件时生成 incident 引用与处置入口', async () => {
      const mockRuns = [
        {
          id: '11111111-1111-1111-1111-111111111111',
          scenarioId: 'sc-1',
          scenarioName: '订单创建',
          targetId: 'tgt-11111111-1111-1111-1111-111111111111',
          status: 'FAILED',
          createdAt: '2026-09-27T10:00:00.000Z',
        },
      ]
      const mockSummaries = [
        {
          runId: '11111111-1111-1111-1111-111111111111',
          stepName: '填写地址',
          errorCode: 'TIMEOUT_WAITING_FOR_SELECTOR',
        },
      ]
      const mockIncidents = [
        {
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          targetId: 'tgt-11111111-1111-1111-1111-111111111111',
          title: 'ERP 接口响应延迟突增',
          summary: 'EWMA 成功率跌破 80%',
          severity: 'HIGH',
          status: 'ACTION_REQUIRED',
          lastSeenAt: '2026-09-27T10:00:00.000Z',
        },
      ]

      vi.mocked(listRuns).mockResolvedValue({ items: mockRuns as any, nextCursor: null })
      vi.mocked(loadRunFailureSummaries).mockResolvedValue(mockSummaries as any)
      vi.mocked(listIncidents).mockResolvedValue({ items: mockIncidents as any, total: 1 })

      let capturedPayload: any = null
      const completeJsonMock = vi.fn().mockImplementation((name, schema, messages) => {
        capturedPayload = JSON.parse(messages[1].content)
        return Promise.resolve({
          ok: true,
          value: {
            summary: '当前失败与目标系统 ERP 接口延迟突增事件高度吻合。',
            claims: [
              {
                factKind: 'observed',
                text: '关联目标系统存在活跃可靠性事件 ERP 接口响应延迟突增',
                citations: ['incident:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
              },
            ],
          },
        })
      })

      const ctx = createMockContext({
        actor: {
          id: 'user-1',
          name: 'Ops',
          permissions: ['ai:assist', 'run:read', 'reliability:read'],
          targetScope: 'all',
        },
        session: { completeJson: completeJsonMock } as any,
        body: {
          question: '这些失败是同一个原因吗？',
          pageContext: {
            version: 2,
            routeKey: 'runs',
            pageKind: 'run',
            page: 'run',
          },
        },
      })

      const result = await handleKnowledgeAnswer(ctx)

      expect(listIncidents).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ targetId: 'tgt-11111111-1111-1111-1111-111111111111' }),
        'user-1',
      )

      expect(capturedPayload.availableCitations).toContain('incident:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
      expect(result.nextActions?.some((a) => a.kind === 'incident.detail' && a.href === '/maintenance/incidents/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe(true)
      expect(result.claims[0].citations).toContain('incident:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    })

    it('权限隔离：缺少 run:read 权限时拒绝读取运行数据，记录 permission_denied', async () => {
      const ctx = createMockContext({
        actor: {
          id: 'user-1',
          name: 'NoRunPermission',
          permissions: ['ai:assist'], // 无 run:read
          targetScope: 'all',
        },
        body: {
          question: '请帮我分析当前筛选出的这些失败运行，它们是同一个原因导致的吗？',
          pageContext: {
            version: 2,
            routeKey: 'runs',
            pageKind: 'run',
            page: 'run',
          },
        },
      })

      const result = await handleKnowledgeAnswer(ctx)
      expect(listRuns).not.toHaveBeenCalled()
      expect(loadRunFailureSummaries).not.toHaveBeenCalled()
      expect(result.missing.some((m) => m.key === 'runs' && m.reason === 'permission_denied')).toBe(true)
    })

    it('权限隔离：缺少 reliability:read 权限时正常归并失败，安全记录 reliability_incidents 缺口', async () => {
      const mockRuns = [
        {
          id: '11111111-1111-1111-1111-111111111111',
          scenarioId: 'sc-1',
          scenarioName: '订单创建',
          targetId: 'tgt-1',
          status: 'FAILED',
          createdAt: '2026-09-27T10:00:00.000Z',
        },
      ]
      vi.mocked(listRuns).mockResolvedValue({ items: mockRuns as any, nextCursor: null })
      vi.mocked(loadRunFailureSummaries).mockResolvedValue([
        { runId: '11111111-1111-1111-1111-111111111111', stepName: '填写地址', errorCode: 'TIMEOUT' },
      ] as any)

      const completeJsonMock = vi.fn().mockResolvedValue({
        ok: true,
        value: {
          summary: '经分析，失败主要由超时导致。',
          claims: [
            {
              factKind: 'observed',
              text: '填写地址步骤因 TIMEOUT 失败',
              citations: ['run:11111111-1111-1111-1111-111111111111'],
            },
          ],
        },
      })

      const ctx = createMockContext({
        actor: {
          id: 'user-1',
          name: 'OpsWithoutReliability',
          permissions: ['ai:assist', 'run:read'], // 无 reliability:read
          targetScope: 'all',
        },
        session: { completeJson: completeJsonMock } as any,
        body: {
          question: '这些失败是同一个原因吗？',
          pageContext: {
            version: 2,
            routeKey: 'runs',
            pageKind: 'run',
            page: 'run',
          },
        },
      })

      const result = await handleKnowledgeAnswer(ctx)
      expect(listIncidents).not.toHaveBeenCalled()
      expect(result.missing.some((m) => m.key === 'reliability_incidents' && m.reason === 'permission_denied')).toBe(true)
      expect(result.claims.length).toBeGreaterThan(0)
    })

    it('感知一致性：运行列表筛选条件经列表查询 schema 校验后原样传递（含试跑、业务结果，丢弃未知字段）', async () => {
      vi.mocked(listRuns).mockResolvedValue({ items: [], nextCursor: null })

      const ctx = createMockContext({
        actor: {
          id: 'user-1',
          name: 'Ops',
          permissions: ['ai:assist', 'run:read'],
          targetScope: 'all',
        },
        body: {
          question: '请帮我分析当前筛选出的这些失败运行，它们是同一个原因导致的吗？',
          pageContext: {
            version: 2,
            routeKey: 'runs',
            pageKind: 'run',
            page: 'run',
            view: {
              filters: {
                status: 'FAILED',
                scenarioId: SC_UUID,
                targetId: TGT_UUID,
                from: '2026-09-01T00:00:00.000Z',
                to: '2026-09-27T00:00:00.000Z',
                sourceKind: 'console',
                isTrial: true,
                outcomeStatus: 'FAIL',
                unknownKey: 'ignored',
              },
            },
          },
        },
      })

      const result = await handleKnowledgeAnswer(ctx)
      expect(listRuns).toHaveBeenCalledWith(
        expect.anything(),
        {
          status: 'FAILED',
          limit: 50,
          scenarioId: SC_UUID,
          targetId: TGT_UUID,
          from: '2026-09-01T00:00:00.000Z',
          to: '2026-09-27T00:00:00.000Z',
          sourceKind: 'console',
          isTrial: true,
          outcomeStatus: 'FAIL',
        },
        'user-1',
      )
      expect(result.missing.some((m) => m.key === 'runs' && m.reason === 'no_failed_runs')).toBe(true)
    })

    it('场景编排全局排查：Studio 提问为什么老失败时自动限定当前 scenarioId 与 7 天范围', async () => {
      vi.mocked(listRuns).mockResolvedValue({ items: [], nextCursor: null })

      const ctx = createMockContext({
        actor: {
          id: 'user-1',
          name: 'Author',
          permissions: ['ai:assist', 'run:read', 'workflow:read', 'target:read'],
          targetScope: 'all',
        },
        body: {
          question: '请帮我分析当前场景最近 7 天内的失败运行记录，归纳主要失败原因。',
          pageContext: {
            version: 2,
            routeKey: 'scenarios.$scenarioId',
            pageKind: 'studio',
            page: 'studio',
            scenarioId: SC_UUID,
          },
        },
      })

      await handleKnowledgeAnswer(ctx)
      expect(listRuns).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: 'FAILED',
          limit: 50,
          scenarioId: SC_UUID,
          from: expect.any(String),
        }),
        'user-1',
      )
    })

    it('截断保护：当失败运行达到 50 条时事实明确标注文案', async () => {
      const fiftyRuns = Array.from({ length: 50 }, (_, i) => ({
        id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
        scenarioId: 'sc-1',
        scenarioName: '高频任务',
        targetId: 'tgt-1',
        status: 'FAILED',
        createdAt: '2026-09-27T10:00:00.000Z',
      }))
      const fiftySummaries = fiftyRuns.map((r) => ({
        runId: r.id,
        stepName: '步骤1',
        errorCode: 'ERR_TIMEOUT',
      }))

      vi.mocked(listRuns).mockResolvedValue({ items: fiftyRuns as any, nextCursor: null })
      vi.mocked(loadRunFailureSummaries).mockResolvedValue(fiftySummaries as any)

      let capturedPayload: any = null
      const completeJsonMock = vi.fn().mockImplementation((name, schema, messages) => {
        capturedPayload = JSON.parse(messages[1].content)
        return Promise.resolve({
          ok: true,
          value: {
            summary: '仅分析最近 50 次失败，全为 ERR_TIMEOUT。',
            claims: [
              {
                factKind: 'observed',
                text: '分析了最近 50 条失败记录',
                citations: [`run:${fiftyRuns[0].id}`],
              },
            ],
          },
        })
      })

      const ctx = createMockContext({
        actor: {
          id: 'user-1',
          name: 'Ops',
          permissions: ['ai:assist', 'run:read'],
          targetScope: 'all',
        },
        session: { completeJson: completeJsonMock } as any,
        body: {
          question: '这些失败是同一个原因吗？',
          pageContext: {
            version: 2,
            routeKey: 'runs',
            pageKind: 'run',
            page: 'run',
          },
        },
      })

      await handleKnowledgeAnswer(ctx)
      expect(capturedPayload).not.toBeNull()
      const totalFact = capturedPayload.contextFacts.find((f: any) => f.label.includes('总览'))
      expect(totalFact.fact).toContain('已达单批上限 50 条，仅分析最近 50 次失败')
    })

    it('触发范围：运行详情页问「为什么失败」不做跨运行归并', async () => {
      const ctx = createMockContext({
        actor: { id: 'user-1', name: 'Ops', permissions: ['ai:assist', 'run:read'], targetScope: 'all' },
        body: {
          question: '这次运行为什么失败？',
          pageContext: {
            version: 2,
            routeKey: 'runs.$runId',
            pageKind: 'run',
            page: 'run',
            runId: '99999999-9999-4999-8999-999999999999',
            scenarioId: SC_UUID,
          },
        },
      })
      await handleKnowledgeAnswer(ctx)
      expect(listRuns).not.toHaveBeenCalled()
    })

    it('触发范围：Studio 已选中步骤时不做跨运行归并', async () => {
      const ctx = createMockContext({
        actor: { id: 'user-1', name: 'Author', permissions: ['ai:assist', 'run:read', 'workflow:read'], targetScope: 'all' },
        body: {
          question: '这一步为什么老失败？',
          pageContext: {
            version: 2,
            routeKey: 'scenarios.$scenarioId',
            pageKind: 'studio',
            page: 'studio',
            scenarioId: SC_UUID,
            stepId: 'step-1',
          },
        },
      })
      await handleKnowledgeAnswer(ctx)
      expect(listRuns).not.toHaveBeenCalled()
    })

    it('筛选校验：状态筛选不是失败时不做归并并登记缺口', async () => {
      const ctx = createMockContext({
        actor: { id: 'user-1', name: 'Ops', permissions: ['ai:assist', 'run:read'], targetScope: 'all' },
        body: {
          question: '这些失败是同一个原因吗？',
          pageContext: { version: 2, routeKey: 'runs', pageKind: 'run', page: 'run', view: { filters: { status: 'SUCCEEDED' } } },
        },
      })
      const result = await handleKnowledgeAnswer(ctx)
      expect(listRuns).not.toHaveBeenCalled()
      expect(result.missing.some((m) => m.key === 'run_filters' && m.reason === 'status_not_failed')).toBe(true)
    })

    it('筛选校验：筛选条件非法时不做归并并登记缺口，不猜测范围', async () => {
      const ctx = createMockContext({
        actor: { id: 'user-1', name: 'Ops', permissions: ['ai:assist', 'run:read'], targetScope: 'all' },
        body: {
          question: '这些失败是同一个原因吗？',
          pageContext: { version: 2, routeKey: 'runs', pageKind: 'run', page: 'run', view: { filters: { scenarioId: 'not-a-uuid' } } },
        },
      })
      const result = await handleKnowledgeAnswer(ctx)
      expect(listRuns).not.toHaveBeenCalled()
      expect(result.missing.some((m) => m.key === 'run_filters' && m.reason === 'invalid_filters')).toBe(true)
    })

    it('可靠性事件：查询时只取未关闭状态，处置入口首位保留代表性失败运行', async () => {
      const runIdA = '11111111-1111-4111-8111-111111111111'
      vi.mocked(listRuns).mockResolvedValue({
        items: [{ id: runIdA, scenarioId: SC_UUID, scenarioName: '订单创建', targetId: TGT_UUID, status: 'FAILED', createdAt: '2026-09-27T10:00:00.000Z' }] as any,
        nextCursor: null,
      })
      vi.mocked(loadRunFailureSummaries).mockResolvedValue([
        { runId: runIdA, stepName: '填写地址', errorCode: 'LOCATOR_NOT_FOUND', errorSafeMessage: '未找到地址输入框' },
      ] as any)
      vi.mocked(listIncidents).mockResolvedValue({
        items: [
          { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', targetId: TGT_UUID, title: 'A', summary: 's', severity: 'P2', status: 'DETECTED', lastSeenAt: '2026-09-27T10:00:00.000Z' },
          { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', targetId: TGT_UUID, title: 'B', summary: 's', severity: 'P2', status: 'OBSERVING', lastSeenAt: '2026-09-27T10:00:00.000Z' },
        ] as any,
        total: 2,
      })
      let captured: any = null
      const ctx = createMockContext({
        actor: { id: 'user-1', name: 'Ops', permissions: ['ai:assist', 'run:read', 'reliability:read'], targetScope: 'all' },
        session: {
          completeJson: vi.fn().mockImplementation((_n: string, _s: unknown, messages: any[]) => {
            captured = JSON.parse(messages[1].content)
            return Promise.resolve({ ok: true, value: { summary: 'ok', claims: [] } })
          }),
        } as any,
        body: {
          question: '这些失败是同一个原因吗？',
          pageContext: { version: 2, routeKey: 'runs', pageKind: 'run', page: 'run', view: { filters: { status: 'FAILED' } } },
        },
      })
      const result = await handleKnowledgeAnswer(ctx)
      expect(listIncidents).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          targetId: TGT_UUID,
          statuses: ['DETECTED', 'DIAGNOSING', 'ACTION_REQUIRED', 'VERIFYING', 'OBSERVING'],
        }),
        'user-1',
      )
      expect(result.nextActions?.[0]).toMatchObject({ kind: 'run.detail', href: `/runs/${runIdA}` })
      expect(result.nextActions?.[1]).toMatchObject({ kind: 'incident.detail' })
      expect(captured.contextFacts.some((f: any) => f.fact.includes('错误说明示例: 未找到地址输入框'))).toBe(true)
    })
  })
})
