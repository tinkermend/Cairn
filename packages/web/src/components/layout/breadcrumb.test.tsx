import '@/styles/index.css'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { AppBreadcrumb } from './breadcrumb'
import { useBreadcrumbStore } from '@/stores/breadcrumb-store'
import { useAuthStore } from '@/stores/auth-store'
import { usePageHeadingStore } from '@/stores/page-heading-store'
import type { MockLinkProps } from '@/test-utils/router-mocks'

let mockPathname = '/'
const mockSearch = {}

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: MockLinkProps) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useRouterState: ({ select }: { select: (state: { location: { pathname: string; search: object } }) => unknown }) =>
    select({
      location: {
        pathname: mockPathname,
        search: mockSearch,
      },
    }),
}))

describe('AppBreadcrumb', () => {
  beforeEach(async () => {
    await page.viewport(1280, 800)
    useBreadcrumbStore.setState({ entities: {} })
    useAuthStore.setState((state) => ({
      auth: {
        ...state.auth,
        user: {
          id: 'u1',
          displayName: 'Admin',
          email: 'admin@cairn.io',
          roles: ['admin'],
          permissions: ['*:*'],
        },
        accessToken: 'mock',
      },
    }))
  })

  it('首页只显示「总览」', async () => {
    mockPathname = '/'
    await render(<AppBreadcrumb />)
    await expect.element(page.getByText('总览', { exact: true })).toBeVisible()
  })

  it('一级菜单只显示菜单名作为页面标题，不重复侧栏分组', async () => {
    mockPathname = '/scenarios'
    await render(<AppBreadcrumb />)
    await expect.element(page.getByText('场景编排', { exact: true })).toBeVisible()
    await expect.element(page.getByText('编写', { exact: true })).not.toBeInTheDocument()
  })

  it('一级菜单页在宽屏把页面描述作为页名下的副标题', async () => {
    await page.viewport(1440, 900)
    mockPathname = '/scenarios'
    usePageHeadingStore.setState({ description: '把业务任务组织成有序步骤。' })
    await render(<AppBreadcrumb />)
    await expect.element(page.getByText('把业务任务组织成有序步骤。')).toBeVisible()
    usePageHeadingStore.setState({ description: null })
  })

  it('菜单页签路由「场景集运行」按所属菜单页显示页名', async () => {
    mockPathname = '/suite-runs'
    await render(<AppBreadcrumb />)
    await expect.element(page.getByText('运行记录', { exact: true })).toBeVisible()
    await expect.element(page.getByText('场景集运行', { exact: true })).not.toBeInTheDocument()
  })

  it('审计子页按所属菜单页显示页名', async () => {
    mockPathname = '/audit/logins'
    await render(<AppBreadcrumb />)
    await expect.element(page.getByText('审计日志', { exact: true })).toBeVisible()
    await expect.element(page.getByText('登录审计', { exact: true })).not.toBeInTheDocument()
  })

  it('详情页展示已注册的实体名与规范回链', async () => {
    mockPathname = '/runs/run-12345678'
    useBreadcrumbStore.getState().setEntity('run-12345678', { title: '巡检场景 #run-12345678' })
    await render(<AppBreadcrumb />)
    await expect.element(page.getByText('运行', { exact: true })).toBeVisible()
    expect(page.getByText('运行记录', { exact: true }).element()).toHaveAttribute('href', '/runs')
    await expect.element(page.getByText('巡检场景 #run-12345678')).toBeVisible()
  })

  it('目标知识地图展示为四段层级', async () => {
    mockPathname = '/targets/t-1/map'
    useBreadcrumbStore.getState().setEntity('t-1', { title: '生产CRM系统' })
    await render(<AppBreadcrumb />)
    await expect.element(page.getByText('目标', { exact: true })).toBeVisible()
    expect(page.getByText('目标系统', { exact: true }).element()).toHaveAttribute('href', '/targets')
    expect(page.getByText('生产CRM系统', { exact: true }).element()).toHaveAttribute('href', '/targets/t-1')
    await expect.element(page.getByText('目标知识', { exact: true })).toBeVisible()
  })

  it('当用户缺少父级权限时，父级仅显示为普通文本而不是链接', async () => {
    mockPathname = '/suite-runs'
    useAuthStore.setState((state) => ({
      auth: {
        ...state.auth,
        user: {
          id: 'u2',
          displayName: 'Restricted',
          email: null,
          roles: [],
          permissions: [], // 没有任何权限，包括 run:read
        },
        accessToken: 'mock',
      },
    }))
    await render(<AppBreadcrumb />)
    const runsItem = page.getByText('运行记录', { exact: true })
    await expect.element(runsItem).toBeVisible()
    expect(runsItem.element().tagName.toLowerCase()).toBe('span')
  })
})
