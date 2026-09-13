import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordingDraftListResponse } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { RecordingsPage } from './index'

const mocks = vi.hoisted(() => ({
  fetchRecordings: vi.fn(),
}))

vi.mock('@/lib/recordings-api', () => mocks)
vi.mock('@/components/layout/app-header', () => ({ AppHeader: () => null }))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children }: { children: React.ReactNode }) => <a href='#'>{children}</a>,
  }
})

const list: RecordingDraftListResponse = {
  items: [
    {
      id: '66666666-6666-4666-8666-666666666666',
      targetId: '11111111-1111-4111-8111-111111111111',
      targetName: '演示商城',
      name: '录制 shop.example',
      recordingId: '22222222-2222-4222-8222-222222222222',
      sourceVersion: 'playwright-crx@0.15.0',
      eventCount: 4,
      itemCount: 3,
      unresolvedCount: 1,
      createdBy: { id: '33333333-3333-4333-8333-333333333333', displayName: '管理员' },
      createdAt: '2026-09-13T04:00:00.000Z',
      updatedAt: '2026-09-13T04:00:00.000Z',
    },
  ],
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RecordingsPage />
    </QueryClientProvider>,
  )
}

describe('录制草稿列表', () => {
  beforeEach(() => {
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '管理员',
      email: null,
      roles: [],
      permissions: ['workflow:write'],
    })
    mocks.fetchRecordings.mockResolvedValue(list)
  })

  afterEach(() => {
    vi.clearAllMocks()
    useAuthStore.getState().auth.reset()
  })

  it('列出草稿名称、目标与待处理数', async () => {
    const screen = await renderPage()
    await expect.element(screen.getByText('录制 shop.example')).toBeVisible()
    await expect.element(screen.getByText('演示商城')).toBeVisible()
    await expect.element(screen.getByText('管理员')).toBeVisible()
    await expect.element(screen.getByRole('cell', { name: '3', exact: true })).toBeVisible()
  })
})
