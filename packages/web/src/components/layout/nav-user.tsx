import useDialogState from '@/hooks/use-dialog-state'
import { UserAvatar } from '@/components/user-avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AccountMenuItems } from '@/components/account-menu-items'
import { SignOutDialog } from '@/components/sign-out-dialog'
import { useAuthStore } from '@/stores/auth-store'

export type NavUserProps = {
  user?: {
    name: string
    email: string
    avatar?: string | null
  }
}

export function NavUser({ user: userProp }: NavUserProps = {}) {
  const [open, setOpen] = useDialogState()
  const authUser = useAuthStore((s) => s.auth.user)

  const user = userProp ?? {
    name: authUser?.displayName || '用户',
    email: authUser?.email || '',
    avatar: authUser?.avatar,
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type='button'
            className='group flex h-8 items-center gap-2 rounded-full p-0.5 max-sm:size-11 max-sm:justify-center sm:pe-2.5 outline-hidden hover:bg-action-hover focus-visible:ring-2 focus-visible:ring-primary transition-colors cursor-pointer select-none'
            aria-label={`账号菜单：${user.name}`}
          >
            <UserAvatar
              user={{ name: user.name, avatar: user.avatar }}
              className='size-7 rounded-full ring-1 ring-border-default/60 group-hover:ring-primary transition-colors shrink-0'
            />
            <span className='hidden sm:inline-block max-w-[120px] md:max-w-[160px] truncate text-small font-medium text-foreground text-start'>
              {user.name}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className='w-56 rounded-lg'
          side='bottom'
          align='end'
          sideOffset={8}
        >
          <DropdownMenuLabel className='p-0 font-normal'>
            <div className='flex items-center gap-2 px-2 py-2 text-start text-body'>
              <UserAvatar
                user={{ name: user.name, avatar: user.avatar }}
                className='size-8 rounded-full shrink-0'
              />
              <div className='grid flex-1 text-start text-body leading-tight min-w-0'>
                <span className='truncate font-semibold text-small'>{user.name}</span>
                <span className='truncate text-caption text-muted-foreground'>{user.email}</span>
              </div>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <AccountMenuItems onSignOut={() => setOpen(true)} />
        </DropdownMenuContent>
      </DropdownMenu>

      <SignOutDialog open={!!open} onOpenChange={setOpen} />
    </>
  )
}
