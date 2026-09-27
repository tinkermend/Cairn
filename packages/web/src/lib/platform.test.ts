import { afterEach, describe, expect, it } from 'vitest'
import {
  formatAriaShortcut,
  formatShortcut,
  getPlatform,
  isMac,
  setMockPlatformForTesting,
} from './platform'

describe('platform 跨平台探测与快捷键格式化', () => {
  afterEach(() => {
    setMockPlatformForTesting(null)
  })

  it('在未 mock 时能探测平台环境', () => {
    const platform = getPlatform()
    expect(['mac', 'windows', 'linux', 'other']).toContain(platform)
  })

  it('在 macOS 环境下自适应呈现 ⌘ 与符号紧凑拼接', () => {
    setMockPlatformForTesting('mac')
    expect(isMac()).toBe(true)
    expect(formatShortcut('mod+j')).toBe('⌘J')
    expect(formatShortcut('mod+k')).toBe('⌘K')
    expect(formatShortcut('mod+shift+p')).toBe('⌘⇧P')
    expect(formatShortcut('mod+enter')).toBe('⌘↵')
    expect(formatShortcut('alt+up')).toBe('⌥↑')
  })

  it('在 Windows / Linux 环境下自适应呈现 Ctrl+ 拼接', () => {
    setMockPlatformForTesting('windows')
    expect(isMac()).toBe(false)
    expect(formatShortcut('mod+j')).toBe('Ctrl+J')
    expect(formatShortcut('mod+k')).toBe('Ctrl+K')
    expect(formatShortcut('mod+shift+p')).toBe('Ctrl+Shift+P')
    expect(formatShortcut('mod+enter')).toBe('Ctrl+Enter')
    expect(formatShortcut('alt+up')).toBe('Alt+↑')

    setMockPlatformForTesting('linux')
    expect(formatShortcut('mod+j')).toBe('Ctrl+J')
  })

  it('无障碍快捷键提示与组合键保持一致', () => {
    expect(formatAriaShortcut('mod+k')).toBe('Meta+K Control+K')
    expect(formatAriaShortcut('mod+shift+p')).toBe('Meta+Shift+P Control+Shift+P')
    expect(formatAriaShortcut('alt+up')).toBe('Alt+ArrowUp')
  })
})
