import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { page } from 'vitest/browser'
import { beforeEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { useAuthStore } from '@/stores/auth-store'
import { TargetsPage } from './index'

const mocks = vi.hoisted(() => ({
  fetchTarget: vi.fn(),
  fetchTargetOverview: vi.fn(),
  previewDeleteTarget: vi.fn(),
  deleteTarget: vi.fn(),
  navigate: vi.fn(),
}))

let routeSearch: Record<string, unknown> = { selected: 'target-a' }

vi.mock('./target-form-dialog', () => ({
  TargetFormDialog: ({ open, current }: { open: boolean; current?: { id: string; name: string; loginUrl?: string | null; loginFields?: { username?: { value: string } } } }) =>
    open ? <div data-testid='target-form-dialog' data-current-id={current?.id ?? 'new'} data-login-url={current?.loginUrl ?? ''} data-username-locator={current?.loginFields?.username?.value ?? ''}>目标系统表单</div> : null,
}))
vi.mock('@/lib/targets-api', () => ({
  fetchTarget: mocks.fetchTarget,
  fetchTargetOverview: mocks.fetchTargetOverview,
  previewDeleteTarget: mocks.previewDeleteTarget,
  deleteTarget: mocks.deleteTarget,
}))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  getRouteApi: () => ({ useSearch: () => routeSearch, useNavigate: () => mocks.navigate }),
  Link: ({ to, params, search, children, ...rest }: { to: string; params?: Record<string, string>; search?: Record<string, string>; children: ReactNode } & Record<string, unknown>) => {
    let href = to
    for (const [key, value] of Object.entries(params ?? {})) href = href.replace('$' + key, value)
    if (search) href += '?' + new URLSearchParams(search).toString()
    return <a href={href} {...rest}>{children}</a>
  },
}))

const available = <T,>(value: T) => ({ state: 'available' as const, value })
const forbidden = { state: 'forbidden' as const }

function item(id: string, name: string, options: { session?: boolean; ready?: boolean; needLogin?: boolean } = {}) {
  const session = options.session !== false
  return {
    target: { id, code: id, name, status: 'active', entryUrl: 'https://' + id + '.example.test', authMethod: 'password', captchaMode: 'none', iconKey: 'globe', accentKey: 'pine', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' },
    readiness: session ? available({ state: options.ready ? 'ready' : options.needLogin ? 'need_login' : 'unprepared', reason: options.needLogin ? '1 个账号需要人工登录' : '当前没有空闲登录会话', nextAction: { kind: options.needLogin ? 'handle_login' : 'manage_sessions', targetAccountId: options.needLogin ? 'account-a' : undefined } }) : forbidden,
    accounts: session ? available({ configuredTotal: 2, eligibleBusinessTotal: 2, readyAccounts: options.ready ? 1 : 0, needLoginAccounts: options.needLogin ? 1 : 0, attentionAccounts: options.needLogin ? 1 : 0, needsCheckAccounts: 0, identityMismatchAccounts: 0, lostAccounts: 0, unpreparedAccounts: 0, maintenanceAccounts: 0, occupiedAccounts: 0, preview: options.needLogin ? [{ targetAccountId: 'account-a', displayName: '值班员', status: 'needs_login', loginMode: 'manual', requiresHumanAuth: true, reason: '需要人工接管登录' }] : [], hiddenAttentionCount: 0 }) : forbidden,
    scenarios: available({ total: 138, active: 120 }),
    knowledge: { state: 'available' },
    runs: available({ running: 1 }),
    activities: available({ sources: ['run'], items: [{ source: 'run', kind: 'run_started', occurredAt: '2026-09-20T00:00:00Z', title: '日常巡检开始执行', runId: 'run-a' }] }),
  }
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    asOf: '2026-09-20T00:00:00Z',
    summary: { totalTargets: 26, readyTargets: { value: 11, coverage: 'partial', coveredTargets: 20 }, needLoginTargets: { value: 4, coverage: 'partial', coveredTargets: 20 }, runningTargets: { value: 3, coverage: 'complete', coveredTargets: 26 } },
    filteredTotal: 2,
    items: [item('target-a', '智慧运维管理系统', { ready: true, needLogin: true }), item('target-b', '供应链系统', { needLogin: true })],
    snapshotToken: 'snapshot-1',
    nextCursor: null,
    ...overrides,
  }
}

function signIn(permissions: string[]) {
  useAuthStore.getState().auth.setUser({ id: 'u1', displayName: '测试', email: null, roles: [], permissions })
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><TargetsPage /></QueryClientProvider>)
}

beforeEach(async () => {
  await page.viewport(1440, 900)
  routeSearch = { selected: 'target-a' }
  mocks.navigate.mockReset()
  mocks.fetchTarget.mockReset().mockResolvedValue({
    ...item('target-a', '智慧运维管理系统').target,
    loginUrl: 'https://target-a.example.test/login',
    loginFields: { username: { by: 'css', value: '#username' } },
    sensitiveSelectors: ['#password'],
    accountCount: 1,
  })
  mocks.fetchTargetOverview.mockReset().mockResolvedValue(response())
  signIn(['target:read', 'session:read', 'workflow:read', 'run:read', 'map:read'])
})

it('首屏展示全范围统计、权限覆盖、五列诊断与同源右栏', async () => {
  const screen = await mount()
  await expect.element(screen.getByRole('button', { name: /系统总数/ })).toHaveTextContent('26')
  await expect.element(screen.getByRole('region', { name: '运行概览' }).getByRole('button', { name: /空闲已登录/ })).toHaveTextContent('统计 20/26 个可见系统')
  for (const heading of ['系统', '运行准备', '目标账号', '关联场景', '最近活动']) await expect.element(screen.getByText(heading, { exact: true }).first()).toBeInTheDocument()
  await expect.element(screen.getByRole('heading', { name: '智慧运维管理系统' })).toBeInTheDocument()
  await expect.element(screen.getByText('138 个 · 120 启用')).toBeInTheDocument()
  await expect.element(screen.getByRole('meter', { name: '智慧运维管理系统已登录业务账号' })).toHaveAttribute('aria-valuenow', '1')
  await expect.element(screen.getByRole('link', { name: '处理登录' })).toHaveAttribute('href', '/sessions/target-a/account-a')
  await expect.element(screen.getByText('日常巡检开始执行').first()).toBeInTheDocument()
  await expect.element(screen.getByRole('link', { name: /关联场景/ })).toHaveAttribute('href', '/scenarios?targetId=target-a')
  await expect.element(screen.getByRole('link', { name: '知识记录' })).toHaveAttribute('href', '/targets/target-a/map?view=list')
  await expect.element(screen.getByRole('link', { name: '执行记录' })).toHaveAttribute('href', '/runs?targetId=target-a')
  expect(screen.getByRole('table').getByText('target-a').query()).toBeNull()
  expect(screen.getByText(/统计取自/).query()).toBeNull()
  expect(screen.getByText(/匹配 2 个系统/).query()).toBeNull()
  for (const oldControl of ['全部启停', '全部认证', '创建时间']) expect(screen.getByText(oldControl, { exact: true }).query()).toBeNull()
  expect(screen.getByRole('button', { name: '刷新' }).query()?.getAttribute('title')).toContain('数据更新于')
})

it('缺少会话权限时收起统计和预览，不把无权值显示成零', async () => {
  signIn(['target:read', 'workflow:read', 'run:read'])
  mocks.fetchTargetOverview.mockResolvedValue(response({
    summary: { totalTargets: 26, readyTargets: { value: null, coverage: 'forbidden', coveredTargets: 0 }, needLoginTargets: { value: null, coverage: 'forbidden', coveredTargets: 0 }, runningTargets: { value: 3, coverage: 'complete', coveredTargets: 26 } },
    items: [item('target-a', '智慧运维管理系统', { session: false })],
    filteredTotal: 1,
  }))
  const screen = await mount()
  await expect.element(screen.getByRole('heading', { name: '智慧运维管理系统' })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '运行概览' }).getByRole('button', { name: /空闲已登录/ }).query()).toBeNull()
  expect(screen.getByRole('region', { name: '运行概览' }).getByRole('button', { name: /需要登录/ }).query()).toBeNull()
  await expect.element(screen.getByText('无权限查看会话和目标账号状态。')).toBeInTheDocument()
  await expect.element(screen.getByRole('link', { name: '查看系统详情' })).toHaveAttribute('href', '/targets/target-a')
  await expect.element(screen.getByLabelText('搜索目标系统')).toHaveAttribute('placeholder', '搜索系统名称或编码')
})

it('当前系统不在写入范围时隐藏创建、添加账号和删除动作', async () => {
  signIn(['target:read', 'target:write', 'target:delete', 'run:delete', 'session:read', 'workflow:read', 'run:read'])
  useAuthStore.getState().auth.setUser({
    ...useAuthStore.getState().auth.user!,
    targetScopes: [
      { roleId: 'reader', mode: 'all', targetIds: [] },
      { roleId: 'operator', mode: 'selected', targetIds: ['target-b'] },
    ],
    targetScopePermissions: [
      { roleId: 'reader', permissions: ['target:read'] },
      { roleId: 'operator', permissions: ['target:write', 'target:delete', 'run:delete'] },
    ],
  })
  const target = item('target-a', '智慧运维管理系统', { ready: true })
  mocks.fetchTargetOverview.mockResolvedValue(response({
    items: [{
      ...target,
      readiness: available({ state: 'unprepared', reason: '需要准备账号', nextAction: { kind: 'view_conditions' } }),
    }],
    filteredTotal: 1,
  }))

  const screen = await mount()
  await expect.element(screen.getByRole('heading', { name: '智慧运维管理系统' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '新建系统' }).query()).toBeNull()
  expect(screen.getByRole('button', { name: '删除' }).query()).toBeNull()
  await screen.getByRole('button', { name: '查看运行条件' }).click()
  expect(screen.getByRole('link', { name: '添加业务账号' }).query()).toBeNull()
})

it('点击概览卡清空互斥条件，并把筛选写入 URL', async () => {
  routeSearch = { selected: 'target-a', q: '旧词', filter: 'all', page: 3 }
  const screen = await mount()
  await screen.getByRole('region', { name: '运行概览' }).getByRole('button', { name: /需要登录/ }).click()
  const last = mocks.navigate.mock.calls[mocks.navigate.mock.calls.length - 1]?.[0] as { search: (previous: Record<string, unknown>) => Record<string, unknown> }
  expect(last.search(routeSearch)).toMatchObject({ filter: 'need_login', q: undefined, page: 1, selected: 'target-a' })
})

it('点击表头先对完整结果排序再分页，不重新请求概览', async () => {
  routeSearch = { selected: 'target-b-01', pageSize: 10 }
  const items = Array.from({ length: 20 }, (_, index) => item('target-b-' + String(index + 1).padStart(2, '0'), 'B系统' + String(index + 1).padStart(2, '0')))
  items.push(item('target-a', 'A系统', { ready: true }))
  mocks.fetchTargetOverview.mockResolvedValue(response({ items, filteredTotal: 21 }))
  mocks.navigate.mockImplementation((options: { search: (previous: Record<string, unknown>) => Record<string, unknown> }) => {
    routeSearch = options.search(routeSearch)
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const screen = await render(<QueryClientProvider client={client}><TargetsPage /></QueryClientProvider>)
  const table = screen.getByRole('table')
  await expect.element(table.getByRole('row').nth(1).getByRole('button', { name: 'B系统01' })).toBeInTheDocument()
  await table.getByRole('button', { name: '按系统名称排序' }).click()
  await screen.rerender(<QueryClientProvider client={client}><TargetsPage /></QueryClientProvider>)
  await expect.element(table.getByRole('row').nth(1).getByRole('button', { name: 'A系统' })).toBeInTheDocument()
  expect(document.querySelector('.target-col-system')?.getAttribute('aria-sort')).toBe('ascending')
  expect(mocks.fetchTargetOverview).toHaveBeenCalledTimes(1)
  await table.getByRole('button', { name: '按系统名称排序' }).click()
  await screen.rerender(<QueryClientProvider client={client}><TargetsPage /></QueryClientProvider>)
  await expect.element(table.getByRole('row').nth(1).getByRole('button', { name: 'B系统20' })).toBeInTheDocument()
  expect(document.querySelector('.target-col-system')?.getAttribute('aria-sort')).toBe('descending')
  await table.getByRole('button', { name: '按系统名称排序' }).click()
  await screen.rerender(<QueryClientProvider client={client}><TargetsPage /></QueryClientProvider>)
  expect(document.querySelector('.target-col-system')?.getAttribute('aria-sort')).toBe('ascending')
  await table.getByRole('button', { name: '按已登录账号数排序' }).click()
  await screen.rerender(<QueryClientProvider client={client}><TargetsPage /></QueryClientProvider>)
  await expect.element(table.getByRole('row').nth(1).getByRole('button', { name: 'A系统' })).toBeInTheDocument()
  expect(document.querySelector('.target-col-accounts')?.getAttribute('aria-sort')).toBe('descending')
  expect(mocks.fetchTargetOverview).toHaveBeenCalledTimes(1)
})

it('旧启停和认证参数不产生看不见的筛选条件', async () => {
  routeSearch = { selected: 'target-a', status: 'disabled', authMethod: 'manual' }
  const screen = await mount()
  await expect.element(screen.getByRole('heading', { name: '智慧运维管理系统' })).toBeInTheDocument()
  expect(mocks.fetchTargetOverview).toHaveBeenCalledWith({ search: undefined, filter: 'all' })
  expect(screen.getByText('全部启停', { exact: true }).query()).toBeNull()
})

it('初次无选中项时自动选首行', async () => {
  routeSearch = {}
  const screen = await mount()
  await expect.element(screen.getByRole('button', { name: '智慧运维管理系统' })).toBeInTheDocument()
  await vi.waitFor(() => {
    const automaticSelection = mocks.navigate.mock.calls.find(([options]) => {
      const patch = (options as { search: (previous: Record<string, unknown>) => Record<string, unknown> }).search(routeSearch)
      return patch.selected === 'target-a'
    })
    expect(automaticSelection).toBeDefined()
  })
})

it('选中项被筛选排除后清除 URL 选择并提示重选', async () => {
  routeSearch = { selected: 'target-a', filter: 'ready' }
  mocks.fetchTargetOverview.mockResolvedValue(response({ items: [item('target-b', '供应链系统')], filteredTotal: 1 }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const screen = await render(<QueryClientProvider client={client}><TargetsPage /></QueryClientProvider>)
  await expect.element(screen.getByText('选中的系统不在当前结果中，请重新选择。')).toBeInTheDocument()
  await vi.waitFor(() => {
    const clearSelection = mocks.navigate.mock.calls.find(([options]) => {
      const patch = (options as { search: (previous: Record<string, unknown>) => Record<string, unknown> }).search(routeSearch)
      return patch.selected === undefined
    })
    expect(clearSelection).toBeDefined()
  })
  mocks.navigate.mockClear()
  routeSearch = { filter: 'ready' }
  await screen.rerender(<QueryClientProvider client={client}><TargetsPage /></QueryClientProvider>)
  await expect.element(screen.getByText('选中的系统不在当前结果中，请重新选择。')).toBeInTheDocument()
  expect(mocks.navigate).not.toHaveBeenCalled()
})

it('宽屏点系统名只切换选择，窄栏点名称或行会打开 Sheet 并恢复焦点', async () => {
  mocks.navigate.mockImplementation((options: { search: (previous: Record<string, unknown>) => Record<string, unknown> }) => {
    routeSearch = options.search(routeSearch)
  })
  const screen = await mount()
  await screen.getByRole('button', { name: '供应链系统' }).click()
  expect(screen.getByRole('dialog').query()).toBeNull()
  expect(routeSearch.selected).toBe('target-b')

  await page.viewport(1024, 768)
  const nameButton = screen.getByRole('button', { name: '智慧运维管理系统', exact: true })
  await nameButton.click()
  await expect.element(screen.getByRole('dialog').getByRole('heading', { name: '智慧运维管理系统' })).toBeInTheDocument()
  await screen.getByRole('dialog').getByRole('button', { name: '关闭' }).click()
  await expect.element(nameButton).toHaveFocus()

  await screen.getByRole('row', { name: /供应链系统/ }).getByRole('cell').nth(1).click()
  await expect.element(screen.getByRole('dialog').getByRole('heading', { name: '供应链系统' })).toBeInTheDocument()
  await screen.getByRole('dialog').getByRole('button', { name: '关闭' }).click()
  await expect.element(screen.getByRole('button', { name: '供应链系统', exact: true })).toHaveFocus()
})

it('390px 且无会话权限时仍显示系统启停状态', async () => {
  await page.viewport(390, 844)
  signIn(['target:read', 'workflow:read', 'run:read'])
  mocks.fetchTargetOverview.mockResolvedValue(response({
    summary: { totalTargets: 26, readyTargets: { value: null, coverage: 'forbidden', coveredTargets: 0 }, needLoginTargets: { value: null, coverage: 'forbidden', coveredTargets: 0 }, runningTargets: { value: 3, coverage: 'complete', coveredTargets: 26 } },
    items: [item('target-a', '智慧运维管理系统', { session: false })],
    filteredTotal: 1,
  }))
  const screen = await mount()
  await expect.element(screen.getByRole('table').getByText('启用', { exact: true })).toBeVisible()
})

it('窄屏折叠次要列后，可在预览 Sheet 查看账号与关联资产', async () => {
  await page.viewport(390, 844)
  const screen = await mount()
  const previewButton = screen.getByRole('button', { name: '预览智慧运维管理系统' })
  await previewButton.click()
  await expect.element(screen.getByRole('dialog')).toBeInTheDocument()
  await expect.element(screen.getByRole('dialog').getByText('目标账号')).toBeInTheDocument()
  await expect.element(screen.getByRole('dialog').getByText('值班员')).toBeInTheDocument()
  await expect.element(screen.getByRole('dialog').getByRole('link', { name: /关联场景/ })).toHaveAttribute('href', '/scenarios?targetId=target-a')
  await screen.getByRole('dialog').getByRole('button', { name: '关闭' }).click()
  await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument()
  await expect.element(previewButton).toHaveFocus()
})

it('有写入权限时右侧卡片头部展示编辑和详情入口，点击编辑就地呼出弹窗', async () => {
  useAuthStore.getState().auth.setUser({
    id: 'u1', displayName: '测试', email: null, roles: [],
    permissions: ['target:read', 'target:write', 'session:read', 'workflow:read', 'run:read'],
    targetScopes: [{ roleId: 'admin', mode: 'all', targetIds: [] }],
    targetScopePermissions: [{ roleId: 'admin', permissions: ['target:read', 'target:write', 'session:read', 'workflow:read', 'run:read'] }],
  })
  const screen = await mount()
  const detailLink = screen.getByRole('complementary', { name: '系统概览' }).getByRole('link', { name: '详情', exact: true })
  await expect.element(detailLink).toHaveAttribute('href', '/targets/target-a')

  const editButton = screen.getByRole('complementary', { name: '系统概览' }).getByRole('button', { name: '编辑', exact: true })
  await expect.element(editButton).toBeInTheDocument()
  await editButton.click()

  const dialog = screen.getByTestId('target-form-dialog')
  await expect.element(dialog).toBeInTheDocument()
  await expect.element(dialog).toHaveAttribute('data-current-id', 'target-a')
  await expect.element(dialog).toHaveAttribute('data-login-url', 'https://target-a.example.test/login')
  await expect.element(dialog).toHaveAttribute('data-username-locator', '#username')
  expect(mocks.fetchTarget).toHaveBeenCalledWith('target-a')
})
