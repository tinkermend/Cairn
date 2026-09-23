import { describe, expect, it } from 'vitest'
import {
  computeEvidenceScores,
  computeEwma,
  computeWindowMetrics,
  evaluateReliabilityRules,
  type StepResolutionSample,
} from '../calculator.js'
import { DEFAULT_RELIABILITY_POLICY } from '@cairn/shared'

describe('Reliability Calculator (RISA01, RISA02, RISA04)', () => {
  describe('computeEwma', () => {
    it('seeds with current value when previous is zero or undefined', () => {
      expect(computeEwma(100, 0, 0.2)).toBe(100)
      expect(computeEwma(50, undefined as any, 0.2)).toBe(50)
    })

    it('correctly applies alpha decay factor', () => {
      // ewma = 0.2 * 200 + 0.8 * 100 = 40 + 80 = 120
      expect(computeEwma(200, 100, 0.2)).toBe(120)
    })
  })

  describe('computeWindowMetrics', () => {
    const makeSample = (overrides: Partial<StepResolutionSample>): StepResolutionSample => ({
      stepRunId: 'sr-1',
      attemptId: 'att-1',
      targetId: 't-1',
      scopeDigest: 'target:t-1',
      isPrimaryHit: true,
      isFallback: false,
      hasRetry: false,
      durationMs: 100,
      success: true,
      subjectRef: { kind: 'scenario_step', id: 's-1' },
      ...overrides,
    })

    it('computes metrics with mixed samples accurately', () => {
      const samples: StepResolutionSample[] = [
        makeSample({ isPrimaryHit: true, isFallback: false, hasRetry: false, durationMs: 100, success: true }),
        makeSample({ isPrimaryHit: true, isFallback: false, hasRetry: false, durationMs: 120, success: true }),
        makeSample({ isPrimaryHit: false, isFallback: true, hasRetry: false, durationMs: 300, success: true }),
        makeSample({ isPrimaryHit: false, isFallback: false, hasRetry: true, durationMs: 250, success: false }),
      ]

      const metrics = computeWindowMetrics(samples, 0, 1.0, 0.2)

      expect(metrics.sampleCount).toBe(4)
      expect(metrics.primaryHitCount).toBe(2)
      expect(metrics.fallbackCount).toBe(1)
      expect(metrics.retryStepCount).toBe(1)
      expect(metrics.primaryHitRate).toBe(0.5) // 2 / 4
      expect(metrics.fallbackRate).toBe(0.25) // 1 / 4
      expect(metrics.p95LatencyMs).toBeGreaterThan(0)
      expect(metrics.medianLatencyMs).toBeGreaterThan(0)
    })
  })

  describe('evaluateReliabilityRules', () => {
    it('returns empty breaches when sample count is below floor', () => {
      const metrics = {
        sampleCount: 5, // floor is 10
        primaryHitCount: 1,
        fallbackCount: 4,
        retryStepCount: 0,
        primaryHitRate: 0.2,
        fallbackRate: 0.8,
        ewmaLatencyMs: 500,
        ewmaSuccessRate: 0.5,
        p95LatencyMs: 600,
        medianLatencyMs: 400,
      }

      const breaches = evaluateReliabilityRules(metrics, DEFAULT_RELIABILITY_POLICY)
      expect(breaches).toEqual([])
    })

    it('detects high fallback rate breach', () => {
      const metrics = {
        sampleCount: 20,
        primaryHitCount: 14,
        fallbackCount: 6, // 30% > 15% threshold
        retryStepCount: 1,
        primaryHitRate: 0.7,
        fallbackRate: 0.3,
        ewmaLatencyMs: 150,
        ewmaSuccessRate: 0.95,
        p95LatencyMs: 200,
        medianLatencyMs: 100,
      }

      const breaches = evaluateReliabilityRules(metrics, DEFAULT_RELIABILITY_POLICY)
      expect(breaches.length).toBeGreaterThan(0)
      const fallbackBreach = breaches.find((b) => b.ruleCode === 'FALLBACK_RATE_SPIKE')
      expect(fallbackBreach).toBeDefined()
      expect(fallbackBreach?.severity).toBe('P3')
    })

    it('detects primary hit rate degradation breach', () => {
      const metrics = {
        sampleCount: 20,
        primaryHitCount: 12, // 60% < 85% threshold
        fallbackCount: 1,
        retryStepCount: 2,
        primaryHitRate: 0.6,
        fallbackRate: 0.05,
        ewmaLatencyMs: 100,
        ewmaSuccessRate: 0.9,
        p95LatencyMs: 120,
        medianLatencyMs: 90,
        retryRate: 0.1,
      }

      const breaches = evaluateReliabilityRules(metrics, DEFAULT_RELIABILITY_POLICY)
      const primaryBreach = breaches.find((b) => b.ruleCode === 'PRIMARY_HIT_RATE_DROP')
      expect(primaryBreach).toBeDefined()
    })
  })

  describe('computeEvidenceScores', () => {
    it('produces bounded evidence score between 0 and 100', () => {
      const score = computeEvidenceScores({
        breachesCount: 2,
        supportingSamplesCount: 10,
        counterSamplesCount: 40,
      })

      expect(score.supportingScore).toBeGreaterThanOrEqual(0)
      expect(score.supportingScore).toBeLessThanOrEqual(100)
      expect(score.counterScore).toBeGreaterThanOrEqual(0)
      expect(score.counterScore).toBeLessThanOrEqual(100)
      expect(score.supportingFactors.length).toBeGreaterThan(0)
      expect(score.counterFactors.length).toBeGreaterThan(0)
    })
  })
})
