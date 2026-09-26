import '@/styles/index.css'
import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { StepHealingCard } from './step-healing-card'
import type { RepairCandidate, Step } from '@cairn/shared'

describe('StepHealingCard', () => {
  const mockStep: Step = {
    id: 'step-1',
    name: '点击确认支付',
    type: 'click',
    effectType: 'SIDE_EFFECT',
    input: {},
    target: {
      kind: 'element',
      candidates: [
        { by: 'css', value: 'button.pay-btn-2025' },
      ],
    },
  } as any

  const mockCandidate: RepairCandidate = {
    id: 'cand-1',
    scenarioId: 'sc-1',
    incidentId: 'inc-1',
    status: 'proposed',
    cause: 'LOCATOR_DRIFT',
    summary: '选择器漂移，已自愈提取新规则',
    patchTargetRef: { stepId: 'step-1', targetKind: 'element' },
    patch: {
      kind: 'replace_element_target',
      suggestedCandidate: { by: 'role', value: 'button', name: '确认支付 ￥99.00' },
    },
    confidence: 0.98,
    riskLevel: 'low',
    evidenceRefs: [
      {
        kind: 'screenshot',
        uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        caption: 'AI 定位目标截图切片',
      },
    ],
    createdAt: '2026-09-26T00:00:00Z',
    updatedAt: '2026-09-26T00:00:00Z',
  } as any as RepairCandidate

  const mockHealth = {
    status: 'fallback_warning' as const,
    ruleHitRate: 0.25,
    fallbackRate: 0.75,
    ai: 3,
    located: 4,
    failed: 0,
  }

  it('展示健康度预警、视觉切片证据、规则对比与安全说明', async () => {
    const { getByTestId, getByText } = await render(
      <StepHealingCard
        step={mockStep}
        health={mockHealth}
        candidate={mockCandidate}
      />,
    )

    await expect.element(getByTestId('step-healing-card')).toBeInTheDocument()
    await expect.element(getByText(/近期规则命中率降至 25%/)).toBeInTheDocument()
    await expect.element(getByTestId('crop-thumbnail')).toBeInTheDocument()
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
    expect(onReject).toHaveBeenCalledWith('cand-1')
  })
})
