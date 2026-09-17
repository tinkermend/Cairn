import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  EXECUTABLE_STEP_TYPES,
  type ScenarioDocument,
  type Step,
} from '@cairn/shared'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { priorBindings, priorOutputShapes } from './document'
import { AuthoringObserveProvider } from './observe'
import { StepEditor } from './step-editor'

const click: Step = {
  id: '00000000-0000-4000-8000-0000000000c1',
  name: '打开子窗',
  type: 'click',
  effectType: 'SIDE_EFFECT',
  input: {
    target: {
      framePath: [],
      candidates: [{ by: 'role', value: 'button', name: '打开' }],
    },
  },
}

const fill: Step = {
  id: '66666666-6666-4666-8666-666666666666',
  name: '填写',
  type: 'fill',
  effectType: 'SIDE_EFFECT',
  input: {
    target: { framePath: [], candidates: [{ by: 'label', value: '关键字' }] },
    value: '订单',
  },
}

const extract: Step = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '提取单号',
  type: 'extract',
  effectType: 'READ_ONLY',
  outputKey: 'extracted',
  input: {
    target: { framePath: [], candidates: [{ by: 'label', value: '单号' }] },
    as: 'text',
  },
}

const echoStale: Step = {
  id: '22222222-2222-4222-8222-222222222222',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { from: 'gone' },
}

const later: Step = {
  id: '33333333-3333-4333-8333-333333333333',
  name: '后序提取',
  type: 'extract',
  effectType: 'READ_ONLY',
  outputKey: 'later',
  input: {
    target: { framePath: [], candidates: [{ by: 'label', value: '金额' }] },
    as: 'text',
  },
}

const aiExtract: Step = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'AI 提取',
  type: 'ai_extract',
  effectType: 'READ_ONLY',
  outputKey: 'extracted',
  input: {
    instruction: '提取订单字段',
    outputSchema: {
      kind: 'object',
      fields: [{ name: 'orderNo', type: 'string', required: true }],
    },
  },
}

const echoField: Step = {
  id: '55555555-5555-4555-8555-555555555555',
  name: '回显字段',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { from: 'extracted', fromField: 'orderNo' },
}

function editor(
  step: Step,
  onChange = vi.fn(),
  extras?: {
    bindings?: ReturnType<typeof priorBindings>
    shapes?: Map<string, never> | ReturnType<typeof priorOutputShapes>
  }
) {
  return (
    <StepEditor
      step={step}
      index={0}
      bindings={extras?.bindings ?? []}
      shapes={extras?.shapes ?? new Map()}
      editableTypes={EXECUTABLE_STEP_TYPES}
      diagnostics={[]}
      onChange={onChange}
      onRequestTypeChange={vi.fn()}
    />
  )
}

function withObserve(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return (
    <QueryClientProvider client={client}>
      <AuthoringObserveProvider enabled={false} onApplyTarget={() => undefined}>
        {ui}
      </AuthoringObserveProvider>
    </QueryClientProvider>
  )
}

describe('StepEditor', () => {
  it('未挂观察时不展示指认和校验高亮', async () => {
    const screen = await render(editor(click))
    await expect
      .element(screen.getByRole('combobox', { name: '点击后页面' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '在页面上指认' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '校验高亮' }))
      .not.toBeInTheDocument()
  })

  it('未指定时不写出 pageAfter，选择弹出窗口才写入', async () => {
    const onChange = vi.fn()
    const screen = await render(withObserve(editor(click, onChange)))
    await expect
      .element(screen.getByRole('button', { name: '在页面上指认' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '校验高亮' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('combobox', { name: '点击后页面' }))
      .toBeInTheDocument()
    await screen.getByRole('combobox', { name: '点击后页面' }).click()
    await screen.getByRole('option', { name: '切换到弹出窗口' }).click()
    const calls = onChange.mock.calls
    const next = calls[calls.length - 1]?.[0] as Step
    expect(next.type === 'click' && next.input.pageAfter).toBe('popup')
  })

  it('填写步骤不展示输出名称，引用可选尚未声明的键', async () => {
    const screen = await render(editor(fill))
    await expect.element(screen.getByLabelText('内容')).toBeInTheDocument()
    await expect
      .element(screen.getByLabelText('输出名称（建议填写）'))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByLabelText('输出名称（可选）'))
      .not.toBeInTheDocument()
    await screen.getByLabelText('引用上下文').click()
    await expect
      .element(screen.getByRole('option', { name: '尚未声明的键' }))
      .toBeInTheDocument()
  })

  it('新绑定候选不含后序输出，失效引用仍保留', async () => {
    const document: ScenarioDocument = {
      schemaVersion: 1,
      inputs: [],
      steps: [extract, echoStale, later],
    }
    const screen = await render(
      editor(echoStale, vi.fn(), {
        bindings: priorBindings(document, 1),
        shapes: priorOutputShapes(document, 1),
      })
    )
    await screen.getByLabelText('引用上下文').click()
    await expect
      .element(screen.getByRole('option', { name: '失效引用 · gone' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('option', { name: '步骤 · 提取单号' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('option', { name: '步骤 · 后序提取' }))
      .not.toBeInTheDocument()
  })

  it('有静态对象形状时 echo 才出现 fromField', async () => {
    const document: ScenarioDocument = {
      schemaVersion: 1,
      inputs: [],
      steps: [aiExtract, echoField],
    }
    const screen = await render(
      editor(echoField, vi.fn(), {
        bindings: priorBindings(document, 1),
        shapes: priorOutputShapes(document, 1),
      })
    )
    await expect.element(screen.getByLabelText('输出字段')).toBeInTheDocument()
    await screen.getByLabelText('输出字段').click()
    await expect
      .element(screen.getByRole('option', { name: /orderNo/ }))
      .toBeInTheDocument()
  })

  it('成功条件默认展开，超时进入高级区', async () => {
    const screen = await render(
      withObserve(
        <StepEditor
          step={click}
          index={0}
          bindings={[]}
          shapes={new Map()}
          editableTypes={EXECUTABLE_STEP_TYPES.filter((type) => type !== 'assert' && type !== 'ai_assert')}
          diagnostics={[]}
          outcomes={[]}
          onChange={vi.fn()}
          onOutcomesChange={vi.fn()}
          onRequestTypeChange={vi.fn()}
        />,
      ),
    )
    await expect.element(screen.getByRole('heading', { name: '成功条件' })).toBeInTheDocument()
    await expect.element(screen.getByLabelText('超时（毫秒，可选）')).not.toBeInTheDocument()
    await screen.getByRole('button', { name: '高级' }).click()
    await expect.element(screen.getByLabelText('超时（毫秒，可选）')).toBeInTheDocument()
  })
})
