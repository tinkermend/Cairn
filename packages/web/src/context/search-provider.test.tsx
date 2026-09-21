import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, type RenderResult } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { PERMISSIONS, SYSTEM_ROLE_DEFINITIONS } from '@cairn/shared'
import { SearchProvider } from '@/context/search-provider'
import { useAuthStore } from '@/stores/auth-store'

const COMMAND_MENU_PLACEHOLDER = '搜索场景、运行、目标或页面'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  fetchScenarios: vi.fn(),
  fetchRuns: vi.fn(),
  fetchTargets: vi.fn(),
}))

vi.mock('@/lib/scenarios-api', () => ({ fetchScenarios: mocks.fetchScenarios }))
vi.mock('@/lib/runs-api', () => ({ fetchRuns: mocks.fetchRuns }))
vi.mock('@/lib/targets-api', () => ({ fetchTargets: mocks.fetchTargets }))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  }
})

type ShortcutModifier = 'Control' | 'Meta'

async function renderWithSearchProvider() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return await render(
    <QueryClientProvider client={client}>
      <SearchProvider>{null}</SearchProvider>
    </QueryClientProvider>
  )
}

/**
 * Open the palette by shortcut, retrying while the keydown listener may not be mounted yet.
 * Waits between attempts so a successful toggle is not immediately undone by a second chord.
 */
async function openCommandPalette(
  screen: RenderResult,
  modifier: ShortcutModifier = 'Control'
) {
  await vi.waitFor(
    async () => {
      const isCommandPaletteOpen =
        document.querySelector(
          `[placeholder="${COMMAND_MENU_PLACEHOLDER}"]`
        ) !== null

      if (!isCommandPaletteOpen) {
        await userEvent.keyboard(`{${modifier}>}k{/${modifier}}`)
      }

      await expect
        .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
        .toBeInTheDocument()
    },
    { interval: 50, timeout: 5000 }
  )
}

function signIn(permissions: readonly string[]) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions: [...permissions],
  })
}

describe('SearchProvider and CommandMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.getState().auth.reset()
    mocks.fetchScenarios.mockResolvedValue({ items: [] })
    mocks.fetchRuns.mockResolvedValue({ items: [] })
    mocks.fetchTargets.mockResolvedValue({ items: [] })
  })

  it('renders the command palette when the palette is open', async () => {
    const screen = await renderWithSearchProvider()
    const { getByPlaceholder, getByText } = screen

    await openCommandPalette(screen)

    await expect
      .element(getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .toBeInTheDocument()
    await expect.element(getByText('总览')).toBeInTheDocument()
  })

  it('does not show the dialog content when search is closed', async () => {
    const { getByPlaceholder } = await renderWithSearchProvider()

    await expect
      .element(getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .not.toBeInTheDocument()
  })

  it.each([
    ['Ctrl', 'Control'],
    ['Cmd', 'Meta'],
  ] as const)(
    'opens the command menu when %s + K is pressed',
    async (_label, modifier) => {
      const screen = await renderWithSearchProvider()

      await expect
        .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
        .not.toBeInTheDocument()

      await openCommandPalette(screen, modifier)

      await expect
        .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
        .toBeInTheDocument()
    }
  )

  it('navigates to a top-level route and closes the palette when a nav item is selected', async () => {
    signIn([...PERMISSIONS])
    const screen = await renderWithSearchProvider()

    await openCommandPalette(screen)

    await userEvent.click(screen.getByRole('option', { name: '用户管理' }))

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/users' })
    await expect
      .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .not.toBeInTheDocument()
  })

  it('navigates for nested sidebar items (group with sub-items)', async () => {
    signIn(['settings:read'])
    const screen = await renderWithSearchProvider()
    const { getByPlaceholder, getByRole } = screen

    await openCommandPalette(screen)

    await userEvent.fill(getByPlaceholder(COMMAND_MENU_PLACEHOLDER), '修改密码')
    await userEvent.click(getByRole('option', { name: '个人设置 修改密码' }))

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/settings/account' })
    await expect
      .element(getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .not.toBeInTheDocument()
  })

  it('执行者看不到治理入口', async () => {
    signIn(SYSTEM_ROLE_DEFINITIONS.operator.permissions)
    const screen = await renderWithSearchProvider()

    await openCommandPalette(screen)

    await expect.element(screen.getByRole('option', { name: '运行记录', exact: true })).toBeInTheDocument()
    await expect.element(screen.getByRole('option', { name: '结果与报告', exact: true })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '用户管理' }).elements()).toHaveLength(0)
    expect(screen.getByRole('option', { name: '录制草稿' }).elements()).toHaveLength(0)
  })

  it('按中文名称搜索个人资料，移到账户菜单后仍可直接进入', async () => {
    signIn(['settings:read'])
    const screen = await renderWithSearchProvider()
    await openCommandPalette(screen)
    await userEvent.fill(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER), '个人资料')
    await userEvent.click(screen.getByRole('option', { name: '个人设置 个人资料' }))
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/settings' })
  })

  it('个人入口保留权限过滤，并移除没有可设置项的外观入口', async () => {
    signIn([])
    const screen = await renderWithSearchProvider()
    await openCommandPalette(screen)
    expect(screen.getByRole('option', { name: /个人设置|外观/ }).elements()).toHaveLength(0)
    signIn(['settings:read'])
    await expect.element(screen.getByRole('option', { name: '个人设置 个人资料' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /外观/ }).elements()).toHaveLength(0)
  })

  it('shows empty state when the filter matches nothing', async () => {
    const screen = await renderWithSearchProvider()

    await openCommandPalette(screen)

    await userEvent.fill(
      screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER),
      'zzzz-no-match-xxxx'
    )

    await expect
      .element(screen.getByText('没有叫这个名字的页面、场景、运行或目标。'))
      .toBeInTheDocument()
  })

  it('输入场景名出现场景行并进入工作区', async () => {
    signIn([...PERMISSIONS])
    mocks.fetchScenarios.mockResolvedValue({
      items: [{ id: 'scenario-1', name: '订单对账', targetId: 't1', status: 'active', draftDirty: true }],
    })
    const screen = await renderWithSearchProvider()
    await openCommandPalette(screen)
    await userEvent.fill(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER), '订单')
    await vi.waitFor(() =>
      expect(mocks.fetchScenarios).toHaveBeenCalledWith({ search: '订单', limit: 5 })
    )
    await userEvent.click(screen.getByRole('option', { name: /订单对账/ }))
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/scenarios/$scenarioId',
      params: { scenarioId: 'scenario-1' },
    })
  })

  it('按目标编码命中的行不会被客户端过滤掉', async () => {
    signIn([...PERMISSIONS])
    mocks.fetchTargets.mockResolvedValue({
      items: [{ id: 'target-1', name: '财务系统', code: 'FIN-01' }],
    })
    const screen = await renderWithSearchProvider()
    await openCommandPalette(screen)
    await userEvent.fill(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER), 'FIN')
    await vi.waitFor(() =>
      expect(mocks.fetchTargets).toHaveBeenCalledWith({ search: 'FIN', limit: 5 })
    )
    await userEvent.click(screen.getByRole('option', { name: /财务系统/ }))
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/targets/$targetId',
      params: { targetId: 'target-1' },
    })
  })

  it('运行行带目标、状态与时间，可进入复盘', async () => {
    signIn([...PERMISSIONS])
    mocks.fetchRuns.mockResolvedValue({
      items: [
        {
          id: 'run-1',
          status: 'SUCCEEDED',
          scenarioName: '订单对账',
          targetName: '财务系统',
          createdAt: '2026-09-20T01:02:03.000Z',
        },
      ],
    })
    const screen = await renderWithSearchProvider()
    await openCommandPalette(screen)
    await userEvent.fill(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER), '订单')
    await vi.waitFor(() => expect(mocks.fetchRuns).toHaveBeenCalledWith({ search: '订单', limit: 5 }))
    const row = screen.getByRole('option', { name: /财务系统/ })
    await expect.element(row).toBeInTheDocument()
    expect(row.element().textContent).toContain('2026')
    await userEvent.click(row)
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/runs/$runId', params: { runId: 'run-1' } })
  })

  it('单字不查对象；无运行读权限时不请求运行', async () => {
    signIn(['workflow:read', 'target:read'])
    const screen = await renderWithSearchProvider()
    await openCommandPalette(screen)
    await userEvent.fill(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER), '订')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(mocks.fetchScenarios).not.toHaveBeenCalled()
    await userEvent.fill(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER), '订单')
    await vi.waitFor(() => expect(mocks.fetchScenarios).toHaveBeenCalledTimes(1))
    expect(mocks.fetchRuns).not.toHaveBeenCalled()
  })
})
