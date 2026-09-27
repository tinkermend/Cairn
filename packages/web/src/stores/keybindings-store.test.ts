import { describe, it, expect, beforeEach } from 'vitest'
import {
  useKeybindingsStore,
  normalizeKeybinding,
  serializeKeyboardEvent,
  validateKeybinding,
  STORAGE_KEY,
} from './keybindings-store'

describe('keybindings-store', () => {
  beforeEach(() => {
    localStorage.clear()
    useKeybindingsStore.getState().resetAll()
  })

  describe('serializeKeyboardEvent', () => {
    it('应将 Cmd/Ctrl+J 序列化为 mod+j', () => {
      const eventMac = new KeyboardEvent('keydown', {
        code: 'KeyJ',
        metaKey: true,
      })
      expect(serializeKeyboardEvent(eventMac)).toBe('mod+j')

      const eventWin = new KeyboardEvent('keydown', {
        code: 'KeyJ',
        ctrlKey: true,
      })
      expect(serializeKeyboardEvent(eventWin)).toBe('mod+j')
    })

    it('应正确组合多修饰键 (mod+shift+k)', () => {
      const event = new KeyboardEvent('keydown', {
        code: 'KeyK',
        metaKey: true,
        shiftKey: true,
      })
      expect(serializeKeyboardEvent(event)).toBe('mod+shift+k')
    })

    it('Ctrl 与 Cmd 同时按下不误触发单一 mod 快捷键', () => {
      const event = new KeyboardEvent('keydown', {
        code: 'KeyK',
        ctrlKey: true,
        metaKey: true,
      })
      expect(serializeKeyboardEvent(event)).toBeNull()
    })

    it('应正确处理 Alt 修饰键 (alt+enter)', () => {
      const event = new KeyboardEvent('keydown', {
        code: 'Enter',
        altKey: true,
      })
      expect(serializeKeyboardEvent(event)).toBe('alt+enter')
    })

    it('当仅按下修饰键自身时应返回 null', () => {
      const metaOnly = new KeyboardEvent('keydown', {
        code: 'MetaLeft',
        metaKey: true,
      })
      expect(serializeKeyboardEvent(metaOnly)).toBeNull()

      const shiftOnly = new KeyboardEvent('keydown', {
        code: 'ShiftRight',
        shiftKey: true,
      })
      expect(serializeKeyboardEvent(shiftOnly)).toBeNull()
    })

    it('应支持功能键如 F1-F12 与方向键', () => {
      const f1 = new KeyboardEvent('keydown', {
        code: 'F1',
        altKey: true,
      })
      expect(serializeKeyboardEvent(f1)).toBe('alt+f1')

      const up = new KeyboardEvent('keydown', {
        code: 'ArrowUp',
        metaKey: true,
      })
      expect(serializeKeyboardEvent(up)).toBe('mod+up')
    })
  })

  describe('validateKeybinding', () => {
    const currentBindings: Record<string, string> = {
      'assistant.toggle': 'mod+j',
      'palette.open': 'mod+k',
    }

    it('应拦截系统绝对黑名单快捷键', () => {
      for (const forbidden of ['mod+w', 'mod+q', 'mod+r', 'f5']) {
        const res = validateKeybinding(forbidden, 'assistant.toggle', currentBindings)
        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.reason).toContain('系统保留')
        }
      }
    })

    it('应强制要求强修饰键（禁止纯单键或纯 shift 组合）', () => {
      const singleKey = validateKeybinding('j', 'assistant.toggle', currentBindings)
      expect(singleKey.ok).toBe(false)
      if (!singleKey.ok) {
        expect(singleKey.reason).toContain('强修饰键')
      }

      const shiftKey = validateKeybinding('shift+j', 'assistant.toggle', currentBindings)
      expect(shiftKey.ok).toBe(false)
      if (!shiftKey.ok) {
        expect(shiftKey.reason).toContain('强修饰键')
      }
    })

    it('应检测内部命令冲突', () => {
      const res = validateKeybinding('mod+k', 'assistant.toggle', currentBindings)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.reason).toContain('冲突')
      }
    })

    it('Ctrl/Cmd 别名与 mod 按同一键位做黑名单和冲突检查', () => {
      expect(normalizeKeybinding('Ctrl+Shift+P')).toBe('mod+shift+p')
      expect(normalizeKeybinding('alt+mod+p')).toBe('mod+alt+p')
      expect(validateKeybinding('ctrl+w', 'assistant.toggle', currentBindings).ok).toBe(false)
      const conflict = validateKeybinding('ctrl+k', 'assistant.toggle', currentBindings)
      expect(conflict.ok).toBe(false)
      if (!conflict.ok) expect(conflict.reason).toContain('冲突')
    })

    it('不接受无法由键盘事件序列化的自定义键位', () => {
      expect(validateKeybinding('ctrl+foo', 'assistant.toggle', currentBindings).ok).toBe(false)
      expect(validateKeybinding('mod+shift', 'assistant.toggle', currentBindings).ok).toBe(false)
    })

    it('允许自身键位保持或合法新键位', () => {
      const same = validateKeybinding('mod+j', 'assistant.toggle', currentBindings)
      expect(same.ok).toBe(true)

      const validNew = validateKeybinding('mod+shift+j', 'assistant.toggle', currentBindings)
      expect(validNew.ok).toBe(true)
    })
  })

  describe('useKeybindingsStore actions', () => {
    it('初始状态应读取默认键位', () => {
      const store = useKeybindingsStore.getState()
      expect(store.getEffectiveKey('assistant.toggle')).toBe('mod+j')
      expect(store.isCustomized('assistant.toggle')).toBe(false)
    })

    it('修改快捷键成功后应更新并写入 localStorage', () => {
      const store = useKeybindingsStore.getState()
      const res = store.setCustomKey('assistant.toggle', 'mod+alt+j')
      expect(res.ok).toBe(true)

      expect(store.getEffectiveKey('assistant.toggle')).toBe('mod+alt+j')
      expect(store.isCustomized('assistant.toggle')).toBe(true)

      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
      expect(stored['assistant.toggle']).toBe('mod+alt+j')
    })

    it('保存 Ctrl 别名时规范化为可执行的 mod 键位', () => {
      const store = useKeybindingsStore.getState()
      expect(store.setCustomKey('palette.open', 'ctrl+shift+p').ok).toBe(true)
      expect(store.getEffectiveKey('palette.open')).toBe('mod+shift+p')
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')['palette.open']).toBe('mod+shift+p')
    })

    it('若修改违规应失败且不影响原值', () => {
      const store = useKeybindingsStore.getState()
      const res = store.setCustomKey('assistant.toggle', 'mod+w')
      expect(res.ok).toBe(false)
      expect(store.getEffectiveKey('assistant.toggle')).toBe('mod+j')
    })

    it('重置单项与全部重置功能正常', () => {
      const store = useKeybindingsStore.getState()
      store.setCustomKey('assistant.toggle', 'mod+alt+j')
      expect(store.isCustomized('assistant.toggle')).toBe(true)

      store.resetCommand('assistant.toggle')
      expect(store.getEffectiveKey('assistant.toggle')).toBe('mod+j')
      expect(store.isCustomized('assistant.toggle')).toBe(false)
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()

      store.setCustomKey('assistant.toggle', 'mod+alt+j')
      store.setCustomKey('palette.open', 'mod+alt+k')
      store.resetAll()
      expect(store.getEffectiveKey('assistant.toggle')).toBe('mod+j')
      expect(store.getEffectiveKey('palette.open')).toBe('mod+k')
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    })
  })
})
