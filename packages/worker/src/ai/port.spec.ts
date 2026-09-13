import { describe, expect, it, vi } from 'vitest'
import { assertPageScope, createAiPort, evidenceFailed, waitWithHang, type AiExecuteEvidence } from './port.js'
import type { DbHandle } from '@cairn/db'
import type { AiCommand, RunGrant, SessionGrant } from '@cairn/shared'
import type { BrowserSessionManager } from '../browser/session-manager.js'
import type { ObjectService } from '../objects/object.service.js'

vi.mock('./midscene/formal-agent.js', () => ({
  midsceneModelConfig: () => ({}),
  createFormalMidsceneAgent: async () => ({
    gate: { markLeaseLost: () => undefined },
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
        const value = await fn({
          url: () => 'https://shop.example/orders',
          context: () => ({ pages: () => [{}] }),
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
})
