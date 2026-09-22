import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { AvatarPicker } from './avatar-picker'

describe('AvatarPicker', () => {
  it('渲染头像预览与选择按钮', async () => {
    const onChange = vi.fn()
    const screen = await render(
      <AvatarPicker value='bottts:cairn-bot-1' onChange={onChange} displayName='Admin' />
    )
    expect(screen.getByRole('button', { name: '选择头像' })).toBeDefined()
    expect(screen.getByRole('button', { name: '清除' })).toBeDefined()
  })

  it('点击清除按钮触发 onChange 为空字符串', async () => {
    const onChange = vi.fn()
    const screen = await render(
      <AvatarPicker value='bottts:cairn-bot-1' onChange={onChange} displayName='Admin' />
    )
    await screen.getByRole('button', { name: '清除' }).click()
    expect(onChange).toHaveBeenCalledWith('')
  })
})
