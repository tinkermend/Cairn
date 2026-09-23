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

  it('B4: 正确渲染 RepairCandidate 假说、安全护栏和验证范围，且支持采纳', async () => {
    const onAdopt = vi.fn()
    const mockCandidate = {
      id: 'rep-uuid-1',
      candidateId: 'rep_123456',
      runId: '11111111-1111-4111-8111-111111111111',
      sourceAttemptId: '22222222-2222-4222-8222-222222222222',
      patchTargetRef: {
        kind: 'scenario' as const,
        scenarioId: '33333333-3333-4333-8333-333333333333',
        stepId: 'step-1',
        sourceDefinitionDigest: 'a'.repeat(64),
      },
      patch: {
        kind: 'ADD_CANDIDATE' as const,
        suggestedCandidate: { by: 'role' as const, value: 'button', name: '登录' },
      },
      hypothesis: '登录按钮更新了角色文本',
      digestManifest: {
        sourceDefinitionDigest: 'a'.repeat(64),
        postPatchExecutionDigest: 'b'.repeat(64),
        originalContractDigest: 'c'.repeat(64),
        algorithmVersion: 'v1',
      },
      guardResults: {
        allowedFields: { name: 'allowedFields', status: 'passed' as const, reason: '通过' },
        unchangedBusinessGoal: { name: 'unchangedBusinessGoal', status: 'passed' as const, reason: '通过' },
        sideEffectSafety: { name: 'sideEffectSafety', status: 'passed' as const, reason: '通过' },
        contextIntegrity: { name: 'contextIntegrity', status: 'passed' as const, reason: '通过' },
        overallPassed: true,
      },
      status: 'validated' as const,
      validationScope: {
        locatorValid: true,
        stepPassed: true,
        outcomePassed: true,
        crossSampleStable: true,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const screen = await render(
      <HealingPatchCard
        candidate={mockCandidate}
        currentRevision={3}
        onAdopt={onAdopt}
      />,
    )

    await expect.element(screen.getByText('受控修复候选 (rep_123456)')).toBeVisible()
    await expect.element(screen.getByText('验证已通过')).toBeVisible()
    await expect.element(screen.getByText('静态安全护栏 (Guardrails)')).toBeVisible()
    await expect.element(screen.getByText('全部通过')).toBeVisible()

    const adoptBtn = screen.getByRole('button', { name: '采纳为草稿 (v3)' })
    await adoptBtn.click()
    expect(onAdopt).toHaveBeenCalledWith('rep-uuid-1', 3)
  })

  it('B4: 安全护栏未通过时阻断采纳操作', async () => {
    const mockBlockedCandidate = {
      id: 'rep-uuid-2',
      candidateId: 'rep_blocked',
      runId: '11111111-1111-4111-8111-111111111111',
      sourceAttemptId: '22222222-2222-4222-8222-222222222222',
      patchTargetRef: {
        kind: 'scenario' as const,
        scenarioId: '33333333-3333-4333-8333-333333333333',
        stepId: 'step-1',
        sourceDefinitionDigest: 'a'.repeat(64),
      },
      patch: {
        kind: 'UPGRADE_TO_AI_STEP' as const,
        upgradeSuggestion: { stepType: 'ai_action' as const, prompt: '跳过' },
      },
      hypothesis: '尝试降级断言',
      digestManifest: {
        sourceDefinitionDigest: 'a'.repeat(64),
        postPatchExecutionDigest: 'b'.repeat(64),
        originalContractDigest: 'c'.repeat(64),
        algorithmVersion: 'v1',
      },
      guardResults: {
        allowedFields: { name: 'allowedFields', status: 'passed' as const, reason: '通过' },
        unchangedBusinessGoal: { name: 'unchangedBusinessGoal', status: 'rejected' as const, reason: '降低断言' },
        sideEffectSafety: { name: 'sideEffectSafety', status: 'passed' as const, reason: '通过' },
        contextIntegrity: { name: 'contextIntegrity', status: 'passed' as const, reason: '通过' },
        overallPassed: false,
      },
      status: 'blocked' as const,
      validationScope: {
        locatorValid: false,
        stepPassed: false,
        outcomePassed: false,
        crossSampleStable: false,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const screen = await render(
      <HealingPatchCard
        candidate={mockBlockedCandidate}
        currentRevision={3}
      />,
    )

    await expect.element(screen.getByText('护栏阻断')).toBeVisible()
    await expect.element(screen.getByText('安全护栏未通过，禁止采纳')).toBeVisible()
  })
})
