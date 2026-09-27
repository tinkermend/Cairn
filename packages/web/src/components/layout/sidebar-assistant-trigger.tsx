import { useAssistantStore } from '@/stores/assistant-store'
import { useKeybindingsStore } from '@/stores/keybindings-store'
import { Can } from '@/components/rbac/can'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Kbd } from '@/components/ui/kbd'
import { formatShortcut } from '@/lib/platform'
import { assistantIcon } from '@/features/assistant/icon'

export function SidebarAssistantTrigger() {
  const open = useAssistantStore((s) => s.open)
  const busy = useAssistantStore((s) => s.busy)
  const openPanel = useAssistantStore((s) => s.openPanel)
  const closePanel = useAssistantStore((s) => s.closePanel)
  const toggleKey = useKeybindingsStore((s) => s.getEffectiveKey('assistant.toggle'))
  const shortcutHint = formatShortcut(toggleKey)

  return (
    <Can permission='ai:assist'>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size='default'
            onClick={() => {
              if (open) closePanel()
              else openPanel()
            }}
            tooltip={`识途助手 (${shortcutHint})`}
            aria-label='打开识途助手'
            data-assistant-trigger='true'
            data-state={open ? 'open' : 'closed'}
            className='flex items-center gap-2.5 rounded-lg border border-border-default/60 bg-surface-subtle/50 px-2.5 py-2 text-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground'
          >
            <div className='relative size-5 shrink-0'>
              <img
                {...assistantIcon}
                alt=''
                className='size-full rounded-full object-cover select-none'
                width={20}
                height={20}
              />
              {busy ? (
                <span
                  className='absolute -top-0.5 -right-0.5 size-2 rounded-full bg-status-info-accent animate-pulse'
                  aria-hidden='true'
                />
              ) : null}
            </div>
            <div className='flex flex-1 items-center justify-between min-w-0'>
              <span className='truncate text-body font-medium'>识途助手</span>
              <Kbd shortcut={toggleKey} className='hidden sm:inline-flex' />
            </div>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </Can>
  )
}
