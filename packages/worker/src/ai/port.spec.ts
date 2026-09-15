import { describe, expect, it, vi } from 'vitest'
import type { Page } from 'playwright'
import {
  assertPageScope,
  createAiPort,
  evidenceFailed,
  leaseLostError,
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
    const objects = {
      putObjectEvidence: async () => ({
        status: 'stored',
        objectKey: 'runs/r1/shot.png',
        contentType: 'image/png',
      }),
    } as unknown as ObjectService

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
})
