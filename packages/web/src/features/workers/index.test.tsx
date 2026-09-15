import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { WorkerStatus, WorkerSummary } from '@cairn/shared'
import { WorkersPage } from './index'

const fetchWorkers = vi.fn()

vi.mock('@/components/layout/app-header', () => ({ AppHeader: () => null }))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    params,
    children,
  }: {
    to: string
    params?: { workerId: string }
    children: ReactNode
  }) => <a href={to.replace('$workerId', params?.workerId ?? '')}>{children}</a>,
}))
vi.mock('@/lib/workers-api', () => ({
  fetchWorkers: (...args: unknown[]) => fetchWorkers(...args),
}))

const INSTANCE = '11111111-1111-4111-8111-111111111111'
const AS_OF = '2026-09-14T00:00:00.000Z'

function summary(workerId: string, status: WorkerStatus, heartbeatFresh: boolean): WorkerSummary {
  return {
    workerId,
    instanceId: INSTANCE,
    status,
    heartbeatAt: AS_OF,
    lostAfterSeconds: 60,
    heartbeatExpiresAt: heartbeatFresh ? '2026-09-14T00:01:00.000Z' : AS_OF,
    heartbeatFresh,
    capacity: 2,
    maxSessions: 2,
    counts: {
      occupiedSlots: status === 'READY' ? 1 : 0,
      lostOccupied: status === 'LOST' ? 1 : 0,
      executingSlots: 0,
      running: status === 'READY' ? 1 : 0,
      holding: 0,
      waitingForAuth: 0,
      leftoverAuthHolds: 0,
      expiredLeaseResidue: 0,
      runCapacityUsed: 0,
    },
    handleSample: {
      liveHandleCount: null,
      sampledSlotCount: null,
      handleMismatchStreak: 0,
      handleSampledAt: null,
      mismatchState: 'unknown',
    },
    routeAvailability: status === 'READY' && heartbeatFresh ? 'eligible' : 'unavailable',
    routeReason: status === 'READY' && heartbeatFresh ? null : 'worker_not_ready',
    endpointSource: 'none',
    internalEndpoint: null,
  }
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <WorkersPage />
    </QueryClientProvider>,
  )
}

it('列表可选中节点，四值生命周期同时可见，标题不用会话', async () => {
  fetchWorkers.mockResolvedValue({
    items: [
      summary('worker-ready', 'READY', true),
      summary('worker-expired', 'READY', false),
      summary('worker-stopped', 'STOPPED', true),
      summary('worker-lost', 'LOST', false),
    ],
    asOf: AS_OF,
  })
  const screen = await renderPage()
  await expect.element(screen.getByRole('heading', { name: '执行节点', exact: true })).toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: '就绪', exact: true })).toBeInTheDocument()
  await expect.element(screen.getByRole('cell', { name: '就绪', exact: true })).toBeInTheDocument()
  await expect.element(screen.getByRole('cell', { name: '就绪登记已过期' })).toBeInTheDocument()
  await expect.element(screen.getByRole('cell', { name: '已停止' })).toBeInTheDocument()
  await expect.element(screen.getByRole('cell', { name: '失联', exact: true })).toBeInTheDocument()
  const titles = [...screen.container.querySelectorAll('h1, h2, [data-slot="page-header"]')].map(
    (node) => node.textContent ?? '',
  )
  expect(titles.join('')).not.toContain('会话')

  await screen.getByRole('button', { name: 'worker-stopped', exact: true }).click()
  await expect.element(screen.getByRole('heading', { name: 'worker-stopped' })).toBeInTheDocument()
  await expect.element(screen.getByRole('link', { name: /查看节点详情/ })).toHaveAttribute(
    'href',
    '/workers/worker-stopped',
  )
  await expect.element(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument()
})

it('空列表有明确反馈', async () => {
  fetchWorkers.mockResolvedValue({ items: [], asOf: AS_OF })
  const screen = await renderPage()
  await expect.element(screen.getByText('还没有执行节点')).toBeInTheDocument()
})

it('加载失败有明确反馈', async () => {
  fetchWorkers.mockRejectedValue(new Error('boom'))
  const screen = await renderPage()
  await expect.element(screen.getByText('无法加载执行节点')).toBeInTheDocument()
})
