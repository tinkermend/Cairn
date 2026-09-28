import { Fragment, useEffect } from 'react'
import { Outlet, useRouterState } from '@tanstack/react-router'
import { getCookie } from '@/lib/cookies'
import { cn } from '@/lib/utils'
import { SearchProvider } from '@/context/search-provider'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { AppHeader } from '@/components/layout/app-header'
import { AppSidebar } from '@/components/layout/app-sidebar'
import { SkipToMain } from '@/components/skip-to-main'
import { AssistantHost } from '@/features/assistant/host'
import { useAuthStore } from '@/stores/auth-store'
import { useAssistantStore } from '@/stores/assistant-store'
import { resolveRouteContext, type RouteMatchInfo } from '@/features/assistant/route-context'
import { AuthScopeObserver } from './auth-scope-observer'

type AuthenticatedLayoutProps = {
  children?: React.ReactNode
}

export function AuthenticatedLayout({ children }: AuthenticatedLayoutProps) {
  const cookieVal = getCookie('sidebar_state')
  const defaultOpen =
    cookieVal !== null && cookieVal !== undefined && cookieVal !== ''
      ? cookieVal === 'true'
      : typeof window !== 'undefined'
        ? window.innerWidth >= 1366
        : true
  const auth = useAuthStore(s => s.auth.user)
  const setRouteContext = useAssistantStore((s) => s.setRouteContext)
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  })
  // 叶路由的助手声明与参数序列化成字符串：只在它们变化时重算，免得每次路由状态更新都拿到新对象。
  const leafKey = useRouterState({
    select: (s) => {
      const leaf = s.matches[s.matches.length - 1]
      return leaf ? JSON.stringify({ assistant: leaf.staticData?.assistant, params: leaf.params }) : ''
    },
  })

  useEffect(() => {
    const leaf = leafKey ? (JSON.parse(leafKey) as RouteMatchInfo) : undefined
    setRouteContext(resolveRouteContext(pathname, leaf))
  }, [pathname, leafKey, setRouteContext])

  const scopeKey = JSON.stringify([auth?.id, auth?.permissions, auth?.targetScopes, auth?.targetScopePermissions])
  return (
    <SearchProvider>
      <AuthScopeObserver />
      <SidebarProvider defaultOpen={defaultOpen}>
        <SkipToMain />
        <AppSidebar />
        <SidebarInset
          className={cn(
            // Set content container, so we can use container queries
            '@container/content',
            'min-w-0',

            // 顶栏半透明叠在这里，底色须与内容画布一致
            'bg-surface-page',

            // If layout is fixed, set the height
            // to 100svh to prevent overflow
            'has-data-[layout=fixed]:h-svh',

            // If layout is fixed and sidebar is inset,
            // set the height to 100svh - spacing (total margins) to prevent overflow
            'peer-data-[variant=inset]:has-data-[layout=fixed]:h-[calc(100svh-(var(--spacing)*4))]'
          )}
        >
          <AppHeader />
          <Fragment key={scopeKey}>{children ?? <Outlet />}</Fragment>
        </SidebarInset>
        <AssistantHost showFloatingLauncher={false} />
      </SidebarProvider>
    </SearchProvider>
  )
}
