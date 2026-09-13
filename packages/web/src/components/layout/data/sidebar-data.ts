import {
  Home,
  KeyRound,
  CircleDot,
  ListChecks,
  Monitor,
  Palette,
  Play,
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
          title: '场景',
          url: '/scenarios',
          icon: ListChecks,
          permission: 'workflow:read',
        },
        {
          title: '录制草稿',
          url: '/recordings',
          icon: CircleDot,
          permission: 'workflow:write',
        },
        {
          title: '运行',
          url: '/runs',
          icon: Play,
          permission: 'run:read',
        },
      ],
    },
    {
      title: '治理',
      items: [
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
          title: '开放服务',
          url: '/services',
          icon: KeyRound,
          permission: 'service:read',
        },
        {
          title: '审计',
          url: '/audit',
          icon: ScrollText,
          anyOf: ['audit:read', 'audit:login'],
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
