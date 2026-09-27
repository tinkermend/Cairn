import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { setMockPlatformForTesting } from '@/lib/platform'
import { Kbd } from './kbd'

describe('Kbd 统一键帽组件', () => {
  afterEach(() => {
    setMockPlatformForTesting(null)
  })

  it('在 macOS 环境下根据 shortcut 渲染 ⌘ 键帽', async () => {
    setMockPlatformForTesting('mac')
    const screen = await render(<Kbd shortcut='mod+j' />)
    expect(screen.getByText('⌘J').elements()).toHaveLength(1)
  })

  it('在 Windows 环境下根据 shortcut 渲染 Ctrl 键帽', async () => {
    setMockPlatformForTesting('windows')
    const screen = await render(<Kbd shortcut='mod+j' />)
    expect(screen.getByText('Ctrl+J').elements()).toHaveLength(1)
  })

  it('支持直接传递 children 呈现自定义键帽', async () => {
    const screen = await render(<Kbd>Esc</Kbd>)
    expect(screen.getByText('Esc').elements()).toHaveLength(1)
  })
})
