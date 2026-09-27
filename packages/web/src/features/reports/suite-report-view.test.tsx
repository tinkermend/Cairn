import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import type { ReportDocument } from '@cairn/shared'
import { SuiteReportView } from './suite-report-view'

const sampleSuiteDocument: ReportDocument = {
  stage: 'final',
  title: '双十一电商核心链路巡检总报表',
  timeZone: 'Asia/Shanghai',
  generatedAt: '2026-09-22T00:00:00.000Z',
  asOf: '2026-09-22T00:00:00.000Z',
  source: {},
  summary: {},
  gaps: [],
  materials: [
    {
      id: '11111111-1111-4111-8111-111111111110',
      kind: 'screenshot',
      evidenceId: '11111111-1111-4111-8111-111111111111',
      artifactId: '22222222-2222-4222-8222-222222222222',
      runId: null,
      caption: '支付超时现场截图',
      digest: null,
      width: 1280,
      height: 720,
      missingReason: null,
    },
  ],
  sections: [
    {
      id: 'sec-1',
      title: '业务总览',
      required: true,
      blocks: [
        {
          type: 'suite_business_summary',
          healthScore: 59,
          healthGrade: 'POOR',
          totalCount: 3,
          normalCount: 2,
          warningCount: 0,
          anomalousCount: 1,
          skippedCount: 0,
          undeterminedCount: 0,
          wallClockMs: 12000,
          childDurationMs: 30000,
          savedPercent: 60,
          gridRows: [
            {
              ordinal: 0,
              memberId: 'm1',
              displayName: '商品详情页加载',
              scenarioName: '商品中心',
              status: 'NORMAL',
              summary: '商品信息完整',
              metrics: { responseTime: 120 },
              dataRow: { skuId: 9901, stock: 100 },
              durationMs: 3200,
              hasFindings: false,
            },
            {
              ordinal: 1,
              memberId: 'm2',
              displayName: '下单与结算',
              scenarioName: '交易中心',
              status: 'ANOMALOUS',
              summary: '支付超时未返回确认',
              metrics: { timeoutMs: 5000 },
              dataRow: { orderId: 'ORD-20260922-001' },
              durationMs: 8800,
              hasFindings: true,
            },
            {
              ordinal: 2,
              memberId: 'm3',
              displayName: '满减优惠券领取',
              scenarioName: '营销中心',
              status: 'NORMAL',
              summary: '优惠券到账正常',
              metrics: {},
              dataRow: { couponId: 'CPN-100' },
              durationMs: 4500,
              hasFindings: false,
            },
          ],
          aggregatedFindings: [
            {
              id: 'f-1',
              memberId: 'm2',
              displayName: '下单与结算',
              severity: 'FATAL',
              title: '支付网关未在 5s 内响应',
              detail: '模拟支付请求在 5000ms 后超时，未收到后端回执回调。',
              evidenceId: '11111111-1111-4111-8111-111111111111',
            },
          ],
        },
      ],
    },
  ],
}

describe('SuiteReportView 交互控制台与四层总报表', () => {
  it('L0: 正确展示健康评分卡、模块状态分布与并发耗时节约指标', async () => {
    await render(<SuiteReportView document={sampleSuiteDocument} />)

    await expect.element(page.getByText('59')).toBeVisible()
    await expect.element(page.getByText('评级：差')).toBeVisible()
    await expect.element(page.getByText('并发节约 60% 耗时')).toBeVisible()
    await expect.element(page.getByText('整次耗时：12.0 秒')).toBeVisible()
    await expect.element(page.getByText('总巡检项')).toBeVisible()
  })

  it('L1: 渲染业务巡检对照总表，并支持按状态过滤切分', async () => {
    await render(<SuiteReportView document={sampleSuiteDocument} />)

    // Check table rows
    await expect.element(page.getByText('商品中心')).toBeVisible()
    await expect.element(page.getByRole('cell', { name: '下单与结算' })).toBeVisible()
    await expect.element(page.getByText('满减优惠券领取')).toBeVisible()
    await expect.element(page.getByText('skuId:')).toBeVisible()

    // Filter to ANOMALOUS only
    const anomalousFilterBtn = page.getByRole('button', { name: '仅看异常 (1)' })
    await anomalousFilterBtn.click()

    await expect.element(page.getByRole('cell', { name: '下单与结算' })).toBeVisible()
    await expect.element(page.getByText('商品详情页加载')).not.toBeInTheDocument()

    // Filter back to ALL
    const allFilterBtn = page.getByRole('button', { name: '全部 (3)' })
    await allFilterBtn.click()
    await expect.element(page.getByText('商品详情页加载')).toBeVisible()
  })

  it('L2: 渲染现场异常证据画廊，支持缩略图与点击全屏审查 Lightbox', async () => {
    await render(<SuiteReportView document={sampleSuiteDocument} />)

    await expect.element(page.getByText('支付网关未在 5s 内响应')).toBeVisible()
    await expect.element(page.getByText('模拟支付请求在 5000ms 后超时，未收到后端回执回调。')).toBeVisible()

    const previewBtn = page.getByRole('button', { name: '查看高清原图' })
    await expect.element(previewBtn).toBeVisible()

    // Click to open Lightbox Dialog
    await previewBtn.click()

    await expect.element(page.getByRole('button', { name: '重置' })).toBeVisible()
  })

  it('L3: 渲染技术明细与运行追溯折叠区', async () => {
    await render(<SuiteReportView document={sampleSuiteDocument} />)

    await expect.element(page.getByText(/【L3: 技术明细与执行追溯】/)).toBeVisible()
  })

  it('提供一键复制决策总结功能', async () => {
    if (!navigator.clipboard) {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
      })
    }
    const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)

    await render(<SuiteReportView document={sampleSuiteDocument} />)

    const copyBtn = page.getByRole('button', { name: '复制总结' })
    await expect.element(copyBtn).toBeVisible()
    await copyBtn.click()

    expect(writeTextSpy).toHaveBeenCalled()
    const copiedText = writeTextSpy.mock.calls[0]?.[0]
    expect(copiedText).toContain('【双十一电商核心链路巡检总报表】')
    expect(copiedText).toContain('业务检查得分：59分 (差)')
    expect(copiedText).toContain('支付网关未在 5s 内响应')
  })

  it('旧版封存报告按来源运行只读修正未评估分类与满分展示', async () => {
    const legacy = structuredClone(sampleSuiteDocument)
    const block = legacy.sections[0]!.blocks[0]!
    block.healthScore = 100
    block.healthGrade = 'EXCELLENT'
    block.normalCount = 3
    block.anomalousCount = 0
    delete block.undeterminedCount
    const rows = block.gridRows as Array<Record<string, unknown>>
    block.gridRows = rows.map((row) => ({ ...row, status: 'NORMAL' })) as typeof block.gridRows
    legacy.verdict = 'incomplete'
    legacy.source = {
      items: ['m1', 'm2', 'm3'].map((memberId) => ({
        memberId,
        admission: 'SETTLED',
        run: { status: 'SUCCEEDED', outcomeStatus: 'NOT_EVALUATED' },
      })),
    }
    await render(<SuiteReportView document={legacy} />)
    await expect.element(page.getByText('业务结果未完整判定，暂不评分')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '仅看正常 (0)' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '仅看未判定 (3)' })).toBeVisible()
    await expect.element(page.getByText(/旧版封存报告。本页按来源运行重新分类 3 项/)).toBeVisible()
    await expect.element(page.getByText('评级：优')).not.toBeInTheDocument()
  })
})
