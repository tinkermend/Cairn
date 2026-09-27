import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { targetAccessPolicySchema } from '@cairn/shared'
import { affectsCapturedSurface, blockedRequestImpactBasis, classifyReadOnlyRequest, installExploreGuard, onlyGraphqlQueries } from './explore-network-guard.js'

const policy = targetAccessPolicySchema.parse({
  schemaVersion: 1, policyVersion: 1,
  rules: [
    { origin: 'https://app.example', purpose: 'business_surface', effect: 'allow' },
    { origin: 'https://app.example', purpose: 'business_surface', effect: 'deny', pathPrefix: '/admin' },
  ],
  readOnlyRequests: [{ method: 'POST', origin: 'https://app.example', pathPattern: '/api/search' }],
})
const options = { allowedOrigins: [], accessPolicy: policy }
const post = (url: string, contentType: string, postData: string) => classifyReadOnlyRequest({
  url, method: 'POST', resourceType: 'fetch', navigation: false, contentType, postData,
}, options)

describe('read-only map network guard', () => {
  it('accepts query operations and rejects mutations, subscriptions, malformed and persisted queries', () => {
    expect(onlyGraphqlQueries('query List { items { id } }')).toBe(true)
    expect(onlyGraphqlQueries('{ items { id } }')).toBe(true)
    expect(onlyGraphqlQueries('mutation Delete { deleteItem }')).toBe(false)
    expect(onlyGraphqlQueries('query List { items } subscription S { changed }')).toBe(false)
    expect(onlyGraphqlQueries('query List { items')).toBe(false)
    expect(post('https://app.example/graphql', 'application/json', JSON.stringify({ query: 'query List { items { id } }' })).allowed).toBe(true)
    expect(post('https://app.example/graphql', 'application/json', JSON.stringify([
      { query: '{ items { id } }' }, { query: 'mutation Delete { deleteItem }' },
    ])).allowed).toBe(false)
    expect(post('https://app.example/graphql', 'application/json', JSON.stringify({ extensions: { persistedQuery: { sha256Hash: 'x' } } })).allowed).toBe(false)
  })

  it('allows only declared read-only POST paths and still blocks dangerous methods and paths', () => {
    expect(post('https://app.example/api/search', 'application/json', '{}').allowed).toBe(true)
    expect(post('https://app.example/api/search', 'application/json', JSON.stringify({ query: 'customer name' })).allowed).toBe(true)
    expect(post('https://app.example/api/search/list', 'application/json', '{}').allowed).toBe(false)
    expect(post('https://app.example/api/search-admin', 'application/json', '{}').allowed).toBe(false)
    expect(post('https://app.example/api/tokens/delete', 'application/json', '{}').allowed).toBe(false)
    expect(classifyReadOnlyRequest({ url: 'https://app.example/api/tokens/delete?id=1', method: 'GET', resourceType: 'fetch', navigation: false }, options).allowed).toBe(false)
    expect(classifyReadOnlyRequest({ url: 'https://app.example/api/search', method: 'DELETE', resourceType: 'fetch', navigation: false }, options).allowed).toBe(false)
    expect(classifyReadOnlyRequest({ url: 'https://other.example/api/search', method: 'GET', resourceType: 'fetch', navigation: false }, options).allowed).toBe(false)
  })

  it('admits only bounded read-intent POSTs in an opted-in map ingestion and exposes inference basis', () => {
    const balanced = { ...options, allowInferredReadPosts: true,
      accessPolicy: targetAccessPolicySchema.parse({ ...policy, postReadMode: 'balanced' }),
    }
    const decide = (path: string, body: unknown = {}) => classifyReadOnlyRequest({
      url: `https://app.example${path}`, method: 'POST', resourceType: 'xhr', navigation: false,
      contentType: 'application/json', postData: JSON.stringify(body),
    }, balanced)
    expect(decide('/api/orders/findListByPage', { pageNum: 1 })).toEqual({ allowed: true, basis: 'inferred_read_post' })
    expect(decide('/api/orders', { pageSize: 20, filters: { status: 'open' } })).toEqual({ allowed: true, basis: 'inferred_read_post' })
    expect(decide('/api/search', { query: 'customer name' })).toEqual({ allowed: true, basis: 'declared_read_post' })
    for (const [path, body] of [
      ['/api/orders', {}], ['/api/orders/create', { pageSize: 20 }],
      ['/api/orders/getAndUpdate', {}], ['/api/orders/list', { command: 'delete' }],
      ['/api/orders/list', { nested: { fileName: 'x' } }],
      ['/api/orders/list', { filter: [{ action: 'delete' }] }],
      ['/api/orders/query', { query: 'DELETE FROM orders' }],
      ['/user/loginHistory/logger', { pageSize: 20 }],
    ] as const) expect(decide(path, body).allowed).toBe(false)
    expect(decide('/api/orders/list', { filters: { status: 'open' } }).allowed).toBe(true)
    expect(classifyReadOnlyRequest({ url: 'https://app.example/api/orders/list', method: 'POST',
      resourceType: 'fetch', navigation: false, contentType: 'multipart/form-data', postData: 'x',
    }, balanced).allowed).toBe(false)
    expect(classifyReadOnlyRequest({ url: 'https://app.example/api/orders/list', method: 'POST',
      resourceType: 'fetch', navigation: false, contentType: 'application/json', postData: 'x'.repeat(16_385),
    }, balanced).allowed).toBe(false)
    expect(classifyReadOnlyRequest({ url: 'https://app.example/api/orders/list', method: 'POST',
      resourceType: 'fetch', navigation: false, contentType: 'application/json', postData: '{}',
    }, { ...balanced, allowInferredReadPosts: false }).allowed).toBe(false)
    expect(classifyReadOnlyRequest({ url: 'https://other.example/api/orders/list', method: 'POST',
      resourceType: 'fetch', navigation: false, contentType: 'application/json', postData: '{}',
    }, balanced).allowed).toBe(false)
  })

  it('routes inferred query POSTs while aborting write-shaped POSTs and recording the risk basis', async () => {
    const received: string[] = []
    const server = createServer((request, response) => {
      received.push(`${request.method} ${request.url}`)
      if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end('<script>'
          + 'fetch("/api/orders/findListByPage", {method:"POST", headers:{"Content-Type":"application/json"}, body:"{\\"pageSize\\":10}"});'
          + 'fetch("/api/orders/delete", {method:"POST", headers:{"Content-Type":"application/json"}, body:"{}"}).catch(()=>{});'
          + 'fetch("/user/loginHistory/logger", {method:"POST", headers:{"Content-Type":"application/json"}, body:"{}"}).catch(()=>{});'
          + '</script>')
      } else { response.setHeader('Content-Type', 'application/json'); response.end('{"items":[]}') }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture server has no port')
    const origin = `http://127.0.0.1:${address.port}`
    const browser = await chromium.launch({ headless: true })
    try {
      const context = await browser.newContext()
      const guard = await installExploreGuard(context, { allowedOrigins: [origin], allowInferredReadPosts: true,
        accessPolicy: targetAccessPolicySchema.parse({ schemaVersion: 1, policyVersion: 1, postReadMode: 'balanced',
          rules: [{ origin, purpose: 'business_surface', effect: 'allow' }],
        }),
      })
      const page = await context.newPage()
      await page.goto(origin)
      await expect.poll(() => guard.getBlockedRequests().length).toBe(2)
      await expect.poll(() => received.includes('POST /api/orders/findListByPage')).toBe(true)
      expect(received.filter(item => item.startsWith('POST '))).toEqual(['POST /api/orders/findListByPage'])
      expect(guard.getInferredReadPosts().map(item => item.url)).toEqual([origin + '/api/orders/findListByPage'])
      await guard.uninstall()
    } finally {
      await browser.close()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('applies access deny paths to navigation and strips query values from block records', () => {
    expect(classifyReadOnlyRequest({ url: 'https://app.example/admin/users', method: 'GET', resourceType: 'document', navigation: true }, options).allowed).toBe(false)
    expect(classifyReadOnlyRequest({ url: 'https://app.example/api/tokens/delete?id=1', method: 'GET', resourceType: 'document', navigation: true }, options).allowed).toBe(false)
  })

  it('keeps blocked beacons in the audit without treating their unreadable response as missing page data', () => {
    expect(post('https://app.example/telemetry', 'text/plain', 'metric=1').allowed).toBe(false)
    expect(affectsCapturedSurface({ resourceType: 'ping' })).toBe(false)
    expect(affectsCapturedSurface({ resourceType: 'fetch' })).toBe(true)
  })

  it('only an exact verified POST XHR/fetch rule removes completeness impact, never network blocking', () => {
    const withEvidence = targetAccessPolicySchema.parse({ ...policy,
      verifiedNonContentRequests: [{ method: 'POST', resourceType: 'xhr', origin: 'https://metrics.example',
        pathPattern: '/collect', evidence: '已核实为独立遥测，不参与业务页面内容' }],
    })
    const blocked = { url: 'https://metrics.example/collect', method: 'POST', resourceType: 'xhr',
      reason: '数据请求不在业务授权范围' }
    expect(classifyReadOnlyRequest({ ...blocked, navigation: false }, { allowedOrigins: [], accessPolicy: withEvidence }).allowed).toBe(false)
    expect(blockedRequestImpactBasis(blocked, withEvidence)).toBe('verified_non_content_rule')
    expect(affectsCapturedSurface({ ...blocked, impactBasis: blockedRequestImpactBasis(blocked, withEvidence) })).toBe(false)
    for (const changed of [
      { ...blocked, url: 'https://metrics.example/collect/child' },
      { ...blocked, url: 'https://metrics.example/collect-admin' },
      { ...blocked, resourceType: 'fetch' },
      { ...blocked, method: 'PUT' },
      { ...blocked, reason: '路径疑似写操作' },
    ]) expect(blockedRequestImpactBasis(changed, withEvidence)).toBe('unclassified')
    expect(blockedRequestImpactBasis(blocked, policy)).toBe('unclassified')
    const unsafePolicy = targetAccessPolicySchema.parse({ ...policy,
      verifiedNonContentRequests: [{ method: 'POST', resourceType: 'xhr', origin: 'https://metrics.example',
        pathPattern: '/delete', evidence: '错误配置也不能豁免明显危险的请求路径' }],
    })
    expect(blockedRequestImpactBasis({ ...blocked, url: 'https://metrics.example/delete' }, unsafePolicy)).toBe('unclassified')
  })

  it('blocks actual background and click-triggered writes before they reach the fixture server', async () => {
    let writes = 0
    const server = createServer((request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') writes++
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end('<!doctype html><main><button onclick="fetch(\'/api/write\',{method:\'POST\'}).catch(()=>{})">保存</button></main>'
        + '<script>navigator.sendBeacon("/telemetry", "metric");'
        + 'const xhr = new XMLHttpRequest(); xhr.open("POST", "/telemetry-xhr"); xhr.send("metric")</script>')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture server has no port')
    const origin = `http://127.0.0.1:${address.port}`
    const browser = await chromium.launch({ headless: true })
    try {
      const context = await browser.newContext()
      const guard = await installExploreGuard(context, { allowedOrigins: [origin],
        accessPolicy: targetAccessPolicySchema.parse({ schemaVersion: 1, policyVersion: 1,
          rules: [{ origin, purpose: 'business_surface', effect: 'allow' }],
          verifiedNonContentRequests: [{ method: 'POST', resourceType: 'xhr', origin,
            pathPattern: '/telemetry-xhr', evidence: '已核实为独立遥测，不参与业务页面内容' }],
        }),
      })
      const page = await context.newPage()
      await page.goto(origin)
      await page.getByRole('button', { name: '保存' }).click()
      await expect.poll(() => guard.getBlockedRequests().length).toBe(3)
      expect(writes).toBe(0)
      expect(guard.getBlockedRequests().map(request => request.resourceType).sort()).toEqual(['fetch', 'ping', 'xhr'])
      expect(guard.getBlockedRequests().find(request => request.resourceType === 'xhr')?.impactBasis).toBe('verified_non_content_rule')
      expect(guard.getBlockedRequests().find(request => request.resourceType === 'fetch')?.impactBasis).toBe('unclassified')
      await guard.uninstall()
    } finally {
      await browser.close()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
