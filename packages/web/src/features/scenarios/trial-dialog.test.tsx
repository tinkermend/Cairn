import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { scenarioCapabilitiesFor } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { ApiRequestError } from '@/lib/api-client'
import { TrialDialog } from './trial-dialog'

const SCENARIO_ID = '33333333-3333-4333-8333-333333333333'
const TARGET_ID = '11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => ({
  trialScenario: vi.fn(),
  fetchScenarioCapabilities: vi.fn(),
  fetchTargetAccounts: vi.fn(),
  fetchTarget: vi.fn(),
}))

vi.mock('@/lib/scenarios-api', () => ({
  trialScenario: mocks.trialScenario,
  fetchScenarioCapabilities: mocks.fetchScenarioCapabilities,
}))
vi.mock('@/lib/targets-api', () => ({
  fetchTargetAccounts: mocks.fetchTargetAccounts,
  fetchTarget: mocks.fetchTarget,
}))

describe('TrialDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchScenarioCapabilities.mockResolvedValue(scenarioCapabilitiesFor({ browserAiEnabled: false }))
    mocks.fetchTargetAccounts.mockResolvedValue({ items: [] })
    mocks.fetchTarget.mockResolvedValue({
      id: TARGET_ID,
      authMethod: 'form',
      captchaMode: 'none',
    })
    mocks.trialScenario.mockResolvedValue({ id: 'run-1' })
  })

  it('试跑说明继承平台默认，不单独覆盖证据', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <TrialDialog
          open
          onOpenChange={vi.fn()}
          scenarioId={SCENARIO_ID}
          targetId={TARGET_ID}
          revision={1}
          inputs={[]}
          onCreated={vi.fn()}
          onConflict={vi.fn()}
        />
      </QueryClientProvider>,
    )
    await expect.element(screen.getByText('默认证据：')).toBeInTheDocument()
    await expect.element(screen.getByText('截图（始终）')).toBeInTheDocument()
    await expect.element(screen.getByText('录像（始终）')).toBeInTheDocument()
    await expect.element(screen.getByText('Trace（关闭）')).toBeInTheDocument()
    await screen.getByRole('button', { name: '开始试跑' }).click()
    await vi.waitFor(() => expect(mocks.trialScenario).toHaveBeenCalledTimes(1))
    expect(mocks.trialScenario.mock.calls[0]![1]).not.toHaveProperty('evidencePolicy')
  })

  it('点击取消按钮触发 onOpenChange(false)', async () => {
    const onOpenChange = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <TrialDialog
          open
          onOpenChange={onOpenChange}
          scenarioId={SCENARIO_ID}
          targetId={TARGET_ID}
          revision={1}
          inputs={[]}
          onCreated={vi.fn()}
          onConflict={vi.fn()}
        />
      </QueryClientProvider>,
    )
    await screen.getByRole('button', { name: '取消' }).click()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('支持 pauseBeforeStepId 断点试跑模式', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <TrialDialog
          open
          onOpenChange={vi.fn()}
          scenarioId={SCENARIO_ID}
          targetId={TARGET_ID}
          revision={1}
          inputs={[]}
          pauseBeforeStepId='step-123'
          onCreated={vi.fn()}
          onConflict={vi.fn()}
        />
      </QueryClientProvider>,
    )
    await expect.element(screen.getByText('运行到此步前置')).toBeInTheDocument()
    await screen.getByRole('button', { name: '开始断点试跑' }).click()
    await vi.waitFor(() => expect(mocks.trialScenario).toHaveBeenCalledTimes(1))
    expect(mocks.trialScenario.mock.calls[0]![1]).toMatchObject({
      pauseBeforeStepId: 'step-123',
    })
  })

  it('服务端拒绝编译时在弹窗中展示可操作的诊断', async () => {
    mocks.trialScenario.mockRejectedValueOnce(new ApiRequestError(400, {
      code: 'SCENARIO_COMPILE_BLOCKED',
      message: '场景编译未通过',
      requestId: 'req-compile',
      details: { diagnostics: [{ message: '点击步骤只有语义描述，请点选目标或调整解析档位' }] },
    }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <TrialDialog
          open
          onOpenChange={vi.fn()}
          scenarioId={SCENARIO_ID}
          targetId={TARGET_ID}
          revision={1}
          inputs={[]}
          onCreated={vi.fn()}
          onConflict={vi.fn()}
        />
      </QueryClientProvider>,
    )
    await screen.getByRole('button', { name: '开始试跑' }).click()
    await expect.element(screen.getByRole('alert').getByText('点击步骤只有语义描述，请点选目标或调整解析档位')).toBeInTheDocument()
  })
})
