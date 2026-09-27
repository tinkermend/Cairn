import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { StepPipelineRail } from './step-pipeline-rail'
import type { ScenarioAuthoringDocumentV2 } from '@cairn/shared'
import '@/styles/index.css'

describe('StepPipelineRail', () => {
  const sampleDoc: ScenarioAuthoringDocumentV2 = {
    schemaVersion: 1,
    authoringSchemaVersion: 2,
    inputs: [],
    scenarioOutcomes: [],
    runtimeInvariants: [],
    nodes: [
      {
        kind: 'step',
        step: {
          id: 'step-1',
          name: '打开登录页',
          type: 'navigate',
          effectType: 'READ_ONLY',
          input: { url: 'https://example.com/login' },
        },
      },
      {
        kind: 'step',
        step: {
          id: 'step-2',
          name: '输入用户名并提取Token',
          type: 'extract',
          effectType: 'READ_ONLY',
          outputKey: 'authToken',
          input: {
            target: { framePath: [], candidates: [{ by: 'css', value: '#token' }] },
            as: 'text',
          },
        },
      },
      {
        kind: 'module',
        invocationId: 'mod-inv-1',
        moduleId: '00000000-0000-4000-8000-000000000010',
        name: '公共认证模块',
        implementationKey: 'default',
        inputBindings: {},
        outputBindings: {},
      },
    ],
  }

  it('渲染时间轴节点、名称、输出标记与模块标识', async () => {
    const onSelect = vi.fn()
    const screen = await render(
      <div className='h-[600px] w-[300px] flex flex-col'>
        <StepPipelineRail
          document={sampleDoc}
          selectedId='step-1'
          selectedIndex={0}
          canWrite={true}
          disabled={false}
          editableTypes={['navigate', 'click', 'extract']}
          onSelect={onSelect}
          onAddStep={vi.fn()}
        />
      </div>
    )

    // 检查步骤数
    await expect.element(screen.getByText('(3)')).toBeInTheDocument()

    // 检查第 1 步与第 2 步与模块
    await expect.element(screen.getByText('打开登录页')).toBeInTheDocument()
    await expect.element(screen.getByText('输入用户名并提取Token')).toBeInTheDocument()
    await expect.element(screen.getByText('公共认证模块')).toBeInTheDocument()

    // 检查输出标注
    await expect.element(screen.getByText('输出 authToken')).toBeInTheDocument()

    // 检查模块徽标
    await expect.element(screen.getByText('动作模块')).toBeInTheDocument()

    // 检查点击选择
    await screen.getByText('输入用户名并提取Token').click()
    expect(onSelect).toHaveBeenCalledWith('step-2')
  })

  it('处于挂起状态时展示挂起标记', async () => {
    const screen = await render(
      <div className='h-[600px] w-[300px] flex flex-col'>
        <StepPipelineRail
          document={sampleDoc}
          selectedId='step-2'
          selectedIndex={1}
          holdingDraftStepId='step-2'
          canWrite={true}
          disabled={false}
          editableTypes={['navigate', 'click', 'extract']}
          onSelect={vi.fn()}
          onAddStep={vi.fn()}
        />
      </div>
    )

    await expect.element(screen.getByText('挂起')).toBeInTheDocument()
  })

  it('勾选步骤后可包裹为条件块；块卡片上可解除包裹（复查修复）', async () => {
    const onWrapSelection = vi.fn()
    const onUnwrapBlock = vi.fn()
    const onExtractIdsChange = vi.fn()
    const docWithBlock: ScenarioAuthoringDocumentV2 = {
      ...sampleDoc,
      nodes: [
        sampleDoc.nodes[0]!,
        {
          kind: 'block',
          blockId: 'block-1',
          name: '金额超过一万',
          control: { type: 'if', condition: { kind: 'literal', value: true } },
          then: [sampleDoc.nodes[1]!],
        },
      ],
    }
    const screen = await render(
      <div className='h-[600px] w-[320px] flex flex-col'>
        <StepPipelineRail
          document={docWithBlock}
          selectedId={null}
          canWrite={true}
          disabled={false}
          supportsAuthoringV2={true}
          editableTypes={['navigate', 'click', 'extract']}
          extractIds={['step-1']}
          onExtractIdsChange={onExtractIdsChange}
          onWrapSelection={onWrapSelection}
          onUnwrapBlock={onUnwrapBlock}
          onSelect={vi.fn()}
          onAddStep={vi.fn()}
        />
      </div>
    )
    await expect.element(screen.getByText('已选 1 个步骤')).toBeInTheDocument()
    await screen.getByRole('button', { name: '包裹为条件块' }).click()
    expect(onWrapSelection).toHaveBeenCalledTimes(1)
    await screen.getByRole('button', { name: '解除包裹', exact: true }).click()
    expect(onUnwrapBlock).toHaveBeenCalledWith('block-1')
  })

  it('展示就地定位健康徽标：满分静默、衰减标黄、自愈就绪带星', async () => {
    const healthMap = new Map([
      [
        'step-1',
        {
          stepId: 'step-1',
          status: 'healthy' as const,
          deterministic: 10,
          map: 0,
          ai: 0,
          failed: 0,
          located: 10,
          ruleHitRate: 1.0,
          fallbackRate: 0,
        },
      ],
      [
        'step-2',
        {
          stepId: 'step-2',
          status: 'fallback_warning' as const,
          deterministic: 2,
          map: 0,
          ai: 8,
          failed: 0,
          located: 10,
          ruleHitRate: 0.2,
          fallbackRate: 0.8,
          activeCandidate: {
            id: 'cand-1',
            scenarioId: 'sc-1',
            status: 'proposed' as const,
            patch: { kind: 'replace_element_target' as const },
          } as any,
        },
      ],
    ])

    const screen = await render(
      <div className='h-[600px] w-[320px] flex flex-col'>
        <StepPipelineRail
          document={sampleDoc}
          selectedId='step-1'
          canWrite={true}
          disabled={false}
          editableTypes={['navigate', 'extract']}
          locatorHealthMap={healthMap}
          onSelect={vi.fn()}
          onAddStep={vi.fn()}
        />
      </div>,
    )

    // step-1 是健康规则（100%），默认低噪音静默，不展示醒目徽标
    await expect.element(screen.getByText('打开登录页')).toBeInTheDocument()
    // step-2 有自愈候选，展示自愈就绪徽标
    await expect.element(screen.getByTestId('step-locator-health-step-2')).toHaveTextContent('自愈就绪 (20%)')
  })

  it('步骤编号处使用顺序流向箭头标识前后关系，末尾节点无箭头，且已消除多余灰色竖线', async () => {
    const screen = await render(
      <div className='h-[600px] w-[320px] flex flex-col'>
        <StepPipelineRail
          document={sampleDoc}
          selectedId='step-1'
          canWrite={true}
          disabled={false}
          editableTypes={['navigate', 'extract']}
          onSelect={vi.fn()}
          onAddStep={vi.fn()}
        />
      </div>,
    )

    // 步骤 1 和 步骤 2 均渲染顺序流向箭头
    await expect.element(screen.getByTestId('step-flow-arrow-step-1')).toBeInTheDocument()
    await expect.element(screen.getByTestId('step-flow-arrow-step-2')).toBeInTheDocument()

    // 最后一个节点（模块）为终止步骤，不渲染箭头
    expect(screen.container.querySelector('[data-testid="step-flow-arrow-mod-inv-1"]')).toBeNull()

    // 确认已移除原先生硬且错位遮挡复选框的 before:left-[19px] 灰色竖线类
    const railItems = screen.container.querySelectorAll('[data-list-step]')
    expect(railItems.length).toBe(3)
    railItems.forEach((item) => {
      expect(item.className).not.toContain('before:left-[19px]')
      expect(item.className).not.toContain('before:bg-border-divider')
    })
  })
})

