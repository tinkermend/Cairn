import { describe, expect, it } from 'vitest'
import { computeGroupingFingerprint } from '../grouping-fingerprint.js'

describe('Grouping Fingerprint (RISA03)', () => {
  it('generates consistent and deterministic fingerprints for identical inputs', () => {
    const input = {
      targetId: 'target-1',
      accountId: 'account-1',
      stepName: 'Click Submit',
      errorFamily: 'TimeoutError',
    }

    const fp1 = computeGroupingFingerprint(input)
    const fp2 = computeGroupingFingerprint(input)

    expect(fp1).toBe(fp2)
    expect(fp1).toMatch(/^[a-f0-9]{32}$/)
  })

  it('differentiates fingerprints when targetId changes', () => {
    const fp1 = computeGroupingFingerprint({ targetId: 'target-1', errorFamily: 'Timeout' })
    const fp2 = computeGroupingFingerprint({ targetId: 'target-2', errorFamily: 'Timeout' })

    expect(fp1).not.toBe(fp2)
  })

  it('differentiates fingerprints when errorFamily changes', () => {
    const fp1 = computeGroupingFingerprint({ targetId: 'target-1', errorFamily: 'Timeout' })
    const fp2 = computeGroupingFingerprint({ targetId: 'target-1', errorFamily: 'ElementNotFound' })

    expect(fp1).not.toBe(fp2)
  })

  it('handles empty/undefined optional attributes gracefully', () => {
    const fp = computeGroupingFingerprint({ targetId: 'target-1' })
    expect(fp).toMatch(/^[a-f0-9]{32}$/)
  })
})
