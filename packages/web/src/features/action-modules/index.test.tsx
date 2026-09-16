import type { ReactNode, ComponentProps } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import type { ModuleListResponse } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { SidebarProvider } from '@/components/ui/sidebar'
import { ActionModulesPage } from './index'

const mocks = vi.hoisted(() => ({
  fetchActionModules: vi.fn(),
  fetchTargets: vi.fn(),
  useNavigate: vi.fn(),
}))

vi.mock('@/lib/action-modules-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/action-modules-api')>()),
  fetchActionModules: mocks.fetchActionModules,
  deleteActionModule: vi.fn(),
  createActionModule: vi.fn(),
}))
vi.mock('@/lib/targets-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/targets-api')>()),
  fetchTargets: mocks.fetchTargets,
}))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mocks.useNavigate,
  Link: ({ children, ...props }: ComponentProps<'a'>) => (
    <a {...props}>{children}</a>
  ),
}))
vi.mock('@/hooks/use-permissions', () => ({
  useCan: () => true,
}))
vi.mock('@/components/rbac/can', () => ({
  Can: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/layout/app-header', () => ({
  AppHeader: () => null,
}))

const dummyList: ModuleListResponse = {
  items: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      targetId: '22222222-2222-4222-8222-222222222222',
      key: 'order.query',
      name: '订单查询',
      description: '查询订单详情',
      capabilityKey: 'order',
      executionMode: 'DETERMINISTIC',
      effectCeiling: 'READ_ONLY',
      latestVersionNo: 1,
      latestVersionPublishedAt: '2026-09-16T00:00:00.000Z',
      publicationStatus: 'published',
      tags: ['order'],
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
}

async function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <ActionModulesPage />
      </SidebarProvider>
    </QueryClientProvider>
  )
}

describe('ActionModulesPage', () => {
  beforeEach(async () => {
    await page.viewport(390, 844)
    vi.clearAllMocks()
    mocks.fetchTargets.mockResolvedValue({ items: [] })
    mocks.fetchActionModules.mockResolvedValue(dummyList)
  })

  it('渲染动作库页面标题与模块列表行', async () => {
    const screen = await renderPage()
    await expect
      .element(screen.getByRole('heading', { name: '动作库' }))
      .toBeInTheDocument()
    await expect.element(screen.getByText('订单查询')).toBeInTheDocument()
    await expect.element(screen.getByText('order.query')).toBeInTheDocument()
    await expect.element(screen.getByText('健康')).toBeInTheDocument()
    await expect.element(screen.getByText('样本不足')).toBeInTheDocument()
  })
  it('服务器分页与筛选参数，筛选后回到第一页', async () => {
    mocks.fetchActionModules.mockResolvedValue({ ...dummyList, total: 42 })
    const screen = await renderPage()
    await expect
      .element(screen.getByRole('button', { name: '下一页' }))
      .toBeEnabled()
    await screen.getByRole('button', { name: '下一页' }).click()
    await expect
      .poll(() => mocks.fetchActionModules.mock.lastCall?.[0].page)
      .toBe(2)
    await screen.getByLabelText('筛选能力键').fill('order')
    await screen.getByLabelText('筛选标签').fill('core')
    await expect
      .poll(() => mocks.fetchActionModules.mock.lastCall?.[0])
      .toMatchObject({
        page: 1,
        pageSize: 20,
        capabilityKey: 'order',
        tag: 'core',
      })
    await expect
      .element(screen.getByRole('button', { name: '新建动作模块' }))
      .toBeVisible()
  })
})
