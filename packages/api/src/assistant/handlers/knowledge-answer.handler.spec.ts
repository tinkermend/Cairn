import { describe, expect, it, vi, beforeEach } from 'vitest'
import { FACTORY_PLATFORM_CONFIG, assistantResultSchema } from '@cairn/shared'
import { handleKnowledgeAnswer } from './knowledge-answer.handler.js'
import type { AssistantCapabilityHandlerContext } from '../registry.js'

vi.mock('@cairn/db', () => ({
  authorizeTargetRequest: vi.fn().mockResolvedValue(undefined),
  assertTargetPermission: vi.fn().mockResolvedValue(undefined),
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
  listAccountSessionOverview: vi.fn(),
  loadAccountAuthDisplay: vi.fn(async () => new Map()),
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
  listAccountSessionOverview,
  loadAccountAuthDisplay,
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
const OTHER_TGT_UUID = '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b'
const ACCOUNT_UUID = '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b'
const RETRY_HELP_QUOTE = '在「场景」打开场景工作区，选中要调整的步骤，在右侧步骤检查器展开「执行与容错策略」，填写「重试上限（0~10 次）」；0 表示不自动重试。'
const UNSAVED_HELP_QUOTE = '草稿未保存时仅在画布生效，保存后方可作为发布版本或试跑输入。'

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
            summary: '在场景工作区右侧步骤检查器的执行与容错策略中设置重试上限。',
            claims: [
              {
                factKind: 'human_confirmed',
                text: '选中步骤后，在执行与容错策略中设置 retryLimit 重试上限',
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

  it('从字段契约直接回答选填与平台默认，不让模型编造固定超时', async () => {
    const question = '目标系统配置里的登录页停留超时是选填吗？不填会怎样？'
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read'] } as never,
      slots: { targetId: TGT_UUID }, question,
      body: { question, pageContext: { page: 'target', targetId: TGT_UUID } },
    })
    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toContain('留空使用当前平台配置')
    expect(result.summary).toContain('创建时选填')
    expect(result.claims[0]?.citations).toEqual(['help:target-config-loginLeaveTimeoutSeconds'])
    expect(ctx.session!.completeJson).not.toHaveBeenCalled()
    expect(ctx.slots).not.toHaveProperty('targetId')
  })

  it('场景页实际运行问法区分执行成功与业务结果，并绑定具体运行供历史授权复核', async () => {
    const runId = '11111111-1111-4111-8111-111111111111'
    vi.mocked(getScenario).mockResolvedValue({ id: SC_UUID, name: '订单创建', targetId: TGT_UUID } as never)
    vi.mocked(listRuns).mockResolvedValue({ items: [{
      id: runId, scenarioId: SC_UUID, targetId: TGT_UUID, status: 'SUCCEEDED',
      outcomeStatus: 'FAIL', scenarioVersionKind: 'trial', createdAt: '2026-09-27T10:00:00.000Z',
    }] as never, nextCursor: null } as never)
    const slots: Record<string, unknown> = { scenarioId: SC_UUID, targetId: TGT_UUID }
    const question = '这个场景已经跑成功了吗？'
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'workflow:read', 'run:read', 'target:read'] } as never,
      slots, question,
      body: { question, pageContext: { page: 'studio', scenarioId: SC_UUID, targetId: TGT_UUID } },
    })
    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toContain('执行成功、业务失败')
    expect(result.summary).toContain('不能确认该次运行的执行与业务检查都通过')
    expect(result.summary).toContain('不能证明当前草稿已通过')
    expect(result.claims[0]?.citations).toEqual([`scenario:${SC_UUID}`, `run:${runId}`])
    expect(slots).toMatchObject({ scenarioId: SC_UUID, runId })
    expect(slots).not.toHaveProperty('targetId')
    expect(ctx.session!.completeJson).not.toHaveBeenCalled()
  })

  it('无运行记录时如实说明缺口，不从草稿成功条件推断已通过', async () => {
    vi.mocked(getScenario).mockResolvedValue({ id: SC_UUID, name: '订单创建', targetId: TGT_UUID } as never)
    vi.mocked(listRuns).mockResolvedValue({ items: [], nextCursor: null } as never)
    const question = '刚才这个场景运行通过了吗？'
    const result = await handleKnowledgeAnswer(createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'workflow:read', 'run:read', 'target:read'] } as never,
      slots: { scenarioId: SC_UUID }, question,
      body: { question, pageContext: { page: 'studio', scenarioId: SC_UUID } },
    }))
    expect(result.summary).toContain('没有运行记录，无法确认')
    expect(result.missing).toContainEqual(expect.objectContaining({ reason: 'no_visible_runs' }))
    expect(result.nextActions?.[0]).toMatchObject({ href: '/runs' })
  })

  it('运行列表读取失败不被回答成零条或已通过', async () => {
    vi.mocked(getScenario).mockResolvedValue({ id: SC_UUID, name: '订单创建', targetId: TGT_UUID } as never)
    vi.mocked(listRuns).mockRejectedValue(new Error('storage unavailable'))
    const question = '这个场景已经跑成功了吗？'
    const result = await handleKnowledgeAnswer(createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'workflow:read', 'run:read', 'target:read'] } as never,
      slots: { scenarioId: SC_UUID }, question,
      body: { question, pageContext: { page: 'studio', scenarioId: SC_UUID } },
    }))
    expect(result.summary).toContain('未能读取场景运行记录')
    expect(result.missing[0]?.reason).toBe('read_failed')
    expect(result.summary).not.toContain('没有运行记录')
  })

  it('同名目标不在当前授权范围时，直接说明查询边界而不生成通用架构分析', async () => {
    const question = '模型api中转站的账号和运行有哪些？'
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'run:read'] } as any,
      body: { question, pageContext: { version: 2, routeKey: 'home', pageKind: 'home', page: 'home' } },
      targets: { listTargets: vi.fn(async () => ({ items: [], nextCursor: null })) } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)

    expect(assistantResultSchema.parse(result).kind).toBe('knowledge_answer')
    expect(ctx.targets.listTargets).toHaveBeenCalledWith(
      expect.objectContaining({ search: '模型api中转站' }), ctx.actor)
    expect(result.summary).toContain('本次查询可访问的目标范围内')
    expect(result.summary).toContain('不能确认它是否存在')
    expect(result.summary).not.toContain('模型api中转站')
    expect(ctx.session?.completeJson).not.toHaveBeenCalled()
  })

  it('可见目标有账号和运行时，按授权事实列摘要而不是解释平台概念', async () => {
    const question = '智慧运维管理平台的账号和运行有哪些？'
    vi.mocked(listRuns).mockResolvedValueOnce({ items: [{
      id: '9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c', scenarioName: '实例检查',
      status: 'FAILED', outcomeStatus: 'UNKNOWN',
    }], nextCursor: null } as any)
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'run:read'] } as any,
      body: { question, pageContext: { version: 2, routeKey: 'home', pageKind: 'home', page: 'home' } },
      targets: {
        listTargets: vi.fn(async () => ({ items: [{ id: TGT_UUID, name: '智慧运维管理平台' }], nextCursor: null })),
        getTarget: vi.fn(async () => ({ id: TGT_UUID, name: '智慧运维管理平台' })),
        listAccounts: vi.fn(async () => ({ items: [{ displayName: '巡检账号', status: 'active' }], nextCursor: null })),
      } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)

    expect(assistantResultSchema.parse(result).kind).toBe('knowledge_answer')
    expect(result.summary).toContain('巡检账号（启用）')
    expect(result.summary).toContain('实例检查：执行失败、业务结果未知')
    expect(result.summary).not.toContain('平台架构')
    expect(result.nextActions?.map((item) => item.href)).toEqual([`/targets/${TGT_UUID}`, '/runs'])
    expect(ctx.slots.targetId).toBe(TGT_UUID)
    expect(ctx.session?.completeJson).not.toHaveBeenCalled()
  })

  it.each([
    ['active', '已启用'],
    ['disabled', '已停用'],
  ] as const)('直接解释目标配置状态 %s，并避免误称账号或服务健康', async (status, label) => {
    const question = '这个目标系统目前是什么状态？'
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read'], targetScope: 'all' } as any,
      body: { question, pageContext: {
        version: 2, routeKey: 'target.detail', pageKind: 'target', page: 'target', targetId: TGT_UUID,
      } },
      targets: { getTarget: vi.fn(async () => ({ id: TGT_UUID, name: '智慧运维管理平台', status })) } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(assistantResultSchema.parse(result).kind).toBe('knowledge_answer')
    expect(result.summary).toContain(`配置状态为${label}（${status}）`)
    expect(result.summary).toContain('不能据此判断账号认证或业务服务是否健康')
    expect(result.claims[0]?.citations).toEqual([`target:${TGT_UUID}`])
    expect(result.nextActions?.[0]?.href).toBe(`/targets/${TGT_UUID}`)
    expect(ctx.session?.completeJson).not.toHaveBeenCalled()
  })

  it('checks target account health from authorized live session facts without inventing an auth failure', async () => {
    vi.mocked(listAccountSessionOverview).mockResolvedValue({
      items: [{
        accountDisplayName: '巡检账号', accountStatus: 'active', status: 'unprepared',
        liveCount: 0, effectiveCap: 1, occupyingRunId: null, occupyingOperationId: null,
        lastAuthCheckedAt: null,
      }],
      nextCursor: null,
      summary: { total: 1, available: 0, problem: 0, unprepared: 1, busy: 0, retained: 0 },
      asOf: '2026-09-27T12:00:00.000Z',
    } as never)
    const question = '请检查该目标系统关联账号的认证健康状态与会话租约情况。'
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'session:read'] } as any,
      body: { question, pageContext: { page: 'target', targetId: 'tgt-1' } },
    })

    const result = await handleKnowledgeAnswer(ctx)

    expect(authorizeTargetRequest).toHaveBeenCalledWith(ctx.db, 'user-1', { targetId: 'tgt-1', permissions: ['session:read'] })
    expect(listAccountSessionOverview).toHaveBeenCalledWith(ctx.db, { targetId: 'tgt-1', limit: 5 }, 'user-1')
    expect(result.summary).toContain('1 个关联账号：就绪可用 0')
    expect(result.summary).toContain('活跃会话 0/1')
    expect(result.summary).toContain('不能断定账号密码错误')
    expect(result.missing).toContainEqual(expect.objectContaining({ key: 'auth_probe' }))
    expect(result.claims[0]?.citations).toEqual(['target:tgt-1'])
    expect(result.sourceAsOf).toBe('2026-09-27T12:00:00.000Z')
    expect(result.asOf).not.toBe(result.sourceAsOf)
    expect(ctx.session?.completeJson).not.toHaveBeenCalled()
  })

  it('跨页点名目标的账号健康问法使用授权名称匹配目标，不使用当前页面目标', async () => {
    vi.mocked(listAccountSessionOverview).mockResolvedValueOnce({
      items: [], nextCursor: null,
      summary: { total: 0, available: 0, problem: 0, unprepared: 0, busy: 0, retained: 0 },
      asOf: '2026-09-28T00:00:00.000Z',
    } as never)
    const question = '请问系统甲的账号现在健康吗？'
    const listTargets = vi.fn().mockResolvedValue({ items: [{ id: 'tgt-a', name: '系统甲' }], nextCursor: null })
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'session:read'] } as any,
      question,
      body: { question, pageContext: { page: 'target', targetId: 'tgt-b' } },
      slots: { targetId: 'tgt-b' },
      targets: { listTargets, getTarget: vi.fn() } as any,
    })
    const result = await handleKnowledgeAnswer(ctx)
    expect(listTargets).toHaveBeenCalledWith(expect.objectContaining({ search: '系统甲' }), ctx.actor)
    expect(listAccountSessionOverview).toHaveBeenCalledWith(ctx.db, { targetId: 'tgt-a', limit: 5 }, 'user-1')
    expect(result.claims[0]?.citations).toEqual(['target:tgt-a'])
    expect(result.summary).toContain('目标系统「系统甲」')
    expect(result.summary).not.toContain('tgt-b')
  })

  it('跨页点名目标有重名时不任选一个账号健康范围', async () => {
    const question = '请问系统甲的账号现在健康吗？'
    const result = await handleKnowledgeAnswer(createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'session:read'] } as any,
      question,
      body: { question, pageContext: { page: 'target', targetId: 'tgt-b' } },
      targets: { listTargets: vi.fn().mockResolvedValue({ items: [
        { id: 'tgt-a', name: '系统甲' }, { id: 'tgt-c', name: '系统甲' },
      ], nextCursor: null }) } as any,
    }))
    expect(result.summary).toContain('多个同名目标')
    expect(listAccountSessionOverview).not.toHaveBeenCalled()
  })

  it('does not read target session health without session:read or its target scope', async () => {
    const question = '检查账号健康度'
    const body = { question, pageContext: { page: 'target' as const, targetId: 'tgt-1' } }
    const missingRole = await handleKnowledgeAnswer(createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read'] } as any,
      body,
    }))
    expect(missingRole.summary).toContain('缺少目标系统或会话读取权限')
    expect(missingRole.claims[0]?.citations).toEqual(['platform:knowledge_status:session_permission_denied'])
    expect(listAccountSessionOverview).not.toHaveBeenCalled()

    vi.mocked(authorizeTargetRequest).mockRejectedValueOnce(new Error('scope denied'))
    const missingScope = await handleKnowledgeAnswer(createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'session:read'] } as any,
      body,
    }))
    expect(missingScope.summary).toContain('未能访问目标账号与会话信息')
    expect(missingScope.claims[0]?.citations).toEqual(['platform:knowledge_status:session_access_denied'])
    expect(listAccountSessionOverview).not.toHaveBeenCalled()
  })

  it('answers a target-scoped session list from authorized live account facts', async () => {
    vi.mocked(listAccountSessionOverview).mockResolvedValueOnce({
      items: [{
        accountDisplayName: '演示账号', accountStatus: 'active', status: 'unprepared',
        liveCount: 0, effectiveCap: 1, occupyingRunId: null, occupyingOperationId: null,
        lastAuthCheckedAt: null,
      }],
      nextCursor: null,
      summary: { total: 1, available: 0, problem: 0, unprepared: 1, busy: 0, retained: 0 },
      asOf: '2026-09-28T00:00:00.000Z',
    } as never)
    const result = await handleKnowledgeAnswer(createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'session:read'] } as any,
      body: { question: '这个系统有哪些账号正在使用会话？', pageContext: {
        version: 2, routeKey: 'sessions.index.systems', pageKind: 'session', page: 'session',
        targetId: 'tgt-1', scopeRefs: [{ kind: 'target', id: 'tgt-1' }],
      } },
    }))
    expect(result.summary).toContain('该目标当前有 0 个账号持有活跃会话')
    expect(result.summary).toContain('演示账号：未准备；活跃会话 0/1')
    expect(result.summary).not.toContain('入口地址')
    expect(result.claims[0]?.citations).toEqual(['target:tgt-1'])
    expect(listAccountSessionOverview).toHaveBeenCalledWith(expect.anything(), { targetId: 'tgt-1', limit: 5 }, 'user-1')
  })

  it('reports a session overview read error without presenting it as zero healthy accounts', async () => {
    vi.mocked(listAccountSessionOverview).mockRejectedValueOnce(new Error('db unavailable'))
    const question = '检查账号健康度'
    const result = await handleKnowledgeAnswer(createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'session:read'] } as any,
      body: { question, pageContext: { page: 'target', targetId: 'tgt-1' } },
    }))
    expect(result.summary).toContain('读取失败')
    expect(result.summary).not.toContain('0 个')
    expect(result.claims[0]?.citations).toEqual(['platform:knowledge_status:session_read_failed'])
    expect(result.missing).toContainEqual(expect.objectContaining({ key: 'session_overview', reason: 'read_failed' }))
  })

  it('requires session permission and target scope before reading an account session page', async () => {
    const question = '这个账号为什么需要重新登录？'
    const body = { question, pageContext: {
      version: 2 as const, routeKey: 'sessions.$targetId.$accountId', pageKind: 'session' as const,
      page: 'session' as const, targetId: TGT_UUID,
      scopeRefs: [{ kind: 'account' as const, id: ACCOUNT_UUID }],
    } }
    const noRole = await handleKnowledgeAnswer(createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read'] } as any,
      body,
    }))
    expect(noRole.missing).toContainEqual(expect.objectContaining({ key: 'session', reason: 'permission_denied' }))
    expect(getAccountSessionDetail).not.toHaveBeenCalled()

    vi.mocked(authorizeTargetRequest).mockRejectedValueOnce(new Error('session scope denied'))
    const noScope = await handleKnowledgeAnswer(createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'session:read'] } as any,
      body,
    }))
    expect(noScope.missing).toContainEqual(expect.objectContaining({ key: 'session', reason: 'access_denied_or_not_found' }))
    expect(getAccountSessionDetail).not.toHaveBeenCalled()
  })

  it('persists an authorized account deep link with a target citation and hides run facts without run access', async () => {
    const question = '这个账号的会话状态怎样？'
    const runId = '9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c'
    vi.mocked(getAccountSessionDetail).mockResolvedValue({
      targetId: TGT_UUID, targetName: '生产系统', targetAccountId: ACCOUNT_UUID,
      accountDisplayName: '巡检账号', accountUsername: 'inspector', accountStatus: 'active',
      lastAuthError: null, status: 'ready', effectiveCap: 1, liveCount: 1,
    } as never)
    vi.mocked(listQueuedRunsForAccount).mockResolvedValue([{ id: runId, status: 'QUEUED', createdAt: new Date() }] as never)
    let modelPayload: any = null
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'session:read'] } as any,
      body: { question, pageContext: {
        version: 2, routeKey: 'sessions.$targetId.$accountId', pageKind: 'session',
        page: 'session', targetId: TGT_UUID,
        scopeRefs: [{ kind: 'account', id: ACCOUNT_UUID }],
      } },
      session: { completeJson: vi.fn().mockImplementation((_name, _schema, messages) => {
        modelPayload = JSON.parse(messages[1].content)
        return Promise.resolve({ ok: true, value: {
          summary: '当前账号有一条活跃会话。',
          claims: [{ factKind: 'observed', text: '当前账号有一条活跃会话。', citations: [`target:${TGT_UUID}`] }],
        } })
      }) } as any,
    })
    const result = await handleKnowledgeAnswer(ctx)
    expect(authorizeTargetRequest).toHaveBeenCalledWith(ctx.db, 'user-1', { targetId: TGT_UUID, permissions: ['session:read'] })
    expect(listQueuedRunsForAccount).not.toHaveBeenCalled()
    expect(JSON.stringify(modelPayload)).not.toContain(runId)
    expect(modelPayload.contextFacts.find((fact: any) => fact.citation === `target:${TGT_UUID}`)?.fact).toContain('未检查')
    expect(result.nextActions).toContainEqual(expect.objectContaining({
      kind: 'target.accounts',
      href: `/sessions/${TGT_UUID}/${ACCOUNT_UUID}`,
      citations: [`target:${TGT_UUID}`],
    }))
    expect(assistantResultSchema.safeParse(result).success).toBe(true)

    vi.mocked(authorizeTargetRequest).mockImplementation(async (_db, _actorId, input) => {
      if (input.permissions.includes('run:read')) throw new Error('run scope denied')
    })
    const scopedResult = await handleKnowledgeAnswer(createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'session:read', 'run:read'] } as any,
      body: ctx.body,
      session: ctx.session,
    }))
    expect(listQueuedRunsForAccount).not.toHaveBeenCalled()
    expect(JSON.stringify(modelPayload)).not.toContain(runId)
    expect(scopedResult.nextActions?.some((action) => action.kind === 'run.detail')).toBe(false)
  })

  it('does not mix facts from individually authorized Run, scenario, and target IDs with conflicting relationships', async () => {
    const runId = '9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d'
    vi.mocked(getRun).mockResolvedValue({ id: runId, targetId: TGT_UUID, scenarioId: SC_UUID } as never)
    vi.mocked(getScenario).mockResolvedValue({ id: SC_UUID, targetId: OTHER_TGT_UUID, name: '另一个目标的场景' } as never)
    const question = '这次运行和当前场景、目标的关系是什么？'
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'run:read', 'workflow:read', 'target:read'] } as any,
      body: { question, pageContext: {
        version: 2, routeKey: 'runs.$runId', pageKind: 'run', page: 'run',
        runId, scenarioId: SC_UUID, targetId: OTHER_TGT_UUID,
      } },
    })

    const result = await handleKnowledgeAnswer(ctx)

    expect(getRun).toHaveBeenCalledWith(ctx.db, runId, 'user-1')
    expect(authorizeTargetRequest).toHaveBeenCalledWith(ctx.db, 'user-1', { scenarioId: SC_UUID, permissions: ['workflow:read'] })
    expect(getScenario).toHaveBeenCalledWith(ctx.db, SC_UUID)
    expect(result.summary).toContain('不属于同一上下文')
    expect(result.missing).toContainEqual(expect.objectContaining({ key: 'page_context', reason: 'scope_mismatch' }))
    expect(result.claims).toEqual([expect.objectContaining({
      factKind: 'human_confirmed',
      citations: ['platform:page_context_mismatch'],
    })])
    expect(loadRunObservation).not.toHaveBeenCalled()
    expect(ctx.session?.completeJson).not.toHaveBeenCalled()
    expect(assistantResultSchema.safeParse(result).success).toBe(true)
  })

  it('does not invent a current CPU value for an external target instance', async () => {
    const question = 'Mysql50.33 实例现在 CPU 利用率是多少？'
    const ctx = createMockContext({
      question,
      body: { question, pageContext: { page: 'target', targetId: 'tgt-1' } },
    })

    const result = await handleKnowledgeAnswer(ctx)

    expect(result.summary).toContain('没有这个目标外部实例的实时 CPU 利用率数据')
    expect(result.summary).not.toMatch(/\b\d+(?:\.\d+)?%/)
    expect(result.claims).toEqual([expect.objectContaining({
      factKind: 'human_confirmed',
      citations: ['platform:target_cpu_unavailable'],
    })])
    expect(result.missing).toContainEqual(expect.objectContaining({ key: 'target_cpu_metric' }))
    expect(ctx.session?.completeJson).not.toHaveBeenCalled()
    expect(ctx.targets.getTarget).not.toHaveBeenCalled()
  })

  it('answers the first-time capability question from the current permission catalog', async () => {
    const question = '识途能帮我做什么？'
    const ctx = createMockContext({
      question,
      body: { question },
      actor: {
        id: 'user-1',
        permissions: ['ai:assist', 'target:read', 'workflow:read', 'run:read'],
      } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)

    expect(result.summary).toContain('运行诊断')
    expect(result.summary).toContain('场景解释')
    expect(result.summary).not.toContain('场景编排建议')
    expect(result.claims[0]?.citations).toEqual(['platform:capability_overview'])
    expect(result.missing).toEqual([])
    expect(ctx.session?.completeJson).not.toHaveBeenCalled()
  })

  it('CQ-06: returns grounded answer citing published help catalog', async () => {
    const ctx = createMockContext()
    const result = await handleKnowledgeAnswer(ctx)

    expect(result.kind).toBe('knowledge_answer')
    expect(result.summary).toContain('retryLimit')
    expect(result.claims.length).toBe(1)
    expect(result.claims[0].factKind).toBe('human_confirmed')
    expect(result.claims[0].citations).toContain('help:studio-retry')
    expect(result.nextActions).toBeDefined()
    expect(result.nextActions?.length).toBeGreaterThan(0)
    expect(result.nextActions?.[0].kind).toBe('studio.step')
  })

  it('instructs JSON output explicitly for the knowledge answer provider', async () => {
    const completeJson = vi.fn().mockResolvedValue({ ok: false, message: '模型暂不可用' })
    await handleKnowledgeAnswer(createMockContext({ session: { completeJson } as any }))

    const messages = completeJson.mock.calls[0]?.[2] as Array<{ role: string; content: string }>
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('JSON')
    expect(messages[0]?.content).toContain('不要另写 summary')
    expect(messages[0]?.content).not.toContain('{"summary":')
    expect(messages[0]?.content).toContain('"claims":[]')
    expect(messages[0]?.content).toContain('"missing":[]')
    const schema = completeJson.mock.calls[0]?.[1]
    expect(schema.parse({ claims: [], missing: [], summary: '未校验的多余摘要' })).toEqual({ claims: [], missing: [] })
    expect(completeJson.mock.calls[0]?.[5]).toBe('off')
  })

  it('keeps a focused, explicitly incomplete help answer when model generation fails', async () => {
    const question = '确定性步骤可以配置重试吗？怎么设置？'
    const ctx = createMockContext({
      question,
      body: { question },
      session: { completeJson: vi.fn().mockResolvedValue({ ok: false, message: '模型暂不可用' }) } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toContain('执行与容错策略')
    expect(result.summary).toContain('重试上限（0~10 次）')
    expect(result.summary).not.toContain('已找到相关可核验资料，以下列出最相关的事实')
    expect(result.claims).toHaveLength(1)
    expect(result.claims[0]?.citations).toEqual(['help:studio-retry'])
    expect(result.summary).not.toContain('识途场景由有序的步骤列表组成')
    expect(result.claims.some((claim) => claim.citations.includes('help:platform-architecture'))).toBe(false)
    expect(result.nextActions?.every((action) => action.href === '/scenarios')).toBe(true)
    expect(result.missing).toContainEqual(expect.objectContaining({ reason: 'generation_failed' }))
  })

  it('returns honest missing notice when query has no matching facts', async () => {
    const ctx = createMockContext({
      question: '火星上有生命吗？',
      body: { question: '火星上有生命吗？' },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.kind).toBe('knowledge_answer')
    expect(result.claims[0]?.citations).toEqual(['platform:knowledge_status:no_matching_facts'])
    expect(result.missing.some((m) => m.reason === 'no_matching_facts')).toBe(true)
  })

  it('replaces a model answer with no verified claims instead of exposing its unsupported summary', async () => {
    const ctx = createMockContext({
      session: { completeJson: vi.fn().mockResolvedValue({ ok: true, value: {
        summary: '没有依据的虚构结论',
        claims: [{ factKind: 'observed', text: '虚构实体事实', citations: ['unknown:invented'] }],
        missing: [],
      } }) } as any,
    })
    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toContain('未产生通过事实引用校验的结论')
    expect(JSON.stringify(result)).not.toContain('没有依据的虚构结论')
    expect(result.claims[0]?.citations).toEqual(['platform:knowledge_status:no_verified_claims'])
    expect(result.nextActions?.every((action) => action.href === '/scenarios')).toBe(true)
  })

  it('rejects a claim that mixes a real citation with a fabricated one', async () => {
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
    expect(result.claims[0].citations).toEqual(['platform:knowledge_status:no_verified_claims'])
    expect(result.missing).toContainEqual(expect.objectContaining({ key: 'unsupported_citation' }))
    expect(JSON.stringify(result)).not.toContain('help:fake-non-existent-id')
  })

  it('rejects an explicit denial of retry configuration despite a valid help citation', async () => {
    const falseConclusion = '在 Studio 中，确定性步骤不能配置重试策略。'
    const ctx = createMockContext({
      session: { completeJson: vi.fn().mockResolvedValue({ ok: true, value: {
        summary: falseConclusion,
        claims: [{ factKind: 'human_confirmed', text: falseConclusion, citations: ['help:studio-retry'] }],
        missing: [],
      } }) } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(JSON.stringify(result)).not.toContain(falseConclusion)
    expect(result.claims[0]?.citations).toEqual(['platform:knowledge_status:no_verified_claims'])
    expect(result.missing).toContainEqual(expect.objectContaining({ reason: 'contradicts_published_help' }))
  })

  it('does not publish an unsupported schedule conclusion behind a real help citation', async () => {
    const question = '定时调度能按目标时区运行吗？'
    const falseConclusion = '定时调度不支持目标时区，只按服务器时区运行。'
    const ctx = createMockContext({
      question,
      body: { question },
      session: { completeJson: vi.fn().mockResolvedValue({ ok: true, value: {
        claims: [{ factKind: 'human_confirmed', text: falseConclusion, citations: ['help:schedule-cron'] }],
        missing: [],
      } }) } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(JSON.stringify(result)).not.toContain(falseConclusion)
    expect(result.summary).toContain('目标时区绑定')
    expect(result.claims[0]?.citations).toEqual(['help:schedule-cron'])
    expect(result.missing).toContainEqual(expect.objectContaining({ reason: 'quote_not_in_cited_help' }))
  })

  it('shows the verified help quote instead of a conflicting model paraphrase', async () => {
    const question = '定时调度能按目标时区运行吗？'
    const falseConclusion = '定时调度不支持目标时区。'
    const quote = '支持标准 5 字段 Cron 表达式与目标时区绑定。'
    const ctx = createMockContext({
      question,
      body: { question },
      session: { completeJson: vi.fn().mockResolvedValue({ ok: true, value: {
        claims: [{ factKind: 'human_confirmed', text: falseConclusion,
          evidenceQuote: quote, citations: ['help:schedule-cron'] }],
        missing: [],
      } }) } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toBe(quote)
    expect(JSON.stringify(result)).not.toContain(falseConclusion)
    expect(result.claims[0]?.citations).toEqual(['help:schedule-cron'])
  })

  it('retains a verified retry quote even when the discarded paraphrase is wrong', async () => {
    const falseConclusion = '在 Studio 中，确定性步骤不能配置重试策略。'
    const ctx = createMockContext({ session: { completeJson: vi.fn().mockResolvedValue({ ok: true, value: {
      claims: [{ factKind: 'human_confirmed', text: falseConclusion,
        evidenceQuote: RETRY_HELP_QUOTE, citations: ['help:studio-retry'] }],
      missing: [],
    } }) } as any })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toBe(RETRY_HELP_QUOTE)
    expect(JSON.stringify(result)).not.toContain(falseConclusion)
    expect(result.missing).toEqual([])
  })

  it('keeps the answer topic when two genuine help quotes cover different subjects', async () => {
    const question = '确定性步骤可以配置重试吗？怎么设置？'
    const unrelated = '确定性步骤包括页面导航（navigate）、元素点击（click）、表单填充（fill）、内容提取（extract）与业务断言（assert）。'
    const ctx = createMockContext({
      question,
      body: { question },
      session: { completeJson: vi.fn().mockResolvedValue({ ok: true, value: {
        claims: [
          { factKind: 'human_confirmed', text: unrelated, evidenceQuote: unrelated, citations: ['help:studio-steps'] },
          { factKind: 'human_confirmed', text: RETRY_HELP_QUOTE,
            evidenceQuote: RETRY_HELP_QUOTE, citations: ['help:studio-retry'] },
        ],
        missing: [],
      } }) } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toBe(RETRY_HELP_QUOTE)
    expect(result.claims.map((claim) => claim.citations)).toEqual([['help:studio-retry']])
  })

  it('rejects a claim that an unsaved draft can be trial-run despite a valid help citation', async () => {
    const falseConclusion = '草稿没保存也可以直接试跑。'
    const question = '草稿没保存时能试跑吗？'
    const ctx = createMockContext({
      question,
      body: { question },
      session: { completeJson: vi.fn().mockResolvedValue({ ok: true, value: {
        claims: [{ factKind: 'human_confirmed', text: falseConclusion, citations: ['help:studio-steps'] }],
        missing: [],
      } }) } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(JSON.stringify(result)).not.toContain(falseConclusion)
    expect(result.missing).toContainEqual(expect.objectContaining({ reason: 'contradicts_published_help' }))
  })

  it('keeps the cited rule that an unsaved draft cannot be used for a trial run', async () => {
    const question = '草稿没保存时能试跑吗？'
    const answer = '草稿未保存时不能作为试跑输入，先保存草稿。'
    const ctx = createMockContext({
      question,
      body: { question },
      session: { completeJson: vi.fn().mockResolvedValue({ ok: true, value: {
        claims: [{ factKind: 'human_confirmed', text: answer,
          evidenceQuote: UNSAVED_HELP_QUOTE, citations: ['help:studio-steps'] }],
        missing: [{ key: 'trial-run-without-save', reason: 'missing_procedure',
          description: '缺少未保存草稿直接试跑的操作步骤' }],
      } }) } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toBe(UNSAVED_HELP_QUOTE)
    expect(result.claims[0]?.citations).toEqual(['help:studio-steps'])
    expect(result.missing).toEqual([])
  })

  it('rejects obsolete retry controls even when the citation key is real', async () => {
    const falseConclusion = 'Studio 中可设置 maxAttempts 与初始退避延迟。'
    const ctx = createMockContext({ session: { completeJson: vi.fn().mockResolvedValue({ ok: true, value: {
      summary: falseConclusion,
      claims: [{ factKind: 'human_confirmed', text: falseConclusion, citations: ['help:studio-retry'] }],
      missing: [],
    } }) } as any })

    const result = await handleKnowledgeAnswer(ctx)

    expect(result.summary).not.toContain('可设置 maxAttempts')
    expect(result.missing).toContainEqual(expect.objectContaining({ reason: 'contradicts_published_help' }))
  })

  it('rejects the same help contradiction when relabeled as an inference', async () => {
    const falseConclusion = '在 Studio 中，确定性步骤不能配置重试策略。'
    const ctx = createMockContext({
      session: { completeJson: vi.fn().mockResolvedValue({ ok: true, value: {
        summary: falseConclusion,
        claims: [{ factKind: 'inferred', text: falseConclusion, citations: ['help:studio-retry'], premises: ['步骤可配置重试策略'] }],
        missing: [],
      } }) } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(JSON.stringify(result)).not.toContain(falseConclusion)
    expect(result.missing).toContainEqual(expect.objectContaining({ reason: 'contradicts_published_help' }))
  })

  it('rebuilds the summary from retained claims when one help claim is contradicted', async () => {
    const falseConclusion = '步骤不支持配置重试策略。'
    const supportedConclusion = '确定性步骤可在执行与容错策略中设置重试上限。'
    const ctx = createMockContext({
      session: { completeJson: vi.fn().mockResolvedValue({ ok: true, value: {
        summary: falseConclusion,
        claims: [
          { factKind: 'human_confirmed', text: falseConclusion, citations: ['help:studio-retry'] },
          { factKind: 'human_confirmed', text: supportedConclusion,
            evidenceQuote: RETRY_HELP_QUOTE, citations: ['help:studio-retry'] },
        ],
        missing: [],
      } }) } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toBe(RETRY_HELP_QUOTE)
    expect(result.claims.map((claim) => claim.text)).toEqual([RETRY_HELP_QUOTE])
    expect(JSON.stringify(result)).not.toContain(falseConclusion)
  })

  it('keeps a supported paraphrase and removes an independently false model summary', async () => {
    const supportedConclusion = 'Studio 的确定性步骤可在执行与容错策略中设置重试上限。'
    const ctx = createMockContext({
      session: { completeJson: vi.fn().mockResolvedValue({ ok: true, value: {
        summary: '确定性步骤无法配置重试。',
        claims: [{ factKind: 'human_confirmed', text: supportedConclusion,
          evidenceQuote: RETRY_HELP_QUOTE, citations: ['help:studio-retry'] }],
        missing: [],
      } }) } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toBe(RETRY_HELP_QUOTE)
    expect(result.claims).toEqual([expect.objectContaining({ text: RETRY_HELP_QUOTE, citations: ['help:studio-retry'] })])
  })

  it('separates retained claim sentences without adding unsupported summary prose', async () => {
    const first = '0 表示不自动重试。'
    const second = '当前步骤配置字段是 policy.retryLimit 与 policy.timeoutMs；界面没有 maxAttempts、初始退避延迟或最大退避延迟输入项。'
    const ctx = createMockContext({
      session: { completeJson: vi.fn().mockResolvedValue({ ok: true, value: {
        summary: '模型自行生成的摘要',
        claims: [
          { factKind: 'human_confirmed', text: first, evidenceQuote: first, citations: ['help:studio-retry'] },
          { factKind: 'human_confirmed', text: second, evidenceQuote: second, citations: ['help:studio-retry'] },
        ],
        missing: [],
      } }) } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toBe(`${first}\n${second}`)
    expect(result.summary).not.toContain('模型自行生成的摘要')
    expect(result.summary).not.toContain('。；')
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
      const cited = ['run:run-100', 'stepRun:sr-1', 'attempt:att-1', 'view:tab']
      return Promise.resolve({
        ok: true,
        value: {
          summary: '运行失败在第 1 次尝试。',
          claims: cited.map((citation) => ({
            factKind: 'observed',
            text: userPayload.contextFacts.find((fact: any) => fact.citation === citation).fact,
            evidenceQuote: userPayload.contextFacts.find((fact: any) => fact.citation === citation).fact,
            citations: [citation],
          })),
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
    expect(result.claims.map((claim) => claim.citations[0])).toEqual([
      'run:run-100', 'stepRun:sr-1', 'attempt:att-1', 'view:tab',
    ])
  })

  it('does not turn a succeeded Run into a failure behind its real citation', async () => {
    vi.mocked(loadRunObservation).mockResolvedValue({
      run: {
        id: 'run-100', targetId: 'tgt-1', scenarioId: 'sc-1',
        status: 'SUCCEEDED', outcomeStatus: 'PASS', evidenceStatus: 'COMPLETE',
        stepRuns: [],
      },
      evidence: { items: [] },
    } as any)
    const falseConclusion = '这次运行失败了。'
    const ctx = createMockContext({
      question: '这次运行成功了吗？',
      actor: { id: 'user-1', permissions: ['ai:assist', 'run:read', 'target:read'], targetScope: 'all' } as any,
      body: { question: '这次运行成功了吗？', pageContext: {
        version: 2, routeKey: 'runs.$runId', pageKind: 'run', page: 'run', runId: 'run-100',
      } },
      session: { completeJson: vi.fn().mockResolvedValue({ ok: true, value: {
        claims: [{ factKind: 'observed', text: falseConclusion, citations: ['run:run-100'] }],
        missing: [],
      } }) } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(JSON.stringify(result)).not.toContain(falseConclusion)
    expect(result.summary).toContain('SUCCEEDED')
    expect(result.claims[0]?.citations).toEqual(['run:run-100'])

    // A real excerpt cannot validate the model's opposite paraphrase: show
    // only the excerpt itself, even when both the quote and citation are valid.
    const quotedCtx = createMockContext({
      question: '这次运行成功了吗？',
      actor: { id: 'user-1', permissions: ['ai:assist', 'run:read', 'target:read'], targetScope: 'all' } as any,
      body: { question: '这次运行成功了吗？', pageContext: {
        version: 2, routeKey: 'runs.$runId', pageKind: 'run', page: 'run', runId: 'run-100',
      } },
      session: { completeJson: vi.fn().mockResolvedValue({ ok: true, value: {
        claims: [{ factKind: 'observed', text: falseConclusion, citations: ['run:run-100'],
          evidenceQuote: '状态: SUCCEEDED, 业务结果: PASS' }],
        missing: [],
      } }) } as any,
    })
    const quotedResult = await handleKnowledgeAnswer(quotedCtx)
    expect(JSON.stringify(quotedResult)).not.toContain(falseConclusion)
    expect(quotedResult.summary).toContain('状态: SUCCEEDED, 业务结果: PASS')
    expect(quotedResult.claims[0]?.citations).toEqual(['run:run-100'])
  })

  it('does not publish a false inference even when its premises quote the real Run', async () => {
    vi.mocked(loadRunObservation).mockResolvedValue({
      run: { id: 'run-100', targetId: 'tgt-1', scenarioId: 'sc-1',
        status: 'SUCCEEDED', outcomeStatus: 'PASS', evidenceStatus: 'COMPLETE', stepRuns: [] },
      evidence: { items: [] },
    } as any)
    const falseConclusion = '这次运行失败了。'
    const question = '这次运行成功了吗？'
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'run:read', 'target:read'], targetScope: 'all' } as any,
      body: { question, pageContext: {
        version: 2, routeKey: 'runs.$runId', pageKind: 'run', page: 'run', runId: 'run-100',
      } },
      session: { completeJson: vi.fn().mockResolvedValue({ ok: true, value: {
        claims: [{ factKind: 'inferred', text: falseConclusion, citations: ['run:run-100'],
          premises: ['状态: SUCCEEDED, 业务结果: PASS'] }], missing: [],
      } }) } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(JSON.stringify(result)).not.toContain(falseConclusion)
    expect(result.summary).toContain('状态: SUCCEEDED, 业务结果: PASS')
    expect(result.claims[0]?.factKind).toBe('observed')
    expect(result.missing).toContainEqual(expect.objectContaining({ reason: 'conclusion_not_verified' }))
  })

  it('不把模型自由填写的缺口说明当成已核验的故障结论展示', async () => {
    vi.mocked(loadRunObservation).mockResolvedValue({
      run: { id: 'run-100', targetId: 'tgt-1', scenarioId: 'sc-1',
        status: 'SUCCEEDED', outcomeStatus: 'PASS', evidenceStatus: 'COMPLETE', stepRuns: [] },
      evidence: { items: [] },
    } as any)
    const fabricated = '已确认数据库故障是这次失败的根因'
    const question = '这次运行成功了吗？'
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'run:read', 'target:read'], targetScope: 'all' } as any,
      body: { question, pageContext: {
        version: 2, routeKey: 'runs.$runId', pageKind: 'run', page: 'run', runId: 'run-100',
      } },
      session: { completeJson: vi.fn().mockResolvedValue({ ok: true, value: {
        claims: [{ factKind: 'observed', text: '这次运行成功', citations: ['run:run-100'],
          evidenceQuote: '状态: SUCCEEDED, 业务结果: PASS' }],
        missing: [{ key: 'root_cause', reason: 'database_failure', description: fabricated }],
      } }) } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toContain('SUCCEEDED')
    expect(JSON.stringify(result)).not.toContain(fabricated)
    expect(result.missing).not.toContainEqual(expect.objectContaining({ key: 'root_cause' }))
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
      const quoteFor = (citation: string) => userPayload.contextFacts.find((fact: any) => fact.citation === citation).fact
      return Promise.resolve({
        ok: true,
        value: {
          summary: '提取发票金额步骤用于从 PDF 识别金额。',
          claims: [
            {
              factKind: 'observed',
              text: '提取发票金额步骤动作类型为 extract',
              evidenceQuote: quoteFor('step:step-invoice'),
              citations: ['step:step-invoice'],
            },
            {
              factKind: 'observed',
              text: '当前画布存在未保存修改，依据已保存修订号 12 解答',
              evidenceQuote: quoteFor('scenario:sc-1:draft_status'),
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
    expect(completeJsonMock.mock.calls[0]?.[5]).toBeUndefined()
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

  it('answers current account readiness from the authorized session even when the model would fail', async () => {
    const sessionId = '9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a'
    vi.mocked(getSessionDto).mockResolvedValue({
      id: sessionId, targetId: TGT_UUID, targetAccountId: ACCOUNT_UUID,
      status: 'OPEN', health: 'HEALTHY', authState: 'AUTHENTICATED',
      lastAuthSuccessAt: '2026-09-27T15:41:42.989Z', activeLease: null,
    } as any)
    const completeJson = vi.fn().mockResolvedValue({ ok: false })
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'session:read'], targetScope: 'all' } as any,
      session: { completeJson } as any,
      body: {
        question: '这个账号现在能用吗？会话是谁占着，最近认证成功了吗？',
        pageContext: {
          version: 2, routeKey: 'sessions.$targetId.$accountId', pageKind: 'session', page: 'session',
          primaryRef: { kind: 'session', id: sessionId },
          scopeRefs: [{ kind: 'target', id: TGT_UUID }], targetId: TGT_UUID,
        },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toContain('已认证、开放且健康')
    expect(result.summary).toContain('未记录活动租约')
    expect(result.summary).toContain('2026-09-27T15:41:42.989Z')
    expect(result.claims[0]?.citations).toEqual([`session:${sessionId}`])
    expect(result.nextActions?.[0]?.href).toBe(`/sessions/${TGT_UUID}/${ACCOUNT_UUID}`)
    expect(completeJson).not.toHaveBeenCalled()
    expect(assistantResultSchema.safeParse(result).success).toBe(true)
  })

  it('answers the actual account page context from live account and session facts', async () => {
    vi.mocked(getAccountSessionDetail).mockResolvedValue({
      targetId: TGT_UUID, targetAccountId: ACCOUNT_UUID,
      accountStatus: 'active', status: 'ready', liveCount: 1, effectiveCap: 1,
      session: { authState: 'AUTHENTICATED', lastAuthSuccessAt: '2026-09-27T15:41:42.989Z' },
      instances: [], occupancy: null, asOf: '2026-09-27T15:50:00.000Z',
    } as any)
    const completeJson = vi.fn().mockResolvedValue({ ok: false })
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'session:read'], targetScope: 'all' } as any,
      session: { completeJson } as any,
      body: {
        question: '这个账号为什么一直等登录？现在谁占着会话？',
        pageContext: {
          version: 2, routeKey: 'sessions.$targetId.$accountId', pageKind: 'session', page: 'session',
          primaryRef: { kind: 'account', id: ACCOUNT_UUID },
          scopeRefs: [{ kind: 'target', id: TGT_UUID }], targetId: TGT_UUID,
        },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toContain('当前账号状态为就绪')
    expect(result.summary).toContain('当前没有已记录的会话占用')
    expect(result.summary).toContain('不支持“仍在等登录”的前提')
    expect(result.claims[0]?.citations).toEqual([`target:${TGT_UUID}`])
    expect(result.sourceAsOf).toBe('2026-09-27T15:50:00.000Z')
    expect(result.asOf).not.toBe(result.sourceAsOf)
    expect(completeJson).not.toHaveBeenCalled()
    expect(assistantResultSchema.safeParse(result).success).toBe(true)
  })

  it('answers the account authentication timestamp from recorded history without calling the model', async () => {
    vi.mocked(getAccountSessionDetail).mockResolvedValue({
      targetId: TGT_UUID, targetAccountId: ACCOUNT_UUID,
      accountStatus: 'active', status: 'unprepared', liveCount: 0, effectiveCap: 1,
      session: null, instances: [], occupancy: null, asOf: '2026-09-28T00:00:00.000Z',
    } as any)
    vi.mocked(loadAccountAuthDisplay).mockResolvedValueOnce(new Map([
      [ACCOUNT_UUID, { lastAuthSuccessAt: '2026-09-27T16:40:01.900Z' }],
    ]) as never)
    const completeJson = vi.fn().mockResolvedValue({ ok: false })
    const result = await handleKnowledgeAnswer(createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'session:read'], targetScope: 'all' } as any,
      session: { completeJson } as any,
      body: { question: '这个账号最近一次认证成功是什么时候？', pageContext: {
        version: 2, routeKey: 'sessions.$targetId.$accountId', pageKind: 'session', page: 'session',
        primaryRef: { kind: 'account', id: ACCOUNT_UUID },
        scopeRefs: [{ kind: 'target', id: TGT_UUID }, { kind: 'account', id: ACCOUNT_UUID }],
        targetId: TGT_UUID,
      } },
    }))
    expect(result.summary).toContain('账号历史上最近一次成功认证记录为 2026-09-27T16:40:01.900Z')
    expect(result.summary).toContain('不代表当前有可用会话')
    expect(result.summary).not.toContain('厂家')
    expect(result.claims[0]?.citations).toEqual([`target:${TGT_UUID}`])
    expect(result.sourceAsOf).toBe('2026-09-28T00:00:00.000Z')
    expect(completeJson).not.toHaveBeenCalled()
  })

  it('does not mistake a historical success for the latest authentication attempt', async () => {
    vi.mocked(getAccountSessionDetail).mockResolvedValue({
      targetId: TGT_UUID, targetAccountId: ACCOUNT_UUID,
      accountStatus: 'active', status: 'unprepared', liveCount: 0, effectiveCap: 1,
      session: null, instances: [], occupancy: null, asOf: '2026-09-28T00:00:00.000Z',
    } as any)
    vi.mocked(loadAccountAuthDisplay).mockResolvedValueOnce(new Map([
      [ACCOUNT_UUID, { lastAuthSuccessAt: '2026-09-27T16:40:01.900Z' }],
    ]) as never)
    const result = await handleKnowledgeAnswer(createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'session:read'], targetScope: 'all' } as any,
      body: { question: '这个账号最近认证成功了吗？', pageContext: {
        version: 2, routeKey: 'sessions.$targetId.$accountId', pageKind: 'session', page: 'session',
        primaryRef: { kind: 'account', id: ACCOUNT_UUID },
        scopeRefs: [{ kind: 'target', id: TGT_UUID }, { kind: 'account', id: ACCOUNT_UUID }],
        targetId: TGT_UUID,
      } },
    }))
    expect(result.summary).toContain('2026-09-27T16:40:01.900Z')
    expect(result.summary).toContain('不能确认最近一次认证尝试是否成功')
    expect(result.summary).toContain('不代表当前有可用会话')
    expect(result.summary).not.toContain('需补充该账号的登录触发或运行历史')
  })

  it('does not turn an unprepared account into an invented login wait cause', async () => {
    vi.mocked(getAccountSessionDetail).mockResolvedValue({
      targetId: TGT_UUID, targetAccountId: ACCOUNT_UUID,
      accountStatus: 'active', status: 'unprepared', liveCount: 0, effectiveCap: 1,
      session: null, instances: [], occupancy: null, asOf: '2026-09-28T00:00:00.000Z',
    } as any)
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'session:read'], targetScope: 'all' } as any,
      body: {
        question: '这个账号为什么一直等登录？现在谁占着会话？',
        pageContext: {
          version: 2, routeKey: 'session', pageKind: 'session', page: 'session',
          primaryRef: { kind: 'account', id: ACCOUNT_UUID },
          scopeRefs: [{ kind: 'target', id: TGT_UUID }], targetId: TGT_UUID,
        },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toContain('状态为未准备，活跃会话 0/1')
    expect(result.summary).toContain('不能确定是在等待登录或判断具体原因')
    expect(result.summary).toContain('当前没有已记录的会话占用')
    expect(result.summary).not.toContain('unprepared')
  })

  it('distinguishes historical account authentication from a currently available session', async () => {
    vi.mocked(getAccountSessionDetail).mockResolvedValue({
      targetId: TGT_UUID, targetAccountId: ACCOUNT_UUID,
      accountStatus: 'active', status: 'unprepared', liveCount: 0, effectiveCap: 1,
      session: null, instances: [], occupancy: null, asOf: '2026-09-28T00:00:00.000Z',
    } as any)
    vi.mocked(loadAccountAuthDisplay).mockResolvedValueOnce(new Map([[ACCOUNT_UUID, {
      lastAuthCheckedAt: '2026-09-27T15:57:03.773Z',
      lastAuthSuccessAt: '2026-09-27T15:57:03.773Z',
      lastAuthError: null, autoLoginPausedReason: null,
    }]]))
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'session:read'], targetScope: 'all' } as any,
      body: {
        question: '这个账号现在能用吗？会话是谁占着，最近认证成功了吗？',
        pageContext: {
          version: 2, routeKey: 'session', pageKind: 'session', page: 'session',
          primaryRef: { kind: 'account', id: ACCOUNT_UUID },
          scopeRefs: [{ kind: 'target', id: TGT_UUID }], targetId: TGT_UUID,
        },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toContain('状态为未准备，活跃会话 0/1')
    expect(result.summary).toContain('账号历史上最近一次成功认证记录为 2026-09-27T15:57:03.773Z')
    expect(result.summary).toContain('这不代表当前有可用会话')
    expect(result.missing).toEqual([])
  })

  it('P09: reports a recorded auth error and the occupying run from the account page', async () => {
    const runId = '44444444-4444-4444-8444-444444444444'
    vi.mocked(getAccountSessionDetail).mockResolvedValue({
      targetId: TGT_UUID, targetAccountId: ACCOUNT_UUID,
      accountStatus: 'active', status: 'needs_login', liveCount: 1, effectiveCap: 1,
      lastAuthError: 'LOGIN_PAGE_UNREACHABLE',
      session: { authState: 'STALE', lastAuthCheckedAt: '2026-09-27T10:00:00.000Z', lastAuthSuccessAt: null },
      instances: [], occupancy: { purpose: 'EXECUTION', occupyingRunId: runId, occupyingOperationId: null },
      asOf: '2026-09-27T10:05:00.000Z',
    } as any)
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'session:read', 'run:read'], targetScope: 'all' } as any,
      body: {
        question: '这个账号为什么一直等登录？现在谁占着会话？',
        pageContext: { version: 2, routeKey: 'session', pageKind: 'session', page: 'session',
          primaryRef: { kind: 'account', id: ACCOUNT_UUID },
          scopeRefs: [{ kind: 'target', id: TGT_UUID }], targetId: TGT_UUID },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toContain('LOGIN_PAGE_UNREACHABLE')
    expect(result.summary).toContain('目标登录页打不开')
    expect(result.summary).toContain('占用运行 ID ' + runId)
    expect(result.summary).toContain('不能断定现在可用')
    expect(result.nextActions).toContainEqual(expect.objectContaining({
      kind: 'run.detail', href: `/runs/${runId}`,
    }))
    expect(result.claims[0]?.citations).toEqual([`target:${TGT_UUID}`])
    expect(assistantResultSchema.safeParse(result).success).toBe(true)
  })

  it('P09: hides the occupying run ID when the reader lacks run access', async () => {
    const runId = '55555555-5555-4555-8555-555555555555'
    vi.mocked(getAccountSessionDetail).mockResolvedValue({
      targetId: TGT_UUID, targetAccountId: ACCOUNT_UUID,
      accountStatus: 'active', status: 'needs_login', liveCount: 1, effectiveCap: 1,
      lastAuthError: 'LOGIN_PAGE_UNREACHABLE', session: { authState: 'STALE', lastAuthSuccessAt: null },
      instances: [], occupancy: { purpose: 'EXECUTION', occupyingRunId: runId, occupyingOperationId: null },
      asOf: '2026-09-27T10:05:00.000Z',
    } as any)
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'target:read', 'session:read'], targetScope: 'all' } as any,
      body: {
        question: '这个账号为什么一直等登录？现在谁占着会话？',
        pageContext: { version: 2, routeKey: 'session', pageKind: 'session', page: 'session',
          primaryRef: { kind: 'account', id: ACCOUNT_UUID },
          scopeRefs: [{ kind: 'target', id: TGT_UUID }], targetId: TGT_UUID },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).not.toContain(runId)
    expect(result.nextActions?.some((action) => action.kind === 'run.detail')).toBe(false)
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
    expect(JSON.stringify(capturedPayload)).not.toContain(runId)
    expect(listQueuedRunsForAccount).not.toHaveBeenCalled()
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

    // 具体日期与跳过事件由已授权事实直接回答，不依赖模型推断。
    expect(completeJsonMock).not.toHaveBeenCalled()
    expect(result.summary).toContain('AUTH_PREPARATION_REQUIRED')
    expect(result.summary).toContain('08:00')
    expect(result.summary).toContain('Asia/Shanghai')
    expect(result.summary).toContain(`昨天（${yesterday}`)
    expect(result.summary).toContain('已跳过 1 次')
  })

  it('explains that a schedule created today could not have triggered yesterday', async () => {
    const scheduleId = '8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a'
    const today = shanghaiLocalDate(0)
    const yesterday = shanghaiLocalDate(-1)
    vi.mocked(getSchedule).mockResolvedValue({
      scheduleId, targetId: TGT_UUID, name: '地图采集测试', enabled: true,
      definition: { timezone: 'Asia/Shanghai' },
      createdAt: `${today}T08:00:00.000Z`, nextDueAt: `${today}T18:00:00.000Z`,
    } as any)
    vi.mocked(listScheduleOccurrences).mockResolvedValue({ items: [], nextCursor: null } as any)
    const completeJson = vi.fn()
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'schedule:read', 'target:read'], targetScope: 'all' } as any,
      session: { completeJson } as any,
      body: {
        question: '昨晚这条调度怎么没跑？',
        pageContext: { version: 2, routeKey: 'schedule', pageKind: 'schedule', page: 'schedule',
          primaryRef: { kind: 'schedule', id: scheduleId } },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toContain(yesterday)
    expect(result.summary).toContain('当时尚不存在')
    expect(result.claims[0]?.citations).toEqual([`schedule:${scheduleId}`])
    expect(completeJson).not.toHaveBeenCalled()
    expect(assistantResultSchema.safeParse(result).success).toBe(true)
  })

  it('explains a weekday excluded by the saved calendar rule without inventing a skip event', async () => {
    const scheduleId = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a'
    const yesterday = shanghaiLocalDate(-1)
    const priorDate = shanghaiLocalDate(-2)
    const yesterdayWeekday = new Date(`${yesterday}T00:00:00.000Z`).getUTCDay() || 7
    const weekdays = [1, 2, 3, 4, 5, 6, 7].filter((day) => day !== yesterdayWeekday)
    vi.mocked(getSchedule).mockResolvedValue({
      scheduleId, targetId: TGT_UUID, name: '工作日采集', enabled: true,
      definition: { timezone: 'Asia/Shanghai', timeRule: {
        kind: 'calendar', timezone: 'Asia/Shanghai', weekdays,
        windows: [{ ruleId: 'daily', windowStart: '02:00', windowEnd: '03:00' }], misfire: 'skip',
      } },
      createdAt: `${priorDate}T08:00:00.000Z`, nextDueAt: null,
    } as any)
    vi.mocked(listScheduleOccurrences).mockResolvedValue({ items: [], nextCursor: null } as any)
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'schedule:read', 'target:read'], targetScope: 'all' } as any,
      body: {
        question: '昨晚这条调度怎么没跑？',
        pageContext: { version: 2, routeKey: 'schedule', pageKind: 'schedule', page: 'schedule',
          primaryRef: { kind: 'schedule', id: scheduleId } },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toContain('不在计划日期')
    expect(result.summary).toContain('没有已记录的跳过事件')
    expect(result.claims[0]?.citations).toEqual([`schedule:${scheduleId}`])
    expect(result.missing).toEqual([])
  })

  it('P10: explains an actual skipped occurrence in the schedule timezone', async () => {
    const scheduleId = '66666666-6666-4666-8666-666666666666'
    const occurrenceId = '77777777-7777-4777-8777-777777777777'
    const yesterday = shanghaiLocalDate(-1)
    vi.mocked(getSchedule).mockResolvedValue({
      scheduleId, targetId: TGT_UUID, name: '夜间订单巡检', enabled: true,
      definition: { timezone: 'Asia/Shanghai' }, createdAt: '2025-01-01T00:00:00.000Z',
    } as any)
    vi.mocked(listScheduleOccurrences).mockResolvedValue({
      items: [{ occurrenceId, scheduleId, localStartDate: yesterday, source: 'scheduled',
        windowStartUtc: `${yesterday}T14:00:00.000Z`, windowEndUtc: null,
        admissionStatus: 'SKIPPED', reason: 'WORKER_UNAVAILABLE', runId: null }],
      nextCursor: null,
    } as any)
    const completeJson = vi.fn()
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'schedule:read', 'target:read'], targetScope: 'all' } as any,
      session: { completeJson } as any,
      body: {
        question: '昨晚这条调度怎么没跑？',
        pageContext: { version: 2, routeKey: 'schedule', pageKind: 'schedule', page: 'schedule',
          primaryRef: { kind: 'schedule', id: scheduleId } },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toContain(yesterday)
    expect(result.summary).toContain('Asia/Shanghai')
    expect(result.summary).toContain('已跳过 1 次')
    expect(result.summary).toContain('WORKER_UNAVAILABLE')
    expect(result.summary).toContain('在准入阶段被跳过')
    expect(result.claims[0]?.citations).toContain(`occurrence:${occurrenceId}`)
    expect(completeJson).not.toHaveBeenCalled()
    expect(assistantResultSchema.safeParse(result).success).toBe(true)
  })

  it('P10: corrects the premise when a scheduled occurrence was admitted', async () => {
    const scheduleId = '88888888-8888-4888-8888-888888888888'
    const occurrenceId = '99999999-9999-4999-8999-999999999999'
    const yesterday = shanghaiLocalDate(-1)
    vi.mocked(getSchedule).mockResolvedValue({
      scheduleId, targetId: TGT_UUID, name: '夜间订单巡检', enabled: true,
      definition: { timezone: 'Asia/Shanghai' }, createdAt: '2025-01-01T00:00:00.000Z',
    } as any)
    vi.mocked(listScheduleOccurrences).mockResolvedValue({
      items: [{ occurrenceId, scheduleId, localStartDate: yesterday, source: 'scheduled',
        windowStartUtc: `${yesterday}T14:00:00.000Z`, windowEndUtc: null,
        admissionStatus: 'ADMITTED', reason: null, runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
      nextCursor: null,
    } as any)
    const ctx = createMockContext({
      actor: { id: 'user-1', permissions: ['ai:assist', 'schedule:read'], targetScope: 'all' } as any,
      body: {
        question: '昨晚这条调度怎么没跑？',
        pageContext: { version: 2, routeKey: 'schedule', pageKind: 'schedule', page: 'schedule',
          primaryRef: { kind: 'schedule', id: scheduleId } },
      },
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.summary).toContain('已准入 1 次')
    expect(result.summary).toContain('不能说完全没跑')
    expect(result.summary).toContain('是否执行完成或成功需要查看关联运行')
    expect(result.claims[0]?.citations).toContain(`occurrence:${occurrenceId}`)
    expect(assistantResultSchema.safeParse(result).success).toBe(true)
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
              { factKind: 'human_confirmed', text: '真实帮助规则',
                evidenceQuote: RETRY_HELP_QUOTE, citations: ['help:studio-retry'] },
              { factKind: 'observed', text: '真实目标状态',
                evidenceQuote: '状态: ACTIVE', citations: ['target:tgt-1'] },
            ],
          },
        }),
      } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.claims.map((claim) => claim.text)).toEqual([RETRY_HELP_QUOTE, '状态: ACTIVE'])
    expect(result.missing.filter((item) => item.reason === 'citation_source_mismatch')).toHaveLength(2)
  })

  it('requires cited source text for inference premises and rejects invented amounts', async () => {
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
                text: '引用键正确但前提是编造的推论',
                citations: ['help:studio-retry'],
                premises: ['所有浏览器均已验证重试必定成功'],
              },
              {
                factKind: 'inferred',
                text: '遇到瞬态异常时可以考虑配置重试',
                citations: ['help:studio-retry'],
                premises: ['填写「重试上限（0~10 次）」'],
              },
              {
                factKind: 'human_confirmed',
                text: 'maxAttempts 默认会自动重试 99 次',
                citations: ['help:studio-retry'],
              },
            ],
            missing: [],
          },
        }),
      } as any,
    })

    const result = await handleKnowledgeAnswer(ctx)
    expect(result.claims.length).toBe(1)
    expect(result.claims[0].factKind).toBe('human_confirmed')
    expect(result.claims[0].text).toContain('重试上限')
    expect(result.claims[0].text).not.toContain('遇到瞬态异常时可以考虑配置重试')
    expect(result.missing.some((m) => m.key === 'unsupported_inference')).toBe(true)
    expect(result.missing.some((m) => m.key === 'unverified_inference')).toBe(true)
    expect(result.missing.some((m) => m.key === 'unsupported_citation')).toBe(true)
    expect(result.missing.some((m) => m.key === 'unsupported_quantity')).toBe(true)
    expect(result.summary).not.toContain('99')
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
      const quoteFor = (citation: string) => userPayload.contextFacts.find((fact: any) => fact.citation === citation).fact

      return Promise.resolve({
        ok: true,
        value: {
          summary: '填写购买数量步骤具有 CSS 选择器定位和变量依赖。',
          claims: [
            {
              factKind: 'observed',
              text: '定位包含 CSS 选择器 input.quantity-field',
              evidenceQuote: quoteFor('step:step-fill-qty:selector'),
              citations: ['step:step-fill-qty:selector'],
            },
            {
              factKind: 'observed',
              text: '引用了上游 itemUrl 变量，并将结果写入 submittedQty',
              evidenceQuote: quoteFor('step:step-fill-qty:vars'),
              citations: ['step:step-fill-qty:vars'],
            },
            {
              factKind: 'observed',
              text: '紧邻前置分支判定步骤 检查库存状态',
              evidenceQuote: quoteFor('step:step-fill-qty:flow'),
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

      const completeJsonMock = vi.fn()

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

      expect(completeJsonMock).not.toHaveBeenCalled()
      expect(result.summary).toContain('分为 2 个错误表现组；现有事实不能确认它们同因')
      expect(result.summary).toContain('填写地址：TIMEOUT_WAITING_FOR_SELECTOR（3 次）')
      expect(result.summary).toContain('提交订单：BUTTON_NOT_INTERACTABLE（1 次）')
      expect(result.claims[0]?.citations).toEqual([
        'platform:run_failure_digest_v1',
        ...mockRuns.map((run) => `run:${run.id}`),
      ])

      // 验证处置动作
      expect(result.nextActions).toBeDefined()
      expect(result.nextActions?.some((a) => a.kind === 'run.detail' && a.href === '/runs/11111111-1111-1111-1111-111111111111')).toBe(true)
      expect(result.nextActions?.some((a) => a.kind === 'run.detail' && a.href === '/runs/44444444-4444-4444-4444-444444444444')).toBe(true)
      expect(result.claims).toHaveLength(1)
    })

    it('failure digest does not claim an incident as the cause of a Run failure', async () => {
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

      const completeJsonMock = vi.fn()

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

      expect(listIncidents).not.toHaveBeenCalled()
      expect(completeJsonMock).not.toHaveBeenCalled()
      expect(result.summary).toContain('只有 1 条失败运行，无法判断多次失败是否同因')
      expect(result.claims[0].citations).toEqual([
        'platform:run_failure_digest_v1',
        'run:11111111-1111-1111-1111-111111111111',
      ])
      expect(result.nextActions?.every((action) => action.kind === 'run.detail')).toBe(true)
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

    it('failure digest only requires Run permission and does not infer reliability incidents', async () => {
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
      expect(result.summary).toContain('只有 1 条失败运行')
      expect(result.missing.some((m) => m.key === 'reliability_incidents')).toBe(false)
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
      vi.mocked(getScenario).mockResolvedValue({ id: SC_UUID, name: '订单创建', targetId: TGT_UUID } as never)
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

      const result = await handleKnowledgeAnswer(ctx)
      expect(result.summary).toContain('场景「订单创建」最近 7 天没有状态为 FAILED 的运行记录')
      expect(result.summary).toContain('不代表其余运行的业务检查都通过')
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

    it('页面选中步骤但明确问整个场景失败记录时仍限定 scenarioId', async () => {
      vi.mocked(getScenario).mockResolvedValue({ id: SC_UUID, name: '订单创建', targetId: TGT_UUID } as never)
      vi.mocked(listRuns).mockResolvedValue({ items: [], nextCursor: null } as never)
      const question = '分析当前场景最近 7 天内的失败运行记录，归纳主要失败原因。'
      const result = await handleKnowledgeAnswer(createMockContext({
        actor: { id: 'user-1', permissions: ['ai:assist', 'workflow:read', 'run:read', 'target:read'] } as never,
        slots: { scenarioId: SC_UUID, stepId: 'step-1' }, question,
        body: { question, pageContext: { page: 'studio', scenarioId: SC_UUID, stepId: 'step-1' } },
      }))
      expect(result.summary).toContain('场景「订单创建」最近 7 天没有状态为 FAILED')
      expect(listRuns).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        scenarioId: SC_UUID, status: 'FAILED', limit: 50,
      }), 'user-1')
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

      const completeJsonMock = vi.fn()

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

      const result = await handleKnowledgeAnswer(ctx)
      expect(completeJsonMock).not.toHaveBeenCalled()
      expect(result.summary).toContain('已达单批上限 50 条，仅分析最近 50 次失败')
      expect(result.claims[0]?.citations).toHaveLength(51)
      expect(result.missing).toContainEqual(expect.objectContaining({ key: 'older_runs', reason: 'truncated' }))
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

    it('failure digest stays within the authorized Run set and links its representative Run', async () => {
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
      const completeJson = vi.fn()
      const ctx = createMockContext({
        actor: { id: 'user-1', name: 'Ops', permissions: ['ai:assist', 'run:read', 'reliability:read'], targetScope: 'all' },
        session: { completeJson } as any,
        body: {
          question: '这些失败是同一个原因吗？',
          pageContext: { version: 2, routeKey: 'runs', pageKind: 'run', page: 'run', view: { filters: { status: 'FAILED' } } },
        },
      })
      const result = await handleKnowledgeAnswer(ctx)
      expect(listIncidents).not.toHaveBeenCalled()
      expect(completeJson).not.toHaveBeenCalled()
      expect(result.summary).toContain('LOCATOR_NOT_FOUND')
      expect(result.claims[0]?.citations).toEqual(['platform:run_failure_digest_v1', `run:${runIdA}`])
      expect(result.nextActions?.[0]).toMatchObject({ kind: 'run.detail', href: `/runs/${runIdA}` })
      expect(result.nextActions).toHaveLength(1)
    })
  })
})
