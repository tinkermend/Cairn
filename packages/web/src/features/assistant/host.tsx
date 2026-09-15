import { useRef } from 'react'
import { useAssistantStore } from '@/stores/assistant-store'
import { Can } from '@/components/rbac/can'
import { AssistantFloatingWindow } from './floating-window'
import { AssistantLauncher } from './launcher'

export function AssistantHost() {
  const open = useAssistantStore((state) => state.open)
  const openPanel = useAssistantStore((state) => state.openPanel)
  const closePanel = useAssistantStore((state) => state.closePanel)
  const launcherRef = useRef<HTMLButtonElement>(null)

  return (
    <Can permission='ai:assist'>
      {!open ? (
        <AssistantLauncher buttonRef={launcherRef} onOpen={() => openPanel()} />
      ) : null}
      <AssistantFloatingWindow
        open={open}
        onClose={closePanel}
        onReturnFocus={() =>
          launcherRef.current?.focus({ preventScroll: true })
        }
      />
    </Can>
  )
}
