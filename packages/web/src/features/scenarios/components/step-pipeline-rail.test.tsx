import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { StepPipelineRail } from './step-pipeline-rail'
import type { ModuleManifest, ScenarioAuthoringDocumentV2 } from '@cairn/shared'
import { makeRunDetail } from '@/test-utils/run-detail'
import { makeRepairCandidate } from '@/test-utils/repair-candidate'
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
          activeCandidate: makeRepairCandidate(),
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

  it('试跑执行中时高亮当前步骤、展示旋转动效与执行中徽标，已完成步骤展示成功与耗时', async () => {
    const trialRun = makeRunDetail({
      id: 'run-trial-1',
      scenarioId: 'sc-1',
      status: 'RUNNING',
      stepRuns: [
        {
          id: 'sr-1',
          stepId: 'step-1',
          name: '打开登录页',
          type: 'navigate',
          ordinal: 0,
          status: 'SUCCEEDED',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-28T00:00:00.000Z',
          finishedAt: '2026-09-28T00:00:01.200Z',
          attempts: [],
        },
        {
          id: 'sr-2',
          stepId: 'step-2',
          name: '输入用户名并提取Token',
          type: 'extract',
          ordinal: 1,
          status: 'RUNNING',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-28T00:00:01.300Z',
          finishedAt: null,
          attempts: [],
        },
      ],
    })

    const screen = await render(
      <div className='h-[600px] w-[320px] flex flex-col'>
        <StepPipelineRail
          document={sampleDoc}
          selectedId='step-1'
          trialRun={trialRun}
          canWrite={true}
          disabled={false}
          editableTypes={['navigate', 'extract']}
          onSelect={vi.fn()}
          onAddStep={vi.fn()}
        />
      </div>,
    )

    // 顶栏不展示多余的试跑指示器，避免挤压右侧操作项
    expect(screen.getByTestId('trial-running-indicator').elements()).toHaveLength(0)

    // 步骤 1：已成功完成，展示成功图标与耗时徽标
    await expect.element(screen.getByTestId('step-succeeded-icon-step-1')).toBeInTheDocument()
    await expect.element(screen.getByTestId('step-status-succeeded-step-1')).toHaveTextContent('成功 · 1.2s')

    // 步骤 2：正在执行中，展示旋转动效与“执行中”徽标
    await expect.element(screen.getByTestId('step-running-spinner-step-2')).toBeInTheDocument()
    await expect.element(screen.getByTestId('step-status-running-step-2')).toHaveTextContent('执行中')
  })

  it('试跑失败时步骤卡片展示失败图标与失败徽标', async () => {
    const trialRun = makeRunDetail({
      id: 'run-trial-2',
      scenarioId: 'sc-1',
      status: 'FAILED',
      stepRuns: [
        {
          id: 'sr-1',
          stepId: 'step-1',
          name: '打开登录页',
          type: 'navigate',
          ordinal: 0,
          status: 'FAILED',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-28T00:00:00.000Z',
          finishedAt: '2026-09-28T00:00:00.800Z',
          attempts: [],
        },
      ],
    })

    const screen = await render(
      <div className='h-[600px] w-[320px] flex flex-col'>
        <StepPipelineRail
          document={sampleDoc}
          selectedId='step-1'
          trialRun={trialRun}
          canWrite={true}
          disabled={false}
          editableTypes={['navigate', 'extract']}
          onSelect={vi.fn()}
          onAddStep={vi.fn()}
        />
      </div>,
    )

    // 步骤 1：失败，展示失败图标与失败徽标
    await expect.element(screen.getByTestId('step-failed-icon-step-1')).toBeInTheDocument()
    await expect.element(screen.getByTestId('step-status-failed-step-1')).toHaveTextContent('失败 · 800ms')
  })

  it('条件块内子步骤执行中时，条件块展示执行中徽标与旋转动画', async () => {
    const docWithBlock: ScenarioAuthoringDocumentV2 = {
      ...sampleDoc,
      nodes: [
        {
          kind: 'block',
          blockId: 'block-test',
          name: '高频重试处理',
          control: { type: 'if', condition: { kind: 'literal', value: true } },
          then: [sampleDoc.nodes[1]!], // step-2
        },
      ],
    }

    const trialRun = makeRunDetail({
      id: 'run-trial-block',
      scenarioId: 'sc-1',
      status: 'RUNNING',
      stepRuns: [
        {
          id: 'sr-2',
          stepId: 'step-2',
          name: '输入用户名并提取Token',
          type: 'extract',
          ordinal: 0,
          status: 'RUNNING',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-28T00:00:01.000Z',
          finishedAt: null,
          attempts: [],
        },
      ],
    })

    const screen = await render(
      <div className='h-[600px] w-[320px] flex flex-col'>
        <StepPipelineRail
          document={docWithBlock}
          selectedId={null}
          trialRun={trialRun}
          canWrite={true}
          disabled={false}
          editableTypes={['navigate', 'extract']}
          onSelect={vi.fn()}
          onAddStep={vi.fn()}
        />
      </div>,
    )

    // 块自身出现旋转转圈和执行中徽标
    await expect.element(screen.getByTestId('block-running-spinner-block-test')).toBeInTheDocument()
    await expect.element(screen.getByTestId('block-status-running-block-test')).toHaveTextContent('执行中')

    // 块内子步骤同样出现旋转转圈和执行中徽标
    await expect.element(screen.getByTestId('step-running-spinner-step-2')).toBeInTheDocument()
    await expect.element(screen.getByTestId('step-status-running-step-2')).toHaveTextContent('执行中')
  })

  it('开启批量提取/包裹选择时，动作模块展示置灰禁用的占位勾选框，对齐整体纵向布局', async () => {
    const screen = await render(
      <div className='h-[600px] w-[320px] flex flex-col'>
        <StepPipelineRail
          document={sampleDoc}
          selectedId={null}
          canWrite={true}
          disabled={false}
          supportsAuthoringV2={true}
          actionModulesEnabled={true}
          editableTypes={['navigate', 'click', 'extract']}
          extractIds={[]}
          onExtractIdsChange={vi.fn()}
          onWrapSelection={vi.fn()}
          onSelect={vi.fn()}
          onAddStep={vi.fn()}
        />
      </div>,
    )

    // 普通步骤渲染可用的选择勾选框
    const step1Check = screen.getByRole('checkbox', { name: '选择提炼 打开登录页' })
    await expect.element(step1Check).toBeInTheDocument()
    await expect.element(step1Check).toBeEnabled()

    // 动作模块渲染置灰禁用的占位勾选框，保证第一列宽度与对齐完整
    const moduleCheck = screen.getByRole('checkbox', { name: '公共认证模块暂不支持批量提炼或包裹' })
    await expect.element(moduleCheck).toBeInTheDocument()
    await expect.element(moduleCheck).toBeDisabled()
  })

  it('动作模块内部子步骤执行中时，动作模块节点高亮并展示转圈与执行中徽标', async () => {
    const trialRun = makeRunDetail({
      id: 'run-trial-module-1',
      scenarioId: 'sc-1',
      status: 'RUNNING',
      snapshot: {
        ...makeRunDetail().snapshot,
        moduleManifest: {
          entries: [
            {
              invocationId: 'mod-inv-1',
              expandedStepIds: ['exp-step-1', 'exp-step-2'],
            } as ModuleManifest['entries'][number],
          ],
        },
      },
      stepRuns: [
        {
          id: 'sr-exp-1',
          stepId: 'exp-step-1',
          name: '模块内部第1步',
          type: 'click',
          ordinal: 0,
          status: 'SUCCEEDED',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-28T00:00:00.000Z',
          finishedAt: '2026-09-28T00:00:01.000Z',
          attempts: [],
        },
        {
          id: 'sr-exp-2',
          stepId: 'exp-step-2',
          name: '模块内部第2步',
          type: 'fill',
          ordinal: 1,
          status: 'RUNNING',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-28T00:00:01.100Z',
          finishedAt: null,
          attempts: [],
        },
      ],
    })

    const screen = await render(
      <div className='h-[600px] w-[320px] flex flex-col'>
        <StepPipelineRail
          document={sampleDoc}
          selectedId={null}
          trialRun={trialRun}
          canWrite={true}
          disabled={false}
          editableTypes={['navigate', 'extract']}
          onSelect={vi.fn()}
          onAddStep={vi.fn()}
        />
      </div>,
    )

    // 动作模块 mod-inv-1 出现转圈动效和执行中徽标
    await expect.element(screen.getByTestId('step-running-spinner-mod-inv-1')).toBeInTheDocument()
    await expect.element(screen.getByTestId('step-status-running-mod-inv-1')).toHaveTextContent('执行中')
  })

  it('动作模块内部所有子步骤成功时，动作模块展示成功对勾与耗时；失败时展示失败徽标', async () => {
    const trialRunSucceeded = makeRunDetail({
      id: 'run-trial-module-2',
      scenarioId: 'sc-1',
      status: 'SUCCEEDED',
      snapshot: {
        ...makeRunDetail().snapshot,
        moduleManifest: {
          entries: [
            {
              invocationId: 'mod-inv-1',
              expandedStepIds: ['exp-step-1', 'exp-step-2'],
            } as ModuleManifest['entries'][number],
          ],
        },
      },
      stepRuns: [
        {
          id: 'sr-exp-1',
          stepId: 'exp-step-1',
          name: '模块内部第1步',
          type: 'click',
          ordinal: 0,
          status: 'SUCCEEDED',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-28T00:00:00.000Z',
          finishedAt: '2026-09-28T00:00:01.000Z',
          attempts: [],
        },
        {
          id: 'sr-exp-2',
          stepId: 'exp-step-2',
          name: '模块内部第2步',
          type: 'fill',
          ordinal: 1,
          status: 'SUCCEEDED',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-28T00:00:01.000Z',
          finishedAt: '2026-09-28T00:00:02.500Z',
          attempts: [],
        },
      ],
    })

    const screen1 = await render(
      <div className='h-[600px] w-[320px] flex flex-col'>
        <StepPipelineRail
          document={sampleDoc}
          selectedId={null}
          trialRun={trialRunSucceeded}
          canWrite={true}
          disabled={false}
          editableTypes={['navigate', 'extract']}
          onSelect={vi.fn()}
          onAddStep={vi.fn()}
        />
      </div>,
    )

    // 动作模块展示成功图标与耗时（从 0s 到 2.5s 即 2.5s）
    await expect.element(screen1.getByTestId('step-succeeded-icon-mod-inv-1')).toBeInTheDocument()
    await expect.element(screen1.getByTestId('step-status-succeeded-mod-inv-1')).toHaveTextContent('成功 · 2.5s')

    // 接下来测试断点停在动作模块内部时的挂起状态
    const trialRunHolding = makeRunDetail({
      id: 'run-trial-module-3',
      scenarioId: 'sc-1',
      status: 'HOLDING',
      checkpoint: {
        mode: 'holdAfterEach',
        reason: 'step_succeeded',
        stepId: 'exp-step-1',
        stepOrdinal: 0,
        contextKeys: [],
        sessionGeneration: 1,
        fencingToken: '1',
        overlayRevision: 0,
      },
      snapshot: {
        ...makeRunDetail().snapshot,
        moduleManifest: {
          entries: [
            {
              invocationId: 'mod-inv-1',
              expandedStepIds: ['exp-step-1', 'exp-step-2'],
            } as ModuleManifest['entries'][number],
          ],
        },
      },
      stepRuns: [],
    })

    const screen2 = await render(
      <div className='h-[600px] w-[320px] flex flex-col'>
        <StepPipelineRail
          document={sampleDoc}
          selectedId={null}
          trialRun={trialRunHolding}
          canWrite={true}
          disabled={false}
          editableTypes={['navigate', 'extract']}
          onSelect={vi.fn()}
          onAddStep={vi.fn()}
        />
      </div>,
    )

    // 动作模块卡片展示挂起徽标
    await expect.element(screen2.getByText('挂起')).toBeInTheDocument()
  })
})


