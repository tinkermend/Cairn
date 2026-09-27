import { describe, expect, it } from 'vitest'
import {
  FACTORY_MAP_JOB_POLICY,
  isMapJobRun,
  MAP_JOB_EVIDENCE_POLICY,
  mapJobCommandKey,
  mapJobIdempotencyKey,
  originsForAccessPurposes,
  runListQuerySchema,
  seedTargetAccessRules,
  targetAccessPolicyUpdateBodySchema,
  targetAccessPolicySchema,
} from '../index.js'

describe('地图作业契约', () => {
  it('工厂作业政策默认关闭', () => {
    expect(FACTORY_MAP_JOB_POLICY.manualJobsEnabled).toBe(false)
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

  it('路径级 deny 不从 allowedOrigins 删除 origin', () => {
    const policy = {
      schemaVersion: 1 as const,
      policyVersion: 1,
      rules: [
        { origin: 'https://shop.example', purpose: 'business_surface' as const, effect: 'allow' as const, pathPrefix: '/' },
        { origin: 'https://shop.example', purpose: 'business_surface' as const, effect: 'deny' as const, pathPrefix: '/admin' },
      ],
    }
    expect(originsForAccessPurposes(policy, ['business_surface'])).toEqual(['https://shop.example'])
  })

  it('发布 pathPrefix 必须是路径且不含 query', () => {
    const base = {
      expectedRevision: 0,
      idempotencyKey: 'policy-path-1',
      reason: '收窄路径',
    }
    expect(() =>
      targetAccessPolicyUpdateBodySchema.parse({
        ...base,
        rules: [{ origin: 'https://shop.example', purpose: 'business_surface', effect: 'allow', pathPrefix: 'orders' }],
      }),
    ).toThrow()
    expect(() =>
      targetAccessPolicyUpdateBodySchema.parse({
        ...base,
        rules: [{ origin: 'https://shop.example', purpose: 'business_surface', effect: 'allow', pathPrefix: '/orders?x=1' }],
      }),
    ).toThrow()
    expect(
      targetAccessPolicyUpdateBodySchema.parse({
        ...base,
        rules: [{ origin: 'https://shop.example', purpose: 'business_surface', effect: 'allow', pathPrefix: '/orders' }],
      }).rules[0]?.pathPrefix,
    ).toBe('/orders')
  })

  it('非页面数据例外必须有精确请求身份和核实依据，空规则保持旧策略形状', () => {
    const base = { schemaVersion: 1, policyVersion: 1,
      rules: [{ origin: 'https://shop.example', purpose: 'business_surface', effect: 'allow' }] }
    expect(targetAccessPolicySchema.parse(base).verifiedNonContentRequests).toBeUndefined()
    const rule = { method: 'POST', resourceType: 'xhr', origin: 'https://metrics.example',
      pathPattern: '/collect', evidence: '已核对前端调用，仅上报访问统计，不驱动页面内容' }
    expect(targetAccessPolicySchema.parse({ ...base, verifiedNonContentRequests: [rule] })
      .verifiedNonContentRequests).toEqual([rule])
    for (const invalid of [
      { ...rule, origin: 'https://metrics.example/other' },
      { ...rule, pathPattern: '/collect?kind=page' },
      { ...rule, pathPattern: '/collect/*' },
      { ...rule, resourceType: 'document' },
      { ...rule, evidence: '猜测' },
    ]) expect(targetAccessPolicySchema.safeParse({ ...base, verifiedNonContentRequests: [invalid] }).success).toBe(false)
  })

  it('地图作业证据策略关闭截图与录像', () => {
    expect(MAP_JOB_EVIDENCE_POLICY).toEqual({
      screenshot: 'off',
      video: 'off',
      trace: 'off',
    })
  })

  it('运行列表缺省不含 isMapJob，显式 true 才只看作业', () => {
    expect(runListQuerySchema.parse({}).isMapJob).toBeUndefined()
    expect(runListQuerySchema.parse({ isMapJob: true }).isMapJob).toBe(true)
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
