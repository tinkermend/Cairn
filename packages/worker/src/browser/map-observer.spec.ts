import { describe, expect, it, vi } from 'vitest'
import { FACTORY_MAP_CAPTURE_POLICY, mapConditionSnapshot } from '@cairn/shared'
import { createPassiveMapObservationPort } from './map-observer.js'
import type { BrowserSessionManager } from './session-manager.js'

const ids = {
  run: '22222222-2222-4222-8222-222222222222',
  step: '33333333-3333-4333-8333-333333333333',
  attempt: '44444444-4444-4444-8444-444444444444',
  target: '11111111-1111-4111-8111-111111111111',
  account: '66666666-6666-4666-8666-666666666666',
  lease: '77777777-7777-4777-8777-777777777777',
}

function request(overrides?: Partial<Parameters<ReturnType<typeof createPassiveMapObservationPort>['capture']>[0]>) {
  return {
    grant: { runId: ids.run, fencingToken: 1, holderWorkerId: 'w', expiresAt: new Date().toISOString() },
    sessionGrant: {
      sessionId: ids.lease,
      leaseId: ids.lease,
      generation: 1,
      sessionFencingToken: 1,
      expiresAt: new Date().toISOString(),
      purpose: 'EXECUTION' as const,
      ownerKind: 'RUN' as const,
      runId: ids.run,
    },
    runId: ids.run,
    stepRunId: ids.step,
    attemptId: ids.attempt,
    phase: 'after_action' as const,
    targetId: ids.target,
    policy: { ...FACTORY_MAP_CAPTURE_POLICY, enabled: true, maxNodes: 20 },
    sourceType: 'probe' as const,
    condition: mapConditionSnapshot({ targetId: ids.target, targetAccountId: ids.account }),
    remainingStepMs: 8_000,
    runBudgetUsedMs: 0,
    stepType: 'assert',
    allowedOrigins: ['https://shop.example'],
    ...overrides,
  }
}

describe('被动地图观察端口', () => {
  it('采集标题和具名控件，未授权 iframe 仍保留主页面观察', async () => {
    const evaluate = vi.fn(async () => ({
      title: '订单中心',
      heading: '订单',
      locale: 'zh-CN',
      viewport: { category: 'desktop', widthPx: 1280, heightPx: 800 },
      ready: true,
      empty: false,
      loading: false,
      nodeCount: 3,
      truncated: false,
      closedShadow: false,
      canvas: false,
      landmarks: [{ role: 'main', name: 'main' }],
      named: [
        { role: 'heading', name: '订单' },
        { role: 'link', name: '待发货' },
      ],
    }))
    const port = createPassiveMapObservationPort({
      pageForGrant: () => ({
        url: () => 'https://shop.example/orders',
        frames: () => [{ url: () => 'https://ads.example/pixel' }],
        evaluate,
      }),
    } as unknown as BrowserSessionManager)
    const result = await port.capture(request())
    expect('observation' in result).toBe(true)
    if (!('observation' in result)) return
    expect(evaluate).toHaveBeenCalled()
    expect(result.observation.captureStatus).toBe('observed')
    expect(result.observation.topUrlPattern).toBe('https://shop.example/orders')
    expect(result.observation.semanticSummary.predicates).toContainEqual({ name: 'label', value: '订单中心' })
    expect(result.observation.missingReasons).toContain('CAPABILITY_MISSING')
    expect(result.observation.conditionSnapshot.locale).toBe('zh-CN')
    expect(result.observation.structuralSummary.nodeCount).toBe(3)
    expect(result.observation.regionRefs).toEqual([{ key: 'main', kind: 'region' }])
  })

  it('about:blank 仍记 NOT_APPLICABLE 缺口', async () => {
    const port = createPassiveMapObservationPort({
      pageForGrant: () => ({
        url: () => 'about:blank',
        frames: () => [],
        evaluate: vi.fn(),
      }),
    } as unknown as BrowserSessionManager)
    const result = await port.capture(request())
    expect('gap' in result || ('observation' in result && result.observation.captureStatus === 'missing')).toBe(true)
    const observation = 'observation' in result ? result.observation : result.gap
    expect(observation.captureStatus).toBe('missing')
    expect(observation.captureReason).toBe('NOT_APPLICABLE')
  })
})
