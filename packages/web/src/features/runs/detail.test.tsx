import '@/styles/index.css'
import { page } from 'vitest/browser'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPlacement, type RunDetailDto, type RunEvidenceListResponse, type RunObservation } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { RunDetailPage } from './detail'

const RUN_ID = '44444444-4444-4444-8444-444444444444'

const mocks = vi.hoisted(() => ({
  fetchRunObservation: vi.fn(),
  subscribeRunEvents: vi.fn(),
  fetchEvidenceContent: vi.fn(),
  cancelRun: vi.fn(),
  reviewRun: vi.fn(),
  resumeRunAuth: vi.fn(),
  fetchManagedBrowser: vi.fn(),
  subscribeBrowserFrames: vi.fn(),
  acquireAuthControl: vi.fn(),
  heartbeatAuthControl: vi.fn(),
  inputAuthControl: vi.fn(),
  releaseAuthControl: vi.fn(),
  fetchRunCleanup: vi.fn(),
  previewDeleteRun: vi.fn(),
  deleteRun: vi.fn(),
  retryRunCleanup: vi.fn(),
  observeRun: vi.fn(),
  debugRun: vi.fn(),
  createRun: vi.fn(),
  fetchRunMapDecisions: vi.fn(),
  search: {} as { invocation?: string },
}))

vi.mock('@/lib/runs-api', async (original) => ({ ...await original<typeof import('@/lib/runs-api')>(), ...mocks }))

// 顶栏是各页共用的外壳（侧栏上下文、搜索、账号菜单），与本页要验的东西无关。
vi.mock('@/components/layout/app-header', () => ({
  AppHeader: () => null,
}))

// Link / useParams 需要路由上下文，本用例只关心页面本身：给最小替身。
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useParams: () => ({ runId: RUN_ID }),
    useSearch: () => mocks.search,
    useNavigate: () => vi.fn(),
    Link: ({ children }: { children: ReactNode }) => <a href='#'>{children}</a>,
  }
})

function runDetail(overrides: Partial<RunDetailDto> = {}): RunDetailDto {
  return {
    id: RUN_ID,
    status: 'NEEDS_REVIEW',
    cancelRequested: false,
    targetId: '11111111-1111-4111-8111-111111111111',
    targetName: '演示商城',
    targetAccountId: '22222222-2222-4222-8222-222222222222',
    targetAccountName: '巡检账号',
    scenarioId: '33333333-3333-4333-8333-333333333333',
    scenarioName: '下单巡检',
    scenarioVersionId: '55555555-5555-4555-8555-555555555555',
    createdAt: '2026-09-11T02:00:00.000Z',
    startedAt: '2026-09-11T02:00:01.000Z',
    finishedAt: null,
    evidenceStatus: 'PENDING',
    lease: null,
    debugMode: 'runThrough',
    placement: runPlacement({
      state: 'not_applicable',
      sessionId: null,
      ownerWorkerId: null,
      sessionStatus: null,
    }),
    snapshot: {
      schemaVersion: 1,
      runId: RUN_ID,
      targetId: '11111111-1111-4111-8111-111111111111',
      scenarioId: '33333333-3333-4333-8333-333333333333',
      scenarioVersionId: '55555555-5555-4555-8555-555555555555',
      steps: [],
      input: {},
      createdAt: '2026-09-11T02:00:00.000Z',
    },
    context: { greeting: 'hello' },
    stepRuns: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        stepId: '77777777-7777-4777-8777-777777777777',
        name: '提交订单',
        type: 'delay',
        ordinal: 0,
        status: 'FAILED',
        startedAt: '2026-09-11T02:00:01.000Z',
        finishedAt: '2026-09-11T02:00:09.000Z',
        attempts: [
          {
            id: '88888888-8888-4888-8888-888888888888',
            attemptNo: 1,
            status: 'FAILED',
            startedAt: '2026-09-11T02:00:01.000Z',
            finishedAt: '2026-09-11T02:00:09.000Z',
            output: null,
            error: {
              code: 'UNKNOWN',
              category: 'UNKNOWN',
              retryable: false,
              safeMessage: '接管时副作用步骤结果未确认',
            },
          },
        ],
      },
    ],
    ...overrides,
  }
}

function observationOf(
  run: RunDetailDto,
  items: RunEvidenceListResponse['items'] = evidence.items,
): RunObservation {
  return {
    run,
    evidence: { items },
    eventSeq: 1,
    earliestEventSeq: 1,
  }
}

function hangSubscribe() {
  mocks.subscribeRunEvents.mockImplementation(
    async (id: string, input: { signal: AbortSignal; handlers: { onControl?: (control: { kind: string }) => void } }) => {
      input.handlers.onControl?.({
        kind: 'ready',
        runId: id,
        eventSeq: 1,
        earliestEventSeq: 1,
        realtime: true,
      } as never)
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) {
          resolve()
          return
        }
        input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
  )
}

const evidence: RunEvidenceListResponse = {
  items: [
    {
      schemaVersion: 1,
      id: '99999999-9999-4999-8999-999999999999',
      runId: RUN_ID,
      stepRunId: '66666666-6666-4666-8666-666666666666',
      attemptId: '88888888-8888-4888-8888-888888888888',
      type: 'error',
      status: 'available',
      createdAt: '2026-09-11T02:00:09.000Z',
      payload: { code: 'UNKNOWN', safeMessage: '接管时副作用步骤结果未确认' },
    },
  ],
}

function signIn(permissions: string[]) {
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
      <RunDetailPage />
    </QueryClientProvider>,
  )
}

describe('RunDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.search = {}
    mocks.fetchRunObservation.mockResolvedValue(observationOf(runDetail()))
    mocks.fetchRunMapDecisions.mockResolvedValue({ items: [] })
    hangSubscribe()
    mocks.cancelRun.mockResolvedValue({ status: 'CANCELLED' })
    mocks.reviewRun.mockResolvedValue(undefined)
    mocks.fetchManagedBrowser.mockResolvedValue({
      runId: RUN_ID,
      runStatus: 'NEEDS_REVIEW',
      sessionId: null,
      sessionGeneration: 0,
      ownerWorkerId: null,
      framesAvailable: false,
      viewingOtherPage: false,
      currentPage: null,
      pages: [],
      authHold: null,
      authControl: null,
      capabilities: {
        screencast: 'closed',
        authInput: 'closed',
        popupHandoff: 'closed',
        chineseInsertText: 'closed',
      },
      degradedReason: null,
    })
    mocks.subscribeBrowserFrames.mockResolvedValue(undefined)
    mocks.fetchRunCleanup.mockResolvedValue({
      resourceId: RUN_ID,
      resourceType: 'run',
      status: 'completed',
      totalObjects: 0,
      purgedObjects: 0,
      failedObjects: 0,
      totalBytes: 0,
      purgedBytes: 0,
      lastError: null,
      completedAt: '2026-09-14T00:00:00.000Z',
    })
    mocks.previewDeleteRun.mockResolvedValue({ previewToken: 'tok', counts: {}, blockers: [] })
    mocks.deleteRun.mockResolvedValue({
      resourceId: RUN_ID,
      resourceType: 'run',
      status: 'completed',
      totalObjects: 0,
      purgedObjects: 0,
      failedObjects: 0,
      totalBytes: 0,
      purgedBytes: 0,
    })
  })

  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
  })

  /** 验收 33 与 34：步骤、Attempt、证据、context 都要能看见，待核查是橙色且核查是主操作。 */
  it('待核查：橙色状态、核查是主操作，步骤/Attempt/证据/context 可见', async () => {
    signIn(['run:read', 'run:review', 'run:cancel', 'run:execute'])
    const screen = await renderPage()

    const badge = screen.getByText('待核查')
    await expect.element(badge).toBeInTheDocument()
    // D14：待核查用橙色（warning），不能混进红色失败语义
    expect(badge.element().closest('[data-slot="status-badge"]')?.className).toContain(
      'bg-status-warning-background',
    )

    // 场景与目标系统给人看的是名字，不是 UUID
    await expect.element(screen.getByText('下单巡检')).toBeInTheDocument()
    await expect.element(screen.getByText('演示商城')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('33333333-3333-4333-8333-333333333333')

    // 核查是这一页的主操作；待核查的 Run 不给取消按钮
    await expect.element(screen.getByRole('button', { name: '判定失败' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '判定取消' })).toBeInTheDocument()
    // 注意 exact：'判定取消' 也含'取消'，不加就永远命中
    expect(screen.getByRole('button', { name: '取消', exact: true }).elements()).toHaveLength(0)

    // 步骤、Attempt、错误、证据、context 一个都不许省
    await expect.element(screen.getByText('1. 提交订单')).toBeInTheDocument()
    await expect.element(screen.getByText(/Attempt #1/)).toBeInTheDocument()
    expect(document.body.textContent).toContain('接管时副作用步骤结果未确认')
    expect(document.body.textContent).toContain('greeting')
  })

  it('核查写入说明并调用接口', async () => {
    signIn(['run:read', 'run:review'])
    const screen = await renderPage()

    await screen.getByLabelText('核查说明').fill('人工确认订单未生成')
    await screen.getByRole('button', { name: '判定失败' }).click()

    expect(mocks.reviewRun).toHaveBeenCalledWith(RUN_ID, {
      conclusion: 'fail',
      note: '人工确认订单未生成',
    })
  })

  /** 验收 35：排队中的 Run 可以取消。 */
  it('排队中：取消按钮调用取消接口', async () => {
    mocks.fetchRunObservation.mockResolvedValue(observationOf(runDetail({ status: 'QUEUED', stepRuns: [] })))
    signIn(['run:read', 'run:cancel'])
    const screen = await renderPage()

    await screen.getByRole('button', { name: '取消', exact: true }).click()
    expect(mocks.cancelRun).toHaveBeenCalledWith(RUN_ID)
  })

  /** 验收 37：viewer 只读——看得见状态，但建不了、取消不了、核查不了。 */
  it('只读权限：看得见内容，没有取消与核查入口', async () => {
    signIn(['run:read'])
    const screen = await renderPage()

    await expect.element(screen.getByText('待核查')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '判定失败' }).elements()).toHaveLength(0)
    expect(screen.getByRole('button', { name: '判定取消' }).elements()).toHaveLength(0)
    expect(screen.getByRole('button', { name: '取消', exact: true }).elements()).toHaveLength(0)
    expect(screen.getByRole('button', { name: '确认目标系统已登录' }).elements()).toHaveLength(0)
    expect(screen.getByRole('button', { name: '处理登录' }).elements()).toHaveLength(0)
    expect(screen.getByRole('region', { name: '受管浏览器' }).elements()).toHaveLength(0)
    // 刷新是只读操作，任何人都能点
    await expect.element(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '分析本次运行' }).elements()).toHaveLength(0)
    expect(screen.getByRole('button', { name: '删除' }).elements()).toHaveLength(0)
  })

  it('已删除场景与目标不再提供可编辑链接', async () => {
    mocks.fetchRunObservation.mockResolvedValue(
      observationOf(
        runDetail({
          scenarioDeleted: true,
          targetDeleted: true,
          scenarioName: '旧场景',
          targetName: '旧目标',
        }),
      ),
    )
    signIn(['run:read'])
    const screen = await renderPage()
    await expect.element(screen.getByText('旧场景')).toBeInTheDocument()
    await expect.element(screen.getByText('旧目标')).toBeInTheDocument()
    expect(screen.getByText('已删除').elements().length).toBeGreaterThanOrEqual(2)
    expect(document.querySelector('a[href*="scenarios"]')).toBeNull()
    expect(document.querySelector('a[href*="targets"]')).toBeNull()
  })

  it('终态运行在具备 run:delete 时展示删除入口', async () => {
    mocks.fetchRunObservation.mockResolvedValue(
      observationOf(runDetail({ status: 'SUCCEEDED', finishedAt: '2026-09-11T02:01:00.000Z' })),
    )
    signIn(['run:read', 'run:delete'])
    const screen = await renderPage()
    await expect.element(screen.getByRole('button', { name: '删除' })).toBeInTheDocument()
  })

  it('已删除运行展示清理状态而不是普通加载失败', async () => {
    mocks.fetchRunObservation.mockRejectedValue(new Error('运行不存在'))
    mocks.fetchRunCleanup.mockResolvedValue({
      resourceId: RUN_ID,
      resourceType: 'run',
      status: 'failed',
      totalObjects: 2,
      purgedObjects: 1,
      failedObjects: 1,
      totalBytes: 2048,
      purgedBytes: 1024,
      lastError: '部分对象文件清理失败，请重试',
    })
    signIn(['run:read', 'run:delete'])
    const screen = await renderPage()
    await expect.element(screen.getByText('运行已删除。业务记录不可访问，附件按清理状态处理。')).toBeInTheDocument()
    await expect.element(screen.getByText(/清理失败/)).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('具备 ai:assist 与目标可见性时出现次级分析入口，核查仍是主操作', async () => {
    signIn(['ai:assist', 'run:read', 'run:review', 'target:read'])
    const screen = await renderPage()
    await expect.element(screen.getByRole('button', { name: '分析本次运行' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '判定失败' })).toBeInTheDocument()
  })

  it.each(['FAILED', 'NEEDS_REVIEW'] as const)('认证恢复结论 %s：失败可新建，核查禁止重放', async (status) => {
    mocks.fetchRunObservation.mockResolvedValue(
      observationOf(
        runDetail({
          status,
          scenarioVersionKind: 'trial',
          authCheckpoint: {
            schemaVersion: 1,
            status: 'unrecoverable',
            closedAt: '2026-09-16T04:00:00.000Z',
            trigger: { kind: 'navigated_to_login', at: '2026-09-16T04:00:00.000Z', summary: '已跳到登录页' },
            nextStepId: '77777777-7777-4777-8777-777777777777',
            nextOrdinal: 0,
            interruptedClassification: 'not_dispatched',
            contextVersion: 'a'.repeat(64),
            contextKeys: [],
            sessionGeneration: 1,
            fencingToken: '1',
            recoveryRule: {
              reuse: 'NEW_PAGE',
              entryUrl: 'https://shop.example.com/',
              allowedOrigins: ['https://shop.example.com'],
            },
            capability: 'LOGIN_VERIFIED',
            autoRecoveriesUsed: 0,
            manualRecoveriesUsed: 0,
            unrecoverableCode: 'AUTH_CONTEXT_NOT_RECOVERABLE',
          },
        }),
      ),
    )
    signIn(['run:read', 'run:execute', 'target:read', 'workflow:read'])
    const screen = await renderPage()
    await expect.element(screen.getByText(/恢复位置：第 1 步/)).toBeInTheDocument()
    if (status === 'NEEDS_REVIEW') {
      await expect.element(screen.getByText('操作结果待核查，请先确认业务结果')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '新建完整试跑' }).elements()).toHaveLength(0)
      for (const width of [1440, 390]) {
        await page.viewport(width, 900)
        await page.screenshot({ path: `/Users/tinker/src/singe/Cairn/.run/session-d-fixes/核查-${width}.png` })
      }
      await page.viewport(1440, 900)
    } else {
      await expect.element(screen.getByText('登录已失效，本次运行无法安全续跑')).toBeInTheDocument()
      await expect.element(screen.getByRole('button', { name: '新建完整试跑' })).toBeInTheDocument()
    }
  })

  it('等待认证：有控制权的用户在详情页直接看到处理登录', async () => {
    mocks.fetchRunObservation.mockResolvedValue(
      observationOf(runDetail({ status: 'WAITING_FOR_AUTH', stepRuns: [] })),
    )
    signIn(['run:read', 'session:view', 'session:control', 'run:execute'])
    const screen = await renderPage()
    await expect.element(screen.getByText('需要登录')).toBeInTheDocument()
    await expect.element(screen.getByRole('region', { name: '受管浏览器' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '处理登录' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认目标系统已登录' }).elements()).toHaveLength(0)
  })

  it('失联会话：橙色说明须处置；等待 owner：灰色说明', async () => {
    mocks.fetchRunObservation.mockResolvedValue(
      observationOf(
        runDetail({
          status: 'QUEUED',
          stepRuns: [],
          placement: runPlacement({
            state: 'session_lost',
            sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            ownerWorkerId: 'worker-a',
            sessionStatus: 'LOST',
          }),
        }),
      ),
    )
    signIn(['run:read'])
    const lost = await renderPage()
    await expect.element(lost.getByText(/会话失联，处置并确认旧浏览器停止后才会继续/)).toBeInTheDocument()
    expect(lost.getByText(/会话失联/).element().className).toContain('text-status-warning-foreground')

    mocks.fetchRunObservation.mockResolvedValue(
      observationOf(
        runDetail({
          status: 'QUEUED',
          stepRuns: [],
          placement: runPlacement({
            state: 'owner_required',
            sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            ownerWorkerId: 'worker-a',
            sessionStatus: 'OPEN',
          }),
        }),
      ),
    )
    const waiting = await renderPage()
    await expect.element(waiting.getByText(/等待持有该账号会话的 Worker 领取/)).toBeInTheDocument()
    expect(waiting.getByText(/等待持有该账号会话/).element().className).toContain('text-muted-foreground')
  })

  it('排队中显示占用等待原因与 Session 代次', async () => {
    mocks.fetchRunObservation.mockResolvedValue(
      observationOf(
        runDetail({
          status: 'QUEUED',
          stepRuns: [],
          placement: runPlacement({
            state: 'session_not_ready',
            sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            ownerWorkerId: 'worker-a',
            sessionStatus: 'OPEN',
            waitReason: 'SESSION_IN_USE_BY_RUN',
            occupyingRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            generation: 3,
            acquireReason: 'reused',
          }),
        }),
      ),
    )
    signIn(['run:read'])
    const screen = await renderPage()
    await expect.element(screen.getByText(/同一账号会话正在被另一条运行占用/)).toBeInTheDocument()
    await expect.element(screen.getByText(/代次 3/)).toBeInTheDocument()
    await expect.element(screen.getByText(/复用会话/)).toBeInTheDocument()
    await expect.element(screen.getByText(/占用运行/)).toBeInTheDocument()
    await expect.element(screen.getByText(/历史运行未冻结核验规则，按旧模式解释/)).toBeInTheDocument()
  })

  it('快照含 authVerification 时显示等级与修订，不用可用绿', async () => {
    mocks.fetchRunObservation.mockResolvedValue(
      observationOf(
        runDetail({
          status: 'QUEUED',
          stepRuns: [],
          snapshot: {
            schemaVersion: 1,
            runId: RUN_ID,
            targetId: '11111111-1111-4111-8111-111111111111',
            scenarioId: '33333333-3333-4333-8333-333333333333',
            scenarioVersionId: '55555555-5555-4555-8555-555555555555',
            steps: [],
            input: {},
            createdAt: '2026-09-11T02:00:00.000Z',
            authVerification: {
              profileRevision: 2,
              profileDigest: 'digest',
              loginFieldsDigest: 'fields',
              expectedIdentity: 'alice',
              capability: 'LOGIN_VERIFIED',
              freshnessSeconds: 300,
              verifyTimeoutMs: 15_000,
              loginTimeoutMs: 60_000,
              verifyRetryBackoffSeconds: [30, 120],
              platformConfigRevision: 1,
            },
          },
        }),
      ),
    )
    signIn(['run:read'])
    const screen = await renderPage()
    await expect.element(screen.getByText(/登录已核验/)).toBeInTheDocument()
    await expect.element(screen.getByText(/规则修订 2/)).toBeInTheDocument()
    expect(screen.getByText(/登录已核验/).element().className).toContain('text-muted-foreground')
  })

  it('两根轴并列：成功且证据不完整是橙色；终态收集中是灰色', async () => {
    mocks.fetchRunObservation.mockResolvedValue(
      observationOf(runDetail({ status: 'SUCCEEDED', evidenceStatus: 'INCOMPLETE', stepRuns: [] })),
    )
    signIn(['run:read'])
    const incomplete = await renderPage()
    await expect.element(incomplete.getByText('成功')).toBeInTheDocument()
    const incompleteBadge = incomplete.getByText('证据不完整')
    await expect.element(incompleteBadge).toBeInTheDocument()
    expect(incompleteBadge.element().closest('[data-slot="status-badge"]')?.className).toContain(
      'bg-status-warning-background',
    )

    mocks.fetchRunObservation.mockResolvedValue(
      observationOf(runDetail({ status: 'SUCCEEDED', evidenceStatus: 'PENDING', stepRuns: [] })),
    )
    const pending = await renderPage()
    const collecting = pending.getByText('证据收集中')
    await expect.element(collecting).toBeInTheDocument()
    expect(collecting.element().closest('[data-slot="status-badge"]')?.className).toContain(
      'bg-status-neutral-background',
    )
    expect(collecting.element().closest('[data-slot="status-badge"]')?.className).not.toContain(
      'bg-status-warning-background',
    )
  })

  it('步骤开始前失败：运行级错误证据在时间线上方', async () => {
    mocks.fetchRunObservation.mockResolvedValue(
      observationOf(
        runDetail({
          status: 'FAILED',
          targetAccountId: null,
          targetAccountName: null,
          stepRuns: [
            {
              id: '66666666-6666-4666-8666-666666666666',
              stepId: '77777777-7777-4777-8777-777777777777',
              name: '打开总览',
              type: 'navigate',
              ordinal: 0,
              status: 'SKIPPED',
              startedAt: null,
              finishedAt: '2026-09-11T02:00:02.000Z',
              attempts: [],
            },
          ],
        }),
        [
          {
            schemaVersion: 1,
            id: '99999999-9999-4999-8999-999999999992',
            runId: RUN_ID,
            type: 'error',
            status: 'available',
            createdAt: '2026-09-11T02:00:02.000Z',
            payload: {
              code: 'SESSION_ACCOUNT_REQUIRED',
              category: 'VALIDATION',
              retryable: false,
              safeMessage: '浏览器步骤未指定目标账号，无法建立会话',
            },
          },
        ],
      ),
    )
    signIn(['run:read'])
    const screen = await renderPage()
    await expect.element(screen.getByRole('heading', { name: '运行级证据' })).toBeInTheDocument()
    await expect.element(screen.getByText('浏览器步骤未指定目标账号，无法建立会话')).toBeInTheDocument()
    await expect.element(screen.getByText('运行在步骤开始前失败。原因见运行级证据。')).toBeInTheDocument()
  })

  it('缺失原因用橙色而不是红色；证据挂在对应 Attempt 下', async () => {
    mocks.fetchRunObservation.mockResolvedValue(
      observationOf(runDetail(), [
        {
          schemaVersion: 1,
          id: '99999999-9999-4999-8999-999999999991',
          runId: RUN_ID,
          stepRunId: '66666666-6666-4666-8666-666666666666',
          attemptId: '88888888-8888-4888-8888-888888888888',
          type: 'screenshot',
          status: 'missing',
          createdAt: '2026-09-11T02:00:09.000Z',
          missingReason: 'worker_lost',
        },
      ]),
    )
    signIn(['run:read', 'run:review'])
    const screen = await renderPage()
    await expect.element(screen.getByText(/Attempt #1/)).toBeInTheDocument()
    const reason = screen.getByText(/缺失原因：执行进程失联，现场字节已不可得/)
    await expect.element(reason).toBeInTheDocument()
    expect(reason.element().className).toContain('text-status-warning-foreground')
    expect(reason.element().className).not.toContain('text-destructive')
    await expect.element(screen.getByText(/本次采集：截图 失败时/)).toBeInTheDocument()
  })

  it('点刷新重新拉取运行与证据', async () => {
    signIn(['run:read'])
    const screen = await renderPage()
    await expect.element(screen.getByText('待核查')).toBeInTheDocument()
    expect(mocks.fetchRunObservation).toHaveBeenCalledTimes(1)
    await expect.element(screen.getByText('连接正常')).toBeInTheDocument()

    await screen.getByRole('button', { name: '刷新' }).click()
    await vi.waitFor(() => expect(mocks.fetchRunObservation).toHaveBeenCalledTimes(2))
    expect(mocks.subscribeRunEvents).toHaveBeenCalled()
  })

  it('当快照含 moduleManifest 时按动作模块分组展示，支持折叠与展开', async () => {
    signIn(['run:read'])
    const stepId1 = '77777777-7777-4777-8777-777777777771'
    const stepId2 = '77777777-7777-4777-8777-777777777772'
    const detailWithManifest = runDetail({
      status: 'SUCCEEDED',
      snapshot: {
        schemaVersion: 1,
        runId: RUN_ID,
        targetId: '11111111-1111-4111-8111-111111111111',
        scenarioId: '33333333-3333-4333-8333-333333333333',
        scenarioVersionId: '55555555-5555-4555-8555-555555555555',
        steps: [],
        input: {},
        createdAt: '2026-09-11T02:00:00.000Z',
        moduleManifest: {
          entries: [
            {
              invocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
              ordinal: 0,
              name: '统一登录',
              moduleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
              moduleKey: 'login.auth',
              moduleVersionId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
              versionNo: 2,
              contentDigest: 'content-digest',
              contractDigest: 'contract-digest',
              implementationDigest: 'impl-digest',
              implementationKey: 'default',
              executionMode: 'DETERMINISTIC',
              effectCeiling: 'SIDE_EFFECT',
              expandedStepIds: [stepId1, stepId2],
              internalToExpanded: { login: stepId1, submit: stepId2 },
              preconditionStepIds: [],
              postconditionStepIds: [],
              outputRequired: [],
              inputBindingsDigest: 'bindings-digest',
            },
          ],
        },
      },
      stepRuns: [
        {
          id: 'step-run-1',
          stepId: stepId1,
          name: '输入用户名',
          type: 'fill',
          ordinal: 0,
          status: 'SUCCEEDED',
          startedAt: '2026-09-11T02:00:01.000Z',
          finishedAt: '2026-09-11T02:00:02.000Z',
          attempts: [],
        },
        {
          id: 'step-run-2',
          stepId: stepId2,
          name: '点击登录',
          type: 'click',
          ordinal: 1,
          status: 'SUCCEEDED',
          startedAt: '2026-09-11T02:00:02.000Z',
          finishedAt: '2026-09-11T02:00:03.000Z',
          attempts: [],
        },
      ],
    })
    mocks.fetchRunObservation.mockResolvedValue({
      run: detailWithManifest,
      evidence: { items: [], nextCursor: null },
      realtime: false,
    })
    const screen = await renderPage()
    await expect.element(screen.getByText('统一登录')).toBeInTheDocument()
    await expect.element(screen.getByText('v2')).toBeInTheDocument()
    await expect.element(screen.getByText('步骤已按动作模块分组展示')).toBeInTheDocument()
    // 成功分组默认折叠
    await expect.element(screen.getByText('1. 输入用户名')).not.toBeInTheDocument()
    // 点击分组头部展开
    await screen.getByRole('button', { name: /统一登录/ }).click()
    await expect.element(screen.getByText('1. 输入用户名')).toBeInTheDocument()
    await expect.element(screen.getByText('2. 点击登录')).toBeInTheDocument()
  })

  it('AME-11 带 invocation 查询时展开对应模块分组', async () => {
    signIn(['run:read'])
    const stepId1 = '77777777-7777-4777-8777-777777777771'
    const stepId2 = '77777777-7777-4777-8777-777777777772'
    const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    mocks.search = { invocation: invocationId }
    const detailWithManifest = runDetail({
      status: 'SUCCEEDED',
      snapshot: {
        schemaVersion: 1,
        runId: RUN_ID,
        targetId: '11111111-1111-4111-8111-111111111111',
        scenarioId: '33333333-3333-4333-8333-333333333333',
        scenarioVersionId: '55555555-5555-4555-8555-555555555555',
        steps: [],
        input: {},
        createdAt: '2026-09-11T02:00:00.000Z',
        moduleManifest: {
          entries: [
            {
              invocationId,
              ordinal: 0,
              name: '统一登录',
              moduleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
              moduleKey: 'login.auth',
              moduleVersionId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
              versionNo: 2,
              contentDigest: 'content-digest',
              contractDigest: 'contract-digest',
              implementationDigest: 'impl-digest',
              implementationKey: 'default',
              executionMode: 'DETERMINISTIC',
              effectCeiling: 'SIDE_EFFECT',
              expandedStepIds: [stepId1, stepId2],
              internalToExpanded: { login: stepId1, submit: stepId2 },
              preconditionStepIds: [],
              postconditionStepIds: [],
              outputRequired: [],
              inputBindingsDigest: 'bindings-digest',
            },
          ],
        },
      },
      stepRuns: [
        {
          id: 'step-run-1',
          stepId: stepId1,
          name: '输入用户名',
          type: 'fill',
          ordinal: 0,
          status: 'SUCCEEDED',
          startedAt: '2026-09-11T02:00:01.000Z',
          finishedAt: '2026-09-11T02:00:02.000Z',
          attempts: [],
        },
        {
          id: 'step-run-2',
          stepId: stepId2,
          name: '点击登录',
          type: 'click',
          ordinal: 1,
          status: 'SUCCEEDED',
          startedAt: '2026-09-11T02:00:02.000Z',
          finishedAt: '2026-09-11T02:00:03.000Z',
          attempts: [],
        },
      ],
    })
    mocks.fetchRunObservation.mockResolvedValue({
      run: detailWithManifest,
      evidence: { items: [], nextCursor: null },
      realtime: false,
    })
    const screen = await renderPage()
    await expect.element(screen.getByText('1. 输入用户名')).toBeInTheDocument()
    expect(document.getElementById(`module-group-${invocationId}`)?.dataset.focused).toBe('true')
  })
})

/**
 * 页面不得把 TanStack Query 定时轮询当进度机制。P7 的 SSE 重连只允许出现在
 * 观察 hook 里，不能用 refetchInterval / EventSource / 页面级 setInterval。
 */
describe('运行与场景页不得有定时刷新', () => {
  const sources = {
    ...import.meta.glob('../runs/*.ts', { query: '?raw', import: 'default', eager: true }),
    ...import.meta.glob('../runs/*.tsx', { query: '?raw', import: 'default', eager: true }),
    ...import.meta.glob('../scenarios/*.tsx', { query: '?raw', import: 'default', eager: true }),
  } as Record<string, string>

  it('源码里没有 refetchInterval / EventSource / 页面级 setInterval', () => {
    const offenders = Object.entries(sources)
      .filter(([file]) => !file.endsWith('.test.tsx') && !file.endsWith('.test.ts'))
      .filter(([, code]) => /refetchInterval|refetchIntervalInBackground|setInterval|EventSource/.test(code))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })
})
