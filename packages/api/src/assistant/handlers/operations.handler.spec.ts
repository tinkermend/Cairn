import { describe, expect, it, vi } from 'vitest'
import {
  handleOperationsDiagnose,
  handleSchedulePropose,
  handleOperationsAction,
} from './operations.handler.js'
import type { AssistantCapabilityHandlerContext } from '../registry.js'

function mockContext(overrides: Partial<AssistantCapabilityHandlerContext> = {}): AssistantCapabilityHandlerContext {
  return {
    db: {} as any,
    actor: {
      id: 'user-001',
      displayName: 'Operator',
      email: 'op@example.com',
      status: 'active',
      roles: [],
      permissions: ['ai:assist', 'monitoring:read', 'schedule:write'],
    },
    slots: {},
    question: '排队积压情况如何？',
    body: { question: '排队积压情况如何？' },
    session: null,
    platformConfig: {} as any,
    targets: {} as any,
    models: {} as any,
    onProgress: vi.fn(),
    ...overrides,
  }
}

describe('AI-04 D2: Operations Assistant Handler Tests', () => {
  describe('handleOperationsDiagnose', () => {
    it('returns queue backlog diagnosis with safe suggestions', async () => {
      const ctx = mockContext({
        question: '为什么当前任务排队积压这么严重？',
        slots: { kind: 'queue_backlog' },
      })

      const result = await handleOperationsDiagnose(ctx)
      expect(result.kind).toBe('diagnosis')
      if (result.kind === 'diagnosis') {
        expect(result.observations.length).toBeGreaterThan(0)
        expect(result.hypotheses.some((h) => h.citations.includes('monitoring:queue_backlog:slot_utilization_high'))).toBe(true)
        expect((result as any).operationsDiagnosis.suggestedActions[0].actionKey).toBe('schedule.pause')
      }
    })

    it('returns auth waiting diagnosis with 2FA instructions', async () => {
      const ctx = mockContext({
        question: '为什么任务一直处于等待认证状态？',
        slots: { kind: 'auth_waiting' },
      })

      const result = await handleOperationsDiagnose(ctx)
      expect(result.kind).toBe('diagnosis')
      if (result.kind === 'diagnosis') {
        expect(result.observations.some((o) => o.includes('WAITING_FOR_AUTH'))).toBe(true)
        expect(result.missingChecks.some((c) => c.includes('TOTP'))).toBe(true)
      }
    })
  })

  describe('handleSchedulePropose', () => {
    it('binds timezone and computes deterministic 5-occurrence preview', async () => {
      const ctx = mockContext({
        question: '请帮我每天凌晨2点定时执行巡检',
        slots: {
          cronExpr: '0 2 * * 1-5',
          timezone: 'Asia/Shanghai',
          name: '工作日凌晨巡检',
        },
      })

      const result = await handleSchedulePropose(ctx)
      expect(result.kind).toBe('explanation')
      const proposal = (result as any).scheduleProposal
      expect(proposal).toBeDefined()
      expect(proposal.timezone).toBe('Asia/Shanghai')
      expect(proposal.preview).toHaveLength(5)
    })
  })

  describe('handleOperationsAction', () => {
    it('allows low-risk single-resource pause action from allowlist', async () => {
      const ctx = mockContext({
        slots: {
          actionKey: 'schedule.pause',
          resourceKind: 'schedule',
          resourceId: '00000000-0000-4000-8000-000000000001',
          expectedRevision: 1,
        },
      })

      const proposal = await handleOperationsAction(ctx)
      expect(proposal.actionKey).toBe('schedule.pause')
      expect(proposal.resources).toHaveLength(1)
      expect(proposal.resources[0]?.id).toBe('00000000-0000-4000-8000-000000000001')
      expect(proposal.impact).toContain('将暂停调度任务')
      expect(new Date(proposal.expiresAt).getTime()).toBeGreaterThan(Date.now())
    })

    it('allows low-risk single-resource cancel action from allowlist', async () => {
      const ctx = mockContext({
        slots: {
          actionKey: 'run.cancel_single',
          resourceKind: 'run',
          resourceId: '00000000-0000-4000-8000-000000000002',
          expectedRevision: 1,
        },
      })

      const proposal = await handleOperationsAction(ctx)
      expect(proposal.actionKey).toBe('run.cancel_single')
      expect(proposal.impact).toContain('单个 Run')
    })

    it('rejects disallowed actionKey not in allowlist', async () => {
      const ctx = mockContext({
        slots: {
          actionKey: 'run.cancel_batch', // 严禁批量撤销
          resourceKind: 'run',
          resourceId: '00000000-0000-4000-8000-000000000003',
        },
      })

      await expect(handleOperationsAction(ctx)).rejects.toThrow('操作助手仅允许执行受控白名单动作')
    })

    it('rejects missing resourceId', async () => {
      const ctx = mockContext({
        slots: {
          actionKey: 'schedule.pause',
        },
      })

      await expect(handleOperationsAction(ctx)).rejects.toThrow('缺少操作目标资源 ID')
    })
  })
})

