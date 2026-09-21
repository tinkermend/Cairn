import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { AssertFields } from './assert'
import type { AssertExpect } from '@cairn/shared'

describe('TC-PAS-A10: Web 断言表单支持 aria_snapshot (PAS-W)', () => {
  it('当 expect.kind 为 aria_snapshot 时，渲染多行模板输入框、字数统计与语法提示', async () => {
    const onChange = vi.fn()
    const initialExpect: AssertExpect = {
      kind: 'aria_snapshot',
      template: '- heading "系统控制台" [level=1]\n- button "确认"',
    }

    const screen = await render(
      <AssertFields
        expect={initialExpect}
        onChange={onChange}
      />,
    )

    const textarea = screen.getByRole('textbox', { name: 'Aria 快照模板 (YAML)' })
    await expect.element(textarea).toBeInTheDocument()
    await expect.element(textarea).toHaveValue('- heading "系统控制台" [level=1]\n- button "确认"')

    const charCount = screen.getByText(new RegExp(`${initialExpect.template.length} / 16384`))
    await expect.element(charCount).toBeInTheDocument()

    const hint = screen.getByText(/支持角色、无障碍名称与正则匹配/)
    await expect.element(hint).toBeInTheDocument()
  })

  it('当模板顶层非列表时，展示语法错误提示', async () => {
    const onChange = vi.fn()
    const invalidExpect: AssertExpect = {
      kind: 'aria_snapshot',
      template: 'heading: "系统控制台"',
    }

    const screen = await render(
      <AssertFields
        expect={invalidExpect}
        onChange={onChange}
      />,
    )

    const errorMsg = screen.getByText(/aria_snapshot 模板根节点必须是列表/)
    await expect.element(errorMsg).toBeInTheDocument()
  })
})
