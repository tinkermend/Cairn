import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { RunResolutionDecisions } from './resolution-decisions'

const mocks = vi.hoisted(() => ({
  fetchRunResolutionDecisions: vi.fn(),
}))

vi.mock('@/lib/runs-api', () => mocks)

function signIn(permissions = ['run:read', 'target:read']) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions,
  })
}

const STEP_RUN_ID = '00000000-0000-4000-8000-000000000022'

async function renderDecisions(resolution?: Parameters<typeof RunResolutionDecisions>[0]['resolution']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RunResolutionDecisions
        runId='00000000-0000-4000-8000-000000000021'
        resolution={resolution}
        steps={[
          {
            id: STEP_RUN_ID,
            stepId: '00000000-0000-4000-8000-000000000023',
            name: '提交查询',
            type: 'click',
            ordinal: 0,
            status: 'SUCCEEDED',
            outcomeStatus: 'NOT_EVALUATED',
            startedAt: '2026-09-20T00:00:00.000Z',
            finishedAt: '2026-09-20T00:00:02.000Z',
            attempts: [],
          },
        ]}
      />
    </QueryClientProvider>,
  )
}

describe('运行页解析决策', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900)
    vi.clearAllMocks()
    signIn()
  })

  it('缺少读取权限时不请求', async () => {
    signIn(['run:read'])
    mocks.fetchRunResolutionDecisions.mockResolvedValue({ items: [] })
    await renderDecisions()
    expect(mocks.fetchRunResolutionDecisions).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('目标解析')
  })

  it('展示步骤名与策略文案，不用 eventSeq 另开缓存', async () => {
    mocks.fetchRunResolutionDecisions.mockResolvedValue({
      items: [
        {
          decisionId: '00000000-0000-4000-8000-000000000031',
          runId: '00000000-0000-4000-8000-000000000021',
          stepRunId: STEP_RUN_ID,
          attemptId: '00000000-0000-4000-8000-000000000024',
          stepId: '00000000-0000-4000-8000-000000000023',
          effectivePolicy: 'prefer_deterministic',
          rungs: [
            { rung: 'D', outcome: 'TARGET_NOT_FOUND', spentMs: 12 },
            { rung: 'M', outcome: 'SKIPPED', spentMs: 1 },
            { rung: 'A', outcome: 'FOUND', spentMs: 3200 },
          ],
          decision: 'ai',
          evidenceRefs: [],
        },
      ],
    })
    await renderDecisions()
    await expect.element(page.getByText('经 AI 定位')).toBeVisible()
    await expect.element(page.getByText(/提交查询/)).toBeVisible()
    await expect.element(page.getByText(/规则优先，AI 兜底/)).toBeVisible()
    await expect.element(page.getByText(/规则\(未找到目标\) → 地图修复\(未尝试\) → 模型\(命中\)/)).toBeVisible()
  })

  it('断点重试覆盖定位顺序时区分原始冻结计划和实际尝试', async () => {
    mocks.fetchRunResolutionDecisions.mockResolvedValue({
      items: [{
        decisionId: '00000000-0000-4000-8000-000000000031',
        runId: '00000000-0000-4000-8000-000000000021',
        stepRunId: STEP_RUN_ID,
        attemptId: '00000000-0000-4000-8000-000000000024',
        stepId: '00000000-0000-4000-8000-000000000023',
        effectivePolicy: 'deterministic_only',
        plan: { v: 2, order: ['rule'] },
        rungs: [{ rung: 'D', outcome: 'FOUND', spentMs: 10 }],
        decision: 'deterministic',
        evidenceRefs: [],
      }],
    })
    await renderDecisions({
      protocol: 'snapshot.resolution@2',
      allowed: ['rule', 'text_ai'],
      steps: {
        '00000000-0000-4000-8000-000000000023': {
          requested: ['text_ai'], actual: ['text_ai'], skipped: [], source: 'step',
        },
      },
    })
    await expect.element(page.getByText(/调试覆盖 规则/)).toBeVisible()
    await page.getByText('创建运行时冻结的定位计划').click()
    await expect.element(page.getByText(/请求 文本模型；实际 文本模型/)).toBeVisible()
  })

  it('分页只请求对应游标，SSE 提示触发重新读取', async () => {
    mocks.fetchRunResolutionDecisions.mockResolvedValue({
      items: [],
      nextCursor: '00000000-0000-4000-8000-000000000050',
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <RunResolutionDecisions runId='run' eventSeq={1} />
      </QueryClientProvider>,
    )
    await page.getByRole('button', { name: '下一页' }).click()
    await vi.waitFor(() =>
      expect(mocks.fetchRunResolutionDecisions).toHaveBeenCalledWith(
        'run',
        expect.objectContaining({ cursor: '00000000-0000-4000-8000-000000000050' }),
      ),
    )
    const before = mocks.fetchRunResolutionDecisions.mock.calls.length
    await screen.rerender(
      <QueryClientProvider client={client}>
        <RunResolutionDecisions runId='run' eventSeq={2} />
      </QueryClientProvider>,
    )
    await vi.waitFor(() => expect(mocks.fetchRunResolutionDecisions.mock.calls.length).toBeGreaterThan(before))
  })
})
