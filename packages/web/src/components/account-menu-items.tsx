import { Link } from '@tanstack/react-router'
import { useAuthStore } from '@/stores/auth-store'
import { filterNavItems } from '@/lib/rbac'
import { personalSettingsNav } from '@/components/layout/data/sidebar-data'
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

type AccountMenuItemsProps = {
  onSignOut: () => void
  onNavigate?: () => void
}

export function AccountMenuItems({ onSignOut, onNavigate }: AccountMenuItemsProps) {
  const user = useAuthStore((s) => s.auth.user)
  const settings = filterNavItems([personalSettingsNav], user)[0]
  return (
    <>
      {settings && (
        <>
          <DropdownMenuGroup>
            {settings.items.map((item) => (
              <DropdownMenuItem key={item.url} asChild>
                <Link to={item.url} onClick={onNavigate}>
                  {item.icon && <item.icon />}
                  {item.title}
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem variant='destructive' onClick={onSignOut}>
        退出登录
      </DropdownMenuItem>
    </>
  )
}
