import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DomainError, listRuns } from '@cairn/db'
import { handleRunDiagnose } from './diagnose.handler'

vi.mock('@cairn/db', () => ({
  DomainError: class DomainError extends Error {
    constructor(public kind: string, public code: string, message: string) {
      super(message)
    }
  },
  listRuns: vi.fn(),
}))

function context() {
  return {
    db: {},
    actor: { id: 'reader-1' },
    slots: { findRecentFailed: true },
    body: {
      question: '最近 7 天有失败运行吗？',
      pageContext: { targetId: 'target-1' },
    },
    onProgress: vi.fn(),
  } as any
}

describe('recent failed run lookup', () => {
  beforeEach(() => vi.clearAllMocks())

  it('filters FAILED in storage before pagination and states the checked scope when empty', async () => {
    vi.mocked(listRuns).mockResolvedValueOnce({ items: [], nextCursor: null } as any)

    const answer = await handleRunDiagnose(context())

    expect(listRuns).toHaveBeenCalledOnce()
    expect(listRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'FAILED', limit: 1, targetId: 'target-1' }),
      'reader-1',
    )
    expect(answer.facts[0]?.text).toContain('状态为 FAILED')
    expect(answer.facts[0]?.text).not.toContain('TIMED_OUT')
    expect(answer.missingInformation).toEqual([])
  })

  it('does not report no failures when the run query fails', async () => {
    vi.mocked(listRuns).mockRejectedValueOnce(new Error('database unavailable'))

    await expect(handleRunDiagnose(context())).rejects.toMatchObject({
      code: 'RUN_LIST_UNAVAILABLE',
      kind: 'unavailable',
    } satisfies Partial<DomainError>)
  })
})
