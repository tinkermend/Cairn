import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { AiTaskListResponse, CreateSolidificationDraftResponse } from '@cairn/shared'
import { AiActionTracePanel } from './ai-action-trace'

const mocks = vi.hoisted(() => ({
  fetchAttemptAiTasks: vi.fn(),
  createSolidificationDraft: vi.fn(),
  useCan: vi.fn(() => true),
}))

vi.mock('@/lib/runs-api', () => ({
  fetchAttemptAiTasks: mocks.fetchAttemptAiTasks,
  createSolidificationDraft: mocks.createSolidificationDraft,
}))

vi.mock('@/hooks/use-permissions', () => ({
  useCan: () => mocks.useCan(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

const runId = '66666666-6666-4666-8666-666666666666'
const attemptId = '77777777-7777-4777-8777-777777777777'

const mockData: AiTaskListResponse = {
  events: [
    {
      attemptId,
      runId,
      stepRunId: 'sr-1',
      source: 'action_edge' as const,
      timestamp: '2026-09-24T10:00:00.000Z',
      agentInstanceId: 'agent-1',
      ordinal: 1,
      phase: 'completed',
      actionName: 'Tap',
      sdkVersion: '1.0.0',
      elementDescription: '确认按钮',
      binding: {
        status: 'bound',
        candidates: [{ by: 'role', value: 'button', name: '确认' }],
        redirected: false,
        dataDependent: false,
      },
      valueProvenance: { kind: 'none' },
      pageBefore: {
        url: 'https://example.com',
        urlPattern: 'https://example.com',
        documentEpoch: 1,
        readyState: 'complete',
        timestamp: '2026-09-24T10:00:00.000Z',
      },
      pageAfter: {
        url: 'https://example.com/done',
        urlPattern: 'https://example.com/done',
        documentEpoch: 2,
        readyState: 'complete',
        timestamp: '2026-09-24T10:00:01.000Z',
      },
      writeSignalCount: 1,
      writeSignalPaths: ['POST /api/submit'],
      durationMs: 300,
    },
  ],
  observation: {
    attemptId,
    runId,
    stepRunId: '88888888-8888-4888-8888-888888888888',
    stepId: 'step-1',
    scenarioId: '33333333-3333-4333-8333-333333333333',
    scenarioVersion: 1,
    targetId: '11111111-1111-4111-8111-111111111111',
    targetAccountId: null,
    stepDefinitionDigest: 'digest-1',
    namespaceDigest: 'ns-1',
    signature: 'sig-1',
    actionCount: 1,
    solidifiableLevel: 'full',
    solidifiableReasons: [],
    traceIntegrity: 'complete',
    modelCalls: 1,
    inputTokens: 100,
    outputTokens: 20,
    durationMs: 300,
    stepResult: 'SUCCEEDED',
    recordedAt: '2026-09-24T10:00:01.000Z',
  },
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AiActionTracePanel runId={runId} attemptId={attemptId} />
    </QueryClientProvider>,
  )
}

describe('AiActionTracePanel', () => {
  beforeEach(() => {
    mocks.fetchAttemptAiTasks.mockReset()
    mocks.createSolidificationDraft.mockReset()
    mocks.useCan.mockReturnValue(true)
  })

  it('展开后渲染动作详情与固化草案按钮，点击可触发生成', async () => {
    mocks.fetchAttemptAiTasks.mockResolvedValue(mockData)
    const draftResponse: CreateSolidificationDraftResponse = {
      recordingDraftId: 'rec-draft-1',
      scenarioId: mockData.observation!.scenarioId,
      sourceNodeId: 'step-1',
      sourceNodePresent: true,
      definitionChanged: false,
      diagnostics: [],
    }
    mocks.createSolidificationDraft.mockResolvedValue(draftResponse)

    const screen = await renderPanel()
    // 默认折叠，展示摘要
    await expect.element(screen.getByText('AI 动作')).toBeVisible()

    // 展开面板
    await screen.getByRole('button', { name: /AI 动作/ }).click()

    // 验证渲染动作与候选
    await expect.element(screen.getByText('Tap')).toBeVisible()
    await expect.element(screen.getByText('确认按钮')).toBeVisible()
    await expect.element(screen.getByText('role: button')).toBeVisible()

    // 验证展示「生成确定性草案」按钮并点击
    const solidifyBtn = screen.getByRole('button', { name: '生成确定性草案' })
    await expect.element(solidifyBtn).toBeVisible()
    await solidifyBtn.click()

    expect(mocks.createSolidificationDraft).toHaveBeenCalledWith(runId, attemptId)
    // 生成成功后出现提示与前往工作台按钮
    await expect.element(screen.getByText('确定性草案已就绪')).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '前往工作台导入' })).toBeVisible()
  })

  it('轨迹等级为 blocked 时生成按钮被禁用', async () => {
    mocks.fetchAttemptAiTasks.mockResolvedValue({
      ...mockData,
      observation: {
        ...mockData.observation!,
        solidifiableLevel: 'blocked',
        solidifiableReasons: ['TRAJECTORY_INCOMPLETE'],
      },
    })

    const screen = await renderPanel()
    await screen.getByRole('button', { name: /AI 动作/ }).click()

    const solidifyBtn = screen.getByRole('button', { name: '生成确定性草案' })
    await expect.element(solidifyBtn).toBeDisabled()
  })
})
