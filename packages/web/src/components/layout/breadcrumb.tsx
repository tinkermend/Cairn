import { useMemo } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'
import { can } from '@/lib/rbac'
import { sidebarData } from './data/sidebar-data'
import { findMenuItem } from './data/menu-lookup'
import { useBreadcrumbStore } from '@/stores/breadcrumb-store'
import { usePageHeadingStore } from '@/stores/page-heading-store'
import { cn } from '@/lib/utils'

export interface BreadcrumbSegment {
  label: string
  href?: string
  isCurrent?: boolean
}

function checkAccess(
  user: ReturnType<typeof useAuthStore.getState>['auth']['user'],
  pathname: string,
): boolean {
  if (!user) return false
  const targetPath = pathname.split('?')[0]
  if (targetPath === '/' || targetPath === '/home' || targetPath.startsWith('/settings')) return true

  for (const group of sidebarData.navGroups) {
    for (const item of group.items) {
      if ('url' in item && item.url === targetPath) {
        if (item.anyOf && item.anyOf.length > 0) {
          return item.anyOf.some((p) => can(user, p as any))
        }
        if (item.permission) {
          return can(user, item.permission as any)
        }
        return true
      }
    }
  }
  return true
}

export function AppBreadcrumb({ className }: { className?: string }) {
  const user = useAuthStore((s) => s.auth.user)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const search = useRouterState({ select: (s) => s.location.search }) as Record<string, string | undefined>
  const entities = useBreadcrumbStore((s) => s.entities)

  const segments = useMemo<BreadcrumbSegment[]>(() => {
    // 1. 首页 / 总览
    if (pathname === '/' || pathname === '/home') {
      return [{ label: '总览', isCurrent: true }]
    }

    // 2. 一级菜单页：顶栏直接充当页面标题，只显示菜单名。
    //    分组（编写、运行…）在侧栏已经可见且不可点击，这里不再重复。
    const exactMenu = findMenuItem(pathname)
    if (exactMenu) {
      return [{ label: exactMenu.itemTitle, isCurrent: true }]
    }

    // 3. 显式规则处理非菜单与深层路由
    // 3.1 场景集运行详情
    const suiteRunMatch = pathname.match(/^\/suite-runs\/([^/]+)/)
    if (suiteRunMatch) {
      const id = suiteRunMatch[1]
      const entity = entities[id]
      const title = entity?.title || `场景集运行 #${id.slice(0, 8)}`
      const canRuns = checkAccess(user, '/runs')
      return [
        { label: '运行' },
        { label: '运行记录', href: canRuns ? '/runs' : undefined },
        { label: '场景集运行', href: '/suite-runs' },
        { label: title, isCurrent: true },
      ]
    }

    // 3.2 运行详情
    const runMatch = pathname.match(/^\/runs\/([^/]+)/)
    if (runMatch) {
      const id = runMatch[1]
      const entity = entities[id]
      const title = entity?.title || `运行 #${id.slice(0, 8)}`
      const canRuns = checkAccess(user, '/runs')
      return [
        { label: '运行' },
        { label: '运行记录', href: canRuns ? '/runs' : undefined },
        { label: title, isCurrent: true },
      ]
    }

    // 3.3 自动化维护事件详情
    const incidentMatch = pathname.match(/^\/maintenance\/incidents\/([^/]+)/)
    if (incidentMatch) {
      const id = incidentMatch[1]
      const entity = entities[id]
      const title = entity?.title || `维护事件 #${id.slice(0, 8)}`
      const canMaint = checkAccess(user, '/maintenance')
      return [
        { label: '运行' },
        { label: '自动化维护', href: canMaint ? '/maintenance?view=incidents' : undefined },
        { label: title, isCurrent: true },
      ]
    }

    // 3.4 报告详情
    const reportMatch = pathname.match(/^\/reports\/([^/]+)/)
    if (reportMatch) {
      const id = reportMatch[1]
      const entity = entities[id]
      const title = entity?.title || '报告详情'
      const canRuns = checkAccess(user, '/runs')
      return [
        { label: '运行' },
        { label: '运行记录', href: canRuns ? '/runs?view=reports' : undefined },
        { label: title, isCurrent: true },
      ]
    }

    // 3.5 证据详情
    const evidenceMatch = pathname.match(/^\/evidence\/([^/]+)/)
    if (evidenceMatch) {
      const id = evidenceMatch[1]
      const entity = entities[id]
      const title = entity?.title || '证据详情'
      const canRuns = checkAccess(user, '/runs')
      // 映射旧参数 view 为 evidenceView，并固定 view=materials
      const parentParams = new URLSearchParams()
      parentParams.set('view', 'materials')
      if (search?.view) {
        parentParams.set('evidenceView', search.view)
      }
      if (search?.runId) parentParams.set('runId', search.runId)
      if (search?.targetId) parentParams.set('targetId', search.targetId)

      return [
        { label: '运行' },
        { label: '运行记录', href: canRuns ? `/runs?${parentParams.toString()}` : undefined },
        { label: title, isCurrent: true },
      ]
    }

    // 3.6 场景详情
    const scenarioMatch = pathname.match(/^\/scenarios\/([^/]+)/)
    if (scenarioMatch) {
      const id = scenarioMatch[1]
      const entity = entities[id]
      const title = entity?.title || '场景详情'
      const canScenarios = checkAccess(user, '/scenarios')
      return [
        { label: '编写' },
        { label: '场景编排', href: canScenarios ? '/scenarios' : undefined },
        { label: title, isCurrent: true },
      ]
    }

    // 3.7 场景集详情
    const suiteMatch = pathname.match(/^\/suites\/([^/]+)/)
    if (suiteMatch) {
      const id = suiteMatch[1]
      const entity = entities[id]
      const title = entity?.title || '场景集详情'
      const canSuites = checkAccess(user, '/suites')
      return [
        { label: '编写' },
        { label: '场景集', href: canSuites ? '/suites' : undefined },
        { label: title, isCurrent: true },
      ]
    }

    // 3.8 批量任务详情
    const batchMatch = pathname.match(/^\/batches\/([^/]+)/)
    if (batchMatch) {
      const id = batchMatch[1]
      const entity = entities[id]
      const title = entity?.title || '批量任务详情'
      const canBatches = checkAccess(user, '/batches')
      return [
        { label: '编写' },
        { label: '批量任务', href: canBatches ? '/batches' : undefined },
        { label: title, isCurrent: true },
      ]
    }

    // 3.9 动作库详情
    const moduleMatch = pathname.match(/^\/action-modules\/([^/]+)/)
    if (moduleMatch) {
      const id = moduleMatch[1]
      const entity = entities[id]
      const title = entity?.title || '动作详情'
      const canModules = checkAccess(user, '/action-modules')
      return [
        { label: '编写' },
        { label: '动作库', href: canModules ? '/action-modules' : undefined },
        { label: title, isCurrent: true },
      ]
    }

    // 3.10 录制草稿详情
    const recordingMatch = pathname.match(/^\/recordings\/([^/]+)/)
    if (recordingMatch) {
      const id = recordingMatch[1]
      const entity = entities[id]
      const title = entity?.title || '录制草稿详情'
      const canRec = checkAccess(user, '/recordings')
      return [
        { label: '编写' },
        { label: '录制草稿', href: canRec ? '/recordings' : undefined },
        { label: title, isCurrent: true },
      ]
    }

    // 3.11 目标知识地图与详情
    const targetMapMatch = pathname.match(/^\/targets\/([^/]+)\/map/)
    if (targetMapMatch) {
      const id = targetMapMatch[1]
      const entity = entities[id]
      const targetTitle = entity?.parentTitle || entity?.title || '具体目标'
      const canTargets = checkAccess(user, '/targets')
      return [
        { label: '目标' },
        { label: '目标系统', href: canTargets ? '/targets' : undefined },
        { label: targetTitle, href: `/targets/${id}` },
        { label: '目标知识', isCurrent: true },
      ]
    }
    const targetMatch = pathname.match(/^\/targets\/([^/]+)/)
    if (targetMatch) {
      const id = targetMatch[1]
      const entity = entities[id]
      const title = entity?.title || '目标详情'
      const canTargets = checkAccess(user, '/targets')
      return [
        { label: '目标' },
        { label: '目标系统', href: canTargets ? '/targets' : undefined },
        { label: title, isCurrent: true },
      ]
    }

    // 3.12 账号会话详情
    const sessionMatch = pathname.match(/^\/sessions\/([^/]+)\/([^/]+)/)
    if (sessionMatch) {
      const [_, targetId, accountId] = sessionMatch
      const entity = entities[accountId] || entities[targetId]
      const targetTitle = entity?.parentTitle || '目标系统'
      const accountTitle = entity?.title || '会话详情'
      const canSessions = checkAccess(user, '/sessions')
      return [
        { label: '目标' },
        {
          label: '账号会话',
          href: canSessions ? `/sessions?view=systems&targetId=${encodeURIComponent(targetId)}` : undefined,
        },
        { label: targetTitle },
        { label: accountTitle, isCurrent: true },
      ]
    }

    // 3.13 执行节点详情
    const workerMatch = pathname.match(/^\/workers\/([^/]+)/)
    if (workerMatch) {
      const id = workerMatch[1]
      const entity = entities[id]
      const title = entity?.title || `节点 #${id.slice(0, 8)}`
      const canWorkers = checkAccess(user, '/workers')
      return [
        { label: '运维' },
        { label: '执行节点', href: canWorkers ? '/workers' : undefined },
        { label: title, isCurrent: true },
      ]
    }

    // 3.15 个人设置子页
    if (pathname === '/settings') {
      return [{ label: '个人设置' }, { label: '个人资料', isCurrent: true }]
    }
    if (pathname === '/settings/account') {
      return [{ label: '个人设置' }, { label: '修改密码', isCurrent: true }]
    }
    if (pathname === '/settings/keybindings') {
      return [{ label: '个人设置' }, { label: '快捷键', isCurrent: true }]
    }
    if (pathname === '/settings/appearance') {
      return [{ label: '个人设置' }, { label: '外观与主题', isCurrent: true }]
    }

    return [{ label: '控制台', isCurrent: true }]
  }, [pathname, search, user, entities])

  const pageDescription = usePageHeadingStore((s) => s.description)
  const showDescription = segments.length === 1 && pageDescription != null && pageDescription !== ''

  return (
    <nav
      aria-label='面包屑导航'
      className={cn('flex min-w-0 flex-col justify-center gap-0.5 text-small text-muted-foreground', className)}
    >
      <ol className='flex items-center gap-1.5 min-w-0 overflow-hidden'>
        {segments.map((seg, idx) => {
          const isLast = idx === segments.length - 1
          return (
            <li
              key={`${idx}-${seg.label}`}
              className={cn(
                'flex items-center gap-1.5 min-w-0 shrink-0',
                isLast && 'shrink min-w-0 font-medium text-foreground',
                // 在极窄视口下，隐藏前面的父级以避免顶栏溢出
                !isLast && idx < segments.length - 1 && 'hidden sm:flex',
                // 只有一级（菜单页标题）时按页面标题的字号显示
                isLast && segments.length === 1 && 'text-section leading-5 font-semibold',
              )}
            >
              {idx > 0 ? (
                <ChevronRight
                  // 窄屏只显示当前页，前面没有父级，分隔符随之隐藏
                  className={cn('size-3 text-muted-foreground/70 shrink-0', isLast && 'max-sm:hidden')}
                  aria-hidden='true'
                />
              ) : null}
              {seg.href && !isLast ? (
                <Link
                  to={seg.href}
                  className='truncate max-w-[140px] md:max-w-[200px] hover:text-foreground transition-colors'
                  title={seg.label}
                >
                  {seg.label}
                </Link>
              ) : (
                <span
                  className={cn(
                    'truncate',
                    isLast ? 'max-w-[200px] md:max-w-[320px] lg:max-w-[480px]' : 'max-w-[140px]',
                  )}
                  title={seg.label}
                  aria-current={isLast ? 'page' : undefined}
                >
                  {seg.label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
      {showDescription ? (
        // 菜单页副标题：与页名同一组，一行放不下时截断，悬停看全文
        <p
          className='hidden min-w-0 truncate text-small leading-4 lg:block'
          title={typeof pageDescription === 'string' ? pageDescription : undefined}
        >
          {pageDescription}
        </p>
      ) : null}
    </nav>
  )
}
