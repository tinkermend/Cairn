import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import '@/styles/index.css'
import { ContextMentionInput } from './context-mention-input'
import type { BindingOption } from '@/features/authoring/document'

describe('ContextMentionInput', () => {
  const bindings: BindingOption[] = [
    { key: 'targetAccount', label: '输入 · 目标账号', typeLabel: 'string', description: '登录使用的账号' },
    { key: 'extractedToken', label: '步骤 · 提取令牌' },
    { key: 'moduleOutput', label: '模块 · 登录模块 · token' },
  ]

  it('点击变量按钮能展开浮层并展示可用前序变量', async () => {
    const screen = await render(
      <ContextMentionInput
        value=''
        bindings={bindings}
        onChange={() => {}}
      />,
    )

    const btn = screen.getByLabelText('插入变量引用')
    await btn.click()

    await expect.element(screen.getByText('targetAccount')).toBeInTheDocument()
    await expect.element(screen.getByText('extractedToken')).toBeInTheDocument()
    await expect.element(screen.getByText('moduleOutput')).toBeInTheDocument()
    await expect.element(screen.getByText('登录使用的账号')).toBeInTheDocument()
  })

  it('在 template 模式下选中变量，将 {{key}} 插入文本中', async () => {
    const onChange = vi.fn()
    const screen = await render(
      <ContextMentionInput
        value='https://api.com/'
        bindings={bindings}
        onChange={onChange}
      />,
    )

    const btn = screen.getByLabelText('插入变量引用')
    await btn.click()

    const tokenOpt = screen.getByText('extractedToken')
    await tokenOpt.click()

    expect(onChange).toHaveBeenCalledWith('https://api.com/{{extractedToken}}')
  })

  it('在 binding_picker 模式下选中变量，触发 onSelectBinding 回调', async () => {
    const onSelectBinding = vi.fn()
    const onChange = vi.fn()
    const screen = await render(
      <ContextMentionInput
        mode='binding_picker'
        value=''
        bindings={bindings}
        onChange={onChange}
        onSelectBinding={onSelectBinding}
      />,
    )

    const btn = screen.getByLabelText('插入变量引用')
    await btn.click()

    const accountOpt = screen.getByText('targetAccount')
    await accountOpt.click()

    expect(onSelectBinding).toHaveBeenCalledWith(bindings[0])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('失效引用显示修复说明且不可重新选中', async () => {
    const onSelectBinding = vi.fn()
    const screen = await render(<ContextMentionInput mode='binding_picker' value='' bindings={[{ key: 'gone', label: '失效引用 · gone', stale: true, description: '上游已删除' }]} onChange={() => {}} onSelectBinding={onSelectBinding} />)
    await screen.getByLabelText('插入变量引用').click()
    await expect.element(screen.getByRole('option')).toHaveAttribute('aria-disabled', 'true')
    await expect.element(screen.getByText('上游已删除')).toBeInTheDocument()
    expect(onSelectBinding).not.toHaveBeenCalled()
  })
})
