import { describe, expect, it } from 'vitest'
import {
  FACTORY_EXPLORATION_POLICY,
  FACTORY_PLATFORM_CONFIG,
  executableStepTypesFor,
  explorationPolicyUpdateBodySchema,
  explorationProposalSchema,
  isUrlInExploreAllowlist,
  mapExploreCommandKey,
  mapJobCommandKey,
  mapJobCreateBodySchema,
  mapObserveStepSchema,
  stepSchema,
  stepUsesBrowser,
} from '../index.js'

describe('OM-I 探索契约', () => {
  it('工厂探索政策与平台开关默认关闭', () => {
    expect(FACTORY_EXPLORATION_POLICY.exploreEnabled).toBe(false)
    expect(FACTORY_EXPLORATION_POLICY.modelEnabled).toBe(false)
    expect(FACTORY_EXPLORATION_POLICY.mode).toBe('allowlist')
    expect(FACTORY_PLATFORM_CONFIG.mapExplorationEnabled).toBe(false)
    expect(executableStepTypesFor(true)).not.toContain('map_observe')
    expect(executableStepTypesFor(false)).not.toContain('map_propose')
  })

  it('OMI01 Schema 拒绝 open_in_target / 写入字段', () => {
    expect(() =>
      explorationPolicyUpdateBodySchema.parse({
        expectedRevision: 0,
        idempotencyKey: 'explore-1',
        exploreEnabled: true,
        mode: 'open_in_target',
        reason: '全站',
      }),
    ).toThrow()
    expect(() =>
      explorationPolicyUpdateBodySchema.parse({
        expectedRevision: 0,
        idempotencyKey: 'explore-1',
        exploreEnabled: true,
        mode: 'allowlist',
        write: true,
        reason: '写入',
      }),
    ).toThrow()
    expect(() =>
      explorationProposalSchema.parse({
        kind: 'write',
        reason: '提交',
      }),
    ).toThrow()
  })

  it('探索命令键短于 128，且与作业来源对齐', () => {
    expect(mapExploreCommandKey('manual-explore-1')).toBe('map:explore:manual-explore-1')
    expect(
      mapJobCommandKey({
        source: 'explore',
        targetId: '00000000-0000-4000-8000-000000000001',
        targetAccountId: '00000000-0000-4000-8000-000000000002',
        manualId: 'manual-explore-1',
      }),
    ).toBe('map:explore:manual-explore-1')
  })

  it('map_explore 必须带 explore 来源与探索修订', () => {
    const base = {
      manualId: 'manual-explore-1',
      expectedPolicyRevision: 0,
      jobKind: 'map_explore',
      targetAccountId: '00000000-0000-4000-8000-000000000002',
      entryId: '00000000-0000-4000-8000-000000000003',
    }
    expect(() => mapJobCreateBodySchema.parse(base)).toThrow()
    expect(
      mapJobCreateBodySchema.parse({
        ...base,
        source: 'explore',
        expectedExplorationRevision: 0,
      }).source,
    ).toBe('explore')
  })

  it('allowlist 只匹配 origin 与可选 pathPrefix', () => {
    const allowlist = [{ origin: 'https://shop.example', pathPrefix: '/orders' }]
    expect(isUrlInExploreAllowlist('https://shop.example/orders/1', allowlist)).toBe(true)
    expect(isUrlInExploreAllowlist('https://shop.example/pay', allowlist)).toBe(false)
    expect(isUrlInExploreAllowlist('https://other.example/orders', allowlist)).toBe(false)
    expect(isUrlInExploreAllowlist('https://shop.example/orders-admin', allowlist)).toBe(false)
  })

  it('探索步骤只读，propose 不占用浏览器', () => {
    const observe = mapObserveStepSchema.parse({
      id: '00000000-0000-4000-8000-000000000101',
      name: '观察',
      type: 'map_observe',
      effectType: 'READ_ONLY',
      outputKey: 'explore_observation',
      input: { mode: 'allowlist', allowlist: [{ origin: 'https://shop.example' }], seedUrls: [] },
    })
    expect(stepSchema.parse(observe).effectType).toBe('READ_ONLY')
    expect(stepUsesBrowser('map_observe')).toBe(true)
    expect(stepUsesBrowser('map_propose')).toBe(false)
    expect(stepUsesBrowser('map_guarded_action')).toBe(true)
    expect(stepUsesBrowser('map_verify')).toBe(true)
  })
})
