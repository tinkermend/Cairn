import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { FACTORY_PLATFORM_CONFIG } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { AutoRefreshCard } from './auto-refresh'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'
const ENTRY_ID = '33333333-3333-4333-8333-333333333333'
const SCHEDULE_ID = '44444444-4444-4444-8444-444444444444'

const mocks = vi.hoisted(() => ({
  fetchSchedules: vi.fn(),
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  setScheduleEnabled: vi.fn(),
  previewSchedule: vi.fn(),
  fetchPlatformConfig: vi.fn(),
  fetchMapJobPolicy: vi.fn(),
  fetchMapSafeEntries: vi.fn(),
  fetchTargetAccounts: vi.fn(),
}))

vi.mock('@/lib/schedules-api', () => ({
  fetchSchedules: mocks.fetchSchedules,
  createSchedule: mocks.createSchedule,
  updateSchedule: mocks.updateSchedule,
  setScheduleEnabled: mocks.setScheduleEnabled,
  previewSchedule: mocks.previewSchedule,
}))
vi.mock('@/lib/platform-config-api', () => ({
  fetchPlatformConfig: mocks.fetchPlatformConfig,
}))
vi.mock('@/lib/map-api', () => ({
  fetchMapJobPolicy: mocks.fetchMapJobPolicy,
  fetchMapSafeEntries: mocks.fetchMapSafeEntries,
}))
vi.mock('@/lib/targets-api', () => ({
  fetchTargetAccounts: mocks.fetchTargetAccounts,
}))

function signIn(permissions = ['schedule:read', 'schedule:write', 'map:maintain']) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions,
  })
}

async function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AutoRefreshCard targetId={TARGET_ID} />
    </QueryClientProvider>,
  )
}

describe('知识页自动复查', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900)
    vi.clearAllMocks()
    signIn()
    mocks.fetchSchedules.mockResolvedValue({ items: [] })
    mocks.fetchPlatformConfig.mockResolvedValue({
      revision: 1,
      document: FACTORY_PLATFORM_CONFIG,
      updatedAt: '2026-09-16T00:00:00.000Z',
      updatedByAccountId: 'u1',
      reason: '初始化',
      source: 'bootstrap',
    })
    mocks.fetchMapJobPolicy.mockResolvedValue({
      targetId: TARGET_ID,
      revision: 0,
      policy: {
        schemaVersion: 1,
        policyVersion: 1,
        manualJobsEnabled: false,
        maxProbePages: 1,
        maxProbeObjects: 8,
        maxProbeActions: 8,
        maxProbeSeconds: 300,
        maxRefreshPages: 5,
        maxRefreshObjects: 20,
        maxRefreshActions: 20,
        maxRefreshSeconds: 900,
        sliceWorkSeconds: 20,
        defaultDepth: 'structure',
        staticRefreshDays: 7,
      },
      updatedAt: '1970-01-01T00:00:00.000Z',
    })
    mocks.fetchMapSafeEntries.mockResolvedValue({
      items: [{ entryId: ENTRY_ID, name: '订单入口', url: 'https://shop.example/orders' }],
    })
    mocks.fetchTargetAccounts.mockResolvedValue({
      items: [{ id: ACCOUNT_ID, targetId: TARGET_ID, displayName: '值班账号', username: 'ops', status: 'active' }],
    })
  })

  it('默认关闭，工厂关闭时说明不会触发', async () => {
    const screen = await renderCard()
    await expect.element(page.getByRole('heading', { name: '自动复查' })).toBeVisible()
    await expect.element(page.getByText('当前没有自动复查计划，默认关闭。')).toBeVisible()
    await expect.element(page.getByText(/出厂关闭/)).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '保存计划' })).toBeDisabled()
  })

  it('可预览并保存计划，已准入不显示为成功', async () => {
    mocks.fetchSchedules.mockResolvedValue({
      items: [
        {
          scheduleId: SCHEDULE_ID,
          targetId: TARGET_ID,
          targetAccountId: ACCOUNT_ID,
          consumerKey: 'map_refresh',
          enabled: false,
          revision: 1,
          currentVersionId: '55555555-5555-4555-8555-555555555555',
          definition: {
            timezone: 'Asia/Shanghai',
            weekdays: [1, 2, 3, 4, 5],
            windowStart: '02:00',
            windowEnd: '03:00',
            misfire: 'skip',
            consumer: {
              type: 'map_refresh',
              targetId: TARGET_ID,
              targetAccountId: ACCOUNT_ID,
              entryId: ENTRY_ID,
            },
          },
          nextDueAt: '2026-09-17T18:00:00.000Z',
          lastOccurrence: {
            occurrenceId: '66666666-6666-4666-8666-666666666666',
            scheduleId: SCHEDULE_ID,
            scheduleVersionId: '55555555-5555-4555-8555-555555555555',
            localSlotKey: `${SCHEDULE_ID}:2026-09-16`,
            occurrenceKey: `schedule:${SCHEDULE_ID}:2026-09-15T18:00:00.000Z`,
            localStartDate: '2026-09-16',
            windowStartUtc: '2026-09-15T18:00:00.000Z',
            windowEndUtc: '2026-09-15T19:00:00.000Z',
            startOffsetMinutes: 480,
            endOffsetMinutes: 480,
            timeRuleVersion: 'schedule-time@1',
            admissionStatus: 'ADMITTED',
            reason: null,
            jobId: '77777777-7777-4777-8777-777777777777',
            firstRunId: '88888888-8888-4888-8888-888888888888',
            createdAt: '2026-09-16T00:00:00.000Z',
            admittedAt: '2026-09-16T00:01:00.000Z',
          },
          createdAt: '2026-09-16T00:00:00.000Z',
          updatedAt: '2026-09-16T00:00:00.000Z',
        },
      ],
    })
    mocks.previewSchedule.mockResolvedValue({
      asOf: '2026-09-16T00:00:00.000Z',
      windows: [],
      gaps: [{ code: 'FACTORY_DISABLED', message: '平台尚未开放自动复查' }],
    })
    mocks.updateSchedule.mockResolvedValue({
      created: false,
      schedule: { scheduleId: SCHEDULE_ID, revision: 2 },
    })
    const screen = await renderCard()
    await expect.element(page.getByText(/已准入（已创建作业，不等于复查成功）/)).toBeVisible()
    await screen.getByRole('button', { name: '预览窗口' }).click()
    expect(mocks.previewSchedule).toHaveBeenCalled()
    await screen.getByRole('button', { name: '保存计划' }).click()
    expect(mocks.updateSchedule).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({ expectedRevision: 1 }),
    )
  })

  it('无写入权限只读', async () => {
    signIn(['schedule:read'])
    await renderCard()
    await expect.element(page.getByText(/需要调度写入和地图维护权限才能设置自动复查/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: '保存计划' })).not.toBeInTheDocument()
  })
})
