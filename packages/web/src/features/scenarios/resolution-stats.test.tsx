import '@/styles/index.css'
import { render } from 'vitest-browser-react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ScenarioResolutionStats } from './resolution-stats'
import * as scenariosApi from '@/lib/scenarios-api'

vi.mock('@/lib/scenarios-api', () => ({
  fetchScenarioResolutionStats: vi.fn(),
}))

const mockFetchStats = vi.mocked(scenariosApi.fetchScenarioResolutionStats)

describe('ScenarioResolutionStats', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })
    vi.clearAllMocks()
  })

  it('数据为空时不渲染任何内容', async () => {
    mockFetchStats.mockResolvedValueOnce({ items: [] })

    const { container } = await render(
      <QueryClientProvider client={queryClient}>
        <ScenarioResolutionStats scenarioId='sc-1' />
      </QueryClientProvider>,
    )

    await expect.element(container).toBeEmptyDOMElement()
  })

  it('展示解析兜底统计：包含步骤名、序号、健康度徽标与人话描述', async () => {
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
        {
          stepId: 'step-2',
          scenarioVersionId: 'v1',
          targetId: 't1',
          deterministic: 1,
          map: 0,
          ai: 3,
          failed: 0,
          fallbackRate: 0.75,
        },
        {
          stepId: 'step-3',
          scenarioVersionId: 'v1',
          targetId: 't1',
          deterministic: 0,
          map: 0,
          ai: 0,
          failed: 2,
          fallbackRate: null,
        },
      ],
    })

    const sampleSteps = [
      { id: 'step-1', name: '打开登录页面' },
      { id: 'step-2', name: '点击登录按钮' },
      { id: 'step-3', name: '输入验证码' },
    ]

    const onSelectStep = vi.fn()

    const { getByText } = await render(
      <QueryClientProvider client={queryClient}>
        <ScenarioResolutionStats
          scenarioId='sc-1'
          steps={sampleSteps}
          onSelectStep={onSelectStep}
        />
      </QueryClientProvider>,
    )

    // 检查卡片标题与聚合徽标
    await expect.element(getByText('元素定位稳定性（规则命中率）')).toBeInTheDocument()
    await expect.element(getByText('1 步发生规则衰减')).toBeInTheDocument()
    await expect.element(getByText('1 步定位失败')).toBeInTheDocument()

    // 检查步骤 1：规则稳定 (100%)
    await expect.element(getByText('第 1 步 · 打开登录页面')).toBeInTheDocument()
    await expect.element(getByText('规则稳定 (100%)')).toBeInTheDocument()

    // 检查步骤 2：规则衰减 25%（AI 兜底 75%）
    await expect.element(getByText('第 2 步 · 点击登录按钮')).toBeInTheDocument()
    await expect.element(getByText('规则命中 25%（AI 兜底 75%）')).toBeInTheDocument()

    // 检查步骤 3：定位失败
    await expect.element(getByText('第 3 步 · 输入验证码')).toBeInTheDocument()
    await expect.element(getByText('定位失败 (2)')).toBeInTheDocument()

    // 测试点击交互：点击步骤 2 触发 onSelectStep
    await getByText('第 2 步 · 点击登录按钮').click()
    expect(onSelectStep).toHaveBeenCalledWith('step-2')
  })

  it('对于已从草稿中删除的步骤，展示为已移除的历史步骤折叠区与真实历史名称', async () => {
    mockFetchStats.mockResolvedValueOnce({
      items: [
        {
          stepId: 'deleted-step-uuid-1234',
          stepName: '历史点击登录按钮',
          scenarioVersionId: 'v1',
          targetId: 't1',
          deterministic: 2,
          map: 0,
          ai: 0,
          failed: 0,
          fallbackRate: 0,
        },
      ],
    })

    const { getByText } = await render(
      <QueryClientProvider client={queryClient}>
        <ScenarioResolutionStats scenarioId='sc-1' steps={[]} />
      </QueryClientProvider>,
    )

    const toggle = getByText('已从当前草稿移除的历史步骤 (1)')
    await expect.element(toggle).toBeInTheDocument()
    await toggle.click()

    await expect.element(getByText('历史步骤 · 历史点击登录按钮')).toBeInTheDocument()
    await expect.element(getByText('已从草稿移除')).toBeInTheDocument()
  })
})
