import '@/styles/index.css'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthenticatedLayout } from './authenticated-layout'
import { useAuthStore } from '@/stores/auth-store'
import { useAssistantStore } from '@/stores/assistant-store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { setCookie } from '@/lib/cookies'

const mocks = vi.hoisted(() => ({
  pathname: '/scenarios',
  navigate: vi.fn(),
}))

type MockLocation = { pathname: string; href: string; search: Record<string, never> }
type MockRouterState = { location: MockLocation }
type MockLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  to: string | Record<string, unknown>
  children?: ReactNode
}

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useRouterState: (opts?: { select?: (s: MockRouterState) => unknown }) => {
      const state: MockRouterState = { location: { pathname: mocks.pathname, href: mocks.pathname, search: {} } }
      return opts?.select ? opts.select(state) : state
    },
    useLocation: (opts?: { select?: (l: MockLocation) => unknown }) => {
      const loc: MockLocation = { pathname: mocks.pathname, href: mocks.pathname, search: {} }
      return opts?.select ? opts.select(loc) : loc
    },
    useNavigate: () => mocks.navigate,
    Link: ({ to, children, className, onClick, ...props }: MockLinkProps) => (
      <a
        href={typeof to === 'string' ? to : '#'}
        className={className}
        onClick={(e) => {
          e.preventDefault()
          onClick?.(e)
          mocks.navigate({ to })
        }}
        {...props}
      >
        {children}
      </a>
    ),
  }
})

const mockHealthResponse = {
  overall: 'healthy' as const,
  asOf: '2026-09-27T12:00:00.000Z',
  validUntil: '2026-09-27T12:01:00.000Z',
  freshForMs: 30000,
  checks: {
    api: { status: 'healthy' as const, code: 'OK', message: 'API 自检正常' },
    database: { status: 'healthy' as const, code: 'OK', message: '数据库正常' },
    worker: {
      status: 'healthy' as const,
      code: 'OK',
      message: 'Worker 节点健康',
      healthyNodes: 3,
      affectedActiveRuns: 0,
      affectedActiveSessions: 0,
    },
    changeHint: { status: 'healthy' as const, code: 'OK', message: '链路正常' },
  },
}

describe('Console Shell Redesign Acceptance (控制台外框全面验收)', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.pathname = '/scenarios'
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (url.includes('/api/platform-health')) {
        return new Response(JSON.stringify(mockHealthResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/health')) {
        return new Response(
          JSON.stringify({
            status: 'ok',
            checks: { database: 'up', changeHint: 'up' },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }
      if (url.includes('/api/me/events')) {
        return new Response(new ReadableStream(), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    useAuthStore.getState().auth.reset()
    useAuthStore.getState().auth.setUser({
      id: 'admin-1',
      displayName: '管理员',
      email: 'admin@cairn.local',
      roles: ['admin'],
      permissions: ['*:*'],
    })

    useAssistantStore.setState({
      open: false,
      busy: false,
      question: '',
      mode: 'docked',
      dockWidth: 400,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    useAuthStore.getState().auth.reset()
  })

  it('1440px 视口：顶栏 56px (h-14)、侧栏 208px 含运维常驻区与底部「系统与管理」入口', async () => {
    await page.viewport(1440, 900)
    setCookie('sidebar_state', 'true')

    await render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthenticatedLayout>
            <div data-testid='main-content'>场景工作区</div>
          </AuthenticatedLayout>
        </TooltipProvider>
      </QueryClientProvider>,
    )

    // 1. 顶栏高度为 56px (h-14)
    const header = document.querySelector('header')
    expect(header).not.toBeNull()
    expect(header?.classList.contains('h-14')).toBe(true)
    expect(header?.clientHeight).toBeGreaterThanOrEqual(55)
    expect(header?.clientHeight).toBeLessThanOrEqual(56)

    // 2. 侧栏展开宽度为 208px
    const sidebar = document.querySelector('[data-sidebar="sidebar"]')
    expect(sidebar).not.toBeNull()
    expect(sidebar?.clientWidth).toBe(208)

    // 3. 常驻区包含总览、编写、运行、目标、运维
    await expect.element(page.getByRole('link', { name: '总览', exact: true })).toBeVisible()
    await expect.element(page.getByRole('link', { name: '场景编排' })).toBeVisible()
    await expect.element(page.getByRole('link', { name: '运行记录' })).toBeVisible()
    await expect.element(page.getByRole('link', { name: '目标系统' })).toBeVisible()
    await expect.element(page.getByText('运行', { exact: true })).toBeVisible()
    await expect.element(page.getByText('目标', { exact: true })).toBeVisible()
    await expect.element(page.getByText('运维', { exact: true })).toBeVisible()
    await expect.element(page.getByRole('link', { name: '监控', exact: true })).toBeVisible()
    await expect.element(page.getByRole('link', { name: '执行节点', exact: true })).toBeVisible()
    await expect.element(page.getByRole('link', { name: '消息推送', exact: true })).toBeVisible()

    // 4. 底部系统与管理入口渲染
    const systemTrigger = page.getByRole('button', { name: '系统与管理' })
    await expect.element(systemTrigger).toBeVisible()

    // 5. 顶栏右侧元素可达：搜索入口、识途助手、头像及用户昵称
    await expect.element(page.getByRole('button', { name: '搜索或跳转' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '打开识途助手' })).toBeVisible()
    const accountBtn = page.getByRole('button', { name: /账号菜单/ })
    await expect.element(accountBtn).toBeVisible()
    await expect.element(accountBtn.getByText('管理员')).toBeVisible()

    // 6. 一级菜单页：顶栏直接显示页名，不再显示侧栏分组
    const crumb = page.getByRole('navigation', { name: '面包屑导航' })
    await expect.element(crumb.getByText('场景编排', { exact: true })).toBeVisible()
    await expect.element(crumb.getByText('编写', { exact: true })).not.toBeInTheDocument()
  })

  it('桌面端侧栏折叠为 72px 图标栏，品牌区折叠按钮工作正常', async () => {
    await page.viewport(1440, 900)
    setCookie('sidebar_state', 'true')

    await render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthenticatedLayout>
            <div data-testid='main-content'>内容</div>
          </AuthenticatedLayout>
        </TooltipProvider>
      </QueryClientProvider>,
    )

    const toggleBtn = page.getByRole('button', { name: /收起侧栏/ })
    await expect.element(toggleBtn).toBeVisible()

    // 点击收起侧栏
    await toggleBtn.click()

    // 等待 200ms 宽度过渡完成，侧栏收起为 72px 图标栏
    const sidebar = document.querySelector('[data-sidebar="sidebar"]')
    await vi.waitFor(() => expect(sidebar?.clientWidth).toBe(72))

    // 展开按钮出现
    const expandBtn = page.getByRole('button', { name: /展开侧栏/ })
    await expect.element(expandBtn).toBeVisible()

    // 再次点击展开
    await expandBtn.click()
    await vi.waitFor(() => expect(sidebar?.clientWidth).toBe(208))
  })

  it('矮窗口中的折叠侧栏可滚动到运维末项', async () => {
    await page.viewport(1024, 500)
    setCookie('sidebar_state', 'false')

    await render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthenticatedLayout>
            <div>内容</div>
          </AuthenticatedLayout>
        </TooltipProvider>
      </QueryClientProvider>,
    )

    const content = document.querySelector<HTMLElement>('[data-sidebar="content"]')
    const outbound = content?.querySelector<HTMLAnchorElement>('a[href="/outbound"]')
    expect(content).not.toBeNull()
    expect(outbound).not.toBeNull()
    expect(content!.scrollHeight).toBeGreaterThan(content!.clientHeight)

    content!.scrollTop = content!.scrollHeight
    await vi.waitFor(() => {
      const viewport = content!.getBoundingClientRect()
      const item = outbound!.getBoundingClientRect()
      expect(item.top).toBeGreaterThanOrEqual(viewport.top)
      expect(item.bottom).toBeLessThanOrEqual(viewport.bottom)
    })
  })

  it('点击「系统与管理」入口弹出面板，只展示管理导航及原有健康状态', async () => {
    await page.viewport(1440, 900)
    setCookie('sidebar_state', 'true')

    await render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthenticatedLayout>
            <div>内容</div>
          </AuthenticatedLayout>
        </TooltipProvider>
      </QueryClientProvider>,
    )

    const systemTrigger = page.getByRole('button', { name: '系统与管理' })
    await systemTrigger.click()

    // 弹出面板展示
    const panel = page.getByRole('dialog')
    await expect.element(panel.getByText('平台运行概况')).toBeVisible()
    await expect.element(panel.getByText('运维')).not.toBeInTheDocument()
    await expect.element(panel.getByRole('link', { name: '监控' })).not.toBeInTheDocument()

    // 管理菜单包含用户管理、平台配置等
    await expect.element(panel.getByRole('link', { name: '用户管理' })).toBeVisible()
    await expect.element(panel.getByRole('link', { name: '平台配置' })).toBeVisible()
  })

  it('1280px 视口且助手停靠宽 600px 时，自适应切为覆盖式（Overlay）避免主区不足 640px 挤压', async () => {
    await page.viewport(1280, 800)
    setCookie('sidebar_state', 'true')

    useAssistantStore.setState({
      open: true,
      mode: 'docked',
      dockWidth: 600,
    })

    await render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthenticatedLayout>
            <div>主区内容</div>
          </AuthenticatedLayout>
        </TooltipProvider>
      </QueryClientProvider>,
    )

    // 1280 - 208 (侧栏) - 600 (助手) = 472px < 640px，必须为 dialog Overlay
    const overlayDialog = page.getByRole('dialog', { name: '识途助手伴随侧栏' })
    await expect.element(overlayDialog).toBeVisible()

    // 主区不被挤压，顶栏控件保持正常可见
    await expect.element(page.getByRole('button', { name: '打开识途助手' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: /账号菜单/ })).toBeVisible()
  })

  it('移动端 375px 视口：汉堡菜单可见、桌面侧栏隐藏、面包屑仅展示当前页、按钮收敛为触控图标', async () => {
    await page.viewport(375, 667)

    await render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthenticatedLayout>
            <div>移动端内容</div>
          </AuthenticatedLayout>
        </TooltipProvider>
      </QueryClientProvider>,
    )

    // 1. 移动端侧栏汉堡开关可见
    const mobileTrigger = page.getByRole('button', { name: '打开侧栏导航' })
    await expect.element(mobileTrigger).toBeVisible()

    // 2. 搜索入口收纳为图标按钮（aria-label 保持为搜索或跳转）
    const searchBtn = page.getByRole('button', { name: '搜索或跳转' })
    await expect.element(searchBtn).toBeVisible()
    expect(searchBtn.element().clientWidth).toBeLessThanOrEqual(44)

    // 3. 识途助手入口保留为图标按钮
    const assistantBtn = page.getByRole('button', { name: '打开识途助手' })
    await expect.element(assistantBtn).toBeVisible()

    // 4. 头像菜单触控目标可达 (>= 44px)
    const avatarBtn = page.getByRole('button', { name: /账号菜单/ })
    await expect.element(avatarBtn).toBeVisible()
    expect(avatarBtn.element().clientWidth).toBeGreaterThanOrEqual(44)
    expect(avatarBtn.element().clientHeight).toBeGreaterThanOrEqual(44)

    // 5. 顶栏高度仍然是 56px (h-14)
    const header = document.querySelector('header')
    expect(header?.classList.contains('h-14')).toBe(true)
    expect(header?.clientHeight).toBeGreaterThanOrEqual(55)
    expect(header?.clientHeight).toBeLessThanOrEqual(56)

    // 6. 抽屉里运维是普通导航组，各项只出现一次；管理项也直接可达
    await mobileTrigger.click()
    const drawer = page.getByRole('dialog', { name: '侧栏' })
    await expect.element(drawer.getByText('运维', { exact: true })).toBeVisible()
    await expect.element(drawer.getByRole('link', { name: '监控', exact: true })).toBeVisible()
    await expect.element(drawer.getByRole('link', { name: '执行节点', exact: true })).toBeVisible()
    await expect.element(drawer.getByRole('link', { name: '消息推送', exact: true })).toBeVisible()
    await expect.element(drawer.getByRole('link', { name: '用户管理', exact: true })).toBeVisible()
    expect(drawer.element().querySelectorAll('a[href="/monitoring"]')).toHaveLength(1)
    expect(drawer.element().querySelectorAll('a[href="/workers"]')).toHaveLength(1)
    expect(drawer.element().querySelectorAll('a[href="/outbound"]')).toHaveLength(1)
  })
})
