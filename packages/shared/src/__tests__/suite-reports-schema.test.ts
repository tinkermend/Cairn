import { describe, expect, it } from 'vitest'
import {
  computeSuiteHealthScore,
  suiteSummaryBlockSchema,
  HEALTH_GRADE_LABELS,
  SUITE_GRID_STATUS_LABELS,
  type SuiteSummaryBlock,
} from '../reports.js'

describe('场景集综合巡检总报表 Schema 与健康度算法', () => {
  it('验证 suiteSummaryBlockSchema 结构校验', () => {
    const validBlock: SuiteSummaryBlock = {
      type: 'suite_business_summary',
      healthScore: 92,
      healthGrade: 'EXCELLENT',
      totalCount: 4,
      normalCount: 3,
      warningCount: 1,
      anomalousCount: 0,
      skippedCount: 0,
      wallClockMs: 12000,
      childDurationMs: 36000,
      savedPercent: 67,
      gridRows: [
        {
          ordinal: 0,
          memberId: 'm1',
          displayName: '用户中心探活',
          scenarioName: '用户中心登录',
          status: 'NORMAL',
          summary: '鉴权正常',
          metrics: { latencyMs: 250 },
          dataRow: { token: 'valid' },
          durationMs: 4000,
          hasFindings: false,
        },
        {
          ordinal: 1,
          memberId: 'm2',
          displayName: '订单超时工单',
          scenarioName: '工单积压巡检',
          status: 'WARNING',
          summary: '发现待办延迟',
          metrics: { pendingCount: 5 },
          dataRow: { queue: 'dispatch' },
          durationMs: 8000,
          hasFindings: true,
        },
      ],
      aggregatedFindings: [
        {
          memberId: 'm2',
          displayName: '订单超时工单',
          id: 'f-1',
          title: '工单积压待处理',
          severity: 'WARN',
          detail: '5 张工单等待派发超过 10 分钟',
          evidenceId: '00000000-0000-4000-8000-000000000001',
        },
      ],
    }

    const parsed = suiteSummaryBlockSchema.parse(validBlock)
    expect(parsed.healthScore).toBe(92)
    expect(parsed.healthGrade).toBe('EXCELLENT')
    expect(parsed.gridRows).toHaveLength(2)
    expect(parsed.aggregatedFindings).toHaveLength(1)
  })

  it('验证非法 block 报错拦截', () => {
    expect(() =>
      suiteSummaryBlockSchema.parse({
        type: 'suite_business_summary',
        healthScore: 105, // 超过 100
        healthGrade: 'EXCELLENT',
        totalCount: 1,
      }),
    ).toThrow()

    expect(() =>
      suiteSummaryBlockSchema.parse({
        type: 'other_type',
        healthScore: 90,
      }),
    ).toThrow()
  })

  it('验证 computeSuiteHealthScore 算分与评级逻辑', () => {
    // 零项保底 100 分
    expect(
      computeSuiteHealthScore({
        totalCount: 0,
        normalCount: 0,
        warningCount: 0,
        anomalousCount: 0,
      }),
    ).toEqual({ healthScore: 100, healthGrade: 'EXCELLENT' })

    // 全量正常 100 分 (EXCELLENT)
    expect(
      computeSuiteHealthScore({
        totalCount: 5,
        normalCount: 5,
        warningCount: 0,
        anomalousCount: 0,
      }),
    ).toEqual({ healthScore: 100, healthGrade: 'EXCELLENT' })

    // 10 项中 9 项正常，1 项异常：(900)/10 = 90分 (EXCELLENT)
    expect(
      computeSuiteHealthScore({
        totalCount: 10,
        normalCount: 9,
        warningCount: 0,
        anomalousCount: 1,
      }),
    ).toEqual({ healthScore: 90, healthGrade: 'EXCELLENT' })

    // 10 项中 7 项正常，2 项警告，1 项异常：(700 + 120)/10 = 82分 (GOOD)
    expect(
      computeSuiteHealthScore({
        totalCount: 10,
        normalCount: 7,
        warningCount: 2,
        anomalousCount: 1,
      }),
    ).toEqual({ healthScore: 82, healthGrade: 'GOOD' })

    // 10 项中 5 项正常，2 项警告，3 项异常：(500 + 120)/10 = 62分 (FAIR)
    expect(
      computeSuiteHealthScore({
        totalCount: 10,
        normalCount: 5,
        warningCount: 2,
        anomalousCount: 3,
      }),
    ).toEqual({ healthScore: 62, healthGrade: 'FAIR' })

    // 严重异常：(200)/10 = 20分 (POOR)
    expect(
      computeSuiteHealthScore({
        totalCount: 10,
        normalCount: 2,
        warningCount: 0,
        anomalousCount: 8,
      }),
    ).toEqual({ healthScore: 20, healthGrade: 'POOR' })
  })

  it('验证标签字典完备性', () => {
    expect(HEALTH_GRADE_LABELS.EXCELLENT).toBe('优')
    expect(HEALTH_GRADE_LABELS.POOR).toBe('差')
    expect(SUITE_GRID_STATUS_LABELS.NORMAL).toBe('正常')
    expect(SUITE_GRID_STATUS_LABELS.ANOMALOUS).toBe('异常')
  })
})
