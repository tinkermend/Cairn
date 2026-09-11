import { describe, expect, it } from 'vitest'
import { candidateTries, decideResolverOutcome, errorForOutcome } from './resolver'

describe('TargetResolver 判定', () => {
  it('全 0 → NOT_FOUND', () => {
    expect(decideResolverOutcome([{ matches: 0 }, { matches: 0 }])).toBe('NOT_FOUND')
  })

  it('出现过 >1 → AMBIGUOUS，即使后面有 0', () => {
    expect(decideResolverOutcome([{ matches: 3 }, { matches: 0 }])).toBe('AMBIGUOUS')
  })

  it('AMBIGUOUS 证据带出每个候选的匹配数', () => {
    const candidates = [
      { by: 'role' as const, value: 'button', name: '删除' },
      { by: 'css' as const, value: '[aria-label="删除"]' },
    ]
    const diagnostics = {
      outcome: 'AMBIGUOUS' as const,
      candidatesTried: candidateTries(candidates, [2, 2]),
    }
    expect(diagnostics.candidatesTried).toEqual([
      { index: 0, by: 'role', value: 'button:删除', matches: 2 },
      { index: 1, by: 'css', value: '[aria-label="删除"]', matches: 2 },
    ])
    const error = errorForOutcome('AMBIGUOUS', diagnostics)
    expect(error.code).toBe('TARGET_AMBIGUOUS')
    expect(error.retryable).toBe(false)
    expect(error.safeMessage).toContain('role=button:删除×2')
  })

  it('四种失败码与重试提示', () => {
    const empty = { outcome: 'NOT_FOUND' as const, candidatesTried: [] }
    expect(errorForOutcome('NOT_FOUND', empty)).toMatchObject({
      code: 'TARGET_NOT_FOUND',
      category: 'EXECUTOR',
      retryable: true,
    })
    expect(errorForOutcome('SURFACE_LOST', { ...empty, outcome: 'SURFACE_LOST' })).toMatchObject({
      code: 'SURFACE_LOST',
      category: 'INFRASTRUCTURE',
      retryable: true,
    })
    expect(errorForOutcome('CAPABILITY_MISSING', { ...empty, outcome: 'CAPABILITY_MISSING' })).toMatchObject({
      code: 'BROWSER_CAPABILITY_MISSING',
      category: 'EXECUTOR',
      retryable: false,
    })
  })
})
