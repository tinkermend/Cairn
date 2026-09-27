import { describe, expect, it } from 'vitest'
import {
  EXECUTABLE_STEP_TYPES,
  FACTORY_PLATFORM_CONFIG,
  MAP_JOB_KINDS,
  buildPageKey,
  platformConfigDocumentSchema,
  sanitizeExplorationUrl,
} from '../index.js'

describe('旧地图采集下线', () => {
  it('作业种类只剩 map_ingest，探索步骤不再可执行', () => {
    expect(MAP_JOB_KINDS).toEqual(['map_ingest'])
    expect(EXECUTABLE_STEP_TYPES.filter((type) => type.startsWith('map_'))).toEqual(['map_ingest'])
  })

  it('存量平台配置里的探索开关读取时被丢弃', () => {
    const parsed = platformConfigDocumentSchema.parse({ ...FACTORY_PLATFORM_CONFIG, mapExplorationEnabled: true })
    expect('mapExplorationEnabled' in parsed).toBe(false)
  })

  it('URL 规范化剔除敏感查询并拒绝疑似写入路径', () => {
    const ok = sanitizeExplorationUrl('/orders?token=abc&page=2', 'https://shop.example/')
    expect(ok).toMatchObject({ ok: true, canonicalUrl: 'https://shop.example/orders?page=2' })
    expect(sanitizeExplorationUrl('https://shop.example/orders/delete?id=1').ok).toBe(false)
    expect(sanitizeExplorationUrl('https://shop.example/admin/payment/config').ok).toBe(true)
    expect(sanitizeExplorationUrl('https://shop.example/orders/pay?id=1').ok).toBe(false)
    expect(sanitizeExplorationUrl('https://shop.example/#/tokens/delete', undefined,
      { allowedSpaHashPrefixes: ['#/'] }).ok).toBe(false)
  })

  it('显式忽略的易变参数不拆分路径路由与 Hash SPA 页面，其他参数仍参与身份', () => {
    const base = { targetId: '00000000-0000-4000-8000-000000000001', ignoreQueryParams: ['nonce'],
      allowedSpaHashPrefixes: ['#/'] }
    expect(buildPageKey({ ...base, url: 'https://app.example/orders?nonce=one&tab=items' }))
      .toBe(buildPageKey({ ...base, url: 'https://app.example/orders?nonce=two&tab=items' }))
    expect(buildPageKey({ ...base, url: 'https://app.example/orders?nonce=one&tab=items' }))
      .not.toBe(buildPageKey({ ...base, url: 'https://app.example/orders?nonce=two&tab=history' }))
    expect(buildPageKey({ ...base, url: 'https://app.example/#/orders?nonce=one&tab=items' }))
      .toBe(buildPageKey({ ...base, url: 'https://app.example/#/orders?nonce=two&tab=items' }))
    expect(buildPageKey({ ...base, url: 'https://app.example/#/orders?nonce=one&tab=items' }))
      .not.toBe(buildPageKey({ ...base, url: 'https://app.example/#/orders?nonce=two&tab=history' }))
  })
})
