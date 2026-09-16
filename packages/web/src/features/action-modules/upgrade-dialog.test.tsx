import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { ModuleUpgradeDialog } from './upgrade-dialog'

const scenarioId = '33333333-3333-4333-8333-333333333333'
const invocationId = '55555555-5555-4555-8555-555555555555'
const moduleId = '22222222-2222-4222-8222-222222222222'
const versionId = '44444444-4444-4444-8444-444444444444'

const mocks = vi.hoisted(() => ({
  fetchScenario: vi.fn(),
  previewScenarioModuleUpgrade: vi.fn(),
  upgradeScenarioModule: vi.fn(),
  fetchActionModuleVersion: vi.fn(),
  onUpgraded: vi.fn(),
}))

vi.mock('@/lib/scenarios-api', () => ({
  fetchScenario: mocks.fetchScenario,
  previewScenarioModuleUpgrade: mocks.previewScenarioModuleUpgrade,
  upgradeScenarioModule: mocks.upgradeScenarioModule,
}))
vi.mock('@/lib/action-modules-api', () => ({
  fetchActionModuleVersion: mocks.fetchActionModuleVersion,
}))

async function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ModuleUpgradeDialog
        open
        onOpenChange={() => {}}
        scenarioId={scenarioId}
        invocationId={invocationId}
        toVersionId={versionId}
        onUpgraded={mocks.onUpgraded}
      />
    </QueryClientProvider>,
  )
}

describe('模块升级对话', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchScenario.mockResolvedValue({
      id: scenarioId,
      draft: { revision: 3, document: { authoringSchemaVersion: 2, schemaVersion: 1, inputs: [], nodes: [] } },
    })
    mocks.fetchActionModuleVersion.mockResolvedValue({
      id: versionId,
      content: {
        contract: { inputs: [{ key: 'limit', label: '条数', valueType: 'number', required: true }] },
      },
    })
    mocks.previewScenarioModuleUpgrade.mockResolvedValue({
      invocationId,
      toVersionId: versionId,
      severity: 'blocking',
      diffs: [
        {
          code: 'MODULE_UPGRADE_INPUT_REQUIRED',
          severity: 'blocking',
          message: '必须补绑定 limit',
          inputKey: 'limit',
        },
      ],
      document: {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [{
          kind: 'module',
          invocationId,
          name: '查询',
          moduleId,
          moduleVersionId: versionId,
          implementationKey: 'default',
          inputBindings: {},
          outputBindings: {},
        }],
      },
      diagnostics: [],
    })
    mocks.upgradeScenarioModule.mockResolvedValue({ id: scenarioId })
  })

  it('未补绑定时不能写入，补绑定后带上当前草稿 revision', async () => {
    const screen = await renderDialog()
    await expect.element(screen.getByText('必须补绑定 limit')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '写入草稿' })).toBeDisabled()
    await screen.getByLabelText('绑定 limit').fill('10')
    await screen.getByRole('button', { name: '写入草稿' }).click()
    await vi.waitFor(() => expect(mocks.upgradeScenarioModule).toHaveBeenCalledTimes(1))
    expect(mocks.upgradeScenarioModule.mock.calls[0]).toEqual([
      scenarioId,
      expect.objectContaining({
        invocationId,
        toVersionId: versionId,
        baseRevision: 3,
        bindingsPatch: { limit: { kind: 'literal', value: 10 } },
      }),
    ])
    expect(mocks.onUpgraded).toHaveBeenCalledWith(scenarioId)
  })
})
