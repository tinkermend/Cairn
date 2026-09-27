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
  fetchActionModuleReferences: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  fetchActionModuleVersions: vi.fn().mockResolvedValue({ items: [] }),
  fetchActionModuleQuality: vi.fn().mockResolvedValue({ implementations: [] }),
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

  it('副作用上限按只读、可重入、有副作用显示对应状态色', async () => {
    const base = dummyList.items[0]!
    mocks.fetchActionModules.mockResolvedValue({
      ...dummyList,
      items: [
        { ...base, id: '11111111-1111-4111-8111-111111111111', effectCeiling: 'READ_ONLY' },
        { ...base, id: '11111111-1111-4111-8111-111111111112', effectCeiling: 'IDEMPOTENT' },
        { ...base, id: '11111111-1111-4111-8111-111111111113', effectCeiling: 'SIDE_EFFECT' },
      ],
      total: 3,
    })
    const screen = await renderPage()

    for (const [label, color] of [
      ['只读', 'bg-status-success-background'],
      ['可重入', 'bg-status-warning-background'],
      ['有副作用', 'bg-status-error-background'],
    ] as const) {
      const badge = screen.getByText(label, { exact: true })
      await expect.element(badge).toBeVisible()
      expect(badge.element().className).toContain(color)
    }
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

  it('渲染 CollectionSummary 指标卡与卡片工具栏', async () => {
    const screen = await renderPage()
    await expect.element(screen.getByText('本页模块')).toBeVisible()
    await expect.element(screen.getByText('已发布')).toBeVisible()
    await expect.element(screen.getByText('覆盖系统')).toBeVisible()
    await expect.element(screen.getByText('AI / 混编')).toBeVisible()
  })

  it('提供测试演练与查看调用方入口，点击展开引用分析抽屉', async () => {
    const screen = await renderPage()
    const refBtn = screen.getByRole('button', { name: '查看调用方（引用）' })
    await expect.element(refBtn).toBeVisible()
    await refBtn.click()

    await expect
      .element(screen.getByRole('heading', { name: '模块引用与调用方' }))
      .toBeVisible()
    await expect
      .element(screen.getByText('查看动作模块「订单查询」在各业务场景中的调用与引用版本。'))
      .toBeVisible()
  })
})
