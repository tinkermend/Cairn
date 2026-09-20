import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { scenarioCapabilitiesFor } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
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
    await expect
      .element(screen.getByText(/试跑继承平台默认证据策略：截图 继承平台默认（始终），录像 继承平台默认（始终），Trace 继承平台默认（关闭）/))
      .toBeInTheDocument()
    await screen.getByRole('button', { name: '开始试跑' }).click()
    await vi.waitFor(() => expect(mocks.trialScenario).toHaveBeenCalledTimes(1))
    expect(mocks.trialScenario.mock.calls[0]![1]).not.toHaveProperty('evidencePolicy')
  })
})
