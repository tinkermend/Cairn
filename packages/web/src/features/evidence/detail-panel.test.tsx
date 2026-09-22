import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { EvidenceDetailResponse, RunDetailDto, RunEvidenceListResponse } from '@cairn/shared'
import { EvidenceDetailBody } from './detail-panel'

const mockRunObservation = vi.hoisted(() => ({
  value: {
    run: undefined as RunDetailDto | undefined,
    evidence: undefined as RunEvidenceListResponse | undefined,
    query: { isPending: false, isError: false },
  },
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={String(to)}>{children}</a>,
}))

vi.mock('@/features/runs/use-run-observation', () => ({
  useRunObservation: () => mockRunObservation.value,
}))

const mockDetail: EvidenceDetailResponse = {
  item: {
    evidence: {
      schemaVersion: 1,
      id: 'evi-222',
      runId: 'run-100',
      stepRunId: 'step-run-2',
      attemptId: 'att-2',
      type: 'screenshot',
      status: 'available',
      createdAt: '2026-09-21T10:00:00.000Z',
    },
    targetId: 'target-1',
    targetName: '测试业务后台',
    targetNameCurrent: '测试业务后台',
    targetDeleted: false,
    scenarioId: 'scen-1',
    scenarioName: '订单自动审核流程',
    scenarioNameCurrent: '订单自动审核流程',
    scenarioDeleted: false,
    scenarioVersionId: 'ver-1',
    scenarioVersionNo: 1,
    scenarioVersionKind: 'published',
    stepName: '输入审核意见',
    stepOrdinal: 1,
    attemptNo: 1,
    runStatus: 'FAILED',
    stepRunStatus: 'SUCCEEDED',
    attemptStatus: 'SUCCEEDED',
    outcomeStatus: 'FAIL',
    runEvidenceStatus: 'COMPLETE',
    displayStatus: 'available',
    displayStatusLabel: '可查看',
    filterBuckets: ['available'],
    overlayProtected: false,
    retainUntil: '2026-09-28T00:00:00.000Z',
    retainUntilUnknown: false,
    byteSize: 1024,
    byteSizeUnknown: false,
    errorSummary: null,
    objectLinked: true,
    reasonCode: null,
    reasonUnknown: false,
  },
  related: {
    sameAttempt: [],
    runVideo: null,
  },
}

const mockRun = {
  id: 'run-100',
  schemaVersion: 1,
  scenarioId: 'scen-1',
  scenarioVersionId: 'ver-1',
  scenarioVersionNo: 1,
  scenarioVersionKind: 'published',
  scenarioName: '订单自动审核流程',
  targetId: 'target-1',
  targetName: '测试业务后台',
  targetAccountId: 'acc-1',
  status: 'FAILED',
  outcomeStatus: 'FAIL',
  evidenceStatus: 'COMPLETE',
  createdAt: '2026-09-21T09:59:00.000Z',
  startedAt: '2026-09-21T09:59:01.000Z',
  finishedAt: '2026-09-21T10:00:05.000Z',
  context: {},
  stepRuns: [
    {
      id: 'step-run-1',
      stepId: 'step-1',
      ordinal: 0,
      name: '打开待审核订单列表',
      type: 'navigate',
      status: 'SUCCEEDED',
      outcomeStatus: 'PASS',
      startedAt: '2026-09-21T09:59:01.000Z',
      finishedAt: '2026-09-21T09:59:03.000Z',
      attempts: [
        {
          id: 'att-1',
          attemptNo: 1,
          status: 'SUCCEEDED',
          startedAt: '2026-09-21T09:59:01.000Z',
          finishedAt: '2026-09-21T09:59:03.000Z',
          error: null,
          output: null,
        },
      ],
    },
    {
      id: 'step-run-2',
      stepId: 'step-2',
      ordinal: 1,
      name: '输入审核意见',
      type: 'input',
      status: 'SUCCEEDED',
      outcomeStatus: 'PASS',
      startedAt: '2026-09-21T09:59:03.000Z',
      finishedAt: '2026-09-21T09:59:05.000Z',
      attempts: [
        {
          id: 'att-2',
          attemptNo: 1,
          status: 'SUCCEEDED',
          startedAt: '2026-09-21T09:59:03.000Z',
          finishedAt: '2026-09-21T09:59:05.000Z',
          error: null,
          output: null,
        },
      ],
    },
    {
      id: 'step-run-3',
      stepId: 'step-3',
      ordinal: 2,
      name: '点击确认提交审核',
      type: 'click',
      status: 'FAILED',
      outcomeStatus: 'FAIL',
      startedAt: '2026-09-21T09:59:05.000Z',
      finishedAt: '2026-09-21T10:00:05.000Z',
      attempts: [
        {
          id: 'att-3',
          attemptNo: 1,
          status: 'FAILED',
          startedAt: '2026-09-21T09:59:05.000Z',
          finishedAt: '2026-09-21T10:00:05.000Z',
          error: {
            code: 'ELEMENT_NOT_FOUND',
            category: 'TIMEOUT',
            retryable: false,
            safeMessage: '等待提交按钮超时：未能找到可交互的 #btn-submit',
          },
          output: null,
        },
      ],
    },
  ],
  snapshot: {
    schemaVersion: 1,
    runId: 'run-100',
    targetId: 'target-1',
    scenarioId: 'scen-1',
    scenarioVersionId: 'ver-1',
    steps: [],
  },
} as unknown as RunDetailDto

describe('EvidenceDetailBody 详情抽屉与全景执行流水线', () => {
  it('抽屉内展示全景执行流水线，清晰看到前序通过、本步位置与后续失败的具体步骤', async () => {
    mockRunObservation.value = {
      run: mockRun,
      evidence: { items: [] },
      query: { isPending: false, isError: false },
    }

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <EvidenceDetailBody detail={mockDetail} />
      </QueryClientProvider>,
    )

    // 1. 验证上下文信息
    await expect.element(screen.getByText('测试业务后台')).toBeInTheDocument()
    await expect.element(screen.getByText('订单自动审核流程')).toBeInTheDocument()

    // 2. 验证全景执行流水线标题与步骤概览
    await expect.element(screen.getByRole('heading', { name: '全景执行流水线' })).toBeInTheDocument()
    await expect.element(screen.getByText(/共 3 步 · 失败/)).toBeInTheDocument()

    // 3. 验证步骤 1（已通过）
    await expect.element(screen.getByText('1. 打开待审核订单列表')).toBeInTheDocument()

    // 4. 验证步骤 2（当前证据所在步骤）
    await expect.element(screen.getByText('2. 输入审核意见')).toBeInTheDocument()
    const step2El = screen.container.querySelector('#step-run-step-run-2')
    expect(step2El).not.toBeNull()
    expect(step2El?.getAttribute('data-current')).toBe('true')

    // 5. 验证步骤 3（后续失败步骤及其明确报错信息）
    await expect.element(screen.getByText('3. 点击确认提交审核')).toBeInTheDocument()
    await expect.element(screen.getByText(/ELEMENT_NOT_FOUND: 等待提交按钮超时：未能找到可交互的 #btn-submit/)).toBeInTheDocument()
  })

  it('流水线加载中状态优雅提示', async () => {
    mockRunObservation.value = {
      run: undefined,
      evidence: undefined,
      query: { isPending: true, isError: false },
    }

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <EvidenceDetailBody detail={mockDetail} />
      </QueryClientProvider>,
    )

    await expect.element(screen.getByText('正在加载完整步骤流水线...')).toBeInTheDocument()
  })
})
