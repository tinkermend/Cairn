import { describe, expect, it, vi } from 'vitest'
import type { Page } from 'playwright'
import {
  assertPageScope,
  classifyAiCallErrorCode,
  createAiPort,
  evidenceFailed,
  leaseLostError,
  locateResultFromFailure,
  settleAiCommand,
  waitWithHang,
  type AiExecuteEvidence,
} from './port.js'
import { ActionGate, gateActions } from './midscene/action-gate.js'
import type { DbHandle } from '@cairn/db'
import type { AiCommand, AiResult, RunGrant, SessionGrant } from '@cairn/shared'
import type { BrowserSessionManager } from '../browser/session-manager.js'
import type { ObjectService } from '../objects/object.service.js'

type GateLike = import('./midscene/action-gate.js').ActionGate

const agentBehavior = vi.hoisted(() => ({
  aiAct: undefined as undefined | ((gate: GateLike) => Promise<string | undefined>),
}))

vi.mock('@cairn/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    reserveAiModelCall: vi.fn().mockResolvedValue({ ok: true, callN: 1 }),
    completeAiModelCall: vi.fn().mockResolvedValue({ ok: true }),
  }
})

vi.mock('./midscene/formal-agent.js', () => ({
  validateBrowserAiModelFamily: async () => undefined,
  midsceneModelConfig: () => ({}),
  createFormalMidsceneAgent: async (input: { gate: GateLike }) => ({
    gate: input.gate,
    aiAct: async () => agentBehavior.aiAct?.(input.gate),
    aiAssert: async () => ({ pass: false, thought: '标题不是这个' }),
    destroy: async () => undefined,
  }),
}))

const command: AiCommand = {
  type: 'ai_extract',
  instruction: '读字段',
  maxCalls: 2,
  maxOutputTokens: 64,
  requestTimeoutMs: 1000,
  hangWaitMs: 20,
  allowedOrigins: ['https://shop.example'],
  loginOrigin: 'https://shop.example',
  loginPath: '/login',
}

describe('AI 端口边界', () => {
  it('越界源和认证页都拒绝', () => {
    expect(() => assertPageScope('https://evil.example/app', command)).toThrow(/不在允许范围/)
    expect(() => assertPageScope('https://shop.example/login', command)).toThrow(/认证页面/)
    expect(() => assertPageScope('https://shop.example/orders', command)).not.toThrow()
    expect(() =>
      assertPageScope('https://shop.example/admin', command, {
        purposes: ['business_surface'],
        rules: [{ origin: 'https://shop.example', purpose: 'business_surface', effect: 'allow', pathPrefix: '/orders' }],
      }),
    ).toThrow(/不在允许范围/)
  })

  it('定位失败映射保留 hung 与可重试的模型错误', () => {
    expect(locateResultFromFailure({ hung: true, callNs: [] })).toMatchObject({
      ok: false,
      hung: true,
      error: { code: 'AI_HUNG', retryable: false },
    })
    expect(locateResultFromFailure({ error: new Error('fetch failed: ECONNRESET'), callNs: [1] })).toMatchObject({
      ok: false,
      error: { code: 'AI_EXECUTION_FAILED', retryable: true },
    })
    expect(locateResultFromFailure({ error: Object.assign(new Error('未找到'), { code: 'AI_NOT_FOUND' }) })).toMatchObject({
      ok: false,
      error: { code: 'AI_NOT_FOUND', retryable: true },
    })
    expect(locateResultFromFailure({ error: new Error('failed to locate element: 当前画面没有目标'), callNs: [2] })).toMatchObject({
      ok: false,
      outcomeClass: 'miss',
      callNs: [2],
      error: { code: 'AI_NOT_FOUND' },
    })
    expect(locateResultFromFailure({ error: new Error('HTTP 500: failed to locate element: upstream error') })).toMatchObject({
      ok: false,
      error: { code: 'AI_EXECUTION_FAILED' },
    })
  })

  it('取消后有界等待，未落定则标 hung', async () => {
    const stop = new AbortController()
    let resolveWork: (value: string) => void = () => undefined
    const work = new Promise<string>((resolve) => {
      resolveWork = resolve
    })
    stop.abort()
    const first = waitWithHang(work, 20, stop.signal)
    await expect(first).resolves.toEqual({ done: false })
    resolveWork('late')
  })

  it('断言不成立按失败取证，不然结算会缺失败截图', () => {
    const failing = { ok: true, output: { passed: false, reason: '不成立' } } as const
    const passing = { ok: true, output: { passed: true, reason: '成立' } } as const
    expect(evidenceFailed('ai_assert', failing)).toBe(true)
    expect(evidenceFailed('ai_assert', passing)).toBe(false)
    expect(evidenceFailed('ai_assert', { ok: true, output: 'yes' })).toBe(true)
    expect(evidenceFailed('ai_extract', { ok: true, output: { passed: false } })).toBe(false)
    expect(evidenceFailed('ai_action', undefined)).toBe(true)
    expect(evidenceFailed('ai_action', { ok: false })).toBe(true)
  })

  it('断言不成立时受管页面按失败抓图，截图落到证据里', async () => {
    const sessionGrant = { sessionId: 's1', leaseId: 'l1', fencingToken: 1 } as unknown as SessionGrant
    const captureDecisions: boolean[] = []
    const manager = {
      observeInRunAuth: async () => null,
      markTransientPageState: () => undefined,
      withManagedPage: async (
        _grant: SessionGrant,
        _evidence: unknown,
        fn: (page: unknown) => Promise<unknown>,
        failed: (value: unknown) => boolean,
      ) => {
        const pages = [{ close: async () => undefined }]
        const value = await fn({
          url: () => 'https://shop.example/orders',
          context: () => ({ pages: () => pages }),
        })
        const capture = failed(value)
        captureDecisions.push(capture)
        return { ok: true, value, screenshotBytes: capture ? Buffer.from('png') : undefined }
      },
    } as unknown as BrowserSessionManager
    const putObjectEvidence = vi.fn(async () => ({
        status: 'stored',
        objectKey: 'runs/r1/shot.png',
        contentType: 'image/png',
      }))
    const objects = { putObjectEvidence } as unknown as ObjectService

    const port = createAiPort({
      manager,
      handle: {} as DbHandle,
      resolveApiKey: async () => 'key',
      objects,
    })
    const evidence = {
      runId: 'r1',
      stepRunId: 'sr1',
      attemptId: 'a1',
      screenshot: 'on_failure',
      grant: { runId: 'r1', holderWorkerId: 'w1' } as unknown as RunGrant,
      maxCalls: 2,
      config: {} as AiExecuteEvidence['config'],
    } satisfies AiExecuteEvidence

    const result = await port.execute(
      sessionGrant,
      { ...command, type: 'ai_assert' },
      new AbortController().signal,
      evidence,
    )
    expect(captureDecisions).toEqual([true])
    expect(result.screenshot?.objectKey).toBe('runs/r1/shot.png')
    expect(putObjectEvidence).toHaveBeenCalledWith(expect.objectContaining({
      artifactKey: 'screenshot:a1:on_error:0',
      payload: expect.objectContaining({ role: 'on_error', viewport: 'full_page' }),
    }))
  })

  it('AI 操作成功截图带 after_action 证据槽，可满足运行证据结算', async () => {
    const putObjectEvidence = vi.fn(async () => ({
      status: 'stored',
      objectKey: 'runs/r1/action.png',
      contentType: 'image/png',
    }))
    const manager = {
      withManagedPage: async () => ({
        ok: true,
        value: { ok: true, output: { summary: '已完成' } },
        screenshotBytes: Buffer.from('png'),
        screenshotCapturedAt: '2026-09-24T00:00:00.000Z',
        faceRole: 'after_action',
      }),
    } as unknown as BrowserSessionManager
    const port = createAiPort({
      manager,
      handle: {} as DbHandle,
      resolveApiKey: async () => 'key',
      objects: { putObjectEvidence } as unknown as ObjectService,
    })
    const result = await port.execute(
      { sessionId: 's1', leaseId: 'l1', fencingToken: 1 } as unknown as SessionGrant,
      { ...command, type: 'ai_action', instruction: '点击按钮' },
      new AbortController().signal,
      {
        runId: 'r1',
        stepRunId: 'sr1',
        attemptId: 'a1',
        screenshot: 'always',
        grant: { runId: 'r1', holderWorkerId: 'w1' } as unknown as RunGrant,
        maxCalls: 2,
        config: {} as AiExecuteEvidence['config'],
      },
    )
    expect(result.ok).toBe(true)
    expect(putObjectEvidence).toHaveBeenCalledWith(expect.objectContaining({
      artifactKey: 'screenshot:a1:after_action:0',
      payload: expect.objectContaining({
        role: 'after_action',
        viewport: 'full_page',
        capturedAt: '2026-09-24T00:00:00.000Z',
      }),
    }))
  })

  it('取消后在窗口内落定则返回结果', async () => {
    const stop = new AbortController()
    const work = Promise.resolve('ok')
    stop.abort()
    await expect(waitWithHang(work, 50, stop.signal)).resolves.toEqual({
      done: true,
      ok: true,
      value: 'ok',
    })
  })

  function fakePage(url: string, pages: Array<{ close: () => Promise<void> }>): Page {
    return {
      url: () => url,
      context: () => ({ pages: () => pages }),
    } as unknown as Page
  }

  it('未落定的结果原样返回：越界与新窗检查不能盖掉 hung', async () => {
    const popup = { close: vi.fn(async () => undefined) }
    const hung: AiResult = { ok: false, hung: true, summary: '未落定' }
    await expect(
      settleAiCommand(fakePage('https://evil.example/app', [popup]), new Set(), command, hung),
    ).resolves.toBe(hung)
    expect(popup.close).not.toHaveBeenCalled()
  })

  it('AI 新开的窗口先关掉再报未支持，原有页面不动', async () => {
    const main = { close: vi.fn(async () => undefined) }
    const popup = { close: vi.fn(async () => undefined) }
    const before = new Set([main]) as unknown as Set<Page>
    await expect(
      settleAiCommand(fakePage('https://shop.example/orders', [main, popup]), before, command, {
        ok: true,
        output: {},
      }),
    ).rejects.toMatchObject({ code: 'AI_POPUP_UNSUPPORTED' })
    expect(popup.close).toHaveBeenCalledTimes(1)
    expect(main.close).not.toHaveBeenCalled()
  })

  it('没有新窗时仍校验页面范围', async () => {
    const main = { close: vi.fn(async () => undefined) }
    const before = new Set([main]) as unknown as Set<Page>
    await expect(
      settleAiCommand(fakePage('https://evil.example/app', [main]), before, command, { ok: true, output: {} }),
    ).rejects.toMatchObject({ code: 'AI_ORIGIN_DENIED' })
  })

  it('丢租分类只看 gate：放行过动作记 UNKNOWN，未放行记 INFRASTRUCTURE，都不可重试', async () => {
    const gate = new ActionGate()
    expect(leaseLostError(gate)).toMatchObject({
      code: 'SESSION_LEASE_LOST',
      category: 'INFRASTRUCTURE',
      retryable: false,
    })
    const [tap] = gateActions([{ name: 'Tap', call: async () => undefined }], gate)
    await tap!.call()
    expect(leaseLostError(gate)).toMatchObject({ code: 'SESSION_LEASE_LOST', category: 'UNKNOWN', retryable: false })
  })

  const leaseGrant = { sessionId: 's1', leaseId: 'l1', fencingToken: 1 } as unknown as SessionGrant
  const quietEvidence = {
    runId: 'r1',
    stepRunId: 'sr1',
    attemptId: 'a1',
    screenshot: 'off',
    grant: { runId: 'r1', holderWorkerId: 'w1' } as unknown as RunGrant,
    maxCalls: 2,
    config: {} as AiExecuteEvidence['config'],
  } satisfies AiExecuteEvidence

  it('动作放行后丢租：SDK 包过的报错不影响分类，端口带出 UNKNOWN 的 SESSION_LEASE_LOST', async () => {
    let held = true
    const pages = [{ close: async () => undefined }]
    const manager = {
      observeInRunAuth: async () => null,
      markTransientPageState: () => undefined,
      guard: {
        assertHeld: () => {
          if (!held) throw new Error('revoked')
        },
      },
      withManagedPage: async (_grant: SessionGrant, _evidence: unknown, fn: (page: unknown) => Promise<unknown>) => ({
        ok: true,
        value: await fn({ url: () => 'https://shop.example/orders', context: () => ({ pages: () => pages }) }),
      }),
    } as unknown as BrowserSessionManager
    agentBehavior.aiAct = async (gate) => {
      const [tap] = gateActions([{ name: 'Tap', call: async () => undefined }], gate)
      await tap!.call()
      held = false
      await tap!.call()
      return 'unreachable'
    }
    try {
      const port = createAiPort({ manager, handle: {} as DbHandle, resolveApiKey: async () => 'key' })
      const result = await port.execute(
        leaseGrant,
        { ...command, type: 'ai_action' },
        new AbortController().signal,
        quietEvidence,
      )
      expect(result.ok).toBe(false)
      expect(result.hung).toBeFalsy()
      expect(result.error).toMatchObject({ code: 'SESSION_LEASE_LOST', category: 'UNKNOWN', retryable: false })
    } finally {
      agentBehavior.aiAct = undefined
    }
  })

  it('入口处丢租原样带出结构化错误，没发出动作记 INFRASTRUCTURE', async () => {
    const manager = {
      guard: { assertHeld: () => undefined },
      withManagedPage: async () => ({
        ok: false,
        error: {
          code: 'SESSION_LEASE_LOST',
          category: 'INFRASTRUCTURE',
          retryable: false,
          safeMessage: '租约已撤销，拒绝浏览器命令',
        },
      }),
    } as unknown as BrowserSessionManager
    const port = createAiPort({ manager, handle: {} as DbHandle, resolveApiKey: async () => 'key' })
    const result = await port.execute(
      leaseGrant,
      { ...command, type: 'ai_action' },
      new AbortController().signal,
      quietEvidence,
    )
    expect(result.error).toMatchObject({ code: 'SESSION_LEASE_LOST', category: 'INFRASTRUCTURE' })
  })

  it('locate 优先使用 platformAi 文本模型通道，成功定位无需调用 MidScene', async () => {
    const pages = [{ close: async () => undefined }]
    const mockPage = {
      url: () => 'https://shop.example/orders',
      context: () => ({ pages: () => pages }),
      ariaSnapshot: async () => `
- heading "订单详情"
- button "立即支付"
`,
      getByRole: (role: string, opts?: { name?: string }) => ({
        count: async () => (role === 'button' && opts?.name === '立即支付' ? 1 : 0),
        boundingBox: async () => ({ x: 100, y: 150, width: 80, height: 30 }),
        isVisible: async () => true,
        evaluate: async () => true,
      }),
      getByText: () => ({ count: async () => 0, boundingBox: async () => null }),
      getByLabel: () => ({ count: async () => 0, boundingBox: async () => null }),
      locator: () => ({ count: async () => 0, boundingBox: async () => null }),
    }
    const manager = {
      guard: { assertHeld: () => undefined },
      withManagedPage: async (_grant: unknown, _evidence: unknown, fn: (page: unknown) => Promise<unknown>) => ({
        ok: true,
        value: await fn(mockPage),
      }),
    } as unknown as BrowserSessionManager

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: 'found',
                candidate: { by: 'role', value: 'button', name: '立即支付' },
                reason: '匹配立即支付按钮',
              }),
            },
          },
        ],
      }),
    }) as any

    try {
      const port = createAiPort({
        manager,
        handle: {} as DbHandle,
        resolveApiKey: async () => 'platform-key',
      })
      const locateEvidence: any = {
        runId: 'r1',
        stepRunId: 'sr1',
        attemptId: 'a1',
        grant: { runId: 'r1', holderWorkerId: 'w1' },
        maxCalls: 2,
        config: {
          modelBaseUrl: 'https://vision.example.com/v1',
          modelName: 'vision-model',
          modelFamily: 'doubao-seed',
          requestTimeoutMs: 5000,
          hangWaitMs: 1000,
          platformAi: {
            baseUrl: 'https://platform-text.example.com/v1',
            model: 'deepseek-chat',
            provider: 'deepseek',
            secretRef: { provider: 'local', secretId: 'text-model-key' },
          },
        },
      }

      const result = await port.locate!(
        leaseGrant,
        { prompt: '立即支付按钮', allowedOrigins: ['https://shop.example'] },
        new AbortController().signal,
        locateEvidence,
      )

      expect(result.ok).toBe(true)
      expect(result.center).toEqual([140, 165])
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://platform-text.example.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
        }),
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('当 allowVision 为 false 时，文本未命中直接截断并拒绝调用视觉多模态', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: 'not_found',
                reason: '页面无匹配元素',
              }),
            },
          },
        ],
      }),
    }) as any

    const mockPage = {
      url: () => 'https://shop.example/checkout',
      context: () => ({}),
      ariaSnapshot: async () => '- button "提交订单"',
      getByRole: () => ({ count: async () => 0, boundingBox: async () => null }),
      getByText: () => ({ count: async () => 0, boundingBox: async () => null }),
      getByLabel: () => ({ count: async () => 0, boundingBox: async () => null }),
      locator: () => ({ count: async () => 0, boundingBox: async () => null }),
    }
    const manager = {
      guard: { assertHeld: () => undefined },
      withManagedPage: async (_grant: unknown, _evidence: unknown, fn: (page: unknown) => Promise<unknown>) => ({
        ok: true,
        value: await fn(mockPage),
      }),
    } as unknown as BrowserSessionManager

    try {
      const port = createAiPort({
        manager,
        handle: {} as DbHandle,
        resolveApiKey: async () => 'platform-key',
      })
      const locateEvidence: any = {
        runId: 'r1',
        stepRunId: 'sr1',
        attemptId: 'a1',
        grant: { runId: 'r1', holderWorkerId: 'w1' },
        maxCalls: 2,
        config: {
          modelBaseUrl: 'https://vision.example.com/v1',
          modelName: 'vision-model',
          modelFamily: 'doubao-seed',
          requestTimeoutMs: 5000,
          hangWaitMs: 1000,
          platformAi: {
            baseUrl: 'https://platform-text.example.com/v1',
            model: 'deepseek-chat',
            provider: 'deepseek',
            secretRef: { provider: 'local', secretId: 'text-model-key' },
          },
        },
      }

      const result = await port.locate!(
        leaseGrant,
        { prompt: '不存在的按钮', allowedOrigins: ['https://shop.example'], allowVision: false },
        new AbortController().signal,
        locateEvidence,
      )

      expect(result.ok).toBe(false)
      expect(result.summary).toContain('不允许视觉多模态定位')
      expect(result.error?.code).toBe('AI_NOT_FOUND')

      const { reserveAiModelCall, completeAiModelCall } = await import('@cairn/db')
      expect(reserveAiModelCall).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          model: 'deepseek-chat',
          route: 'aria_text',
        }),
      )
      expect(completeAiModelCall).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          model: 'deepseek-chat',
          route: 'aria_text',
        }),
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('classifyAiCallErrorCode', () => {
  it('把 HTTP 429 归一为 RATE_LIMITED，供 monitoring 的 rateLimitHits 聚合识别', () => {
    expect(classifyAiCallErrorCode({ status: 429 })).toBe('RATE_LIMITED')
  })

  it('把常见 provider 限流子码也归一为 RATE_LIMITED', () => {
    expect(classifyAiCallErrorCode({ code: 'rate_limit_exceeded' })).toBe('RATE_LIMITED')
    expect(classifyAiCallErrorCode({ code: 'RESOURCE_EXHAUSTED' })).toBe('RATE_LIMITED')
  })

  it('非限流的 provider code 原样透传', () => {
    expect(classifyAiCallErrorCode({ code: 'INVALID_REQUEST' })).toBe('INVALID_REQUEST')
  })

  it('没有 status／code 的普通错误退化为 AI_CALL_FAILED', () => {
    expect(classifyAiCallErrorCode(new Error('boom'))).toBe('AI_CALL_FAILED')
    expect(classifyAiCallErrorCode(null)).toBe('AI_CALL_FAILED')
  })
})
