import { useAuthStore } from '@/stores/auth-store'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from '@/components/ui/sidebar'
import { ApiStatus } from './api-status'
import { AppTitle } from './app-title'
import { sidebarData } from './data/sidebar-data'
import { NavGroup } from './nav-group'
import { NavUser } from './nav-user'

export function AppSidebar() {
  const user = useAuthStore((s) => s.auth.user)
  return (
    <Sidebar collapsible='none' variant='sidebar'>
      <SidebarHeader>
        <AppTitle />
      </SidebarHeader>
      <SidebarContent>
        {sidebarData.navGroups.map((props) => (
          <NavGroup key={props.title} {...props} />
        ))}
      </SidebarContent>
      <SidebarFooter>
        <ApiStatus />
        <NavUser
          user={{
            name: user?.displayName ?? sidebarData.user.name,
            email: user?.email ?? sidebarData.user.email,
            avatar: sidebarData.user.avatar,
          }}
        />
      </SidebarFooter>
    </Sidebar>
  )
}
