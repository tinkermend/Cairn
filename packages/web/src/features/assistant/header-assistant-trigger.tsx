import { useAssistantStore } from '@/stores/assistant-store'
import { useKeybindingsStore } from '@/stores/keybindings-store'
import { Can } from '@/components/rbac/can'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Kbd } from '@/components/ui/kbd'
import { formatShortcut } from '@/lib/platform'
import { assistantIcon } from './icon'

export function HeaderAssistantTrigger() {
  const open = useAssistantStore((s) => s.open)
  const busy = useAssistantStore((s) => s.busy)
  const openPanel = useAssistantStore((s) => s.openPanel)
  const closePanel = useAssistantStore((s) => s.closePanel)
  const toggleKey = useKeybindingsStore((s) => s.getEffectiveKey('assistant.toggle'))
  const shortcutHint = formatShortcut(toggleKey)

  return (
    <Can permission='ai:assist'>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant='ghost'
            size='sm'
            aria-label='打开识途助手'
            data-assistant-trigger='true'
            data-state={open ? 'open' : 'closed'}
            onClick={() => {
              if (open) closePanel()
              else openPanel()
            }}
            className='flex h-8 items-center gap-1.5 px-2.5 text-muted-foreground transition-colors hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground'
          >
            <div className='relative size-4.5 shrink-0'>
              <img
                {...assistantIcon}
                alt=''
                className='size-full rounded-full object-cover select-none'
                width={18}
                height={18}
              />
              {busy ? (
                <span
                  className='absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-status-info-accent animate-pulse'
                  aria-hidden='true'
                />
              ) : null}
            </div>
            <span className='hidden sm:inline text-label font-medium'>识途助手</span>
            <Kbd shortcut={toggleKey} size='sm' className='hidden md:inline-flex' />
          </Button>
        </TooltipTrigger>
        <TooltipContent side='bottom'>识途助手 ({shortcutHint})</TooltipContent>
      </Tooltip>
    </Can>
  )
}
