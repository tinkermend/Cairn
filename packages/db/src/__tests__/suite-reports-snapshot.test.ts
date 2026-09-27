import { describe, expect, it } from 'vitest'
import { buildDocument } from '../reports/reports.js'
import { reportScreenshotRefs } from '../reports/materials.js'
import {
  DEFAULT_REPORT_CONFIG,
  suiteSummaryBlockSchema,
  type SuiteSummaryBlock,
} from '@cairn/shared'

describe('场景集综合巡检报告文档装配与快照', () => {
  it('SUITE_RUN 正确装配四层报告与 suite_business_summary 汇总块', () => {
    const mockSuiteSource = {
      kind: 'SUITE_RUN' as const,
      suiteRunId: '00000000-0000-4000-8000-000000000010',
      suiteName: '每日核心巡检',
      targetName: '电商生产系统',
      status: 'COMPLETED',
      verdict: 'anomalies_found',
      wallClockMs: 15000,
      childDurationMs: 45000,
      items: [
        {
          ordinal: 0,
          memberId: 'm1',
          displayName: '用户中心探活',
          admission: 'SETTLED',
          run: {
            scenarioName: '用户中心探活',
            status: 'SUCCEEDED',
            outcomeStatus: 'PASS',
            startedAt: '2026-09-22T10:00:00.000Z',
            finishedAt: '2026-09-22T10:00:10.000Z',
            output: {
              status: 'NORMAL',
              summary: '登录鉴权成功，Token 有效',
              metrics: { latencyMs: 230 },
              dataRow: { userCount: 100 },
              findings: [],
            },
          },
        },
        {
          ordinal: 1,
          memberId: 'm2',
          displayName: '订单积压巡检',
          admission: 'SETTLED',
          run: {
            scenarioName: '订单超时检查',
            status: 'FAILED',
            outcomeStatus: 'FAIL',
            startedAt: '2026-09-22T10:00:00.000Z',
            finishedAt: '2026-09-22T10:00:20.000Z',
            output: {
              status: 'ANOMALOUS',
              summary: '发现待处理工单超时积压',
              metrics: { backlogCount: 5 },
              dataRow: { queueName: 'order_dispatch' },
              findings: [
                {
                  id: 'f-101',
                  title: '订单积压超时 15 分钟',
                  severity: 'HIGH',
                  detail: '当前队列待派发工单 5 笔已超限',
                  evidenceId: '00000000-0000-4000-8000-000000000099',
                },
              ],
            },
          },
        },
        {
          ordinal: 2,
          memberId: 'm3',
          displayName: '商品库存核对',
          admission: 'SKIPPED',
          skipReason: 'failure_policy_stop',
          run: {},
        },
        {
          ordinal: 3,
          memberId: 'm4',
          displayName: '历史未升级场景',
          admission: 'SETTLED',
          run: {
            scenarioName: '支付对账',
            status: 'SUCCEEDED',
            outcomeStatus: 'PASS',
            startedAt: '2026-09-22T10:00:00.000Z',
            finishedAt: '2026-09-22T10:00:15.000Z',
            // 无 output 契约，测试优雅降级
          },
        },
      ],
    }

    const doc = buildDocument({
      stage: 'final',
      title: '每日核心巡检 2026-09-22 运行报告',
      config: DEFAULT_REPORT_CONFIG,
      source: mockSuiteSource,
      gaps: [],
    })

    expect(doc.sections).toHaveLength(2)
    const overviewSection = doc.sections.find((s) => s.id === 'overview')
    expect(overviewSection).toBeDefined()

    const summaryBlockRaw = overviewSection!.blocks.find((b) => b.type === 'suite_business_summary')
    expect(summaryBlockRaw).toBeDefined()

    const summaryBlock = suiteSummaryBlockSchema.parse(summaryBlockRaw)
    expect(summaryBlock.totalCount).toBe(4)
    expect(summaryBlock.normalCount).toBe(2) // m1 与保底降级的 m4
    expect(summaryBlock.anomalousCount).toBe(1) // m2
    expect(summaryBlock.skippedCount).toBe(1) // m3
    expect(summaryBlock.savedPercent).toBe(67) // (45000 - 15000) / 45000 = 66.67% -> 67%

    // 跳过项没有业务结论，整集不能给出业务评分。
    expect(summaryBlock.healthScore).toBeNull()
    expect(summaryBlock.healthGrade).toBeNull()
    expect(summaryBlock.undeterminedCount).toBe(0)

    // 检查 L1 业务宽表行
    expect(summaryBlock.gridRows).toHaveLength(4)
    expect(summaryBlock.gridRows[0]!.status).toBe('NORMAL')
    expect(summaryBlock.gridRows[0]!.metrics).toEqual({ latencyMs: 230 })
    expect(summaryBlock.gridRows[1]!.status).toBe('ANOMALOUS')
    expect(summaryBlock.gridRows[1]!.hasFindings).toBe(true)
    expect(summaryBlock.gridRows[2]!.status).toBe('SKIPPED')
    expect(summaryBlock.gridRows[2]!.summary).toBe('failure_policy_stop')
    expect(summaryBlock.gridRows[3]!.status).toBe('NORMAL')
    expect(summaryBlock.gridRows[3]!.summary).toBe('运行正常通过')

    // 检查 L2 异常透视聚合 Findings
    expect(summaryBlock.aggregatedFindings).toHaveLength(1)
    expect(summaryBlock.aggregatedFindings[0]!.memberId).toBe('m2')
    expect(summaryBlock.aggregatedFindings[0]!.displayName).toBe('订单积压巡检')
    expect(summaryBlock.aggregatedFindings[0]!.severity).toBe('HIGH')
    expect(summaryBlock.aggregatedFindings[0]!.evidenceId).toBe('00000000-0000-4000-8000-000000000099')
  })

  it('旧输出的执行失败和未配置业务检查不会被报告计为业务正常或异常', () => {
    const doc = buildDocument({
      stage: 'final',
      title: '历史巡检',
      config: DEFAULT_REPORT_CONFIG,
      gaps: [],
      source: {
        kind: 'SUITE_RUN',
        status: 'COMPLETED',
        verdict: 'incomplete',
        items: [
          {
            ordinal: 0,
            memberId: 'm1',
            displayName: '无检查项',
            admission: 'SETTLED',
            run: {
              status: 'SUCCEEDED',
              outcomeStatus: 'NOT_EVALUATED',
              output: { status: 'NORMAL', summary: '业务正常', metrics: {}, findings: [], dataRow: {}, assembledAt: '2026-09-22T10:00:00.000Z' },
            },
          },
          {
            ordinal: 1,
            memberId: 'm2',
            displayName: '执行中断',
            admission: 'SETTLED',
            run: {
              status: 'FAILED',
              outcomeStatus: 'NOT_EVALUATED',
              output: {
                status: 'ANOMALOUS',
                summary: '业务成功',
                metrics: {},
                findings: [{ id: 'f-execution-failed', severity: 'HIGH', title: '执行中断' }],
                dataRow: {},
                assembledAt: '2026-09-22T10:00:00.000Z',
              },
            },
          },
        ],
      },
    })
    const summary = suiteSummaryBlockSchema.parse(doc.sections.flatMap((section) => section.blocks).find((block) => block.type === 'suite_business_summary'))
    expect(summary.normalCount).toBe(0)
    expect(summary.anomalousCount).toBe(0)
    expect(summary.undeterminedCount).toBe(2)
    expect(summary.healthScore).toBeNull()
    expect(summary.gridRows.map((row) => row.status)).toEqual(['UNDETERMINED', 'UNDETERMINED'])
    expect(summary.gridRows.every((row) => !row.summary.includes('业务成功'))).toBe(true)
  })

  it('reportScreenshotRefs 自动将 Finding 关联的证据标记为 anomalous 纳入报告材料', () => {
    const mockRunSource = {
      kind: 'RUN' as const,
      runId: '00000000-0000-4000-8000-000000000020',
      scenarioName: '业务巡检',
      output: {
        findings: [
          {
            id: 'f-1',
            evidenceId: '00000000-0000-4000-8000-000000000088',
          },
        ],
      },
      evidence: [
        {
          evidenceId: '00000000-0000-4000-8000-000000000088',
          type: 'screenshot',
          status: 'available',
        },
        {
          evidenceId: '00000000-0000-4000-8000-000000000089',
          type: 'screenshot',
          status: 'available',
        },
      ],
      stepRuns: [
        {
          id: 'step-1',
          name: '步骤1',
          status: 'SUCCEEDED',
          outcomeStatus: 'PASS',
          attempts: [],
        },
      ],
    }

    const refs = reportScreenshotRefs(mockRunSource)
    const ref88 = refs.find((r) => r.evidenceId === '00000000-0000-4000-8000-000000000088')
    const ref89 = refs.find((r) => r.evidenceId === '00000000-0000-4000-8000-000000000089')

    expect(ref88?.anomalous).toBe(true) // Finding 关联，被标记为 anomalous
    expect(ref89?.anomalous).toBe(false)
  })
})
