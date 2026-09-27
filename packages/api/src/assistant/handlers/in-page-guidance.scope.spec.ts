import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleInPageGuidance } from './in-page-guidance.handler.js'
import { authorizeTargetRequest, getTargetKnowledgeContext } from '@cairn/db'

vi.mock('@cairn/db', () => ({
  authorizeTargetRequest: vi.fn(),
  getTargetKnowledgeContext: vi.fn(),
}))
vi.mock('./common.js', () => ({ requireVisibleTarget: vi.fn() }))

describe('in-page guidance target knowledge scope', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not read target map knowledge when map:read excludes that target', async () => {
    vi.mocked(authorizeTargetRequest).mockRejectedValue(new Error('TARGET_NOT_FOUND'))
    const completeJson = vi.fn()
    await expect(handleInPageGuidance({
      question: 'zz-unmatched-page-question',
      body: {
        question: 'zz-unmatched-page-question',
        pageContext: { page: 'studio', targetId: 'target-b' },
      },
      actor: { id: 'actor-a', permissions: ['ai:assist', 'target:read', 'map:read'] },
      db: {}, targets: {}, session: { completeJson },
    } as never)).rejects.toThrow('TARGET_NOT_FOUND')
    expect(authorizeTargetRequest).toHaveBeenCalledWith(expect.anything(), 'actor-a', {
      targetId: 'target-b', permissions: ['map:read'],
    })
    expect(getTargetKnowledgeContext).not.toHaveBeenCalled()
    expect(completeJson).not.toHaveBeenCalled()
  })
})
