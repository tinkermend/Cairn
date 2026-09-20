import { describe, expect, it } from 'vitest'
import {
  overviewAnalyticsQuerySchema,
  overviewAnalyticsResponseSchema,
} from '../overview-analytics.js'

describe('overviewAnalytics schemas', () => {
  it('parses valid query with default range', () => {
    const parsed = overviewAnalyticsQuerySchema.parse({})
    expect(parsed.range).toBe('7d')
    expect(parsed.targetId).toBeUndefined()
  })

  it('parses valid query with custom range and targetId', () => {
    const targetId = '018f3a2b-1111-7000-8000-000000000001'
    const parsed = overviewAnalyticsQuerySchema.parse({
      range: '30d',
      targetId,
    })
    expect(parsed.range).toBe('30d')
    expect(parsed.targetId).toBe(targetId)
  })

  it('validates a complete overview analytics response', () => {
    const sample = {
      asOf: '2026-09-20T00:00:00.000Z',
      range: '7d',
      summary: {
        totalRuns: 100,
        succeededRuns: 95,
        failedRuns: 3,
        timedOutRuns: 1,
        canceledRuns: 1,
        runningRuns: 0,
        pendingRuns: 0,
        successRate: 0.95,
        avgDurationMs: 12500,
        p95DurationMs: 25000,
        runsDeltaPercentage: 15.5,
        successRateDeltaPercentage: 2.1,
      },
      timeline: [
        {
          bucketAt: '2026-09-19T00:00:00.000Z',
          total: 10,
          succeeded: 10,
          failed: 0,
          timedOut: 0,
          canceled: 0,
          running: 0,
          successRate: 1.0,
          p95DurationMs: 10000,
        },
      ],
      outcomes: {
        passed: 90,
        violation: 5,
        failed: 3,
        notEvaluated: 2,
      },
      triggers: {
        manual: 40,
        schedule: 30,
        serviceApi: 20,
        suiteMember: 10,
      },
      topScenarios: [
        {
          scenarioId: '018f3a2b-1111-7000-8000-000000000002',
          scenarioName: '登录并创建订单',
          targetId: '018f3a2b-1111-7000-8000-000000000001',
          targetName: '电商前台系统',
          runCount: 50,
          failCount: 1,
          successRate: 0.98,
        },
      ],
      troubledScenarios: [],
    }

    const validated = overviewAnalyticsResponseSchema.parse(sample)
    expect(validated.summary.totalRuns).toBe(100)
    expect(validated.summary.successRate).toBe(0.95)
    expect(validated.timeline).toHaveLength(1)
  })
})
