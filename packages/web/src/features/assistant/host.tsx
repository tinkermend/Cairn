import { useEffect, useRef } from 'react'
import { useAssistantStore } from '@/stores/assistant-store'
import { Can } from '@/components/rbac/can'
import { AssistantFloatingWindow } from './floating-window'
import { AssistantDockSidebar } from './dock-sidebar'
import { AssistantLauncher } from './launcher'
import { useAssistantQuoteRouteGuard } from './use-assistant-context-binding'

export function AssistantHost() {
  const open = useAssistantStore((state) => state.open)
  const mode = useAssistantStore((state) => state.mode)
  const openPanel = useAssistantStore((state) => state.openPanel)
  const closePanel = useAssistantStore((state) => state.closePanel)
  const launcherRef = useRef<HTMLButtonElement>(null)

  // 跨路由清理 Quote
  useAssistantQuoteRouteGuard()

  // 快捷键: Cmd/Ctrl + J 快速切换助手展开/折叠
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
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
      {!open ? (
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
        <AssistantDockSidebar open={open} onClose={closePanel} />
      )}
    </Can>
  )
}
