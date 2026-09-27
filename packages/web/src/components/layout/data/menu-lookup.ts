import { sidebarData } from './sidebar-data'

/** 一级菜单页内以独立路由实现的页签：按所属菜单页处理，切换页签时顶栏与页头不跳动 */
const MENU_TAB_ROUTES: Record<string, string> = {
  '/suite-runs': '/runs',
  '/audit/operations': '/audit',
  '/audit/logins': '/audit',
}

/** 查找一级菜单项及其所属分组名称 */
export function findMenuItem(pathname: string) {
  const menuPath = MENU_TAB_ROUTES[pathname] ?? pathname
  for (const group of sidebarData.navGroups) {
    for (const item of group.items) {
      if ('url' in item && item.url === menuPath) {
        return { groupTitle: group.title, itemTitle: item.title, permission: item.permission, anyOf: item.anyOf }
      }
    }
  }
  return null
}
