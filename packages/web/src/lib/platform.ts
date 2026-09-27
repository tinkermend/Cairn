export type PlatformType = 'mac' | 'windows' | 'linux' | 'other'

let mockPlatformOverride: PlatformType | null = null

/**
 * 仅用于单元测试模拟不同的操作系统环境
 */
export function setMockPlatformForTesting(platform: PlatformType | null): void {
  mockPlatformOverride = platform
}

/**
 * 获取当前宿主操作系统平台
 */
export function getPlatform(): PlatformType {
  if (mockPlatformOverride) return mockPlatformOverride
  if (typeof navigator === 'undefined') return 'mac'

  const userAgent = navigator.userAgent || ''
  const platform =
    (navigator as unknown as { userAgentData?: { platform?: string } })
      ?.userAgentData?.platform ||
    navigator.platform ||
    ''

  if (/Mac|iPhone|iPod|iPad/i.test(platform) || /Mac/i.test(userAgent)) {
    return 'mac'
  }
  if (/Win/i.test(platform) || /Windows/i.test(userAgent)) {
    return 'windows'
  }
  if (/Linux/i.test(platform) || /Linux/i.test(userAgent)) {
    return 'linux'
  }
  return 'other'
}

/**
 * 是否为 macOS / iOS 类苹果系统
 */
export function isMac(): boolean {
  return getPlatform() === 'mac'
}

/**
 * 键位 Token 转换为平台友好显示字符串
 * 例如 'mod+j' 在 Mac 下返回 '⌘J'，在 Windows 下返回 'Ctrl+J'
 */
export function formatShortcut(
  shortcut: string,
  platform: PlatformType = getPlatform()
): string {
  if (!shortcut) return ''
  const isApple = platform === 'mac'
  const parts = shortcut.split('+').map((p) => p.trim().toLowerCase())

  const formattedParts = parts.map((part) => {
    switch (part) {
      case 'mod':
      case 'cmd':
      case 'command':
      case 'ctrl_or_cmd':
        return isApple ? '⌘' : 'Ctrl'
      case 'ctrl':
      case 'control':
        return isApple ? '⌃' : 'Ctrl'
      case 'alt':
      case 'opt':
      case 'option':
        return isApple ? '⌥' : 'Alt'
      case 'shift':
        return isApple ? '⇧' : 'Shift'
      case 'enter':
      case 'return':
        return isApple ? '↵' : 'Enter'
      case 'backspace':
        return isApple ? '⌫' : 'Backspace'
      case 'esc':
      case 'escape':
        return 'Esc'
      case 'space':
        return 'Space'
      case 'up':
        return '↑'
      case 'down':
        return '↓'
      case 'left':
        return '←'
      case 'right':
        return '→'
      default:
        return part.length === 1 ? part.toUpperCase() : part
    }
  })

  // Apple 系统紧凑符号拼接（如 ⌘J），非 Apple 系统加加号（如 Ctrl+J）
  if (isApple) {
    // 若全为符号或单个字母，紧凑拼接
    const allSymbols = formattedParts.every(
      (p) => ['⌘', '⌥', '⇧', '⌃', '↵', '⌫', '↑', '↓', '←', '→'].includes(p) || p.length === 1
    )
    return allSymbols ? formattedParts.join('') : formattedParts.join('+')
  }

  return formattedParts.join('+')
}

/** 将内部快捷键 Token 转为 aria-keyshortcuts；mod 同时列出实际支持的 Meta / Control。 */
export function formatAriaShortcut(shortcut: string): string {
  if (!shortcut) return ''
  const keyNames: Record<string, string> = {
    alt: 'Alt',
    ctrl: 'Control',
    shift: 'Shift',
    enter: 'Enter',
    space: 'Space',
    backspace: 'Backspace',
    escape: 'Escape',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
  }
  const parts = shortcut.split('+').map((part) => part.trim().toLowerCase())
  const variants = parts.includes('mod')
    ? ['Meta', 'Control'].map((modifier) =>
        parts.map((part) => (part === 'mod' ? modifier : keyNames[part] ?? part.toUpperCase()))
      )
    : [parts.map((part) => keyNames[part] ?? part.toUpperCase())]
  return variants.map((variant) => variant.join('+')).join(' ')
}
