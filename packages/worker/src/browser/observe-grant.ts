import type { ObserveGrant, PageRef } from '@cairn/shared'

export const OBSERVE_GRANT_TTL_MS = 60_000

export type IssuedObserveGrant = { grant: ObserveGrant; expiresAt: number }

export function resolveObserveGrant(input: {
  op: 'highlight' | 'pick'
  existing?: IssuedObserveGrant
  now: number
  pageRef: PageRef
  sessionGeneration: number
  runId: string
}): { ok: true; issued: IssuedObserveGrant } | { ok: false; code: 'OBSERVE_GRANT_EXPIRED' } {
  const valid = Boolean(
    input.existing &&
      input.existing.expiresAt > input.now &&
      input.existing.grant.pageRef.pageId === input.pageRef.pageId &&
      input.existing.grant.pageRef.documentEpoch === input.pageRef.documentEpoch &&
      input.existing.grant.sessionGeneration === input.sessionGeneration,
  )
  if (input.op === 'pick') {
    if (!valid || !input.existing) return { ok: false, code: 'OBSERVE_GRANT_EXPIRED' }
    return { ok: true, issued: input.existing }
  }
  return {
    ok: true,
    issued: {
      grant: {
        runId: input.runId,
        sessionGeneration: input.sessionGeneration,
        pageRef: input.pageRef,
        epoch: (input.existing?.grant.epoch ?? 0) + 1,
      },
      expiresAt: input.now + OBSERVE_GRANT_TTL_MS,
    },
  }
}
