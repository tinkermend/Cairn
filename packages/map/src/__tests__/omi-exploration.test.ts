import { describe, expect, it } from 'vitest'
import { compileMapJobSlice } from '../jobs.js'
import { buildObservationBundle, decideExploreGuard, proposeExploreHop } from '../exploration.js'
import { FACTORY_EXPLORATION_POLICY, type MapSafeEntry } from '@cairn/shared'

const entry: MapSafeEntry = {
  entryId: '00000000-0000-4000-8000-000000000013',
  version: 1,
  name: '订单入口',
  url: 'https://shop.example/orders',
  arrivalName: '订单标题',
  arrivalTarget: { framePath: [], candidates: [{ by: 'role', value: 'heading', name: '订单' }] },
  safetyBasis: {
    kind: 'confirmed_path',
    summary: '只读复查已确认路径',
    confirmedBy: '00000000-0000-4000-8000-000000000014',
    confirmedAt: '2026-09-16T00:00:00.000Z',
  },
  jobKinds: ['map_explore'],
}

const policy = {
  ...FACTORY_EXPLORATION_POLICY,
  allowlist: [{ origin: 'https://shop.example', pathPrefix: '/orders' }],
}

describe('OM-I 编译与守卫', () => {
  it('OMI01 空名单或模型提名不能编译', () => {
    expect(compileMapJobSlice({ jobKind: 'map_explore', entry, included: [] }).ok).toBe(false)
    expect(
      compileMapJobSlice({
        jobKind: 'map_explore',
        entry,
        included: [],
        exploration: { ...policy, modelEnabled: true },
      }).ok,
    ).toBe(false)
  })

  it('OMI05 探索分片固定 6 步且全部只读', () => {
    const compiled = compileMapJobSlice({
      jobKind: 'map_explore',
      entry,
      included: [],
      exploration: policy,
    })
    expect(compiled).toMatchObject({ ok: true })
    if (!compiled.ok) return
    expect(compiled.steps).toHaveLength(6)
    expect(compiled.steps.map((step) => step.type)).toEqual([
      'navigate',
      'assert',
      'map_observe',
      'map_propose',
      'map_guarded_action',
      'map_verify',
    ])
    expect(compiled.steps.every((step) => step.effectType === 'READ_ONLY')).toBe(true)
  })

  it('OMI02 名单外不提名，名单内只给未访问地址', () => {
    const observed = buildObservationBundle({
      currentUrl: 'https://shop.example/orders',
      policy,
      seedUrls: ['https://shop.example/orders', 'https://shop.example/pay', 'https://shop.example/orders/open'],
    })
    expect(observed.candidates.map((item) => item.url)).toEqual(['https://shop.example/orders/open'])
    expect(proposeExploreHop(observed)).toMatchObject({ kind: 'navigate', candidateId: 'nav:1' })
    expect(proposeExploreHop({ ...observed, candidates: [] })).toEqual({ kind: 'stop', reason: 'no_safe_candidate' })
  })

  it('OMI03/04 守卫拒绝自由 URL 与未引用候选', () => {
    const observed = buildObservationBundle({
      currentUrl: 'https://shop.example/orders',
      policy,
      seedUrls: ['https://shop.example/orders/open'],
    })
    expect(
      decideExploreGuard({
        proposal: { kind: 'navigate', url: 'https://evil.example', reason: '自由地址' },
        observation: observed,
        policy,
      }).decision,
    ).toBe('stop')
    expect(
      decideExploreGuard({
        proposal: proposeExploreHop(observed),
        observation: observed,
        policy,
      }).decision,
    ).toBe('allow')
    expect(
      decideExploreGuard({
        proposal: { kind: 'stop', reason: 'no_safe_candidate' },
        observation: observed,
        policy,
      }).decision,
    ).toBe('skip')
  })
})
