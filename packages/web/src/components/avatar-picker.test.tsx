import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { AvatarPicker } from './avatar-picker'

describe('AvatarPicker', () => {
  it('空值时展示默认机器人头像，点击头像打开选择弹层', async () => {
    const onChange = vi.fn()
    const screen = await render(
      <AvatarPicker onChange={onChange} displayName='Admin' />
    )
    const trigger = screen.getByRole('button', { name: '选择头像' })
    expect(trigger).toBeDefined()
    await expect.element(screen.getByRole('img')).toBeInTheDocument()
    expect(screen.getByText('?').query()).toBeNull()
    expect(screen.getByRole('button', { name: '选择头像' }).elements()).toHaveLength(1)

    await trigger.click()
    await expect
      .element(screen.getByRole('heading', { name: '选择头像' }))
      .toBeInTheDocument()
  })

  it('在选择弹层中清除头像', async () => {
    const onChange = vi.fn()
    const screen = await render(
      <AvatarPicker
        value='bottts:cairn-bot-1'
        onChange={onChange}
        displayName='Admin'
      />
    )
    await screen.getByRole('button', { name: '选择头像' }).click()
    await screen.getByRole('button', { name: '清除头像' }).click()
    expect(onChange).toHaveBeenCalledWith('')
  })
})
