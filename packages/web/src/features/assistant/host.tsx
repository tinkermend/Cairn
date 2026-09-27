import { useEffect, useRef } from 'react'
import { useAssistantStore } from '@/stores/assistant-store'
import { useKeybindingsStore, serializeKeyboardEvent } from '@/stores/keybindings-store'
import { Can } from '@/components/rbac/can'
import { AssistantFloatingWindow } from './floating-window'
import { AssistantDockSidebar } from './dock-sidebar'
import { AssistantLauncher } from './launcher'
import { useAssistantQuoteRouteGuard } from './use-assistant-context-binding'

export function AssistantHost({
  showFloatingLauncher = true,
}: {
  showFloatingLauncher?: boolean
} = {}) {
  const open = useAssistantStore((state) => state.open)
  const mode = useAssistantStore((state) => state.mode)
  const openPanel = useAssistantStore((state) => state.openPanel)
  const closePanel = useAssistantStore((state) => state.closePanel)
  const launcherRef = useRef<HTMLButtonElement>(null)

  // 跨路由清理 Quote
  useAssistantQuoteRouteGuard()

  // 快捷键: 动态从 keybindings store 匹配切换助手展开/折叠
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const shortcut = serializeKeyboardEvent(e)
      const effectiveKey = useKeybindingsStore.getState().getEffectiveKey('assistant.toggle')
      if (shortcut && shortcut === effectiveKey) {
        const target = e.target as HTMLElement | null
        const inInput =
          target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable)
        // 允许在非输入场景或在助手输入框时触发切换
        if (!inInput || target?.id === 'assistant-question') {
          e.preventDefault()
          if (open) closePanel()
          else openPanel()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, openPanel, closePanel])

  return (
    <Can permission='ai:assist'>
      <div data-assistant-host='true'>
        {!open && showFloatingLauncher ? (
          <AssistantLauncher buttonRef={launcherRef} onOpen={() => openPanel()} />
        ) : null}

        {mode === 'floating' ? (
          <AssistantFloatingWindow
            open={open}
            onClose={closePanel}
            onReturnFocus={() =>
              launcherRef.current?.focus({ preventScroll: true })
            }
          />
        ) : (
          <AssistantDockSidebar
            open={open}
            onClose={closePanel}
            onReturnFocus={() => {
              const headerTrigger = document.querySelector<HTMLButtonElement>(
                '[data-assistant-trigger="true"]'
              )
              ;(headerTrigger ?? launcherRef.current)?.focus({ preventScroll: true })
            }}
          />
        )}
      </div>
    </Can>
  )
}
