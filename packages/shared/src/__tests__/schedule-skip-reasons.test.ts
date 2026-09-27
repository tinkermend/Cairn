import { describe, expect, it } from 'vitest'
import {
  SCHEDULE_SKIP_REASONS,
  SCHEDULE_SKIP_REASON_METAS,
  resolveSkipReasonAction,
  ASSISTANT_NEXT_ACTION_KINDS,
  assistantCitationKeySchema,
  assistantNextActionSchema,
} from '../index.js'

describe('schedule skip reasons metadata & contract', () => {
  it('covers all 27 SCHEDULE_SKIP_REASONS with non-empty label and explanation', () => {
    expect(SCHEDULE_SKIP_REASONS).toHaveLength(27)
    for (const reason of SCHEDULE_SKIP_REASONS) {
      const meta = SCHEDULE_SKIP_REASON_METAS[reason]
      expect(meta, `missing meta for reason: ${reason}`).toBeDefined()
      expect(meta.label.trim().length).toBeGreaterThan(0)
      expect(meta.explanation.trim().length).toBeGreaterThan(0)

      if (meta.action) {
        expect(meta.action.label.trim().length).toBeGreaterThan(0)
        expect(meta.action.pathTemplate.startsWith('/')).toBe(true)
        expect(ASSISTANT_NEXT_ACTION_KINDS).toContain(meta.action.kind)
      }
    }
  })

  it('correctly resolves action paths with parameters', () => {
    const authAction = resolveSkipReasonAction('AUTH_PREPARATION_REQUIRED', {
      targetId: 'tgt-123',
    })
    expect(authAction).toEqual({
      kind: 'target.accounts',
      label: '去认证账号',
      href: '/sessions/tgt-123',
    })

    // Missing targetId should return null when path template requires it
    const missingTarget = resolveSkipReasonAction('AUTH_PREPARATION_REQUIRED', {})
    expect(missingTarget).toBeNull()

    // Covered by run
    const runAction = resolveSkipReasonAction('COVERED_BY_RUN', {
      runId: 'run-456',
    })
    expect(runAction).toEqual({
      kind: 'run.detail',
      label: '查看对应运行',
      href: '/runs/run-456',
    })

    // Reasons without actions return null
    expect(resolveSkipReasonAction('WINDOW_CLOSED')).toBeNull()
    expect(resolveSkipReasonAction('NO_NEW_DATA')).toBeNull()

    expect(resolveSkipReasonAction('FACTORY_DISABLED')).toEqual({
      kind: 'platform.config',
      label: '前往平台配置',
      href: '/platform-config',
    })
  })

  it('assistantCitationKeySchema validates occurrence, schedule, dataset, incident keys', () => {
    const validUuid = '12345678-1234-4234-8234-123456789abc'
    expect(() => assistantCitationKeySchema.parse(`occurrence:${validUuid}`)).not.toThrow()
    expect(() => assistantCitationKeySchema.parse(`schedule:${validUuid}`)).not.toThrow()
    expect(() => assistantCitationKeySchema.parse(`dataset:${validUuid}`)).not.toThrow()
    expect(() => assistantCitationKeySchema.parse(`run:${validUuid}`)).not.toThrow()
    expect(() => assistantCitationKeySchema.parse(`incident:${validUuid}`)).not.toThrow()

    expect(() => assistantCitationKeySchema.parse('invalid:123')).toThrow()
  })

  it('assistantNextActionSchema validates actions with occurrence or incident citation', () => {
    const validUuid = '12345678-1234-4234-8234-123456789abc'
    const action = {
      kind: 'target.accounts',
      label: '去认证账号',
      href: '/sessions/tgt-1',
      citations: [`occurrence:${validUuid}`],
    }
    expect(() => assistantNextActionSchema.parse(action)).not.toThrow()

    const incidentAction = {
      kind: 'incident.detail',
      label: '查看可靠性事件详情',
      href: `/maintenance/incidents/${validUuid}`,
      citations: [`incident:${validUuid}`],
    }
    expect(() => assistantNextActionSchema.parse(incidentAction)).not.toThrow()
  })
})
