import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PERMISSIONS } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { ThemeProvider } from '@/context/theme-provider'
import { SessionsPage } from './index'

const mocks = vi.hoisted(() => ({
  fetchSessionOverview: vi.fn(),
  requestAccountSessionOperation: vi.fn(),
}))

vi.mock('@/components/layout/app-header', () => ({ AppHeader: () => null }))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  }
})
vi.mock('./use-session-observation', () => ({ useSessionObservation: () => ({ connected: true, eventSeq: 1 }) }))
vi.mock('@/lib/sessions-api', () => ({
  fetchSessionOverview: mocks.fetchSessionOverview,
  requestAccountSessionOperation: mocks.requestAccountSessionOperation,
  newSessionIdempotencyKey: () => 'session-PREPARE-test-key',
}))

function signIn() {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions: [...PERMISSIONS],
  })
}

describe('SessionsPage', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    sessionStorage.clear()
    await page.viewport(1440, 900)
    signIn()
    mocks.fetchSessionOverview.mockResolvedValue({
      items: [
        {
          targetId: '11111111-1111-4111-8111-111111111111',
          targetName: '演示系统',
          targetAccountId: '22222222-2222-4222-8222-222222222222',
          accountDisplayName: '值班',
          accountUsername: 'ops',
          accountStatus: 'active',
          status: 'unprepared',
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
          primaryAction: 'PREPARE',
        },
      ],
      summary: {
        total: 1,
        available: 0,
        needsCheck: 0,
        needsLogin: 0,
        identityMismatch: 0,
        maintenance: 0,
        executing: 0,
        lost: 0,
        unprepared: 1,
        retained: 0,
      },
      asOf: '2026-09-16T00:00:00.000Z',
    })
  })

  it('按账号展示未准备状态与准备会话', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <SessionsPage />
        </QueryClientProvider>
      </ThemeProvider>,
    )
    await expect.element(screen.getByText('演示系统')).toBeInTheDocument()
    await expect.element(screen.getByRole('cell', { name: /未准备/ })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '准备会话' })).toBeInTheDocument()
  })
})
