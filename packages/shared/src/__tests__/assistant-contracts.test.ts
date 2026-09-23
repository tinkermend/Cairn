import { describe, expect, it } from 'vitest'
import {
  contextItemScopeSchema,
  contextFactKindSchema,
  contextCoverageSchema,
  contextItemSchema,
  assistantStructuredFactSchema,
} from '../assistant-contracts.js'

describe('Assistant Contracts Scheme B extensions', () => {
  it('validates platform and target scopes', () => {
    const platformScope = { kind: 'platform' as const }
    expect(contextItemScopeSchema.parse(platformScope)).toEqual({ kind: 'platform' })

    const targetScope = {
      kind: 'target' as const,
      targetId: 't-123',
      scenarioId: 'sc-456',
      runId: 'r-789',
    }
    expect(contextItemScopeSchema.parse(targetScope)).toEqual(targetScope)
  })

  it('supports user_supplied_unverified factKind', () => {
    expect(contextFactKindSchema.parse('observed')).toBe('observed')
    expect(contextFactKindSchema.parse('human_confirmed')).toBe('human_confirmed')
    expect(contextFactKindSchema.parse('inferred')).toBe('inferred')
    expect(contextFactKindSchema.parse('user_supplied_unverified')).toBe('user_supplied_unverified')
  })

  it('validates ContextItem with temporal triad and coverage', () => {
    const item = {
      sourceRef: {
        kind: 'run',
        id: 'r-1',
        revision: 1,
        fragment: 'step-1',
      },
      scope: { kind: 'target' as const, targetId: 't-1' },
      factKind: 'observed' as const,
      observedAt: '2026-09-23T10:00:00.000Z',
      collectedAt: '2026-09-23T10:01:00.000Z',
      validUntil: '2026-09-23T10:05:00.000Z',
      validity: null,
      sensitivity: 'business' as const,
      content: '测试运行已完成',
      evidenceRefs: ['ev-1'],
      coverage: {
        scopeRange: 'run:r-1',
        status: 'complete' as const,
        completenessBasis: 'frozen_run_snapshot',
      },
    }

    const parsed = contextItemSchema.parse(item)
    expect(parsed.observedAt).toBe('2026-09-23T10:00:00.000Z')
    expect(parsed.coverage?.status).toBe('complete')
  })

  it('validates AssistantStructuredFact DTO', () => {
    const fact = {
      factKey: 'worker.heartbeat.freshness',
      label: 'Worker 节点心跳新鲜度',
      value: true,
      unit: 'boolean',
      scope: { kind: 'platform' as const },
      sourceRef: { kind: 'monitoring', id: 'worker-1' },
      observedAt: '2026-09-23T10:00:00.000Z',
      collectedAt: '2026-09-23T10:00:05.000Z',
      validUntil: '2026-09-23T10:00:15.000Z',
    }

    const parsed = assistantStructuredFactSchema.parse(fact)
    expect(parsed.factKey).toBe('worker.heartbeat.freshness')
    expect(parsed.value).toBe(true)
    expect(parsed.scope).toEqual({ kind: 'platform' })
  })
})
