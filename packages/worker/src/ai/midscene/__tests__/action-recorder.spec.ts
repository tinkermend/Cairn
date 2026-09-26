import { describe, expect, it, vi } from 'vitest'
import {
  ActionRecorder,
  extractActionValue,
  extractParamsSummary,
  extractPointAndDescription,
  normalizeUrlPattern,
  resolveValueProvenance,
  sanitizePageUrl,
} from '../action-recorder.js'

describe('ActionRecorder 辅助纯函数', () => {
  it('sanitizePageUrl 脱敏 URL 中的用户名、密码与敏感查询参数', () => {
    expect(
      sanitizePageUrl('https://admin:secret123@example.com/app/login?token=abc-123&q=search&api_key=xyz#hash'),
    ).toBe('https://example.com/app/login?q=search')
    expect(
      sanitizePageUrl('https://example.com/api?safeParam=123&password=pass'),
    ).toBe('https://example.com/api?safeParam=123')
  })

  it('normalizeUrlPattern 规范化 UUID 与长数字路径', () => {
    expect(
      normalizeUrlPattern('https://example.com/orders/12345/items/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d?tab=detail'),
    ).toBe('https://example.com/orders/:id/items/:id')
    expect(normalizeUrlPattern('https://example.com/login')).toBe('https://example.com/login')
  })

  it('extractPointAndDescription 正确提取坐标与文本描述', () => {
    const p1 = extractPointAndDescription({
      locate: { center: [120, 340], prompt: '登录按钮' },
    })
    expect(p1.point).toEqual({ x: 120, y: 340 })
    expect(p1.description).toBe('登录按钮')

    const p2 = extractPointAndDescription({ x: 50, y: 80, prompt: '提交' })
    expect(p2.point).toEqual({ x: 50, y: 80 })
    expect(p2.description).toBe('提交')

    const p3 = extractPointAndDescription(null)
    expect(p3.point).toBeUndefined()
    expect(p3.description).toBeUndefined()
  })

  it('extractActionValue 提取各类动作的值', () => {
    expect(extractActionValue({ value: 'hello' })).toBe('hello')
    expect(extractActionValue({ text: 'world' })).toBe('world')
    expect(extractActionValue({ keyName: 'Enter' })).toBe('Enter')
    expect(extractActionValue({ locate: { center: [0, 0] } })).toBeUndefined()
  })

  it('resolveValueProvenance 严格执行来源分类与脱敏（input/context 不存值、1KiB超限标记、多源模糊、敏感脱敏）', () => {
    const contextMap = new Map<string, unknown>([
      ['orderNo', 'ORD-2026-001'],
      ['userId', 'U100'],
      ['sharedKey', 'SAME_VALUE'],
    ])
    const runInput = {
      sharedKey: 'SAME_VALUE',
      company: 'Acme Inc',
      amount: 100,
    }

    // 单一匹配 context：持久化 key，不存值
    const prov1 = resolveValueProvenance('ORD-2026-001', contextMap, runInput)
    expect(prov1).toEqual({
      kind: 'context',
      source: 'orderNo',
      value: null,
    })

    // 单一匹配 input：持久化 key，不存值
    const prov2 = resolveValueProvenance('Acme Inc', contextMap, runInput)
    expect(prov2).toEqual({
      kind: 'input',
      source: 'company',
      value: null,
    })

    // 多源匹配：ambiguous，候选来源列表，不存值
    const provAmbiguous = resolveValueProvenance('SAME_VALUE', contextMap, runInput)
    expect(provAmbiguous.kind).toBe('ambiguous')
    expect(provAmbiguous.source).toContain('input:sharedKey')
    expect(provAmbiguous.source).toContain('context:sharedKey')
    expect(provAmbiguous.value).toBeNull()

    // 敏感目标 / 敏感描述 / 敏感字面量：redacted，不存值
    const provSensitive = resolveValueProvenance({
      value: 'my-secret-token',
      isSensitiveTarget: true,
      contextBindings: contextMap,
      runInput,
    })
    expect(provSensitive).toEqual({
      kind: 'redacted',
      source: 'redacted',
      value: null,
    })

    const provSecretLiteral = resolveValueProvenance({
      value: 'sk-12345678901234567890',
      contextBindings: contextMap,
      runInput,
    })
    expect(provSecretLiteral).toEqual({
      kind: 'redacted',
      source: 'redacted',
      value: null,
    })

    // 超长字面量 (> 1024 字节)：TOO_LONG，不存值
    const longString = 'a'.repeat(1025)
    const provTooLong = resolveValueProvenance(longString, contextMap, runInput)
    expect(provTooLong).toEqual({
      kind: 'literal',
      source: 'TOO_LONG',
      value: null,
    })

    // 普通字面量：存储原值
    const prov3 = resolveValueProvenance('custom-text', contextMap, runInput)
    expect(prov3).toEqual({
      kind: 'literal',
      source: 'literal',
      value: 'custom-text',
    })

    // 空值为 none
    const prov4 = resolveValueProvenance(undefined, contextMap, runInput)
    expect(prov4).toEqual({
      kind: 'none',
      source: null,
      value: null,
    })
  })

  it('extractParamsSummary 精简并去除大尺寸冗余对象，且剔除 value/text 及敏感字段防泄露', () => {
    const summary = extractParamsSummary({
      locate: { center: [100, 200], prompt: '按钮', screenshot: 'base64...' },
      value: 'test-should-be-stripped',
      text: 'also-stripped',
      password: 'secret-password',
      active: true,
      count: 42,
    })
    expect(summary).toEqual({
      locate: { center: [100, 200], description: '按钮' },
      active: true,
      count: 42,
    })
  })
})

const { appendCalls } = vi.hoisted(() => ({
  appendCalls: [] as any[],
}))

vi.mock('@cairn/db', () => ({
  appendAiTaskEvent: async (_db: any, input: any) => {
    appendCalls.push(input)
    return { ok: true, eventId: 'ev-1' }
  },
}))

describe('ActionRecorder 生命周期与写入测试', () => {
  it('onDispatch / onSettled 产生独立 prepared / completed 事件并捕获网络写请求信号', async () => {
    const mockDb = {} as any
    const listeners: Record<string, ((req: any) => void)[]> = {}

    const fakePage = {
      url: () => 'https://example.com/app/orders/999',
      evaluate: async () => 'complete',
      evaluateHandle: async () => ({
        asElement: () => null,
        dispose: async () => {},
      }),
      on: (event: string, handler: any) => {
        listeners[event] = listeners[event] || []
        listeners[event].push(handler)
      },
      removeListener: (event: string, handler: any) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter((h) => h !== handler)
        }
      },
    } as any

    const grant = {
      runId: 'r-1',
      leaseId: '00000000-0000-4000-8000-0000000000aa',
      fencingToken: 1,
      holderWorkerId: 'w-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }

    const recorder = new ActionRecorder({
      page: fakePage,
      attemptId: 'att-1',
      runId: 'r-1',
      stepRunId: 'sr-1',
      agentInstanceId: 'agent-inst-1',
      grant,
      db: mockDb,
      runInput: { q: 'cairn' },
      allowedOrigins: ['https://example.com'],
    })

    // 触发网络写请求（POST 到 allowed origin 计入，GET 或 第三方 origin 忽略）
    const requestHandler = listeners['request']?.[0]
    expect(requestHandler).toBeDefined()
    requestHandler?.({
      method: () => 'POST',
      url: () => 'https://example.com/api/orders/12345/items',
    })
    requestHandler?.({
      method: () => 'GET',
      url: () => 'https://example.com/api/orders/12345',
    })
    requestHandler?.({
      method: () => 'POST',
      url: () => 'https://thirdparty.com/analytics',
    })

    await recorder.onDispatch('Tap', {
      locate: { center: [100, 200], description: '查询按钮' },
    })

    expect(appendCalls).toHaveLength(1)
    expect(appendCalls[0].phase).toBe('prepared')
    expect(appendCalls[0].ordinal).toBe(0)
    expect(appendCalls[0].actionName).toBe('Tap')
    expect(appendCalls[0].elementDescription).toBe('查询按钮')
    expect(appendCalls[0].pageBefore.urlPattern).toBe('https://example.com/app/orders/:id')

    // 动作执行期间又收到一个 PUT 请求
    requestHandler?.({
      method: () => 'PUT',
      url: () => 'https://example.com/api/orders/12345',
    })

    await recorder.onSettled('Tap', {
      locate: { center: [100, 200], description: '查询按钮' },
    })

    expect(appendCalls).toHaveLength(2)
    expect(appendCalls[1].phase).toBe('completed')
    expect(appendCalls[1].ordinal).toBe(0)
    expect(appendCalls[1].actionName).toBe('Tap')
    expect(appendCalls[1].writeSignalCount).toBe(1)
    expect(appendCalls[1].writeSignalPaths).toEqual(['PUT /api/orders/:id'])
    expect(appendCalls[1].pageAfter).toBeDefined()

    recorder.destroy()
    expect(listeners['request']?.length ?? 0).toBe(0)
  })
})
