import '@/styles/index.css'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { PageHeader } from './page-header'
import { usePageHeadingStore } from '@/stores/page-heading-store'

let mockPathname: string | null = '/scenarios'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) => select({ location: { pathname: mockPathname ?? '/', search: {} } }),
  useRouter: () =>
    mockPathname === null ? undefined : { state: { location: { pathname: mockPathname } } },
}))

describe('PageHeader', () => {
  it('一级菜单页：标题交给顶栏，页内只保留读屏标题，描述与操作成为首行', async () => {
    mockPathname = '/scenarios'
    await render(
      <PageHeader title='场景编排' description='把业务任务组织成有序步骤。' actions={<button type='button'>新建场景</button>} />,
    )
    const heading = page.getByRole('heading', { level: 1, name: '场景编排' })
    expect(heading.element().classList.contains('sr-only')).toBe(true)
    await expect.element(page.getByText('把业务任务组织成有序步骤。')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '新建场景' })).toBeVisible()
  })

  it('一级菜单页没有描述和操作时只渲染读屏标题，不留空白行', async () => {
    mockPathname = '/schedules'
    const { container } = await render(<PageHeader title='定时任务' />)
    expect(container.children).toHaveLength(1)
    expect(container.firstElementChild?.tagName).toBe('H1')
    expect(container.firstElementChild?.classList.contains('sr-only')).toBe(true)
  })

  it('子页面与带 parent 的页面保留页内大标题', async () => {
    mockPathname = '/scenarios/abc'
    await render(<PageHeader title='场景详情' />)
    const heading = page.getByRole('heading', { level: 1, name: '场景详情' })
    expect(heading.element().classList.contains('sr-only')).toBe(false)
  })

  it('脱离路由渲染时按普通页处理', async () => {
    mockPathname = null
    await render(<PageHeader title='样本页' />)
    const heading = page.getByRole('heading', { level: 1, name: '样本页' })
    expect(heading.element().classList.contains('sr-only')).toBe(false)
  })

  it('一级菜单页把描述登记给顶栏，卸载时清空；子页面不登记', async () => {
    mockPathname = '/scenarios'
    const { unmount } = await render(<PageHeader title='场景编排' description='把业务任务组织成有序步骤。' />)
    expect(usePageHeadingStore.getState().description).toBe('把业务任务组织成有序步骤。')
    unmount()
    expect(usePageHeadingStore.getState().description).toBeNull()

    mockPathname = '/scenarios/abc'
    await render(<PageHeader title='场景详情' description='详情描述' />)
    expect(usePageHeadingStore.getState().description).toBeNull()
  })
})
