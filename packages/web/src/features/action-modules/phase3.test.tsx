import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ModuleInputDecl } from '@cairn/shared'
import { ScopeVariablesBar } from './scope-variables-bar'
import { ImportModuleDialog } from './import-dialog'
import { TrialRunSheet } from './trial-run-sheet'
import { ModuleFixturesPanel, type ModuleTestFixture } from './fixtures-panel'

const mockRunsApi = vi.hoisted(() => ({
  fetchRun: vi.fn(),
}))

vi.mock('@/lib/runs-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runs-api')>()
  return {
    ...actual,
    fetchRun: mockRunsApi.fetchRun,
  }
})

describe('作用域变量芯片栏 (ScopeVariablesBar)', () => {
  it('当无可用变量时呈现中性提示信息', async () => {
    const screen = await render(
      <ScopeVariablesBar inputs={[]} priorSteps={[]} />
    )
    await expect
      .element(
        screen.getByText(
          '当前无可用作用域变量。在左侧声明输入或在前序步骤中配置输出键后，可在此快速引用。'
        )
      )
      .toBeInTheDocument()
  })

  it('展示输入参数与上游步骤输出芯片，并支持点击复制', async () => {
    const mockInputs: ModuleInputDecl[] = [
      { key: 'orderId', label: '订单号', valueType: 'string', required: true },
      { key: 'count', label: '数量', valueType: 'number', required: false },
    ]
    const mockSteps: any[] = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: '查询详情',
        type: 'fill',
        effectType: 'read_only',
        targetElement: { kind: 'selector', selector: '#id' },
        input: { kind: 'literal', value: '1' },
        outputKey: 'detailResult',
      },
    ]

    const screen = await render(
      <ScopeVariablesBar inputs={mockInputs} priorSteps={mockSteps} />
    )

    await expect
      .element(screen.getByText('可用作用域变量 (3)'))
      .toBeInTheDocument()
    await expect.element(screen.getByText('orderId')).toBeInTheDocument()
    await expect.element(screen.getByText('detailResult')).toBeInTheDocument()

    const orderChip = screen.getByRole('button', {
      name: '复制变量 ${inputs.orderId}',
    })
    await expect.element(orderChip).toBeInTheDocument()
    await orderChip.click()
  })
})

describe('动作模块导入弹窗 (ImportModuleDialog)', () => {
  it('非法 JSON 格式输入时展示校验错误信息并阻止导入', async () => {
    const onImport = vi.fn()
    const screen = await render(
      <ImportModuleDialog open onOpenChange={() => {}} onImport={onImport} />
    )

    await expect
      .element(screen.getByText('导入动作模块定义'))
      .toBeInTheDocument()

    const textarea = screen.getByLabelText('JSON 内容定义')
    await textarea.fill('{ "invalid": true }')

    const importButton = screen.getByRole('button', {
      name: '校验并应用至草稿',
    })
    await importButton.click()

    await expect
      .element(screen.getByText(/JSON 校验未通过/))
      .toBeInTheDocument()
    expect(onImport).not.toHaveBeenCalled()
  })

  it('合法 JSON 格式输入时成功调用 onImport 回调', async () => {
    const onImport = vi.fn()
    const screen = await render(
      <ImportModuleDialog open onOpenChange={() => {}} onImport={onImport} />
    )

    const validPayload = {
      name: '导入模块测试',
      description: '导入描述',
      contract: {
        effectCeiling: 'READ_ONLY',
        inputs: [
          {
            key: 'sku',
            label: '商品SKU',
            valueType: 'string',
            required: true,
          },
        ],
        outputs: [],
        preconditions: [],
        postconditions: [],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [],
          outputMapping: {},
        },
      ],
    }

    const textarea = screen.getByLabelText('JSON 内容定义')
    await textarea.fill(JSON.stringify(validPayload))

    const importButton = screen.getByRole('button', {
      name: '校验并应用至草稿',
    })
    await importButton.click()

    expect(onImport).toHaveBeenCalledTimes(1)
    expect(onImport).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: expect.objectContaining({
          effectCeiling: 'READ_ONLY',
        }),
      }),
      expect.objectContaining({
        name: '导入模块测试',
      })
    )
  })
})

describe('原地试跑观测抽屉 (TrialRunSheet)', () => {
  it('展示运行流水、上下文产出，并支持沉淀为测试用例', async () => {
    const runId = 'test-run-123'
    mockRunsApi.fetchRun.mockResolvedValue({
      id: runId,
      status: 'SUCCEEDED',
      startedAt: '2026-09-19T10:00:00.000Z',
      finishedAt: '2026-09-19T10:00:02.500Z',
      stepRuns: [
        {
          id: 'step-run-1',
          stepId: 'step-1',
          name: '打开商品页',
          type: 'navigate',
          ordinal: 0,
          status: 'SUCCEEDED',
          attempts: [],
        },
      ],
      context: { totalCount: 42 },
    })

    const onSaveFixture = vi.fn()
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const screen = await render(
      <QueryClientProvider client={client}>
        <TrialRunSheet
          runId={runId}
          open={true}
          onOpenChange={() => {}}
          currentInputs={{ keyword: 'iPhone' }}
          onSaveAsFixture={onSaveFixture}
        />
      </QueryClientProvider>
    )

    await expect.element(screen.getByText('试跑原地观测')).toBeVisible()
    await expect.element(screen.getByText('打开商品页')).toBeVisible()
    await expect.element(screen.getByText('另存为用例')).toBeVisible()

    await screen.getByRole('button', { name: '另存为用例' }).click()
    const input = screen.getByLabelText('用例名称')
    await input.fill('正向商品检索')
    await screen.getByRole('button', { name: '确认保存' }).click()

    expect(onSaveFixture).toHaveBeenCalledWith(
      '正向商品检索',
      { keyword: 'iPhone' },
      expect.objectContaining({
        runId,
        outcome: 'SUCCEEDED',
      })
    )
  })
})

describe('测试用例套件面板 (ModuleFixturesPanel)', () => {
  it('渲染用例列表、触发运行、支持新建与删除', async () => {
    const mockFixtures: ModuleTestFixture[] = [
      {
        id: 'fix-1',
        name: '正向用例',
        description: '正向流程测试',
        inputs: { orderId: 'ORD-100' },
        lastRun: {
          runId: 'run-1',
          outcome: 'SUCCEEDED',
          durationMs: 1200,
          executedAt: '2026-09-19T10:00:00.000Z',
        },
      },
    ]

    const onUpdateFixtures = vi.fn()
    const onRunFixture = vi.fn()

    const screen = await render(
      <ModuleFixturesPanel
        moduleId='mod-1'
        fixtures={mockFixtures}
        onUpdateFixtures={onUpdateFixtures}
        contractInputs={[
          { key: 'orderId', label: '订单号', valueType: 'string' },
        ]}
        canWrite={true}
        onRunFixture={onRunFixture}
      />
    )

    await expect.element(screen.getByText('正向用例')).toBeVisible()
    await expect.element(screen.getByText('orderId:')).toBeVisible()
    await expect.element(screen.getByText('ORD-100')).toBeVisible()
    await expect.element(screen.getByText('通过')).toBeVisible()

    // 运行用例
    await screen.getByRole('button', { name: '运行用例' }).click()
    expect(onRunFixture).toHaveBeenCalledWith(mockFixtures[0])

    // 删除用例
    await screen.getByTitle('删除用例').click()
    expect(onUpdateFixtures).toHaveBeenCalledWith([])
  })
})
