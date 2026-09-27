import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { AppTitle } from './app-title'
import { persistentNavGroups, systemNavGroups } from './data/sidebar-data'
import { NavGroup } from './nav-group'
import { SystemMenu } from './system-menu'

export function AppSidebar() {
  const { isMobile } = useSidebar()

  return (
    <Sidebar collapsible='icon' variant='sidebar'>
      <SidebarHeader>
        <AppTitle />
      </SidebarHeader>
      <SidebarContent>
        {persistentNavGroups.map((props) => (
          <NavGroup key={props.title} {...props} />
        ))}
        {/* 移动端抽屉内按权限直接展示管理组，不再额外渲染系统与管理弹出触发器 */}
        {isMobile
          ? systemNavGroups.map((props) => (
              <NavGroup key={props.title} {...props} />
            ))
          : null}
      </SidebarContent>
      <SidebarFooter>
        <SystemMenu healthOnly={isMobile} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
