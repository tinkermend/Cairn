import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@cairn/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cairn/db')>()
  return { ...actual, appendSessionEvent: vi.fn().mockResolvedValue(undefined) }
})

import { appendSessionEvent, type DbHandle } from '@cairn/db'
import { beginOperationProgress, peekOperationProgress, takeOperationProgress } from './operation-progress'

const db = {} as DbHandle
const key = { targetId: 't', targetAccountId: 'a' }

describe('OperationProgress', () => {
  beforeEach(() => vi.mocked(appendSessionEvent).mockClear())

  it('用户操作逐阶段落 operation.progress，带上会话与排队耗时', async () => {
    const progress = beginOperationProgress(db, {
      key,
      operationId: 'op-user',
      kind: 'PREPARE',
      background: false,
      createdAt: new Date(Date.now() - 5_000),
    })
    progress.bindSession({ id: 's1', generation: 2 })
    await progress.mark('browser_launched', { durationMs: 1200 })
    expect(appendSessionEvent).toHaveBeenCalledTimes(1)
    expect(vi.mocked(appendSessionEvent).mock.calls[0]![1]).toMatchObject({
      type: 'operation.progress',
      operationId: 'op-user',
      sessionId: 's1',
      generation: 2,
      payload: { kind: 'PREPARE', phase: 'browser_launched', durationMs: 1200 },
    })
    expect(progress.queuedMs).toBeGreaterThanOrEqual(5_000)
    expect(peekOperationProgress('op-user')).toBe(progress)
    expect(takeOperationProgress('op-user')).toBe(progress)
    expect(peekOperationProgress('op-user')).toBeUndefined()
  })

  it('后台操作成功时不落阶段事件，失败时按顺序补写', async () => {
    const ok = beginOperationProgress(db, { key, operationId: 'bg-ok', kind: 'VERIFY_AUTH', background: true })
    await ok.mark('browser_reused')
    await ok.mark('auth_probed', { detail: { authState: 'AUTHENTICATED' } })
    await ok.flush(false)
    expect(appendSessionEvent).not.toHaveBeenCalled()

    const failed = beginOperationProgress(db, { key, operationId: 'bg-fail', kind: 'VERIFY_AUTH', background: true })
    await failed.mark('browser_reused')
    await failed.mark('auth_probed', { detail: { authState: 'EXPIRED' } })
    await failed.flush(true)
    expect(vi.mocked(appendSessionEvent).mock.calls.map((call) => call[1].payload?.phase)).toEqual([
      'browser_reused',
      'auth_probed',
    ])
    await failed.flush(true)
    expect(appendSessionEvent).toHaveBeenCalledTimes(2)
  })

  it('写事件失败不影响维护本身', async () => {
    vi.mocked(appendSessionEvent).mockRejectedValueOnce(new Error('db down'))
    const progress = beginOperationProgress(db, { key, operationId: 'op-err', kind: 'PREPARE', background: false })
    await expect(progress.mark('browser_reused')).resolves.toBeUndefined()
  })
})
