import '@/styles/index.css'
import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ScenarioAuthoringDocumentV2 } from '@cairn/shared'
import { ScenarioConfigWorkspace } from './scenario-config-workspace'
import * as scenariosApi from '@/lib/scenarios-api'

vi.mock('@/lib/scenarios-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/scenarios-api')>()
  return {
    ...actual,
    fetchScenarioResolutionStats: vi.fn(),
  }
})

const mockFetchStats = vi.mocked(scenariosApi.fetchScenarioResolutionStats)

describe('ScenarioConfigWorkspace - 定位稳定性与自愈分区', () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  const mockDoc: ScenarioAuthoringDocumentV2 = {
    schemaVersion: 1,
    authoringSchemaVersion: 2,
    inputs: [],
    nodes: [
      {
        kind: 'step',
        step: {
          id: 'step-1',
          name: '点击支付按钮',
          type: 'click',
          effectType: 'SIDE_EFFECT',
          input: {},
        } as any,
      },
    ],
  }

  it('展示定位稳定性分区与 100% 稳定徽标', async () => {
    mockFetchStats.mockResolvedValueOnce({
      items: [
        {
          stepId: 'step-1',
          scenarioVersionId: 'v1',
          targetId: 't1',
          deterministic: 5,
          map: 0,
          ai: 0,
          failed: 0,
          fallbackRate: 0,
        },
      ],
    })

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ScenarioConfigWorkspace
          scenarioId='sc-1'
          targetId='t1'
          document={mockDoc}
          locatorHealth={{
            healthMap: new Map(),
            overallScore: 100,
            healthyCount: 1,
            warningCount: 0,
            failingCount: 0,
            candidateCount: 0,
            candidates: [],
            isLoading: false,
            isError: false,
            adoptCandidate: vi.fn(),
            rejectCandidate: vi.fn(),
            batchAdoptAll: vi.fn(),
          }}
          onReturnToSteps={vi.fn()}
          onUpdateInputs={vi.fn()}
          onUpdateOutputs={vi.fn()}
          onUpdateScenarioOutcomes={vi.fn()}
          onUpdateRuntimeInvariants={vi.fn()}
          onUpdateDocument={vi.fn()}
        />
      </QueryClientProvider>,
    )

    const stabilityTab = screen.getByTestId('scenario-config-tab-stability')
    await expect.element(stabilityTab).toBeInTheDocument()
    await expect.element(stabilityTab).toHaveTextContent('定位稳定性')
    await expect.element(stabilityTab).toHaveTextContent('100%')

    const stabilitySection = document.querySelector('[data-partition="stability"]')
    expect(stabilitySection).not.toBeNull()
    await expect.element(screen.getByText('全部规则 100% 稳定')).toBeInTheDocument()
  })

  it('存在规则衰减时，展示衰减徽标与一键批量自愈横幅', async () => {
    mockFetchStats.mockResolvedValueOnce({
      items: [
        {
          stepId: 'step-1',
          scenarioVersionId: 'v1',
          targetId: 't1',
          deterministic: 1,
          map: 0,
          ai: 3,
          failed: 0,
          fallbackRate: 0.75,
        },
      ],
    })

    const onBatchAdopt = vi.fn()
    const onSelectStep = vi.fn()

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ScenarioConfigWorkspace
          scenarioId='sc-1'
          targetId='t1'
          document={mockDoc}
          locatorHealth={{
            healthMap: new Map(),
            overallScore: 25,
            healthyCount: 0,
            warningCount: 1,
            failingCount: 0,
            candidateCount: 1,
            candidates: [{} as any],
            isLoading: false,
            isError: false,
            adoptCandidate: vi.fn(),
            rejectCandidate: vi.fn(),
            batchAdoptAll: vi.fn(),
          }}
          onBatchAdopt={onBatchAdopt}
          onSelectStep={onSelectStep}
          onReturnToSteps={vi.fn()}
          onUpdateInputs={vi.fn()}
          onUpdateOutputs={vi.fn()}
          onUpdateScenarioOutcomes={vi.fn()}
          onUpdateRuntimeInvariants={vi.fn()}
          onUpdateDocument={vi.fn()}
        />
      </QueryClientProvider>,
    )

    const stabilityTab = screen.getByTestId('scenario-config-tab-stability')
    await expect.element(stabilityTab).toHaveTextContent('1 衰减')

    const banner = screen.getByTestId('batch-healing-banner')
    await expect.element(banner).toBeInTheDocument()
    await expect.element(banner).toHaveTextContent('检测到 1 个步骤有可用的定位自愈建议')

    const batchBtn = screen.getByRole('button', { name: '一键批量自愈' })
    await batchBtn.click()
    expect(onBatchAdopt).toHaveBeenCalledOnce()
  })
})
