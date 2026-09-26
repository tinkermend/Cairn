import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import type { Step } from '@cairn/shared'
import { SegmentedStepInspector } from './segmented-step-inspector'

function renderInspector(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
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

describe('SegmentedStepInspector', () => {
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
      screen.getByRole('combobox', { name: '步骤 1 类型' }).element().querySelectorAll('svg')
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

    await expect.element(screen.getByText('建议为关键操作配置断言检查')).toBeInTheDocument()
  })
})
