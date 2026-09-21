import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { HealingDiagnosis, Step } from '@cairn/shared'
import { HealingPatchCard } from './healing-patch-card'

describe('SH-3: HealingPatchCard Component', () => {
  const mockStep: Step = {
    id: 'step-1',
    name: '点击登录',
    type: 'click',
    effectType: 'SIDE_EFFECT',
    input: {
      target: { framePath: [], candidates: [{ by: 'css', value: '#old-login' }] },
    },
  }

  const mockDiagnosis: HealingDiagnosis = {
    cause: 'LOCATOR_DRIFT',
    confidence: 0.9,
    analysisSummary: '登录按钮样式改变，推荐新 role 选择器',
    contextVerified: true,
    suggestedPatch: {
      kind: 'ADD_CANDIDATE',
      suggestedCandidate: { by: 'role', value: 'button', name: '登录' },
      suggestedWaitMs: 500,
      upgradeSuggestion: {
        stepType: 'ai_action',
        prompt: '点击登录按钮',
      },
    },
  }

  it('SH08-A: 正确渲染诊断摘要、置信度与推荐候选', async () => {
    const screen = await render(
      <HealingPatchCard
        diagnosis={mockDiagnosis}
        currentStep={mockStep}
        onAcceptReplace={vi.fn()}
        onAcceptAddCandidate={vi.fn()}
        onUpgradeToAi={vi.fn()}
      />,
    )

    await expect.element(screen.getByText('智能修复建议 (Step Healer)')).toBeVisible()
    await expect.element(screen.getByText('选择器漂移')).toBeVisible()
    await expect.element(screen.getByText('置信度 90%')).toBeVisible()
    await expect.element(screen.getByText('登录按钮样式改变，推荐新 role 选择器')).toBeVisible()
    await expect.element(screen.getByText('role="button" [name="登录"]')).toBeVisible()
  })

  it('SH08-B: 点击采纳为新定位器触发 onAcceptReplace 回调', async () => {
    const onReplace = vi.fn()
    const screen = await render(
      <HealingPatchCard
        diagnosis={mockDiagnosis}
        currentStep={mockStep}
        onAcceptReplace={onReplace}
        onAcceptAddCandidate={vi.fn()}
        onUpgradeToAi={vi.fn()}
      />,
    )

    const replaceBtn = screen.getByRole('button', { name: '采纳为新定位器' })
    await replaceBtn.click()
    expect(onReplace).toHaveBeenCalledWith({
      framePath: [],
      candidates: [{ by: 'role', value: 'button', name: '登录' }],
    })
  })

  it('SH09: 点击追加为备选候选触发 onAcceptAddCandidate 回调', async () => {
    const onAdd = vi.fn()
    const screen = await render(
      <HealingPatchCard
        diagnosis={mockDiagnosis}
        currentStep={mockStep}
        onAcceptReplace={vi.fn()}
        onAcceptAddCandidate={onAdd}
        onUpgradeToAi={vi.fn()}
      />,
    )

    const addBtn = screen.getByRole('button', { name: '追加为备选候选' })
    await addBtn.click()
    expect(onAdd).toHaveBeenCalledWith({
      by: 'role',
      value: 'button',
      name: '登录',
    })
  })

  it('SH10: 点击一键升级为 AI 步骤触发 onUpgradeToAi 回调', async () => {
    const onUpgrade = vi.fn()
    const screen = await render(
      <HealingPatchCard
        diagnosis={mockDiagnosis}
        currentStep={mockStep}
        onAcceptReplace={vi.fn()}
        onAcceptAddCandidate={vi.fn()}
        onUpgradeToAi={onUpgrade}
      />,
    )

    const upgradeBtn = screen.getByRole('button', { name: '一键升级为 AI 步骤' })
    await upgradeBtn.click()
    expect(onUpgrade).toHaveBeenCalledWith('点击登录按钮')
  })
})
