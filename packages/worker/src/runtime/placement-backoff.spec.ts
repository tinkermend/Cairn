import { afterEach, describe, expect, it, vi } from 'vitest'
import { yieldClaimedRun } from '@cairn/db'
import type { RunGrant } from '@cairn/shared'
import {
  PLACEMENT_YIELD_BACKOFF_MS,
  clearPlacementYields,
  placementYieldExcludes,
  rememberPlacementYield,
  yieldPlacement,
} from './placement-backoff'

vi.mock('@cairn/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cairn/db')>()
  return {
    ...actual,
    yieldClaimedRun: vi.fn(),
  }
})

const grant: RunGrant = {
  runId: 'run-y',
  leaseId: 'lease-y',
  fencingToken: 1,
  holderWorkerId: 'w',
  expiresAt: new Date().toISOString(),
}

describe('placement yield backoff', () => {
  afterEach(() => {
    clearPlacementYields()
    vi.mocked(yieldClaimedRun).mockReset()
  })

  it('冷却窗口内排除该 runId，过期后不再排除', () => {
    const now = 1_000_000
    rememberPlacementYield('run-a', now)
    expect(placementYieldExcludes(now + 1)).toEqual(['run-a'])
    expect(placementYieldExcludes(now + PLACEMENT_YIELD_BACKOFF_MS + 1)).toEqual([])
  })

  it('回交成功才记冷却；has_attempts / unknown 不记', async () => {
    vi.mocked(yieldClaimedRun).mockResolvedValueOnce('yielded')
    expect(await yieldPlacement({} as never, grant)).toBe('yielded')
    expect(placementYieldExcludes()).toEqual(['run-y'])

    clearPlacementYields()
    vi.mocked(yieldClaimedRun).mockResolvedValueOnce('has_attempts')
    expect(await yieldPlacement({} as never, grant)).toBe('has_attempts')
    expect(placementYieldExcludes()).toEqual([])

    vi.mocked(yieldClaimedRun).mockResolvedValueOnce('unknown')
    expect(await yieldPlacement({} as never, grant)).toBe('unknown')
    expect(placementYieldExcludes()).toEqual([])
  })
})
