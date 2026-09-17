import { describe, expect, it } from 'vitest'
import {
  compileAccessScopeFromSnapshot,
  originsForAccessPurposes,
  urlAllowedByAccessRules,
  urlAllowedByCompiledScope,
} from '../access-scope.js'

const shop = 'https://shop.example'
const idp = 'https://idp.example'

describe('访问策略路径匹配', () => {
  it('PP01 allow /orders 按段边界匹配', () => {
    const rules = [{ origin: shop, purpose: 'business_surface' as const, effect: 'allow' as const, pathPrefix: '/orders' }]
    expect(urlAllowedByAccessRules(`${shop}/orders`, rules, ['business_surface'])).toBe(true)
    expect(urlAllowedByAccessRules(`${shop}/orders/1`, rules, ['business_surface'])).toBe(true)
    expect(urlAllowedByAccessRules(`${shop}/admin`, rules, ['business_surface'])).toBe(false)
    expect(urlAllowedByAccessRules(`${shop}/orders-admin`, rules, ['business_surface'])).toBe(false)
  })

  it('PP02 allow / + deny /admin 仍保留 origin', () => {
    const policy = {
      schemaVersion: 1 as const,
      policyVersion: 1,
      rules: [
        { origin: shop, purpose: 'business_surface' as const, effect: 'allow' as const, pathPrefix: '/' },
        { origin: shop, purpose: 'business_surface' as const, effect: 'deny' as const, pathPrefix: '/admin' },
      ],
    }
    expect(urlAllowedByAccessRules(`${shop}/app`, policy.rules, ['business_surface'])).toBe(true)
    expect(urlAllowedByAccessRules(`${shop}/admin`, policy.rules, ['business_surface'])).toBe(false)
    expect(urlAllowedByAccessRules(`${shop}/admin/x`, policy.rules, ['business_surface'])).toBe(false)
    expect(originsForAccessPurposes(policy, ['business_surface'])).toEqual([shop])
  })

  it('PP03 无前缀 deny 否决整个 origin', () => {
    const policy = {
      schemaVersion: 1 as const,
      policyVersion: 1,
      rules: [
        { origin: shop, purpose: 'business_surface' as const, effect: 'allow' as const },
        { origin: shop, purpose: 'business_surface' as const, effect: 'deny' as const },
      ],
    }
    expect(urlAllowedByAccessRules(`${shop}/app`, policy.rules, ['business_surface'])).toBe(false)
    expect(originsForAccessPurposes(policy, ['business_surface'])).toEqual([])
  })

  it('PP04 deny 与 allow 都按规范 origin 比较', () => {
    const rules = [
      { origin: `${shop}/`, purpose: 'business_surface' as const, effect: 'allow' as const },
      { origin: shop, purpose: 'business_surface' as const, effect: 'deny' as const },
    ]
    expect(urlAllowedByAccessRules(`${shop}/app`, rules, ['business_surface'])).toBe(false)
    expect(
      originsForAccessPurposes({ schemaVersion: 1, policyVersion: 1, rules }, ['business_surface']),
    ).toEqual([])
  })

  it('PP05 凭据 URL 与非 http(s) 拒绝', () => {
    const rules = [{ origin: shop, purpose: 'business_surface' as const, effect: 'allow' as const }]
    expect(urlAllowedByAccessRules('https://user:pass@shop.example/app', rules, ['business_surface'])).toBe(false)
    expect(urlAllowedByAccessRules('ftp://shop.example/app', rules, ['business_surface'])).toBe(false)
    expect(urlAllowedByAccessRules('not-a-url', rules, ['business_surface'])).toBe(false)
  })

  it('旧 pathPrefix 缺斜杠或带 query 时规范化，无法规范化则不放行', () => {
    const missingSlash = [{ origin: shop, purpose: 'business_surface' as const, effect: 'allow' as const, pathPrefix: 'orders' }]
    const withQuery = [{ origin: shop, purpose: 'business_surface' as const, effect: 'allow' as const, pathPrefix: '/orders?x=1' }]
    expect(urlAllowedByAccessRules(`${shop}/orders/1`, missingSlash, ['business_surface'])).toBe(true)
    expect(urlAllowedByAccessRules(`${shop}/orders/1`, withQuery, ['business_surface'])).toBe(true)
    expect(urlAllowedByAccessRules(`${shop}/orders-admin`, missingSlash, ['business_surface'])).toBe(false)
  })

  it('PP12 地图作业只装业务表面', () => {
    const scope = compileAccessScopeFromSnapshot({
      accessPolicy: {
        revision: 1,
        digest: 'a'.repeat(64),
        policy: {
          schemaVersion: 1,
          policyVersion: 1,
          rules: [
            { origin: shop, purpose: 'business_surface', effect: 'allow', pathPrefix: '/app' },
            { origin: idp, purpose: 'authentication', effect: 'allow', pathPrefix: '/login' },
          ],
        },
      },
      mapJob: {
        jobId: '00000000-0000-4000-8000-000000000001',
        purpose: 'map_probe',
        source: 'manual',
      },
    })
    expect(scope.purposes).toEqual(['business_surface'])
    expect(urlAllowedByCompiledScope(`${shop}/app`, scope)).toBe(true)
    expect(urlAllowedByCompiledScope(`${idp}/login`, scope)).toBe(false)
  })

  it('探索 allowlist 与安全进入精确路径取交集', () => {
    const scope = compileAccessScopeFromSnapshot({
      accessPolicy: {
        revision: 1,
        digest: 'b'.repeat(64),
        policy: {
          schemaVersion: 1,
          policyVersion: 1,
          rules: [{ origin: shop, purpose: 'business_surface', effect: 'allow' }],
        },
      },
      mapJob: {
        jobId: '00000000-0000-4000-8000-000000000001',
        purpose: 'map_explore',
        source: 'explore',
      },
      steps: [
        { type: 'navigate', input: { url: `${shop}/` } },
        { type: 'map_observe', input: { mode: 'allowlist', allowlist: [{ origin: shop, pathPrefix: '/orders' }] } },
      ],
    })
    expect(urlAllowedByCompiledScope(`${shop}/`, scope)).toBe(true)
    expect(urlAllowedByCompiledScope(`${shop}/orders/1`, scope)).toBe(true)
    expect(urlAllowedByCompiledScope(`${shop}/admin`, scope)).toBe(false)
    expect(urlAllowedByCompiledScope(`${shop}/orders-admin`, scope)).toBe(false)
  })

  it('无 accessPolicy 的旧快照按 allowedOrigins 全路径放行', () => {
    const scope = compileAccessScopeFromSnapshot({ allowedOrigins: [shop] })
    expect(urlAllowedByCompiledScope(`${shop}/admin`, scope)).toBe(true)
    expect(urlAllowedByCompiledScope(`${idp}/login`, scope)).toBe(false)
  })
})
