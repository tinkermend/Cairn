import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { ModuleExtractWizard } from './extract-wizard'

const scenarioId = '33333333-3333-4333-8333-333333333333'
const stepId = '55555555-5555-4555-8555-555555555555'
const moduleId = '22222222-2222-4222-8222-222222222222'

const mocks = vi.hoisted(() => ({
  previewScenarioModuleExtract: vi.fn(),
  extractScenarioModule: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@/lib/scenarios-api', () => ({
  previewScenarioModuleExtract: mocks.previewScenarioModuleExtract,
  extractScenarioModule: mocks.extractScenarioModule,
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

async function renderWizard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ModuleExtractWizard
        open
        onOpenChange={() => {}}
        scenarioId={scenarioId}
        stepIds={[stepId]}
      />
    </QueryClientProvider>,
  )
}

describe('提炼向导', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.previewScenarioModuleExtract.mockResolvedValue({
      ok: true,
      stepIds: [stepId],
      inputs: [{ key: 'keyword', label: '关键词', valueType: 'string', required: true, source: 'scenario_input' }],
      outputs: [{ key: 'extracted', label: 'extracted', shape: { kind: 'scalar', type: 'string' }, internalOutputKey: 'extracted' }],
      effectCeiling: 'READ_ONLY',
      postconditionCandidates: [{ stepId, name: '断言', meaning: '页面显示完成' }],
      parameterizable: [],
    })
    mocks.extractScenarioModule.mockResolvedValue({ id: moduleId })
  })

  it('预览推断结果后创建模块草稿并跳转编辑页', async () => {
    const screen = await renderWizard()
    await expect.element(screen.getByText(/1 个输入/)).toBeInTheDocument()
    await screen.getByLabelText('确认后置条件 断言').click()
    await screen.getByLabelText('提炼模块名称').fill('查询结果')
    await screen.getByLabelText('提炼模块 key').fill('order.extract')
    await screen.getByRole('button', { name: '创建模块草稿' }).click()
    await vi.waitFor(() => expect(mocks.extractScenarioModule).toHaveBeenCalledTimes(1))
    expect(mocks.extractScenarioModule.mock.calls[0]).toEqual([
      scenarioId,
      expect.objectContaining({
        stepIds: [stepId],
        name: '查询结果',
        key: 'order.extract',
        confirmedPostconditionStepIds: [stepId],
      }),
    ])
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/action-modules/$moduleId',
      params: { moduleId },
    })
  })
})
