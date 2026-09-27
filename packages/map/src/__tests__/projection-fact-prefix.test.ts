import { describe, expect, it } from 'vitest'
import { projectionFactPrefix } from '../projection.js'
import type { MapFactPageItem } from '../ports.js'

describe('projection fact budget', () => {
  it('stops at a whole-fact boundary before a large inventory exceeds the plan object limit', () => {
    const facts = Array.from({ length: 7 }, (_, index) => ({
      type: 'observation' as const,
      ingestSeq: index + 1,
      observation: {
        structuralSummary: {
          features: {
            kind: 'surface-inventory',
            named: Array.from({ length: 80 }, (_, item) => ({ role: 'button', name: `action-${index}-${item}` })),
          },
        },
      },
    })) as unknown as MapFactPageItem[]

    expect(projectionFactPrefix(facts).map(fact => fact.ingestSeq)).toEqual([1, 2, 3])
    expect(projectionFactPrefix(facts.slice(3)).map(fact => fact.ingestSeq)).toEqual([4, 5, 6])
    expect(projectionFactPrefix(facts.slice(6)).map(fact => fact.ingestSeq)).toEqual([7])
  })
})
