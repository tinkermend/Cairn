import { create } from 'zustand'

export interface KeybindingItem {
  id: string
  label: string
  category: 'global' | 'studio'
  defaultKey: string
  customKey?: string
  allowCustomization: boolean
  globalBypassInput?: boolean
}

export const STORAGE_KEY = 'cairn:user-keybindings:v1'

/**
 * 浏览器系统原生保留绝对黑名单（严禁任何业务覆盖）
 */
export const RESERVED_SYSTEM_SHORTCUTS: readonly string[] = [
  'mod+w',
  'mod+q',
  'mod+n',
  'mod+t',
  'mod+r',
  'f5',
  'mod+l',
  'f12',
  'mod+alt+i',
  'mod+c',
  'mod+v',
  'mod+x',
  'mod+z',
  'mod+a',
]

/**
 * 平台默认快捷键资产清单
 */
export const DEFAULT_KEYBINDINGS: readonly KeybindingItem[] = [
  {
    id: 'assistant.toggle',
    label: '唤起/收起识途助手',
    category: 'global',
    defaultKey: 'mod+j',
    allowCustomization: true,
    globalBypassInput: true,
  },
  {
    id: 'sidebar.toggle',
    label: '展开/收起侧栏',
    category: 'global',
    defaultKey: 'mod+b',
    allowCustomization: true,
    globalBypassInput: false,
  },
  {
    id: 'palette.open',
    label: '打开全局速寻/命令盘',
    category: 'global',
    defaultKey: 'mod+k',
    allowCustomization: true,
    globalBypassInput: false,
  },
  {
    id: 'scenario.save',
    label: '保存场景编排草稿',
    category: 'studio',
    defaultKey: 'mod+s',
    allowCustomization: true,
    globalBypassInput: false,
  },
  {
    id: 'scenario.trial',
    label: '触发当前步骤/场景试跑',
    category: 'studio',
    defaultKey: 'mod+enter',
    allowCustomization: true,
    globalBypassInput: false,
  },
]

/** 将可配置写法统一为录制器使用的 Token，避免 Ctrl/Cmd 别名与 mod 被当作不同键位。 */
export function normalizeKeybinding(shortcut: string): string | null {
  const parts = shortcut.trim().toLowerCase().split('+').map((part) => part.trim())
  if (parts.some((part) => !part)) return null

  const key = parts.pop()
  if (!key || !/^(?:[a-z]|[0-9]|f\d+|enter|space|backspace|escape|up|down|left|right)$/.test(key))
    return null

  const modifiers = parts.map((part) => {
    if (['ctrl', 'control', 'meta', 'cmd', 'command'].includes(part)) return 'mod'
    return part
  })
  if (modifiers.some((part) => !['mod', 'alt', 'shift'].includes(part))) return null
  if (new Set(modifiers).size !== modifiers.length) return null

  return [...['mod', 'alt', 'shift'].filter((part) => modifiers.includes(part)), key].join('+')
}

/**
 * 将键盘原生事件归一化为标准的键位序列 Token (如 'mod+j', 'mod+shift+p')
 * 采用 e.code 提取物理硬件键，彻底消除输入法（IME）和大小写锁定的干扰
 */
export function serializeKeyboardEvent(e: KeyboardEvent): string | null {
  const parts: string[] = []

  // mod 代表二者之一；同时按下 Ctrl 与 Cmd 不属于任何可配置键位。
  if (e.metaKey && e.ctrlKey) return null
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')

  let key = ''
  const code = e.code

  if (code.startsWith('Key')) {
    key = code.slice(3).toLowerCase()
  } else if (code.startsWith('Digit')) {
    key = code.slice(5)
  } else if (code === 'Enter') {
    key = 'enter'
  } else if (code === 'Space') {
    key = 'space'
  } else if (code === 'Backspace') {
    key = 'backspace'
  } else if (code === 'Escape') {
    key = 'escape'
  } else if (code === 'ArrowUp') {
    key = 'up'
  } else if (code === 'ArrowDown') {
    key = 'down'
  } else if (code === 'ArrowLeft') {
    key = 'left'
  } else if (code === 'ArrowRight') {
    key = 'right'
  } else if (code.startsWith('F') && /^F\d+$/.test(code)) {
    key = code.toLowerCase()
  }

  // 纯修饰键单独按下时不构成完整快捷键
  if (!key) return null

  // 避免单字母按键重复添加修饰键
  if (!parts.includes(key)) {
    parts.push(key)
  }

  return parts.join('+')
}

/**
 * 校验快捷键合法性与冲突状态
 */
export function validateKeybinding(
  shortcut: string,
  targetCommandId: string,
  bindings: Record<string, string>
): { ok: true } | { ok: false; reason: string } {
  if (!shortcut.trim()) {
    return { ok: false, reason: '快捷键不能为空' }
  }
  const normalized = normalizeKeybinding(shortcut)
  if (!normalized) return { ok: false, reason: '快捷键格式无效' }

  // 1. 绝对黑名单拦截
  if (RESERVED_SYSTEM_SHORTCUTS.includes(normalized)) {
    return { ok: false, reason: '该快捷键已被浏览器系统保留，严禁绑定' }
  }

  // 2. 强修饰键强制校验（Ctrl/Cmd 已规范化为 mod）
  const parts = normalized.split('+')
  const hasStrongModifier = parts.some((p) => ['mod', 'alt'].includes(p))
  if (!hasStrongModifier) {
    return {
      ok: false,
      reason: '全局快捷键必须至少包含一个强修饰键（Ctrl、Alt 或 Cmd）',
    }
  }

  // 3. 内部冲突检测
  for (const [cmdId, key] of Object.entries(bindings)) {
    if (cmdId !== targetCommandId && normalizeKeybinding(key) === normalized) {
      const conflictItem = DEFAULT_KEYBINDINGS.find((i) => i.id === cmdId)
      return {
        ok: false,
        reason: `与「${conflictItem?.label || cmdId}」当前快捷键冲突`,
      }
    }
  }

  return { ok: true }
}

function loadSavedCustomBindings(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return parsed
    }
  } catch {
    // 无效的本地偏好不能阻止默认快捷键加载。
  }
  return {}
}

function persistCustomBindings(customMap: Record<string, string>): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (Object.keys(customMap).length === 0) {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(customMap))
    }
  } catch {
    // 存储不可用时，当前页面的快捷键仍可正常使用。
  }
}

export interface KeybindingsState {
  commands: KeybindingItem[]
  customBindings: Record<string, string>
  getEffectiveKey: (commandId: string) => string
  setCustomKey: (commandId: string, shortcut: string) => { ok: boolean; reason?: string }
  resetCommand: (commandId: string) => void
  resetAll: () => void
  isCustomized: (commandId: string) => boolean
}

export const useKeybindingsStore = create<KeybindingsState>((set, get) => ({
  commands: DEFAULT_KEYBINDINGS as KeybindingItem[],
  customBindings: loadSavedCustomBindings(),

  getEffectiveKey: (commandId: string) => {
    const custom = get().customBindings[commandId]
    const def = get().commands.find((c) => c.id === commandId)
    const normalized = custom ? normalizeKeybinding(custom) : null
    if (normalized && !RESERVED_SYSTEM_SHORTCUTS.includes(normalized)) return normalized
    return def?.defaultKey || ''
  },

  isCustomized: (commandId: string) => {
    return Boolean(get().customBindings[commandId])
  },

  setCustomKey: (commandId: string, shortcut: string) => {
    const allBindings: Record<string, string> = {}
    for (const cmd of get().commands) {
      allBindings[cmd.id] = get().getEffectiveKey(cmd.id)
    }

    const validation = validateKeybinding(shortcut, commandId, allBindings)
    if (!validation.ok) {
      return validation
    }

    const nextCustom = {
      ...get().customBindings,
      [commandId]: normalizeKeybinding(shortcut)!,
    }

    set({ customBindings: nextCustom })
    persistCustomBindings(nextCustom)
    return { ok: true }
  },

  resetCommand: (commandId: string) => {
    const next = { ...get().customBindings }
    delete next[commandId]
    set({ customBindings: next })
    persistCustomBindings(next)
  },

  resetAll: () => {
    set({ customBindings: {} })
    persistCustomBindings({})
  },
}))
