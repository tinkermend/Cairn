import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { SchedulesPage } from './page'

const mocks = vi.hoisted(() => ({
  fetchSchedules: vi.fn(),
  fetchTargets: vi.fn(),
  fetchTargetAccounts: vi.fn(),
}))

vi.mock('@/components/layout/app-header', () => ({ AppHeader: () => null }))
vi.mock('@/lib/schedules-api', () => ({
  fetchSchedules: mocks.fetchSchedules,
}))
vi.mock('@/lib/targets-api', () => ({
  fetchTargets: mocks.fetchTargets,
  fetchTargetAccounts: mocks.fetchTargetAccounts,
}))

function signIn(permissions = ['schedule:read', 'target:read']) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions,
  })
}

async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SchedulesPage />
    </QueryClientProvider>,
  )
}

describe('自动复查列表', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900)
    vi.clearAllMocks()
    signIn()
    mocks.fetchTargets.mockResolvedValue({ items: [{ id: '11111111-1111-4111-8111-111111111111', name: '演示商城' }] })
    mocks.fetchTargetAccounts.mockResolvedValue({
      items: [
        { id: '22222222-2222-4222-8222-222222222222', displayName: '值班账号' },
        { id: '99999999-9999-4999-8999-999999999999', displayName: '备用账号' },
      ],
    })
  })

  it('空列表说明出厂关闭也不会触发', async () => {
    mocks.fetchSchedules.mockResolvedValue({ items: [] })
    await renderPage()
    await expect.element(page.getByRole('heading', { name: '自动复查' })).toBeVisible()
    await expect.element(page.getByText('还没有自动复查计划')).toBeVisible()
    await expect.element(page.getByText(/出厂关闭/)).toBeVisible()
  })

  it('已准入不显示为复查成功，错过窗口单独说明', async () => {
    mocks.fetchSchedules.mockResolvedValue({
      items: [
        {
          scheduleId: '44444444-4444-4444-8444-444444444444',
          targetId: '11111111-1111-4111-8111-111111111111',
          targetAccountId: '22222222-2222-4222-8222-222222222222',
          consumerKey: 'map_refresh',
          enabled: true,
          revision: 2,
          currentVersionId: '55555555-5555-4555-8555-555555555555',
          definition: {
            timezone: 'Asia/Shanghai',
            weekdays: [1],
            windowStart: '02:00',
            windowEnd: '03:00',
            misfire: 'skip',
            consumer: {
              type: 'map_refresh',
              targetId: '11111111-1111-4111-8111-111111111111',
              targetAccountId: '22222222-2222-4222-8222-222222222222',
              entryId: '33333333-3333-4333-8333-333333333333',
            },
          },
          nextDueAt: '2026-09-17T18:00:00.000Z',
          lastOccurrence: {
            occurrenceId: '66666666-6666-4666-8666-666666666666',
            scheduleId: '44444444-4444-4444-8444-444444444444',
            scheduleVersionId: '55555555-5555-4555-8555-555555555555',
            localSlotKey: 'slot',
            occurrenceKey: 'key',
            localStartDate: '2026-09-16',
            windowStartUtc: '2026-09-15T18:00:00.000Z',
            windowEndUtc: '2026-09-15T19:00:00.000Z',
            startOffsetMinutes: 480,
            endOffsetMinutes: 480,
            timeRuleVersion: 'schedule-time@1',
            admissionStatus: 'ADMITTED',
            reason: null,
            jobId: '77777777-7777-4777-8777-777777777777',
            createdAt: '2026-09-16T00:00:00.000Z',
            admittedAt: '2026-09-16T00:01:00.000Z',
          },
          createdAt: '2026-09-16T00:00:00.000Z',
          updatedAt: '2026-09-16T00:00:00.000Z',
        },
        {
          scheduleId: '88888888-8888-4888-8888-888888888888',
          targetId: '11111111-1111-4111-8111-111111111111',
          targetAccountId: '99999999-9999-4999-8999-999999999999',
          consumerKey: 'map_refresh',
          enabled: false,
          revision: 1,
          currentVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          definition: {
            timezone: 'Asia/Shanghai',
            weekdays: [1],
            windowStart: '02:00',
            windowEnd: '03:00',
            misfire: 'skip',
            consumer: {
              type: 'map_refresh',
              targetId: '11111111-1111-4111-8111-111111111111',
              targetAccountId: '99999999-9999-4999-8999-999999999999',
              entryId: '33333333-3333-4333-8333-333333333333',
            },
          },
          nextDueAt: null,
          lastOccurrence: {
            occurrenceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            scheduleId: '88888888-8888-4888-8888-888888888888',
            scheduleVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            localSlotKey: 'slot-2',
            occurrenceKey: null,
            localStartDate: '2026-09-16',
            windowStartUtc: '2026-09-15T18:00:00.000Z',
            windowEndUtc: '2026-09-15T19:00:00.000Z',
            startOffsetMinutes: 480,
            endOffsetMinutes: 480,
            timeRuleVersion: 'schedule-time@1',
            admissionStatus: 'SKIPPED',
            reason: 'WINDOW_CLOSED',
            jobId: null,
            createdAt: '2026-09-16T00:00:00.000Z',
            admittedAt: null,
          },
          createdAt: '2026-09-16T00:00:00.000Z',
          updatedAt: '2026-09-16T00:00:00.000Z',
        },
      ],
    })
    await renderPage()
    await expect.element(page.getByText('演示商城').first()).toBeVisible()
    await expect.element(page.getByText('值班账号')).toBeVisible()
    await expect.element(page.getByText('已准入（作业已创建，不等于复查成功）')).toBeVisible()
    await expect.element(page.getByText('已跳过 · 错过窗口')).toBeVisible()
    await expect.element(page.getByText('复查成功', { exact: true })).not.toBeInTheDocument()
  })
})
