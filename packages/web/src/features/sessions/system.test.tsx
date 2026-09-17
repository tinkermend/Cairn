import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PERMISSIONS } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { ThemeProvider } from '@/context/theme-provider'
import { SessionSystemPage } from './system'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'
const READY_ID = '33333333-3333-4333-8333-333333333333'
const LOST_ID = '44444444-4444-4444-8444-444444444444'
const SESSION_ID = '55555555-5555-4555-8555-555555555555'
const LOST_SESSION_ID = '66666666-6666-4666-8666-666666666666'
const BUSY_ID = '77777777-7777-4777-8777-777777777777'

const mocks = vi.hoisted(() => ({
  fetchTarget: vi.fn(),
  fetchSessionOverview: vi.fn(),
  requestAccountSessionOperation: vi.fn(),
  disposeWorkerSession: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
    getRouteApi: () => ({
      useParams: () => ({ targetId: TARGET_ID }),
    }),
    Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  }
})
vi.mock('./use-session-observation', () => ({ useSessionObservation: () => ({ connected: true, eventSeq: 1 }) }))
vi.mock('@/lib/targets-api', () => ({ fetchTarget: mocks.fetchTarget }))
vi.mock('@/lib/sessions-api', () => ({
  fetchSessionOverview: mocks.fetchSessionOverview,
  requestAccountSessionOperation: mocks.requestAccountSessionOperation,
  newSessionIdempotencyKey: (kind: string) => `session-${kind}-test-key`,
}))
vi.mock('@/lib/workers-api', () => ({ disposeWorkerSession: mocks.disposeWorkerSession }))

function signIn(permissions: string[] = [...PERMISSIONS]) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions,
  })
}

function account(input: {
  id: string
  name: string
  username: string
  status: 'unprepared' | 'ready' | 'lost' | 'maintenance'
  sessionId: string | null
  generation: number | null
  primaryAction: string
}) {
  return {
    targetId: TARGET_ID,
    targetName: '演示系统',
    targetAccountId: input.id,
    accountDisplayName: input.name,
    accountUsername: input.username,
    accountStatus: 'active',
    status: input.status,
    retained: false,
    sessionId: input.sessionId,
    generation: input.generation,
    instanceStatus: input.sessionId ? 'OPEN' : null,
    authState: input.status === 'ready' ? 'AUTHENTICATED' : null,
    identityState: input.status === 'ready' ? 'MATCH' : null,
    observedTier: null,
    occupyingRunId: null,
    occupyingOperationId: null,
    retainUntil: null,
    lastAuthCheckedAt: null,
    lastAuthSuccessAt: null,
    ownerWorkerId: null,
    primaryAction: input.primaryAction,
  }
}

describe('SessionSystemPage', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    sessionStorage.clear()
    await page.viewport(1440, 900)
    signIn()
    mocks.fetchTarget.mockResolvedValue({
      id: TARGET_ID,
      name: '演示系统',
      code: 'demo',
      status: 'active',
    })
    mocks.fetchSessionOverview.mockResolvedValue({
      items: [
        account({
          id: ACCOUNT_ID,
          name: '值班',
          username: 'ops',
          status: 'unprepared',
          sessionId: null,
          generation: null,
          primaryAction: 'PREPARE',
        }),
        account({
          id: READY_ID,
          name: '就绪账号',
          username: 'ready',
          status: 'ready',
          sessionId: SESSION_ID,
          generation: 1,
          primaryAction: 'VERIFY_AUTH',
        }),
        account({
          id: LOST_ID,
          name: '失联账号',
          username: 'lost',
          status: 'lost',
          sessionId: LOST_SESSION_ID,
          generation: 2,
          primaryAction: 'dispose',
        }),
        account({
          id: BUSY_ID,
          name: '占用账号',
          username: 'busy',
          status: 'maintenance',
          sessionId: SESSION_ID,
          generation: 1,
          primaryAction: 'view',
        }),
      ],
      summary: {
        total: 4,
        available: 1,
        needsCheck: 0,
        needsLogin: 0,
        identityMismatch: 0,
        maintenance: 1,
        executing: 0,
        lost: 1,
        unprepared: 1,
        retained: 0,
      },
      asOf: '2026-09-17T00:00:00.000Z',
    })
    mocks.requestAccountSessionOperation.mockResolvedValue({
      operationId: 'op',
      reusedRunId: null,
      created: true,
    })
    mocks.disposeWorkerSession.mockResolvedValue({ id: LOST_SESSION_ID })
  })

  it('用目标详情作标题，未准备不出现关闭，查看与处置可点', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <SessionSystemPage />
        </QueryClientProvider>
      </ThemeProvider>,
    )
    await expect.element(screen.getByRole('heading', { name: '演示系统' })).toBeInTheDocument()
    await expect.element(screen.getByText(/1 就绪 · 1 有问题 · 1 未准备 · 1 占用中/)).toBeInTheDocument()
    expect(mocks.fetchSessionOverview).toHaveBeenCalledWith({
      targetId: TARGET_ID,
      search: undefined,
      filter: undefined,
      limit: 20,
      cursor: undefined,
    })
    await expect.element(screen.getByText('尚未准备')).toBeInTheDocument()
    const closeButtons = document.querySelectorAll('button')
    const closeLabels = [...closeButtons].map((button) => button.textContent)
    expect(closeLabels.filter((label) => label === '关闭会话')).toHaveLength(1)
    await expect.element(screen.getByRole('button', { name: '处置失联' })).toBeEnabled()
    await screen.getByRole('button', { name: '处置失联' }).click()
    expect(mocks.disposeWorkerSession).toHaveBeenCalledWith(LOST_SESSION_ID, {
      note: '系统会话页处置失联实例',
    })
    await screen.getByRole('button', { name: '查看' }).click()
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/sessions/$targetId/$accountId',
      params: { targetId: TARGET_ID, accountId: BUSY_ID },
    })
    expect(document.body.textContent).not.toContain('删除')
  })

  it('编写者看不到关闭会话', async () => {
    signIn(['session:read', 'session:control'])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <SessionSystemPage />
        </QueryClientProvider>
      </ThemeProvider>,
    )
    await expect.element(screen.getByText('值班')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭会话' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '处置失联' })).not.toBeInTheDocument()
  })
})
