import { Link } from '@tanstack/react-router'
import type { PermissionCode } from '@cairn/shared'
import { ListChecks, Monitor, Play, ScrollText, Settings, Shield, SlidersHorizontal, Users } from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'
import { can, canAny } from '@/lib/rbac'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'

const modules: {
  title: string
  description: string
  to: '/targets' | '/scenarios' | '/runs' | '/users' | '/roles' | '/audit' | '/settings' | '/platform-config'
  icon: React.ElementType
  permission?: PermissionCode
  anyOf?: PermissionCode[]
}[] = [
  {
    title: '目标系统',
    description: '登记要仿真的外部业务系统，并维护目标账号。',
    to: '/targets',
    icon: Monitor,
    permission: 'target:read',
  },
  {
    title: '场景',
    description: '绑定目标系统的最小可运行定义，不是编排画布。',
    to: '/scenarios',
    icon: ListChecks,
    permission: 'workflow:read',
  },
  {
    title: '运行',
    description: '对目标系统执行场景，查看步骤、证据与结论。',
    to: '/runs',
    icon: Play,
    permission: 'run:read',
  },
  {
    title: '用户',
    description: '管理控制台账号，并分配角色。',
    to: '/users',
    icon: Users,
    permission: 'account:read',
  },
  {
    title: '角色',
    description: '查看系统角色，维护自定义权限组合。',
    to: '/roles',
    icon: Shield,
    permission: 'role:read',
  },
  {
    title: '审计',
    description: '查看控制台操作记录与登录记录。',
    to: '/audit',
    icon: ScrollText,
    anyOf: ['audit:read', 'audit:login'],
  },
  {
    title: '平台配置',
    description: '调整浏览器 AI、执行、会话与证据的平台默认策略。',
    to: '/platform-config',
    icon: SlidersHorizontal,
    permission: 'platform-config:read',
  },
  {
    title: '设置',
    description: '维护个人资料、账号与界面偏好。',
    to: '/settings',
    icon: Settings,
    permission: 'settings:read',
  },
]

export function HomePage() {
  const user = useAuthStore((s) => s.auth.user)
  const greeting = user?.displayName ? `你好，${user.displayName}` : '你好'
  const visible = modules.filter((item) =>
    item.anyOf ? canAny(user, item.anyOf) : !item.permission || can(user, item.permission)
  )

  return (
    <>
      <AppHeader fixed />
      <Main className='flex flex-1 flex-col gap-6'>
        <PageHeader
          title={greeting}
          description='识途是面向真实 Web 系统的智能仿真平台。控制台账号管平台权限；目标系统与目标账号是被仿真对象；浏览器会话由执行面纳管，不在这张工作台菜单里。'
        />
        <section className='grid gap-4 sm:grid-cols-2 md:gap-5 xl:grid-cols-3'>
          {visible.map((item) => {
            const Icon = item.icon
            return (
              <Link
                key={item.to}
                to={item.to}
                className='group rounded-lg border border-border-card bg-card p-5 shadow-card transition-[box-shadow,transform,border-color] duration-150 ease-[cubic-bezier(0.2,0,0.2,1)] hover:-translate-y-0.5 hover:border-selection-border hover:shadow-tech-panel focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-[3px] focus-visible:outline-none motion-reduce:hover:translate-y-0'
              >
                <div className='mb-3 flex size-11 items-center justify-center rounded-xl bg-[linear-gradient(160deg,var(--primary-500),var(--primary-600))] text-white shadow-action'>
                  <Icon size={20} aria-hidden />
                </div>
                <h2 className='text-section font-semibold text-text-primary'>
                  {item.title}
                </h2>
                <p className='mt-1 text-body text-muted-foreground'>
                  {item.description}
                </p>
              </Link>
            )
          })}
        </section>
      </Main>
    </>
  )
}
