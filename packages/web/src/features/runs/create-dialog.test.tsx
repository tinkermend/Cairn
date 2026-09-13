import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { scenarioCapabilitiesFor } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { RunCreateDialog } from './create-dialog'

const SCENARIO_ID = '33333333-3333-4333-8333-333333333333'
const TARGET_ID = '11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => ({
  createRun: vi.fn(),
  fetchScenarios: vi.fn(),
  fetchScenarioCapabilities: vi.fn(),
  fetchTargetAccounts: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@/lib/runs-api', () => ({ createRun: mocks.createRun }))
vi.mock('@/lib/scenarios-api', () => ({
  fetchScenarios: mocks.fetchScenarios,
  fetchScenarioCapabilities: mocks.fetchScenarioCapabilities,
}))
vi.mock('@/lib/targets-api', () => ({ fetchTargetAccounts: mocks.fetchTargetAccounts }))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => mocks.navigate }
})

async function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RunCreateDialog open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  )
}

describe('RunCreateDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchScenarios.mockResolvedValue({
      items: [{ id: SCENARIO_ID, name: '回显', targetId: TARGET_ID, status: 'active' }],
    })
    mocks.fetchScenarioCapabilities.mockResolvedValue(scenarioCapabilitiesFor({ browserAiEnabled: false }))
    mocks.fetchTargetAccounts.mockResolvedValue({ items: [] })
    mocks.createRun.mockResolvedValue({ id: 'run-1' })
  })

  it('未改采集方式时不提交 evidencePolicy', async () => {
    const screen = await renderDialog()
    await expect.element(screen.getByText('继承平台默认（失败时）')).toBeInTheDocument()
    await expect.element(screen.getByText('继承平台默认（关闭）')).toBeInTheDocument()
    await screen.getByRole('combobox', { name: '场景' }).click()
    await screen.getByRole('option', { name: '回显' }).click()
    await screen.getByRole('button', { name: '创建运行' }).click()
    await vi.waitFor(() => expect(mocks.createRun).toHaveBeenCalledTimes(1))
    expect(mocks.createRun.mock.calls[0]![0]).not.toHaveProperty('evidencePolicy')
  })
})
