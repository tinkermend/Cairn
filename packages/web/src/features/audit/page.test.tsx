import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditListResponse, LoginAuditListResponse } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { AuditPage } from './page'

const mocks = vi.hoisted(() => ({
  fetchOperationAudit: vi.fn(),
  fetchLoginAudit: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@/lib/rbac-api', () => ({
  fetchOperationAudit: mocks.fetchOperationAudit,
  fetchLoginAudit: mocks.fetchLoginAudit,
}))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  }
})

const operations: AuditListResponse = {
  items: [
    {
      id: 'evt-1',
      action: 'account.create',
      resource: 'account',
      resourceId: 'acc-1',
      summary: '创建账号 审计员',
      actor: { id: 'acc-admin', displayName: '管理员', email: 'admin' },
      createdAt: '2026-09-13T04:00:00.000Z',
    },
  ],
}

const logins: LoginAuditListResponse = {
  items: [
    {
      id: 'login-1',
      loginIdentifier: 'admin',
      outcome: 'success',
      failureReason: null,
      actor: { id: 'acc-admin', displayName: '管理员', email: 'admin' },
      clientIp: '127.0.0.1',
      userAgent: 'Mozilla/5.0',
      clientKind: 'web',
      createdAt: '2026-09-13T04:00:00.000Z',
    },
  ],
}

function renderPage(pane: 'operations' | 'logins') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AuditPage pane={pane} />
    </QueryClientProvider>,
  )
}

function setUser(permissions: string[]) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '管理员',
    email: null,
    roles: [],
    permissions,
  })
}

describe('审计页', () => {
  beforeEach(() => {
    mocks.fetchOperationAudit.mockResolvedValue(operations)
    mocks.fetchLoginAudit.mockResolvedValue(logins)
  })

  afterEach(() => {
    vi.clearAllMocks()
    useAuthStore.getState().auth.reset()
  })

  it('同时有两项权限时用页签切换，点击登录记录会改路由', async () => {
    setUser(['audit:read', 'audit:login'])
    const screen = await renderPage('operations')
    await expect.element(screen.getByRole('heading', { name: '审计' })).toBeVisible()
    await expect.element(screen.getByRole('tab', { name: '操作记录' })).toBeVisible()
    await expect.element(screen.getByRole('tab', { name: '登录记录' })).toBeVisible()
    await expect.element(screen.getByText('创建账号 审计员')).toBeVisible()

    await screen.getByRole('tab', { name: '登录记录' }).click()
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/audit/logins' })
  })

  it('只有操作权限时不画孤单页签，也不出现登录记录', async () => {
    setUser(['audit:read'])
    const screen = await renderPage('operations')
    await expect.element(screen.getByRole('heading', { name: '审计' })).toBeVisible()
    await expect.element(screen.getByText('谁在控制台改了账号、权限、目标系统、场景或运行。')).toBeVisible()
    expect(screen.getByRole('tablist').query()).toBeNull()
    expect(screen.getByRole('tab', { name: '登录记录' }).query()).toBeNull()
    await expect.element(screen.getByText('创建账号 审计员')).toBeVisible()
  })

  it('只有登录权限时同样不画孤单页签', async () => {
    setUser(['audit:login'])
    const screen = await renderPage('logins')
    await expect.element(screen.getByRole('heading', { name: '审计' })).toBeVisible()
    expect(screen.getByRole('tablist').query()).toBeNull()
    expect(screen.getByRole('tab', { name: '操作记录' }).query()).toBeNull()
    await expect.element(screen.getByText('127.0.0.1')).toBeVisible()
  })
})
