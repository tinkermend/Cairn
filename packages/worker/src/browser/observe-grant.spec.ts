import { describe, expect, it } from 'vitest'
import { OBSERVE_GRANT_TTL_MS, resolveObserveGrant } from './observe-grant'

const pageRef = {
  sessionId: '00000000-0000-4000-8000-0000000000aa',
  sessionGeneration: 1,
  pageId: '00000000-0000-4000-8000-0000000000ab',
  documentEpoch: 1,
}

describe('resolveObserveGrant', () => {
  it('highlight 签发新授权，pick 必须拿着未过期的同一页 grant', () => {
    const issued = resolveObserveGrant({
      op: 'highlight',
      now: 1_000,
      pageRef,
      sessionGeneration: 1,
      runId: '00000000-0000-4000-8000-0000000000ac',
    })
    expect(issued.ok).toBe(true)
    if (!issued.ok) throw new Error('grant')
    expect(issued.issued.expiresAt).toBe(1_000 + OBSERVE_GRANT_TTL_MS)

    const picked = resolveObserveGrant({
      op: 'pick',
      existing: issued.issued,
      now: 2_000,
      pageRef,
      sessionGeneration: 1,
      runId: '00000000-0000-4000-8000-0000000000ac',
    })
    expect(picked.ok).toBe(true)

    const expired = resolveObserveGrant({
      op: 'pick',
      existing: issued.issued,
      now: issued.issued.expiresAt + 1,
      pageRef,
      sessionGeneration: 1,
      runId: '00000000-0000-4000-8000-0000000000ac',
    })
    expect(expired).toEqual({ ok: false, code: 'OBSERVE_GRANT_EXPIRED' })

    const missing = resolveObserveGrant({
      op: 'pick',
      now: 2_000,
      pageRef,
      sessionGeneration: 1,
      runId: '00000000-0000-4000-8000-0000000000ac',
    })
    expect(missing).toEqual({ ok: false, code: 'OBSERVE_GRANT_EXPIRED' })
  })

  it('换页或会话代次变化后旧 grant 不能再 pick', () => {
    const issued = resolveObserveGrant({
      op: 'highlight',
      now: 1_000,
      pageRef,
      sessionGeneration: 1,
      runId: '00000000-0000-4000-8000-0000000000ac',
    })
    if (!issued.ok) throw new Error('grant')
    expect(
      resolveObserveGrant({
        op: 'pick',
        existing: issued.issued,
        now: 2_000,
        pageRef: { ...pageRef, documentEpoch: 2 },
        sessionGeneration: 1,
        runId: '00000000-0000-4000-8000-0000000000ac',
      }),
    ).toEqual({ ok: false, code: 'OBSERVE_GRANT_EXPIRED' })
  })
})
