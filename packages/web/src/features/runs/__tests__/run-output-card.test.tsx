import '@/styles/index.css'
import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import type { RunOutput } from '@cairn/shared'
import { RunOutputCard } from '../run-output-card'

const mockOutput: RunOutput = {
  summary: '巡检完成，在售商品 128 件，发现 1 项库存不足警告',
  status: 'WARNING',
  metrics: {
    item_count: 128,
    is_available: true,
    avg_price: '¥89.50',
  },
  findings: [
    {
      id: 'f-1',
      severity: 'WARN',
      title: '商品库存量低于预警水位',
      detail: '商品 SKU-8801 当前库存仅余 2 件',
      stepOrdinal: 2,
      evidenceId: '00000000-0000-4000-8000-000000000091',
    },
  ],
  dataRow: {
    sku_id: 'SKU-8801',
    stock_qty: 2,
  },
  assembledAt: '2026-09-22T10:00:00.000Z',
}

describe('RunOutputCard', () => {
  it('无 output 时返回 null，不渲染任何节点', async () => {
    const { container } = await render(<RunOutputCard output={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('渲染业务产出包卡片：包含业务结论、状态徽标、核心指标与发现项', async () => {
    const onFocusEvidence = vi.fn()
    const onFocusStep = vi.fn()

    const { getByText, getByTestId, getByRole } = await render(
      <RunOutputCard
        output={mockOutput}
        onFocusEvidence={onFocusEvidence}
        onFocusStep={onFocusStep}
      />,
    )

    // 标题与状态
    await expect.element(getByText('业务产出与巡检指标')).toBeInTheDocument()
    await expect.element(getByText('业务警告')).toBeInTheDocument()

    // 业务结论
    const summaryEl = getByTestId('run-output-summary')
    await expect.element(summaryEl).toBeInTheDocument()
    await expect.element(summaryEl).toHaveTextContent('巡检完成，在售商品 128 件')

    // 核心指标
    await expect.element(getByTestId('metric-card-item_count')).toHaveTextContent('128')
    await expect.element(getByTestId('metric-card-is_available')).toHaveTextContent('是')
    await expect.element(getByTestId('metric-card-avg_price')).toHaveTextContent('¥89.50')

    // 业务发现项与跳转
    await expect.element(getByText('商品库存量低于预警水位')).toBeInTheDocument()
    await expect.element(getByText('商品 SKU-8801 当前库存仅余 2 件')).toBeInTheDocument()

    // 点击步骤按钮
    const stepBtn = getByText('第 3 步')
    await expect.element(stepBtn).toBeInTheDocument()
    await stepBtn.click()
    expect(onFocusStep).toHaveBeenCalledWith(2)

    // 点击查看现场按钮
    const evidenceBtn = getByRole('button', { name: /查看现场/ })
    await expect.element(evidenceBtn).toBeInTheDocument()
    await evidenceBtn.click()
    expect(onFocusEvidence).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000091')

    // 展开单行宽表
    const expandBtn = getByRole('button', { name: /提取数据/ })
    await expect.element(expandBtn).toBeInTheDocument()
    await expandBtn.click()
    await expect.element(getByRole('cell', { name: 'SKU-8801' })).toBeInTheDocument()
  })
})
