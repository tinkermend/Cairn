import {
  Activity,
  Bell,
  FileSearch,
  Home,
  KeyRound,
  CircleDot,
  Laptop,
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
} from 'lucide-react'
import { CAPABILITY_GROUP_LABELS, capabilityById } from '@cairn/shared'
import { type NavCollapsible, type NavGroup, type SidebarData } from '../types'

const menuTitle = (id: string) => capabilityById(`menu.${id}`).label

export const personalSettingsNav: NavCollapsible = {
  title: menuTitle('settings'),
  icon: Settings,
  permission: 'settings:read',
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
        {
          title: menuTitle('home'),
          url: '/',
          icon: Home,
        },
      ],
    },
    {
      title: CAPABILITY_GROUP_LABELS.workbench,
      items: [
        {
          title: menuTitle('scenarios'),
          url: '/scenarios',
          icon: ListChecks,
          permission: 'workflow:read',
        },
        {
          title: menuTitle('suites'),
          url: '/suites',
          icon: Layers,
          permission: 'suite:read',
        },
        {
          title: menuTitle('action-modules'),
          url: '/action-modules',
          icon: Boxes,
          permission: 'module:read',
        },
        {
          title: menuTitle('recordings'),
          url: '/recordings',
          icon: CircleDot,
          permission: 'workflow:write',
        },
      ],
    },
    {
      title: CAPABILITY_GROUP_LABELS['execution-observation'],
      items: [
        {
          title: menuTitle('schedules'),
          url: '/schedules',
          icon: CalendarClock,
          permission: 'schedule:read',
        },
        {
          title: menuTitle('runs'),
          url: '/runs',
          icon: Play,
          permission: 'run:read',
        },
        {
          title: menuTitle('evidence'),
          url: '/evidence',
          icon: FileSearch,
          permission: 'run:read',
        },
      ],
    },
    {
      title: CAPABILITY_GROUP_LABELS.resources,
      items: [
        {
          title: menuTitle('targets'),
          url: '/targets',
          icon: Monitor,
          permission: 'target:read',
        },
        {
          title: menuTitle('credentials'),
          url: '/credentials',
          icon: KeyRound,
          permission: 'credential:read',
        },
        {
          title: menuTitle('sessions'),
          url: '/sessions',
          icon: Laptop,
          permission: 'session:read',
        },
      ],
    },
    {
      title: CAPABILITY_GROUP_LABELS.operations,
      items: [
        {
          title: menuTitle('monitoring'),
          url: '/monitoring',
          icon: Activity,
          permission: 'monitor:read',
        },
        { title: menuTitle('workers'), url: '/workers', icon: Server, permission: 'session:read' },
        { title: menuTitle('notifications'), url: '/notifications', icon: Bell, permission: 'notification:read' },
      ],
    },
    {
      title: CAPABILITY_GROUP_LABELS.governance,
      items: [
        {
          title: menuTitle('users'),
          url: '/users',
          icon: Users,
          permission: 'account:read',
        },
        {
          title: menuTitle('roles'),
          url: '/roles',
          icon: Shield,
          permission: 'role:read',
        },
        {
          title: menuTitle('services'),
          url: '/services',
          icon: KeyRound,
          permission: 'service:read',
        },
        {
          title: menuTitle('platform-config'),
          url: '/platform-config',
          icon: SlidersHorizontal,
          permission: 'platform-config:read',
        },
        {
          title: menuTitle('audit'),
          url: '/audit',
          icon: ScrollText,
          anyOf: ['audit:read', 'audit:login'],
        },
      ],
    },
  ],
}
