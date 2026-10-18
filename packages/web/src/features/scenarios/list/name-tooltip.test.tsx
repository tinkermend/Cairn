import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ScenarioDto, ScenarioSummaryDto } from '@cairn/shared'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { ScenariosPage } from '../index'
import '@/styles/index.css'

const mocks = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  fetchScenarios: vi.fn(),
  fetchScenarioSummary: vi.fn(async (): Promise<ScenarioSummaryDto> => ({
    total: 1,
    byHealth: { failing: 0, warning: 0, running: 0, passing: 1, cancelled: 0, never: 0 },
  })),
  fetchTargets: vi.fn(async () => ({
    items: [{ id: 'target-1', name: '商城后台', iconKey: 'database', accentKey: 'amber' }],
    nextCursor: undefined,
  })),
  updateScenario: vi.fn(async () => ({})),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    getRouteApi: () => ({
      useSearch: () => mocks.search,
      useNavigate: () => vi.fn(),
    }),
    Link: ({
      children,
      to,
      ...rest
    }: {
      children?: React.ReactNode
      to: string
    } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
      ref?: React.Ref<HTMLAnchorElement>
    }) => (
      <a href={String(to)} {...rest}>
        {children}
      </a>
    ),
  }
})

vi.mock('@/lib/scenarios-api', () => ({
  fetchScenarios: mocks.fetchScenarios,
  fetchScenarioSummary: mocks.fetchScenarioSummary,
  previewDeleteScenario: vi.fn(),
  deleteScenario: vi.fn(),
  copyScenario: vi.fn(),
  updateScenario: mocks.updateScenario,
  createScenario: vi.fn(),
  fetchScenario: vi.fn(),
  fetchScenarioCapabilities: vi.fn(async () => ({})),
}))

vi.mock('@/lib/targets-api', () => ({
  fetchTargets: mocks.fetchTargets,
  fetchTarget: vi.fn(),
  fetchTargetAccounts: vi.fn(async () => ({ items: [], nextCursor: undefined })),
}))

vi.mock('@/features/assistant/use-assistant-context-binding', () => ({
  useAssistantContextBinding: vi.fn(),
}))

const ALL_PERMISSIONS = ['workflow:read', 'workflow:write', 'run:read', 'workflow:delete', 'target:read']

const LONG_NAME =
  '5G需求交付起租情况统计表-规则巡检-附加超长后缀用于验证名称截断后悬停能否弹出完整全文提示的回归用例'

function scenario(overrides: Partial<ScenarioDto> = {}): ScenarioDto {
  return {
    id: 'sc-1',
    targetId: 'target-1',
    name: LONG_NAME,
    status: 'active',
    purpose: 'user',
    latestVersionId: 'v-1',
    latestVersionNo: 3,
    stepCount: 8,
    draftDirty: false,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T02:00:00.000Z',
    ...overrides,
  }
}

async function renderPage(items: ScenarioDto[]) {
  mocks.fetchScenarios.mockResolvedValue({ items, nextCursor: undefined })
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ScenariosPage />
    </QueryClientProvider>,
  )
}

function signIn() {
  useAuthStore
    .getState()
    .auth.setUser({ id: 'u1', displayName: '测试工程师', email: null, roles: [], permissions: ALL_PERMISSIONS })
}

// 回归：截断的名称悬停必须弹全文。此前按截断与否切换树形状，React 重建锚点节点后
// ResizeObserver 对死节点报 0，把截断态清掉且不再恢复，tooltip 从此无法出现。
describe('场景名悬停全文', () => {
  beforeAll(() => {
    page.viewport(800, 900)
  })

  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
    mocks.search = {}
    vi.clearAllMocks()
    try {
      localStorage.removeItem('cairn:scenarios:view')
    } catch {
      // 浏览器存储不可用时不影响用例。
    }
  })

  it('网格视图：名称被截断时悬停显示全文', async () => {
    signIn()
    const screen = await renderPage([scenario()])
    const link = screen.getByRole('article', { name: LONG_NAME }).getByRole('link', { name: LONG_NAME })
    await expect.element(link).toBeInTheDocument()

    await userEvent.hover(link)
    const tooltip = screen.getByRole('tooltip')
    await expect.element(tooltip).toBeInTheDocument()
    await expect.element(tooltip).toHaveTextContent(LONG_NAME)
  })

  it('列表视图：名称被截断时悬停显示全文', async () => {
    signIn()
    mocks.search = { view: 'list' }
    const screen = await renderPage([scenario()])
    const link = screen.getByRole('link', { name: LONG_NAME })
    await expect.element(link).toBeInTheDocument()

    await userEvent.hover(link)
    const tooltip = screen.getByRole('tooltip')
    await expect.element(tooltip).toBeInTheDocument()
    await expect.element(tooltip).toHaveTextContent(LONG_NAME)
  })
})
