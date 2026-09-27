import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { scheduleDefinitionSchema, type ScheduleDto } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { useAssistantStore } from '@/stores/assistant-store'
import { ScheduleDetailDialog } from './detail'

const mocks = vi.hoisted(() => ({
  fetchScheduleOccurrences: vi.fn(),
  fetchScheduleEvents: vi.fn(),
}))

const TARGET_ID = '22222222-2222-4222-8222-222222222222'

vi.mock('@/lib/schedules-api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    fetchScheduleOccurrences: mocks.fetchScheduleOccurrences,
    fetchScheduleEvents: mocks.fetchScheduleEvents,
  }
})

vi.mock('@/lib/observation-stream', () => ({
  subscribeObservation: vi.fn().mockReturnValue(new Promise(() => {})),
}))

const sampleSchedule: ScheduleDto = {
  scheduleId: '11111111-1111-4111-8111-111111111111',
  name: '每日巡检',
  targetId: TARGET_ID,
  targetAccountId: null,
  objectLabel: '生产系统',
  consumerKey: 'scenario_run',
  enabled: true,
  revision: 1,
  currentVersionId: '22222222-2222-4222-8222-222222222222',
  definition: scheduleDefinitionSchema.parse({
    timeRule: {
      kind: 'interval',
      intervalMs: 3600000,
      anchorUtc: '2026-09-20T00:00:00.000Z',
      misfire: 'skip',
    },
    consumer: {
      type: 'scenario_run',
      targetId: TARGET_ID,
      scenarioId: '33333333-3333-4333-8333-333333333333',
      scenarioVersionId: '44444444-4444-4444-8444-444444444444',
      accountBinding: { resolved: false },
      input: {},
    },
  }),
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
  nextDueAt: '2026-09-27T12:00:00.000Z',
  lastOccurrence: {
    occurrenceId: 'occ-1',
    scheduleId: '11111111-1111-4111-8111-111111111111',
    scheduleVersionId: 'v1',
    source: 'scheduled',
    localSlotKey: 'slot-1',
    occurrenceKey: null,
    localStartDate: '2026-09-27 10:00',
    windowStartUtc: null,
    windowEndUtc: null,
    startOffsetMinutes: null,
    endOffsetMinutes: null,
    timeRuleVersion: '1',
    admissionStatus: 'SKIPPED',
    reason: 'AUTH_PREPARATION_REQUIRED',
    jobId: null,
    createdAt: '2026-09-27T02:00:00.000Z',
    admittedAt: null,
  },
}

describe('ScheduleDetailDialog', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '测试用户',
      email: null,
      roles: ['admin'],
      permissions: ['schedule:read', 'target:read'],
    })
    useAssistantStore.setState({ boundContext: null, pageContext: null })
  })

  it('renders admission summary, skip explanation, and action button for AUTH_PREPARATION_REQUIRED', async () => {
    mocks.fetchScheduleOccurrences.mockResolvedValueOnce({
      items: [
        {
          occurrenceId: 'occ-1',
          scheduleId: sampleSchedule.scheduleId,
          scheduleVersionId: 'v1',
          source: 'scheduled',
          localSlotKey: 'slot-1',
          occurrenceKey: null,
          localStartDate: '2026-09-27 10:00',
          windowStartUtc: null,
          windowEndUtc: null,
          startOffsetMinutes: null,
          endOffsetMinutes: null,
          timeRuleVersion: '1',
          admissionStatus: 'SKIPPED',
          reason: 'AUTH_PREPARATION_REQUIRED',
          jobId: null,
          createdAt: '2026-09-27T02:00:00.000Z',
          admittedAt: null,
        },
        {
          occurrenceId: 'occ-2',
          scheduleId: sampleSchedule.scheduleId,
          scheduleVersionId: 'v1',
          source: 'scheduled',
          localSlotKey: 'slot-2',
          occurrenceKey: null,
          localStartDate: '2026-09-27 09:00',
          windowStartUtc: null,
          windowEndUtc: null,
          startOffsetMinutes: null,
          endOffsetMinutes: null,
          timeRuleVersion: '1',
          admissionStatus: 'ADMITTED',
          reason: null,
          jobId: null,
          runId: 'run-999',
          createdAt: '2026-09-27T01:00:00.000Z',
          admittedAt: '2026-09-27T01:00:05.000Z',
        },
      ],
      nextCursor: undefined,
    })
    mocks.fetchScheduleEvents.mockResolvedValueOnce({
      items: [],
      nextCursor: undefined,
    })

    render(
      <QueryClientProvider client={queryClient}>
        <ScheduleDetailDialog schedule={sampleSchedule} onOpenChange={() => {}} />
      </QueryClientProvider>,
    )

    // Check admission summary
    const summary = page.getByTestId('schedule-admission-summary')
    await expect.element(summary).toBeVisible()
    await expect.element(summary).toHaveTextContent('已准入 1 次')
    await expect.element(summary).toHaveTextContent('已跳过 1 次')
    await expect.element(summary).toHaveTextContent('主要跳过原因：认证尚未准备')

    // Check explanation text in occurrence row
    const row = page.getByTestId('schedule-occurrence-row').first()
    await expect.element(row).toHaveTextContent('执行目标系统需要有效的登录凭据或会话')

    // Check action button
    const actionBtn = row.getByRole('link', { name: '去认证账号' })
    await expect.element(actionBtn).toBeVisible()
    expect(actionBtn.element().getAttribute('href')).toBe(`/sessions/${TARGET_ID}`)

    // Check assistant context binding
    const bound = useAssistantStore.getState().boundContext
    expect(bound?.page).toBe('schedule')
    expect(bound?.entityId).toBe(sampleSchedule.scheduleId)
  })
})
