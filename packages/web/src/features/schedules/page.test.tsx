import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { scheduleDefinitionSchema, type ScheduleDto } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { ScheduleEditorDialog } from './editor'
import { SchedulesPage } from './page'

const mocks = vi.hoisted(() => ({
  fetchSchedules: vi.fn(),
  createSchedule: vi.fn(),
  fetchTargets: vi.fn(),
  fetchTargetAccounts: vi.fn(),
  fetchPlatformConfig: vi.fn(),
  fetchScenarios: vi.fn(),
  fetchScenario: vi.fn(),
  fetchSuites: vi.fn(),
  fetchMapSafeEntries: vi.fn(),
  updateSchedule: vi.fn(),
  fetchSuite: vi.fn(),
}))

vi.mock('@/lib/schedules-api', () => ({
  fetchSchedules: mocks.fetchSchedules,
  createSchedule: mocks.createSchedule,
  updateSchedule: mocks.updateSchedule,
  setScheduleEnabled: vi.fn(),
  previewSchedule: vi.fn(),
  triggerSchedule: vi.fn(),
  fetchScheduleOccurrences: vi.fn(async () => ({ items: [] })),
  fetchScheduleEvents: vi.fn(async () => ({ items: [] })),
  fetchAnalysisJob: vi.fn(),
  cancelAnalysisJob: vi.fn(),
}))
vi.mock('@/lib/targets-api', () => ({
  fetchTargets: mocks.fetchTargets,
  fetchTargetAccounts: mocks.fetchTargetAccounts,
}))
vi.mock('@/lib/platform-config-api', () => ({
  fetchPlatformConfig: mocks.fetchPlatformConfig,
}))
vi.mock('@/lib/scenarios-api', () => ({
  fetchScenarios: mocks.fetchScenarios,
  fetchScenario: mocks.fetchScenario,
}))
vi.mock('@/lib/suites-api', () => ({
  fetchSuites: mocks.fetchSuites,
  fetchSuite: mocks.fetchSuite,
}))
vi.mock('@/lib/map-api', () => ({
  fetchMapSafeEntries: mocks.fetchMapSafeEntries,
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
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <SchedulesPage />
    </QueryClientProvider>
  )
}

describe('定时任务列表', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900)
    vi.clearAllMocks()
    signIn()
    mocks.fetchTargets.mockResolvedValue({
      items: [{ id: '11111111-1111-4111-8111-111111111111', name: '演示商城' }],
    })
    mocks.fetchTargetAccounts.mockResolvedValue({
      items: [
        { id: '22222222-2222-4222-8222-222222222222', displayName: '值班账号' },
        { id: '99999999-9999-4999-8999-999999999999', displayName: '备用账号' },
      ],
    })
    mocks.fetchPlatformConfig.mockResolvedValue({
      document: { scenarioScheduledRunEnabled: false },
    })
    mocks.fetchScenarios.mockResolvedValue({ items: [] })
    mocks.fetchScenario.mockResolvedValue({ versions: [] })
    mocks.fetchSuites.mockResolvedValue({ items: [] })
    mocks.fetchMapSafeEntries.mockResolvedValue({ items: [] })
  })

  it('空列表说明任务类型和新计划默认停用', async () => {
    mocks.fetchSchedules.mockResolvedValue({ items: [] })
    await renderPage()
    await expect
      .element(page.getByRole('heading', { name: '定时任务' }))
      .toBeVisible()
    await expect.element(page.getByText('还没有调度计划')).toBeVisible()
    await expect
      .element(page.getByText('先选任务类型和目标系统，再设置排期。新计划保存后默认停用。'))
      .toBeVisible()
    await expect.element(page.getByLabelText('任务类型')).toBeVisible()
    await page.getByLabelText('任务类型').click()
    await expect
      .element(page.getByRole('option', { name: '场景执行', exact: true }))
      .toBeVisible()
    await expect
      .element(page.getByRole('option', { name: '场景集执行', exact: true }))
      .toBeVisible()
    await expect
      .element(page.getByRole('option', { name: '知识分析', exact: true }))
      .toBeVisible()
    await expect
      .element(page.getByRole('option', { name: '地图采集', exact: true }))
      .toBeVisible()
    await page.getByRole('option', { name: '全部', exact: true }).click()
  })

  it('有写权限时可以打开新建调度', async () => {
    signIn(['schedule:read', 'schedule:write', 'target:read', 'platform-config:read'])
    mocks.fetchSchedules.mockResolvedValue({ items: [] })
    await renderPage()
    await page.getByRole('button', { name: '新建调度' }).click()
    await expect
      .element(page.getByRole('heading', { name: '新建调度' }))
      .toBeVisible()
    await expect
      .element(page.getByText(/启用前请预览执行时间，并确认平台已开放相应任务/))
      .toBeVisible()
    await expect
      .element(page.getByText(/平台尚未开放场景执行的定时触发。计划可以保存或启用/))
      .toBeVisible()
    await expect
      .element(page.getByLabelText('时间规则'))
      .toBeVisible()
    await expect
      .element(page.getByLabelText('触发时间'))
      .toBeVisible()
    await expect
      .element(page.getByLabelText('最晚受理截止（窗口保护）'))
      .toBeVisible()
    await expect
      .element(page.getByText('排期规则说明'))
      .toBeVisible()
  })

  it('新建调度缺少目标与场景时指出字段并禁止保存，选齐后可提交', async () => {
    signIn(['schedule:read', 'schedule:write', 'target:read'])
    mocks.fetchSchedules.mockResolvedValue({ items: [] })
    mocks.fetchScenarios.mockResolvedValue({
      items: [{
        id: '33333333-3333-4333-8333-333333333333',
        name: '巡检场景',
        latestVersionId: '44444444-4444-4444-8444-444444444444',
      }],
    })
    mocks.fetchScenario.mockResolvedValue({
      published: {
        versionId: '44444444-4444-4444-8444-444444444444',
        definition: { inputs: [], steps: [] },
      },
    })
    mocks.createSchedule.mockResolvedValue({ created: true })

    await renderPage()
    await page.getByRole('button', { name: '新建调度' }).click()
    await expect.element(page.getByText('请选择目标系统。')).toBeVisible()
    await expect.element(page.getByText('请选择场景。')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '仅保存' })).toBeDisabled()
    await expect.element(page.getByRole('button', { name: '保存并启用' })).toBeDisabled()
    expect(mocks.createSchedule).not.toHaveBeenCalled()

    await page.getByLabelText('目标系统').click()
    await page.getByRole('option', { name: '演示商城' }).click()
    await expect.element(page.getByText('请选择目标系统。')).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: '仅保存' })).toBeDisabled()
    await page.getByLabelText(/场景/).click()
    await page.getByRole('option', { name: '巡检场景' }).click()
    await expect.element(page.getByRole('button', { name: '仅保存' })).toBeEnabled()
    await page.getByRole('button', { name: '仅保存' }).click()
    await expect.poll(() => mocks.createSchedule.mock.calls.length).toBe(1)
    expect(mocks.createSchedule.mock.calls[0]?.[0]?.definition).toMatchObject({
      name: '巡检场景',
      consumer: {
        type: 'scenario_run',
        targetId: '11111111-1111-4111-8111-111111111111',
        scenarioId: '33333333-3333-4333-8333-333333333333',
        scenarioVersionId: '44444444-4444-4444-8444-444444444444',
      },
    })
  })

  it('筛选类型无结果时展示没有匹配计划并提供清除筛选按钮', async () => {
    signIn(['schedule:read', 'target:read'])
    mocks.fetchSchedules.mockResolvedValue({ items: [] })
    await renderPage()
    await page.getByLabelText('任务类型').click()
    await page.getByRole('option', { name: '场景执行', exact: true }).click()
    await expect.element(page.getByText('没有匹配的调度计划')).toBeVisible()
    await expect
      .element(page.getByRole('button', { name: '清除筛选' }))
      .toBeVisible()
    await page.getByRole('button', { name: '清除筛选' }).click()
    await expect.element(page.getByText('还没有调度计划')).toBeVisible()
  })

  it('地图采集计划使用地图开放状态，并保存选定的采集账号', async () => {
    signIn(['schedule:read', 'schedule:write', 'target:read', 'platform-config:read'])
    mocks.fetchSchedules.mockResolvedValue({ items: [] })
    mocks.fetchPlatformConfig.mockResolvedValue({
      document: {
        scenarioScheduledRunEnabled: false,
        knowledgeAnalysisEnabled: true,
        mapScheduledRefreshEnabled: false,
      },
    })
    mocks.fetchTargetAccounts.mockResolvedValue({
      items: [
        { id: '22222222-2222-4222-8222-222222222222', displayName: '地图账号', usage: 'map' },
        { id: '99999999-9999-4999-8999-999999999999', displayName: '业务账号', usage: 'business' },
      ],
    })
    mocks.createSchedule.mockResolvedValue({ created: true })
    await renderPage()
    await page.getByRole('button', { name: '新建调度' }).click()
    await page.getByLabelText('任务类型').last().click()
    await page.getByRole('option', { name: '地图采集', exact: true }).click()
    await expect
      .element(page.getByText(/平台尚未开放地图采集的定时触发。计划可以保存或启用/))
      .toBeVisible()
    await page.getByLabelText('目标系统').click()
    await page.getByRole('option', { name: '演示商城' }).click()
    await page.getByLabelText('目标账号').click()
    await page.getByRole('option', { name: '地图账号', exact: true }).click()
    await page.getByRole('button', { name: '仅保存' }).click()
    await expect
      .poll(() => mocks.createSchedule.mock.calls[0]?.[0]?.definition)
      .toMatchObject({
        name: '知识地图采集',
        consumer: {
          type: 'map_ingest',
          targetId: '11111111-1111-4111-8111-111111111111',
          targetAccountId: '22222222-2222-4222-8222-222222222222',
        },
      })
    expect(scheduleDefinitionSchema.parse(mocks.createSchedule.mock.calls[0][0].definition).consumer.type).toBe('map_ingest')
  })

  it('已准入不显示为采集成功，错过窗口单独说明', async () => {
    mocks.fetchSchedules.mockResolvedValue({
      items: [
        {
          scheduleId: '44444444-4444-4444-8444-444444444444',
          name: '夜间采集',
          targetId: '11111111-1111-4111-8111-111111111111',
          targetAccountId: '22222222-2222-4222-8222-222222222222',
          consumerKey: 'map_ingest',
          enabled: true,
          revision: 2,
          currentVersionId: '55555555-5555-4555-8555-555555555555',
          definition: {
            timezone: 'Asia/Shanghai',
            weekdays: [1],
            windowStart: '02:00',
            windowEnd: '03:00',
            misfire: 'skip',
            timeRule: {
              kind: 'calendar',
              timezone: 'Asia/Shanghai',
              weekdays: [1],
              windows: [
                { ruleId: 'default', windowStart: '02:00', windowEnd: '03:00' },
              ],
              misfire: 'skip',
            },
            consumer: {
              type: 'map_ingest',
              targetId: '11111111-1111-4111-8111-111111111111',
              targetAccountId: '22222222-2222-4222-8222-222222222222',
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
          objectLabel: '知识地图采集',
          createdAt: '2026-09-16T00:00:00.000Z',
          updatedAt: '2026-09-16T00:00:00.000Z',
        },
        {
          scheduleId: '88888888-8888-4888-8888-888888888888',
          targetId: '11111111-1111-4111-8111-111111111111',
          targetAccountId: null,
          consumerKey: 'map_ingest',
          enabled: false,
          revision: 1,
          currentVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          definition: {
            timezone: 'Asia/Shanghai',
            weekdays: [1],
            windowStart: '02:00',
            windowEnd: '03:00',
            misfire: 'skip',
            timeRule: {
              kind: 'calendar',
              timezone: 'Asia/Shanghai',
              weekdays: [1],
              windows: [
                { ruleId: 'default', windowStart: '02:00', windowEnd: '03:00' },
              ],
              misfire: 'skip',
            },
            consumer: {
              type: 'map_ingest',
              targetId: '11111111-1111-4111-8111-111111111111',
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
    await expect.element(page.getByText('由平台选择采集账号')).toBeVisible()
    await expect
      .element(page.getByText('已准入（已创建执行对象，不等于业务成功）'))
      .toBeVisible()
    await expect.element(page.getByText('已跳过 · 错过窗口')).toBeVisible()
    await expect
      .element(page.getByText('采集成功', { exact: true }))
      .not.toBeInTheDocument()
  })

  it('平台未开放时显示阻断原因和处理方法', async () => {
    mocks.fetchSchedules.mockResolvedValue({
      items: [
        {
          scheduleId: '44444444-4444-4444-8444-444444444444',
          name: '验收-知识分析-默认停用',
          targetId: '11111111-1111-4111-8111-111111111111',
          targetAccountId: null,
          consumerKey: 'knowledge_analysis',
          enabled: false,
          revision: 1,
          currentVersionId: '55555555-5555-4555-8555-555555555555',
          definition: {
            name: '验收-知识分析-默认停用',
            timezone: 'UTC',
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            windowStart: '00:00',
            windowEnd: '23:59',
            misfire: 'coalesce',
            timeRule: {
              kind: 'interval',
              intervalMs: 300000,
              anchorUtc: '2026-09-20T00:00:00.000Z',
              misfire: 'coalesce',
            },
            consumer: {
              type: 'knowledge_analysis',
              targetId: '11111111-1111-4111-8111-111111111111',
              mode: 'map_quality',
              source: { includeFailures: true },
              strategyVersion: 'analysis-strategy@1',
              budget: { maxItems: 50, useAi: false },
            },
          },
          nextDueAt: '2026-09-20T00:05:00.000Z',
          lastOccurrence: null,
          objectLabel: '知识分析 · 地图质量分析',
          blockReasons: ['FACTORY_DISABLED'],
          createdAt: '2026-09-20T00:00:00.000Z',
          updatedAt: '2026-09-20T00:00:00.000Z',
        },
      ],
    })
    await renderPage()
    await expect.element(page.getByText('验收-知识分析-默认停用')).toBeVisible()
    await expect.element(page.getByText('平台尚未开放此类定时任务；请在平台配置中开放后再执行')).toBeVisible()
    await expect
      .element(page.getByText('FACTORY_DISABLED', { exact: true }))
      .not.toBeInTheDocument()
  })
})

it('编辑名称保留固定版本、输入与窗口，网络失败重试复用同一请求编号', async () => {
  signIn(['schedule:read', 'schedule:write', 'target:read'])
  const definition = scheduleDefinitionSchema.parse({
    name: '原计划',
    timeRule: {
      kind: 'calendar',
      timezone: 'Asia/Shanghai',
      weekdays: [1, 2],
      windows: [
        { ruleId: 'am', windowStart: '02:00', windowEnd: '03:00' },
        { ruleId: 'pm', windowStart: '14:00', windowEnd: '15:00' },
      ],
      misfire: 'skip',
    },
    consumer: {
      type: 'scenario_run',
      targetId: '11111111-1111-4111-8111-111111111111',
      scenarioId: '22222222-2222-4222-8222-222222222222',
      scenarioVersionId: '33333333-3333-4333-8333-333333333333',
      input: { orderId: 'A-1' },
      accountBinding: {},
    },
  })
  const existing = {
    scheduleId: '44444444-4444-4444-8444-444444444444',
    name: '原计划',
    consumerKey: 'scenario_run',
    targetId: definition.consumer.targetId,
    definition,
    revision: 3,
  } as ScheduleDto
  mocks.updateSchedule
    .mockRejectedValueOnce(new Error('连接中断'))
    .mockResolvedValue({ schedule: existing, created: false })
  mocks.fetchScenarios.mockResolvedValue({
    items: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: '场景',
        latestVersionId: '55555555-5555-4555-8555-555555555555',
      },
    ],
  })
  mocks.fetchScenario.mockResolvedValue({
    published: {
      versionId: '55555555-5555-4555-8555-555555555555',
      definition: {
        inputs: [{ key: 'newRequired', label: '新版新增必填项' }],
        steps: [],
      },
    },
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  await render(
    <QueryClientProvider client={client}>
      <ScheduleEditorDialog
        open
        onOpenChange={() => undefined}
        existing={existing}
      />
    </QueryClientProvider>
  )
  await page.getByLabelText('名称', { exact: true }).fill('仅改名称')
  await page.getByRole('button', { name: '仅保存' }).click()
  await expect
    .poll(
      () =>
        mocks.updateSchedule.mock.calls[
          mocks.updateSchedule.mock.calls.length - 1
        ]?.[1]
    )
    .toMatchObject({
      definition: {
        name: '仅改名称',
        consumer: definition.consumer,
        timeRule: definition.timeRule,
      },
    })
  const firstKey =
    mocks.updateSchedule.mock.calls[
      mocks.updateSchedule.mock.calls.length - 1
    ][1].idempotencyKey
  await expect
    .element(page.getByRole('button', { name: '仅保存' }))
    .toBeEnabled()
  await page.getByRole('button', { name: '仅保存' }).click()
  await expect
    .poll(
      () =>
        mocks.updateSchedule.mock.calls[
          mocks.updateSchedule.mock.calls.length - 1
        ][1].idempotencyKey
    )
    .toBe(firstKey)
})
