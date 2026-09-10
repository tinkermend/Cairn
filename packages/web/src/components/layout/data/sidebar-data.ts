import {
  Home,
  Monitor,
  Palette,
  ScrollText,
  Settings,
  Shield,
  UserCog,
  Users,
  Wrench,
} from 'lucide-react'
import { type SidebarData } from '../types'

export const sidebarData: SidebarData = {
  user: {
    name: '控制台',
    email: '',
    avatar: '',
  },
  navGroups: [
    {
      title: '工作台',
      items: [
        {
          title: '首页',
          url: '/',
          icon: Home,
        },
        {
          title: '目标系统',
          url: '/targets',
          icon: Monitor,
          permission: 'target:read',
        },
        {
          title: '用户',
          url: '/users',
          icon: Users,
          permission: 'account:read',
        },
        {
          title: '角色',
          url: '/roles',
          icon: Shield,
          permission: 'role:read',
        },
        {
          title: '审计',
          url: '/audit',
          icon: ScrollText,
          permission: 'audit:read',
        },
      ],
    },
    {
      title: '其他',
      items: [
        {
          title: '设置',
          icon: Settings,
          permission: 'settings:read',
          items: [
            {
              title: '个人资料',
              url: '/settings',
              icon: UserCog,
            },
            {
              title: '账号',
              url: '/settings/account',
              icon: Wrench,
            },
            {
              title: '外观',
              url: '/settings/appearance',
              icon: Palette,
            },
          ],
        },
      ],
    },
  ],
}
