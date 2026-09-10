import {
  LayoutDashboard,
  HelpCircle,
  Bell,
  Palette,
  Settings,
  Wrench,
  UserCog,
  Users,
  Shield,
  ScrollText,
  Monitor,
  ListTodo,
} from 'lucide-react'
import { type SidebarData } from '../types'

export const sidebarData: SidebarData = {
  user: {
    name: 'Console',
    email: '',
    avatar: '',
  },
  teams: [
    {
      name: 'Cairn',
      logo: Shield,
      plan: 'Console',
    },
  ],
  navGroups: [
    {
      title: 'General',
      items: [
        {
          title: 'Dashboard',
          url: '/',
          icon: LayoutDashboard,
        },
        {
          title: 'Tasks',
          url: '/tasks',
          icon: ListTodo,
        },
        {
          title: 'Users',
          url: '/users',
          icon: Users,
          permission: 'account:read',
        },
        {
          title: 'Roles',
          url: '/roles',
          icon: Shield,
          permission: 'role:read',
        },
        {
          title: 'Audit',
          url: '/audit',
          icon: ScrollText,
          permission: 'audit:read',
        },
      ],
    },
    {
      title: 'Other',
      items: [
        {
          title: 'Settings',
          icon: Settings,
          permission: 'settings:read',
          items: [
            {
              title: 'Profile',
              url: '/settings',
              icon: UserCog,
            },
            {
              title: 'Account',
              url: '/settings/account',
              icon: Wrench,
            },
            {
              title: 'Appearance',
              url: '/settings/appearance',
              icon: Palette,
            },
            {
              title: 'Notifications',
              url: '/settings/notifications',
              icon: Bell,
            },
            {
              title: 'Display',
              url: '/settings/display',
              icon: Monitor,
            },
          ],
        },
        {
          title: 'Help Center',
          url: '/help-center',
          icon: HelpCircle,
        },
      ],
    },
  ],
}
