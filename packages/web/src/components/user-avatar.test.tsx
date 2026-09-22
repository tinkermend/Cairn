import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { UserAvatar } from './user-avatar'

describe('UserAvatar', () => {
  it('当未设置头像时回退显示首字母', async () => {
    const screen = await render(
      <UserAvatar user={{ name: 'Administrator', avatar: null }} />
    )
    expect(screen.getByText('AD')).toBeDefined()
  })

  it('当设置了 bottts 头像时渲染生成的图片', async () => {
    const screen = await render(
      <UserAvatar user={{ name: 'Admin', avatar: 'bottts:cairn-bot-1' }} />
    )
    const img = screen.getByRole('img')
    await expect.element(img).toBeDefined()
    await expect.element(img).toHaveAttribute('src', expect.stringContaining('data:image/svg+xml'))
  })
})
