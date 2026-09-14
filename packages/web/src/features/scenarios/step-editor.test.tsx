import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { EXECUTABLE_STEP_TYPES, type Step } from '@cairn/shared'
import { StepEditor } from './step-editor'

const click: Step = {
  id: '00000000-0000-4000-8000-0000000000c1',
  name: '打开子窗',
  type: 'click',
  effectType: 'SIDE_EFFECT',
  input: {
    target: { framePath: [], candidates: [{ by: 'role', value: 'button', name: '打开' }] },
  },
}

describe('StepEditor click pageAfter', () => {
  it('未指定时不写出 pageAfter，选择弹出窗口才写入', async () => {
    const onChange = vi.fn()
    const screen = await render(
      <StepEditor
        step={click}
        index={0}
        bindings={[]}
        shapes={new Map()}
        editableTypes={EXECUTABLE_STEP_TYPES}
        diagnostics={[]}
        onChange={onChange}
        onRequestTypeChange={vi.fn()}
      />,
    )
    await expect.element(screen.getByRole('combobox', { name: '点击后页面' })).toBeInTheDocument()
    await screen.getByRole('combobox', { name: '点击后页面' }).click()
    await screen.getByRole('option', { name: '切换到弹出窗口' }).click()
    const next = onChange.mock.calls.at(-1)?.[0] as Step
    expect(next.type === 'click' && next.input.pageAfter).toBe('popup')
  })
})
