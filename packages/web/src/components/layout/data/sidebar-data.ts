import {
  Activity,
  Send,
  Home,
  KeyRound,
  CircleDot,
  Layers,
  ListChecks,
  Monitor,
  Play,
  CalendarClock,
  ScrollText,
  Server,
  Settings,
  Shield,
  SlidersHorizontal,
  UserCog,
  Users,
  Boxes,
  Database,
  Rows3,
  Wrench,
} from 'lucide-react'
import { CAPABILITY_GROUP_LABELS, requireMenuItem } from '@cairn/shared'
import { type NavCollapsible, type NavGroup, type NavLink, type SidebarData } from '../types'

function navItem(id: string, icon: React.ElementType): NavLink {
  const item = requireMenuItem(`menu.${id}`)
  return {
    title: item.title,
    url: item.route,
    icon,
    permission: item.permission,
    anyOf: item.anyOf,
  }
}

export const personalSettingsNav: NavCollapsible = {
  title: requireMenuItem('menu.settings').title,
  icon: Settings,
  permission: requireMenuItem('menu.settings').permission,
  items: [
    { title: '个人资料', url: '/settings', icon: UserCog },
    { title: '修改密码', url: '/settings/account', icon: KeyRound },
  ],
}

export const personalSettingsGroup: NavGroup = {
  title: CAPABILITY_GROUP_LABELS.other,
  items: [personalSettingsNav],
}

export const sidebarData: SidebarData = {
  user: {
    name: '控制台',
    email: '',
    avatar: '',
  },
  navGroups: [
    {
      title: '',
      items: [
        navItem('home', Home),
      ],
    },
    {
      title: CAPABILITY_GROUP_LABELS.workbench,
      items: [
        navItem('scenarios', ListChecks),
        navItem('suites', Layers),
        navItem('batches', Rows3),
        navItem('action-modules', Boxes),
        navItem('recordings', CircleDot),
      ],
    },
    {
      title: CAPABILITY_GROUP_LABELS['execution-observation'],
      items: [
        navItem('schedules', CalendarClock),
        navItem('runs', Play),
        navItem('maintenance', Wrench),
      ],
    },
    {
      title: CAPABILITY_GROUP_LABELS.resources,
      items: [
        navItem('datasets', Database),
        navItem('targets', Monitor),
        navItem('sessions', Layers),
      ],
    },
    {
      title: CAPABILITY_GROUP_LABELS.operations,
      items: [
        navItem('monitoring', Activity),
        navItem('workers', Server),
        navItem('outbound', Send),
      ],
    },
    {
      title: CAPABILITY_GROUP_LABELS.governance,
      items: [
        navItem('users', Users),
        navItem('roles', Shield),
        navItem('services', KeyRound),
        navItem('platform-config', SlidersHorizontal),
        navItem('audit', ScrollText),
      ],
    },
  ],
}
