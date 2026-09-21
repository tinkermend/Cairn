import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { userEvent } from 'vitest/browser'
import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { useAuthStore } from '@/stores/auth-store'
import { TargetsPage } from './index'

vi.mock('./target-form-dialog', () => ({ TargetFormDialog: () => null }))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string
    params?: Record<string, string>
    children: ReactNode
  } & Record<string, unknown>) => {
    let href = to
    if (params) {
      for (const [key, val] of Object.entries(params)) {
        href = href.replace(`$${key}`, val)
      }
    }
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    )
  },
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

vi.mock('@/lib/sessions-api', () => ({
  fetchSessionOverview: vi.fn(async ({ targetId }: { targetId?: string } = {}) => ({
    items:
      targetId === 'target-a'
        ? [
            {
              targetId: 'target-a',
              targetName: '智慧运维管理系统',
              targetAccountId: 'acc-1',
              accountDisplayName: '系统管理员',
              accountUsername: 'admin',
              accountStatus: 'active',
              status: 'ready',
              retained: false,
              sessionId: null,
              generation: null,
              instanceStatus: null,
              authState: null,
              identityState: null,
              observedTier: null,
              occupyingRunId: null,
              occupyingOperationId: null,
              retainUntil: null,
              lastAuthCheckedAt: null,
              lastAuthSuccessAt: null,
              ownerWorkerId: null,
              primaryAction: 'VERIFY_AUTH',
            },
            {
              targetId: 'target-a',
              targetName: '智慧运维管理系统',
              targetAccountId: 'acc-2',
              accountDisplayName: '值班员',
              accountUsername: 'operator',
              accountStatus: 'active',
              status: 'needs_login',
              retained: false,
              sessionId: null,
              generation: null,
              instanceStatus: null,
              authState: null,
              identityState: null,
              observedTier: null,
              occupyingRunId: null,
              occupyingOperationId: null,
              retainUntil: null,
              lastAuthCheckedAt: null,
              lastAuthSuccessAt: null,
              ownerWorkerId: null,
              primaryAction: 'LOGIN',
            },
          ]
        : [],
    nextCursor: null,
    summary: {
      total: targetId === 'target-a' ? 2 : 0,
      available: targetId === 'target-a' ? 1 : 0,
      needsCheck: 0,
      needsLogin: targetId === 'target-a' ? 1 : 0,
      identityMismatch: 0,
      maintenance: 0,
      executing: 0,
      lost: 0,
      unprepared: 0,
      retained: 0,
    },
    asOf: '2026-09-20T00:00:00Z',
  })),
  fetchSessionSystemOverview: vi.fn(async () => ({
    items: [
      {
        targetId: 'target-a',
        targetName: '智慧运维管理系统',
        targetCode: 'operations',
        targetStatus: 'active',
        accountTotal: 2,
        readyCount: 1,
        problemCount: 1,
        unpreparedCount: 0,
        busyCount: 0,
        retainedCount: 0,
        worstStatus: 'needs_login',
      },
      {
        targetId: 'target-b',
        targetName: '供应链系统',
        targetCode: 'supply',
        targetStatus: 'active',
        accountTotal: 4,
        readyCount: 4,
        problemCount: 0,
        unpreparedCount: 0,
        busyCount: 0,
        retainedCount: 0,
        worstStatus: 'ready',
      },
    ],
    nextCursor: null,
    summary: {
      systems: 2,
      readyAccounts: 5,
      problemAccounts: 1,
      unpreparedAccounts: 0,
    },
    asOf: '2026-09-20T00:00:00Z',
  })),
}))

vi.mock('@/lib/scenarios-api', () => ({
  fetchScenarios: vi.fn(async ({ targetId }: { targetId?: string } = {}) => ({
    items:
      targetId === 'target-a'
        ? [
            {
              id: 'scenario-1',
              targetId: 'target-a',
              name: '日常巡检与告警收集',
              status: 'active',
              stepsCount: 5,
              updatedAt: '2026-09-20T00:00:00Z',
            },
          ]
        : [],
    nextCursor: null,
  })),
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

it('数据表格右侧方向箭头直接提供跳转到对应系统详情页的链接', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const screen = await render(
    <QueryClientProvider client={client}>
      <TargetsPage />
    </QueryClientProvider>
  )

  const detailLinkA = screen.getByRole('link', { name: '查看智慧运维管理系统详情' })
  await expect.element(detailLinkA).toBeInTheDocument()
  await expect.element(detailLinkA).toHaveAttribute('href', '/targets/target-a')
  await expect.element(detailLinkA).toHaveAttribute('title', '查看智慧运维管理系统详情')

  const detailLinkB = screen.getByRole('link', { name: '查看供应链系统详情' })
  await expect.element(detailLinkB).toBeInTheDocument()
  await expect.element(detailLinkB).toHaveAttribute('href', '/targets/target-b')
  await expect.element(detailLinkB).toHaveAttribute('title', '查看供应链系统详情')
})

it('表格展示账号与会话综合状态，右侧概览窗提供免下钻即时诊断', async () => {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions: ['target:read', 'session:read', 'map:read'],
  })

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

  // 1. 表格表头为「账号 / 会话」，单元格展示综合就绪态
  await expect.element(screen.getByText('账号 / 会话')).toBeInTheDocument()
  await expect.element(screen.getByText('2 个 (1 待处理)')).toBeInTheDocument()
  await expect.element(screen.getByText('4 个 (全就绪)')).toBeInTheDocument()

  // 2. 右侧概览侧栏展示系统入口及快捷操作
  await expect.element(screen.getByLabelText('复制系统入口')).toBeInTheDocument()
  await expect.element(screen.getByLabelText('在新标签页打开系统入口')).toHaveAttribute('href', 'https://ops.example.test')

  // 3. 目标账号与会话健康度 Mini 列表
  await expect.element(screen.getByText('目标账号与会话')).toBeInTheDocument()
  await expect.element(screen.getByText('系统管理员')).toBeInTheDocument()
  await expect.element(screen.getByText('admin')).toBeInTheDocument()
  await expect.element(screen.getByText('就绪', { exact: true })).toBeInTheDocument()
  await expect.element(screen.getByText('值班员')).toBeInTheDocument()
  await expect.element(screen.getByText('operator')).toBeInTheDocument()
  await expect.element(screen.getByText('需要登录', { exact: true })).toBeInTheDocument()

  // 4. 关联业务场景预览
  await expect.element(screen.getByText('关联业务场景')).toBeInTheDocument()
  const scenarioLink = screen.getByRole('link', { name: '日常巡检与告警收集' })
  await expect.element(scenarioLink).toBeInTheDocument()
  await expect.element(scenarioLink).toHaveAttribute('href', '/scenarios/scenario-1')

  // 5. 维护会话与知识地图链接
  await expect.element(screen.getByRole('link', { name: '维护会话' })).toHaveAttribute('href', '/sessions/target-a')
  await expect.element(screen.getByRole('link', { name: '查看拓扑与元素' })).toHaveAttribute('href', '/targets/target-a/map')
})


