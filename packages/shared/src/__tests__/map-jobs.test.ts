import { describe, expect, it } from 'vitest'
import {
  FACTORY_MAP_JOB_POLICY,
  isMapJobRun,
  mapJobCommandKey,
  mapJobIdempotencyKey,
  originsForAccessPurposes,
  seedTargetAccessRules,
  targetAccessPolicyUpdateBodySchema,
} from '../map-jobs.js'

describe('地图作业契约', () => {
  it('工厂作业政策默认关闭', () => {
    expect(FACTORY_MAP_JOB_POLICY.manualJobsEnabled).toBe(false)
    expect(FACTORY_MAP_JOB_POLICY.maxProbePages).toBe(1)
    expect(FACTORY_MAP_JOB_POLICY.sliceWorkSeconds).toBe(20)
  })

  it('从入口派生授权且资源域不进入可操作 origin', () => {
    const rules = seedTargetAccessRules('https://shop.example/orders', 'https://idp.example/login')
    const policy = { schemaVersion: 1 as const, policyVersion: 1, rules }
    expect(originsForAccessPurposes(policy, ['business_surface'])).toEqual(['https://shop.example'])
    expect(originsForAccessPurposes(policy, ['authentication'])).toEqual(['https://idp.example'])
    expect(originsForAccessPurposes(policy, ['resource'])).toEqual([])
  })

  it('deny 优先于 allow', () => {
    const policy = {
      schemaVersion: 1 as const,
      policyVersion: 1,
      rules: [
        { origin: 'https://shop.example', purpose: 'business_surface' as const, effect: 'allow' as const },
        { origin: 'https://shop.example', purpose: 'business_surface' as const, effect: 'deny' as const },
      ],
    }
    expect(originsForAccessPurposes(policy, ['business_surface'])).toEqual([])
  })

  it('缺 mapJob 视为用户 Run', () => {
    expect(isMapJobRun({})).toBe(false)
    expect(mapJobIdempotencyKey({
      targetId: '00000000-0000-4000-8000-000000000001',
      targetAccountId: '00000000-0000-4000-8000-000000000002',
      manualId: 'manual-1',
    })).toMatch(/^map:manual:/)
    expect(
      mapJobCommandKey({
        source: 'scheduled',
        targetId: '00000000-0000-4000-8000-000000000001',
        targetAccountId: '00000000-0000-4000-8000-000000000002',
        occurrenceId: '00000000-0000-4000-8000-000000000003',
      }),
    ).toBe('map:scheduled:00000000-0000-4000-8000-000000000003')
    expect(
      mapJobCommandKey({
        source: 'explore',
        targetId: '00000000-0000-4000-8000-000000000001',
        targetAccountId: '00000000-0000-4000-8000-000000000002',
        manualId: 'manual-explore-1',
      }),
    ).toBe('map:explore:manual-explore-1')
  })

  it('授权更新必须带修订和理由', () => {
    expect(() =>
      targetAccessPolicyUpdateBodySchema.parse({
        expectedRevision: 0,
        idempotencyKey: 'policy-1',
        rules: [],
        reason: '空规则',
      }),
    ).toThrow()
  })
})
