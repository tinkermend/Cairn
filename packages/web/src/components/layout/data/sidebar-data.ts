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
  Palette,
  Play,
  RefreshCw,
  ScrollText,
  Server,
  Settings,
  Shield,
  SlidersHorizontal,
  UserCog,
  Users,
  Wrench,
  Boxes,
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
          title: '场景集',
          url: '/suites',
          icon: Layers,
          permission: 'suite:read',
        },
        {
          title: '动作库',
          url: '/action-modules',
          icon: Boxes,
          permission: 'module:read',
        },
        {
          title: '录制草稿',
          url: '/recordings',
          icon: CircleDot,
          permission: 'workflow:write',
        },
      ],
    },
    {
      title: '执行与观测',
      items: [
        {
          title: '运行',
          url: '/runs',
          icon: Play,
          permission: 'run:read',
        },
        {
          title: '自动复查',
          url: '/schedules',
          icon: RefreshCw,
          permission: 'schedule:read',
        },
        {
          title: '浏览器会话',
          url: '/sessions',
          icon: Laptop,
          permission: 'session:read',
        },
        {
          title: '证据与报告',
          url: '/evidence',
          icon: FileSearch,
          permission: 'run:read',
        },
        {
          title: '运行监控',
          url: '/monitoring',
          icon: Activity,
          permission: 'monitor:read',
        },
        { title: '通知', url: '/notifications', icon: Bell, permission: 'notification:read' },
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
          title: '凭据管理',
          url: '/credentials',
          icon: KeyRound,
          permission: 'credential:read',
        },
        {
          title: '平台配置',
          url: '/platform-config',
          icon: SlidersHorizontal,
          permission: 'platform-config:read',
        },
        {
          title: '执行节点',
          url: '/workers',
          icon: Server,
          permission: 'session:read',
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
