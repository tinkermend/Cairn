import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { userEvent } from 'vitest/browser'
import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { TargetsPage } from './index'

vi.mock('@/components/layout/app-header', () => ({ AppHeader: () => null }))
vi.mock('./target-form-dialog', () => ({ TargetFormDialog: () => null }))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    params,
    children,
  }: {
    to: string
    params?: { targetId: string }
    children: ReactNode
  }) => (
    <a href={to.replace('$targetId', params?.targetId ?? '')}>{children}</a>
  ),
}))
vi.mock('@/lib/targets-api', () => ({
  deleteTarget: vi.fn(),
  previewDeleteTarget: vi.fn(async () => ({ previewToken: 'test', counts: {}, blockers: [] })),
  fetchTargets: async () => ({
    items: [
      {
        id: 'target-a',
        name: '智慧运维管理系统',
        code: 'operations',
        entryUrl: 'https://ops.example.test',
        authMethod: 'password',
        captchaMode: 'none',
        status: 'active',
        accountCount: 2,
        updatedAt: '2026-09-13T00:00:00Z',
      },
      {
        id: 'target-b',
        name: '供应链系统',
        code: 'supply',
        entryUrl: 'https://supply.example.test',
        authMethod: 'manual',
        captchaMode: 'image',
        status: 'active',
        accountCount: 4,
        updatedAt: '2026-09-13T00:00:00Z',
      },
    ],
  }),
}))

it('点击行内容或系统名称同步高亮、概览与详情入口；名称支持键盘选择', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const screen = await render(
    <QueryClientProvider client={client}>
      <TargetsPage />
    </QueryClientProvider>
  )
  await expect
    .element(screen.getByRole('heading', { name: '智慧运维管理系统' }))
    .toBeInTheDocument()
  const rows = screen.getByRole('row')
  const first = rows.nth(1).element()
  const second = rows.nth(2).element()
  const selectedColor = getComputedStyle(first).backgroundColor
  expect(getComputedStyle(second).backgroundColor).not.toBe(selectedColor)

  // 点击普通单元格内容，而不是行尾箭头，复现用户报告的操作。
  await screen.getByText('https://supply.example.test', { exact: true }).click()
  await expect
    .element(screen.getByRole('heading', { name: '供应链系统' }))
    .toBeInTheDocument()
  expect(second.getAttribute('data-state')).toBe('selected')
  expect(first.getAttribute('data-state')).not.toBe('selected')
  await expect
    .poll(() => getComputedStyle(second).backgroundColor)
    .toBe(selectedColor)
  await expect
    .element(screen.getByRole('link', { name: '管理系统与账号' }))
    .toHaveAttribute('href', '/targets/target-b')

  await screen
    .getByRole('button', { name: '智慧运维管理系统', exact: true })
    .click()
  await expect
    .element(screen.getByRole('heading', { name: '智慧运维管理系统' }))
    .toBeInTheDocument()
  const nameButton = screen.getByRole('button', {
    name: '供应链系统',
    exact: true,
  })
  ;(nameButton.element() as HTMLButtonElement).focus()
  await userEvent.keyboard('{Enter}')
  await expect.element(nameButton).toHaveAttribute('aria-pressed', 'true')
  await expect
    .element(screen.getByRole('heading', { name: '供应链系统' }))
    .toBeInTheDocument()
})
