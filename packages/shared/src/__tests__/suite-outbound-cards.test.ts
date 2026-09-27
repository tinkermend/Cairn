import { describe, expect, it } from 'vitest'
import { buildDingTalkCard, buildFeishuCard, buildWechatWorkCard } from '../outbound.js'
import type { SuiteSummaryBlock } from '../reports.js'

const summary: SuiteSummaryBlock = {
  type: 'suite_business_summary',
  healthScore: null,
  healthGrade: null,
  totalCount: 3,
  normalCount: 0,
  warningCount: 0,
  anomalousCount: 0,
  undeterminedCount: 3,
  skippedCount: 0,
  wallClockMs: 1000,
  childDurationMs: 1000,
  savedPercent: 0,
  gridRows: [],
  aggregatedFindings: [],
}

function cardTexts(value: SuiteSummaryBlock): string[] {
  return [
    buildWechatWorkCard({ summary: value, suiteName: '巡检' }).markdown.content,
    buildFeishuCard({ summary: value, suiteName: '巡检' }).card.elements[0].text.content as string,
    buildDingTalkCard({ summary: value, suiteName: '巡检' }).actionCard.text as string,
  ]
}

describe('场景集外发消息卡', () => {
  it('业务未判定时三个渠道均不宣称满分或全部通过', () => {
    for (const text of cardTexts(summary)) {
      expect(text).toContain('未判定 3')
      expect(text).toContain('未评分')
      expect(text).not.toContain('100分')
      expect(text).not.toContain('✅ 全部通过')
    }
  })

  it('旧排队摘要缺少新分类字段时保守提示', () => {
    const { undeterminedCount: _ignored, ...oldSummary } = {
      ...summary,
      healthScore: 100,
      healthGrade: 'EXCELLENT' as const,
      normalCount: 3,
    }
    for (const text of cardTexts(oldSummary as SuiteSummaryBlock)) {
      expect(text).toContain('历史分类未核验')
      expect(text).toContain('未评分')
      expect(text).not.toContain('✅ 全部通过')
    }
  })
})
