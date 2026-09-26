import '@/styles/index.css'
import { render } from 'vitest-browser-react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useScenarioLocatorHealth } from './use-scenario-locator-health'
import * as scenariosApi from '@/lib/scenarios-api'
import * as repairApi from '@/lib/repair-api'
import type { RepairCandidate } from '@cairn/shared'

vi.mock('@/lib/scenarios-api', () => ({
  fetchScenarioResolutionStats: vi.fn(),
}))

vi.mock('@/lib/repair-api', () => ({
  fetchScenarioRepairCandidates: vi.fn(),
  adoptRepairCandidate: vi.fn(),
  rejectRepairCandidate: vi.fn(),
}))

function HealthTestConsumer({
  scenarioId,
  steps,
  onApply,
}: {
  scenarioId: string
  steps: { id: string; name?: string }[]
  onApply?: any
}) {
  const health = useScenarioLocatorHealth(scenarioId, steps, onApply)
  if (health.isLoading) return <div>加载中...</div>

  const cand = health.candidates[0]

  return (
    <div>
      <div data-testid='score'>{health.overallScore}</div>
      <div data-testid='candidate-count'>{health.candidateCount}</div>
      {Array.from(health.healthMap.entries()).map(([id, h]) => (
        <div key={id} data-testid={`health-${id}`}>
          {h.status}-{h.ruleHitRate}
        </div>
      ))}
      {cand && (
        <button
          data-testid='adopt-btn'
          onClick={() => void health.adoptCandidate(cand, 2)}
        >
          采纳
        </button>
      )}
    </div>
  )
}

describe('useScenarioLocatorHealth', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })
  })

  it('正确聚合步骤健康度与 100 分制打分', async () => {
    vi.mocked(scenariosApi.fetchScenarioResolutionStats).mockResolvedValue({
      items: [
        {
          scenarioId: 'sc-1',
          scenarioVersionId: 'ver-1',
          targetId: 'tar-1',
          stepId: 'step-1',
          ruleFamily: 'css',
          deterministic: 10,
          map: 0,
          ai: 0,
          failed: 0,
          fallbackRate: 0,
        },
        {
          scenarioId: 'sc-1',
          scenarioVersionId: 'ver-1',
          targetId: 'tar-1',
          stepId: 'step-2',
          ruleFamily: 'css',
          deterministic: 1,
          map: 0,
          ai: 3,
          failed: 0,
          fallbackRate: 0.75,
        },
        {
          scenarioId: 'sc-1',
          scenarioVersionId: 'ver-1',
          targetId: 'tar-1',
          stepId: 'step-3',
          ruleFamily: 'css',
          deterministic: 0,
          map: 0,
          ai: 0,
          failed: 2,
          fallbackRate: null,
        },
      ] as any,
    })

    const mockCandidates = [
      {
        id: 'cand-1',
        scenarioId: 'sc-1',
        incidentId: 'inc-1',
        status: 'proposed',
        cause: 'LOCATOR_DRIFT',
        summary: '选择器漂移自愈',
        patchTargetRef: { kind: 'scenario', stepId: 'step-2', sourceDefinitionDigest: 'dig-1' },
        patch: {
          kind: 'REPLACE_LOCATOR',
          suggestedCandidate: { by: 'role', value: 'button', name: '提交' },
        },
        confidence: 0.95,
        riskLevel: 'low',
        evidenceRefs: [],
        createdAt: '2026-09-26T00:00:00Z',
        updatedAt: '2026-09-26T00:00:00Z',
      },
    ] as any as RepairCandidate[]

    vi.mocked(repairApi.fetchScenarioRepairCandidates).mockResolvedValue(mockCandidates)

    const steps = [
      { id: 'step-1', name: '打开页面' },
      { id: 'step-2', name: '点击提交' },
      { id: 'step-3', name: '断言弹窗' },
      { id: 'step-4', name: '未运行步骤' },
    ]

    const { getByTestId } = await render(
      <QueryClientProvider client={queryClient}>
        <HealthTestConsumer scenarioId='sc-1' steps={steps} />
      </QueryClientProvider>,
    )

    // 100 - warning(1)*10 - failing(1)*25 = 65
    await expect.element(getByTestId('score')).toHaveTextContent('65')
    await expect.element(getByTestId('candidate-count')).toHaveTextContent('1')
    await expect.element(getByTestId('health-step-1')).toHaveTextContent('healthy-1')
    await expect.element(getByTestId('health-step-2')).toHaveTextContent('fallback_warning-0.25')
    await expect.element(getByTestId('health-step-3')).toHaveTextContent('failing-')
    await expect.element(getByTestId('health-step-4')).toHaveTextContent('untested-')
  })

  it('adoptCandidate 会应用到草稿并调用 API', async () => {
    vi.mocked(scenariosApi.fetchScenarioResolutionStats).mockResolvedValue({ items: [] })
    const candidate = {
      id: 'cand-1',
      scenarioId: 'sc-1',
      incidentId: 'inc-1',
      status: 'proposed',
      cause: 'LOCATOR_DRIFT',
      summary: '自愈建议',
      patchTargetRef: { kind: 'scenario', stepId: 'step-1', sourceDefinitionDigest: 'dig-1' },
      patch: {
        kind: 'REPLACE_LOCATOR',
        suggestedCandidate: { by: 'text', value: '登录' },
      },
      confidence: 0.98,
      riskLevel: 'low',
      evidenceRefs: [],
      createdAt: '2026-09-26T00:00:00Z',
      updatedAt: '2026-09-26T00:00:00Z',
    } as any as RepairCandidate
    vi.mocked(repairApi.fetchScenarioRepairCandidates).mockResolvedValue([candidate])
    vi.mocked(repairApi.adoptRepairCandidate).mockResolvedValue({} as any)

    const applyDraftMock = vi.fn()

    const { getByTestId } = await render(
      <QueryClientProvider client={queryClient}>
        <HealthTestConsumer
          scenarioId='sc-1'
          steps={[{ id: 'step-1' }]}
          onApply={applyDraftMock}
        />
      </QueryClientProvider>,
    )

    await expect.element(getByTestId('candidate-count')).toHaveTextContent('1')
    await getByTestId('adopt-btn').click()

    expect(applyDraftMock).toHaveBeenCalledWith([
      { stepId: 'step-1', candidate: { by: 'text', value: '登录' } },
    ])
    expect(repairApi.adoptRepairCandidate).toHaveBeenCalledWith('cand-1', {
      expectedRevision: 2,
    })
  })
})
