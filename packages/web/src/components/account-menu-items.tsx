import { Link } from '@tanstack/react-router'
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@/components/ui/dropdown-menu'

type AccountMenuItemsProps = {
  onSignOut: () => void
}

export function AccountMenuItems({ onSignOut }: AccountMenuItemsProps) {
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuItem asChild>
          <Link to='/settings'>
            个人资料
            <DropdownMenuShortcut>⇧⌘P</DropdownMenuShortcut>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to='/settings/account'>
            账号
            <DropdownMenuShortcut>⌘S</DropdownMenuShortcut>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant='destructive' onClick={onSignOut}>
        退出登录
        <DropdownMenuShortcut className='text-current'>
          ⇧⌘Q
        </DropdownMenuShortcut>
      </DropdownMenuItem>
    </>
  )
}
