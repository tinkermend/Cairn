import '@/styles/index.css'
import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { StepHealingCard } from './step-healing-card'
import type { Step } from '@cairn/shared'
import { makeRepairCandidate } from '@/test-utils/repair-candidate'

describe('StepHealingCard', () => {
  const mockStep = {
    id: 'step-1',
    name: '点击确认支付',
    type: 'click',
    effectType: 'SIDE_EFFECT',
    input: {
      target: {
        framePath: [],
        candidates: [{ by: 'css', value: 'button.pay-btn-2025' }],
      },
    },
  } as Step

  const mockCandidate = makeRepairCandidate({
    patch: {
      kind: 'ADD_CANDIDATE',
      suggestedCandidate: { by: 'role', value: 'button', name: '确认支付 ￥99.00' },
    },
  })

  const mockHealth = {
    status: 'fallback_warning' as const,
    ruleHitRate: 0.25,
    fallbackRate: 0.75,
    ai: 3,
    located: 4,
    failed: 0,
  }

  it('展示健康度预警、规则对比与安全说明', async () => {
    const { getByTestId, getByText } = await render(
      <StepHealingCard
        step={mockStep}
        health={mockHealth}
        candidate={mockCandidate}
      />,
    )

    await expect.element(getByTestId('step-healing-card')).toBeInTheDocument()
    await expect.element(getByText(/近期规则命中率降至 25%/)).toBeInTheDocument()
    await expect.element(getByText(/button.pay-btn-2025/)).toBeInTheDocument()
    await expect.element(getByText(/确认支付 ￥99.00/)).toBeInTheDocument()
    await expect.element(getByText(/置顶为首选规则，原规则将自动保留为后备兜底/)).toBeInTheDocument()
  })

  it('点击采纳与忽略按钮正确触发回调', async () => {
    const onAdopt = vi.fn()
    const onReject = vi.fn()

    const { getByTestId } = await render(
      <StepHealingCard
        step={mockStep}
        health={mockHealth}
        candidate={mockCandidate}
        onAdopt={onAdopt}
        onReject={onReject}
      />,
    )

    await getByTestId('adopt-candidate-btn').click()
    expect(onAdopt).toHaveBeenCalledWith(mockCandidate)

    await getByTestId('reject-candidate-btn').click()
    expect(onReject).toHaveBeenCalledWith(mockCandidate.id)
  })
})
