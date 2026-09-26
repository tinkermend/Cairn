import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import type { Step } from '@cairn/shared'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { SegmentedStepInspector } from './segmented-step-inspector'

function renderInspector(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  )
}

const mockStep: Step = {
  id: 'step-1',
  name: '点击提交按钮',
  type: 'click',
  effectType: 'IDEMPOTENT',
  input: {
    target: {
      semantic: '提交按钮',
      framePath: [],
      candidates: [{ by: 'label', value: '提交' }],
    },
  },
  policy: {
    retryLimit: 3,
    timeoutMs: 5000,
  },
}

const aiAction: Step = {
  id: 'step-ai',
  name: '视觉操作',
  type: 'ai_action',
  effectType: 'SIDE_EFFECT',
  input: { instruction: '点击提交按钮' },
}

describe('SegmentedStepInspector', () => {
  it('视觉操作只能在视觉动作类型内切换，并保持 ai_action 步骤类型', async () => {
    const onChange = vi.fn()
    const screen = await renderInspector(
      <SegmentedStepInspector
        step={aiAction}
        index={0}
        bindings={[]}
        shapes={new Map()}
        editableTypes={['click', 'fill', 'navigate', 'ai_action', 'ai_extract']}
        diagnostics={[]}
        onChange={onChange}
        onRequestTypeChange={vi.fn()}
      />
    )

    await expect
      .element(screen.getByRole('combobox', { name: '步骤 1 类型' }))
      .not.toBeInTheDocument()
    await screen.getByRole('combobox', { name: '视觉操作动作类型' }).click()
    for (const name of [
      '业务意图',
      '点击目标',
      '输入文字',
      '按键',
      '相对滚动',
    ]) {
      await expect
        .element(screen.getByRole('option', { name, exact: true }))
        .toBeInTheDocument()
    }
    for (const name of ['导航', '点击', '填写', 'AI 提取']) {
      await expect
        .element(screen.getByRole('option', { name, exact: true }))
        .not.toBeInTheDocument()
    }

    await screen.getByRole('option', { name: '点击目标' }).click()
    const next = onChange.mock.lastCall?.[0] as Step
    expect(next).toMatchObject({
      type: 'ai_action',
      input: { operation: 'tap' },
    })
  })

  it('正确渲染 4 级渐进检查器，执行策略折叠且展示非默认 Active Pill 徽标', async () => {
    const screen = await renderInspector(
      <SegmentedStepInspector
        step={mockStep}
        index={0}
        bindings={[]}
        shapes={new Map()}
        editableTypes={['click', 'fill', 'navigate']}
        diagnostics={[]}
        onChange={vi.fn()}
        onRequestTypeChange={vi.fn()}
      />
    )

    // 分区 1：动作名称
    const nameInput = screen.getByLabelText('步骤名称')
    await expect.element(nameInput).toBeInTheDocument()
    expect(nameInput.element().getAttribute('value')).toBe('点击提交按钮')
    // 当前值只显示一个类型图标，另一个 SVG 是下拉箭头。
    expect(
      screen
        .getByRole('combobox', { name: '步骤 1 类型' })
        .element()
        .querySelectorAll('svg')
    ).toHaveLength(2)

    // 分区 4：执行策略折叠，且由于 retryLimit: 3 展示了 Active Pill 徽标
    const policySection = screen.getByTestId('section-execution-policy')
    await expect.element(policySection).toBeInTheDocument()

    const activePills = screen.getByTestId('policy-active-pills')
    await expect.element(activePills).toBeInTheDocument()
    await expect.element(screen.getByText('重试 3次')).toBeInTheDocument()
    await expect.element(screen.getByText('5000ms')).toBeInTheDocument()
  })

  it('展示该步骤专属的编译诊断警告', async () => {
    const screen = await renderInspector(
      <SegmentedStepInspector
        step={mockStep}
        index={0}
        bindings={[]}
        shapes={new Map()}
        editableTypes={['click']}
        diagnostics={[
          {
            code: 'WARN_ASSERT',
            stepId: 'step-1',
            severity: 'warning',
            message: '建议为关键操作配置断言检查',
          },
        ]}
        onChange={vi.fn()}
        onRequestTypeChange={vi.fn()}
      />
    )

    await expect
      .element(screen.getByText('建议为关键操作配置断言检查'))
      .toBeInTheDocument()
  })
})
