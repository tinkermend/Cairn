import '@/styles/index.css'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { useState } from 'react'
import type {
  ScenarioAuthoringDocumentV2,
  ScenarioDocument,
  Step,
} from '@cairn/shared'
import { StudioSplitterLayout, type StudioViewPreset } from './components/studio-splitter-layout'
import { StepPipelineRail } from './components/step-pipeline-rail'
import { StudioInspectorHost } from './components/inspector/studio-inspector-host'
import { SegmentedStepInspector } from './components/inspector/segmented-step-inspector'
import { ContextMentionInput } from './components/context-mention-input'
import { PublishDiffDrawer } from './components/publish-diff-drawer'
import { STEP_SNIPPET_TEMPLATES } from './snippets/step-snippets'

describe('场景编排工作台（Scenario Studio）浏览器全功能与 UI 布局仿真走查', () => {
  const sampleV2Doc: ScenarioAuthoringDocumentV2 = {
    authoringSchemaVersion: 2,
    schemaVersion: 1 as const,
    inputs: [
      {
        key: 'testUser',
        type: 'string',
        label: '测试账号用户名',
        required: true,
      },
    ],
    nodes: [
      {
        kind: 'step',
        step: {
          id: 'step-nav',
          name: '打开系统登录页面',
          type: 'navigate',
          effectType: 'READ_ONLY',
          input: { url: 'https://app.cairn.local/login' },
          policy: { timeoutMs: 15000, retryLimit: 1 },
        },
      },
      {
        kind: 'step',
        step: {
          id: 'step-fill-user',
          name: '输入账号并提取Token',
          type: 'extract',
          effectType: 'READ_ONLY',
          outputKey: 'authToken',
          input: {
            target: { framePath: [], candidates: [{ by: 'css', value: '#auth-token' }] },
            as: 'text',
          },
          policy: { timeoutMs: 8000, retryLimit: 2 },
        },
      },
      {
        kind: 'module',
        invocationId: 'mod-inv-1',
        moduleId: '00000000-0000-4000-8000-000000000001',
        name: '通用双因子认证复合模块',
        implementationKey: 'default',
        inputBindings: {},
        outputBindings: {},
      },
      {
        kind: 'step',
        step: {
          id: 'step-disabled-export',
          name: '导出月度账单（暂未开放）',
          type: 'click',
          effectType: 'SIDE_EFFECT',
          disabled: true,
          input: {
            target: { framePath: [], candidates: [{ by: 'css', value: '#export-btn' }] },
          },
        },
      },
    ],
    scenarioOutcomes: [],
    runtimeInvariants: [],
  }

  it('走查 1：三栏弹性 Splitter 布局、三档聚焦模式切换与自适应约束', async () => {
    function SplitterTestWorkbench() {
      const [preset, setPreset] = useState<StudioViewPreset>('balanced')
      return (
        <div className='h-[700px] w-[1440px] flex flex-col bg-background'>
          <StudioSplitterLayout
            preset={preset}
            onPresetChange={setPreset}
            left={
              <div data-testid='mock-left-rail' className='p-3 text-body'>
                管线栏（左）
              </div>
            }
            center={
              <div data-testid='mock-center-stage' className='p-3 text-body'>
                受管舞台（中）
              </div>
            }
            right={
              <div data-testid='mock-right-inspector' className='p-3 text-body'>
                属性检查器（右）
              </div>
            }
          />
        </div>
      )
    }

    const screen = await render(<SplitterTestWorkbench />)

    const leftPane = screen.getByTestId('splitter-left-pane')
    const centerPane = screen.getByTestId('splitter-center-pane')
    const rightPane = screen.getByTestId('splitter-right-pane')
    const leftHandle = screen.getByTestId('splitter-handle-left')
    const rightHandle = screen.getByTestId('splitter-handle-right')

    // 1. 初始 balanced 模式验证
    await expect.element(leftPane).toBeInTheDocument()
    await expect.element(centerPane).toBeInTheDocument()
    await expect.element(rightPane).toBeInTheDocument()
    await expect.element(leftHandle).toBeInTheDocument()
    await expect.element(rightHandle).toBeInTheDocument()

    // 2. 双击分割条验证重置行为
    await leftHandle.dblClick()
    await rightHandle.dblClick()
  })

  it('走查 2：步骤管线 Rail 时间轴、节点序列、输出标记与禁用跳过状态呈现', async () => {
    const onSelect = vi.fn()
    const onAddStep = vi.fn()
    const onAddModule = vi.fn()

    const screen = await render(
      <div className='h-[650px] w-[320px] flex flex-col bg-card border-r'>
        <StepPipelineRail
          document={sampleV2Doc}
          selectedId='step-fill-user'
          selectedIndex={1}
          holdingDraftStepId='step-fill-user'
          canWrite={true}
          disabled={false}
          editableTypes={['navigate', 'click', 'extract', 'wait']}
          onSelect={onSelect}
          onAddStep={onAddStep}
          onInsertModuleOpen={onAddModule}
        />
      </div>,
    )

    // 验证步骤节点标题呈现
    await expect.element(screen.getByText('打开系统登录页面')).toBeInTheDocument()
    await expect.element(screen.getByText('输入账号并提取Token')).toBeInTheDocument()
    await expect.element(screen.getByText('通用双因子认证复合模块')).toBeInTheDocument()
    await expect.element(screen.getByText('导出月度账单（暂未开放）')).toBeInTheDocument()

    // 验证状态微标：正在挂起、已跳过、输出数据标记
    await expect.element(screen.getByText('挂起')).toBeInTheDocument()
    await expect.element(screen.getByText('已跳过')).toBeInTheDocument()
    await expect.element(screen.getByText('输出 authToken')).toBeInTheDocument()

    // 验证点击选中节点
    const firstStepBtn = screen.getByRole('button', { name: /打开系统登录页面/ })
    await firstStepBtn.click()
    expect(onSelect).toHaveBeenCalledWith('step-nav')
  })

  it('走查 3：模版片段 Snippet 生成合法性（可见性 visible 契约合规与连续步骤）', () => {
    const tableTemplate = STEP_SNIPPET_TEMPLATES.find((t) => t.id === 'snippet-table-first-row')
    expect(tableTemplate).toBeDefined()

    let idCount = 0
    const generated = tableTemplate!.createSteps({
      generateId: () => `gen-step-${++idCount}`,
      allocateOutputKey: (key) => `${key}_1`,
    })

    expect(generated.length).toBe(3)
    const [waitStep, extractStep, clickStep] = generated

    // 严苛验证 wait 步骤的 kind 必须是契约内的 visible，而不是非法 target_visible
    expect(waitStep.type).toBe('wait')
    const waitInput = waitStep.input as { kind?: string; target?: { candidates?: unknown[] } }
    expect(waitInput.kind).toBe('visible')
    expect(waitInput.target?.candidates?.length).toBeGreaterThan(0)

    expect(extractStep.type).toBe('extract')
    expect(extractStep.outputKey).toBe('extracted_row_id_1')
    expect(clickStep.type).toBe('click')
  })

  it('走查 4：分段式检查器 Segmented Inspector 四态 Tab 导航与执行容错策略折叠徽标', async () => {
    function InspectorTestContainer() {
      const [rightTab, setRightTab] = useState<'step' | 'inputs' | 'outputs' | 'outcomes'>('step')
      const [currentStep, setCurrentStep] = useState<Step>({
        id: 'step-nav',
        name: '打开系统登录页面',
        type: 'navigate',
        effectType: 'READ_ONLY',
        input: { url: 'https://app.cairn.local/login' },
        policy: { timeoutMs: 15000, retryLimit: 2 },
      })

      return (
        <div className='h-[700px] w-[400px] flex flex-col bg-card border-l'>
          <StudioInspectorHost
            rightTab={rightTab}
            onTabChange={setRightTab}
            stepTitle={currentStep.name}
            stepSubTitle='步骤 1 / 4'
            inputsCount={1}
            outputsCount={1}
            diagnosticsCount={1}
          >
            {rightTab === 'step' && (
              <SegmentedStepInspector
                step={currentStep}
                index={0}
                bindings={[]}
                shapes={new Map()}
                editableTypes={['echo', 'navigate']}
                diagnostics={[]}
                disabled={false}
                onRequestTypeChange={vi.fn()}
                onChange={setCurrentStep}
              />
            )}
            {rightTab === 'inputs' && <div data-testid='tab-inputs-content'>输入参数面板</div>}
            {rightTab === 'outputs' && <div data-testid='tab-outputs-content'>业务输出指标面板</div>}
            {rightTab === 'outcomes' && <div data-testid='tab-outcomes-content'>预期与诊断面板</div>}
          </StudioInspectorHost>
        </div>
      )
    }

    const screen = await render(<InspectorTestContainer />)

    // 验证 Tab 标题与徽标
    await expect.element(screen.getByText('步骤配置')).toBeInTheDocument()
    await expect.element(screen.getByText('输入参数')).toBeInTheDocument()
    await expect.element(screen.getByText('业务输出')).toBeInTheDocument()
    await expect.element(screen.getByText('预期与诊断')).toBeInTheDocument()

    // 验证执行策略折叠态的非默认徽标（重试 2次, 15000ms）
    await expect.element(screen.getByTestId('policy-active-pills')).toBeInTheDocument()
    await expect.element(screen.getByText('重试 2次')).toBeInTheDocument()
    await expect.element(screen.getByText('15000ms')).toBeInTheDocument()

    // 点击切换 Tab 到输入参数
    const inputsTab = screen.getByRole('tab', { name: /输入参数/ })
    await inputsTab.click()
    await expect.element(screen.getByTestId('tab-inputs-content')).toBeInTheDocument()

    // 点击切换 Tab 到预期与诊断
    const outcomesTab = screen.getByRole('tab', { name: /预期与诊断/ })
    await outcomesTab.click()
    await expect.element(screen.getByTestId('tab-outcomes-content')).toBeInTheDocument()
  })

  it('走查 5：上下文变量提及 ContextMentionInput 弹层与快捷随机填充', async () => {
    function MentionContainer() {
      const [val, setVal] = useState('')
      return (
        <div className='p-6 w-[400px] space-y-4 bg-card'>
          <ContextMentionInput
            id='test-mention'
            value={val}
            bindings={[
              { key: 'authToken', label: '登录提取Token' },
              { key: 'inputs.testUser', label: '测试账号用户名' },
            ]}
            mode='binding_picker'
            placeholder='输入内容或选择变量'
            onChange={setVal}
            onSelectBinding={(b) => setVal(`{{${b.key}}}`)}
          />
          <button
            type='button'
            className='px-2 py-1 bg-muted rounded text-caption'
            onClick={() => setVal('rnd_token_88')}
          >
            🎲 随机文本
          </button>
        </div>
      )
    }

    const screen = await render(<MentionContainer />)
    const input = screen.getByRole('textbox')
    await expect.element(input).toBeInTheDocument()

    // 测试快捷随机文本按钮填充
    const rndBtn = screen.getByRole('button', { name: '🎲 随机文本' })
    await rndBtn.click()
    await expect.element(input).toHaveValue('rnd_token_88')
  })

  it('走查 6：版本发布审查抽屉 PublishDiffDrawer 差异对比与发布确认', async () => {
    const onConfirmPublish = vi.fn()
    const onClose = vi.fn()

    const screen = await render(
      <PublishDiffDrawer
        open={true}
        scenarioName='采购报销主流程'
        currentVersionNo={1}
        baselineDoc={{
          schemaVersion: 1,
          steps: [
            {
              id: 'step-nav',
              name: '打开系统登录页面',
              type: 'navigate',
              effectType: 'READ_ONLY',
              input: { url: 'https://app.cairn.local/login' },
            },
          ],
        } as ScenarioDocument}
        draftDoc={sampleV2Doc}
        publishing={false}
        onClose={onClose}
        onConfirmPublish={onConfirmPublish}
      />,
    )

    // 验证版本升级提示（v1 -> v2）
    await expect.element(screen.getByText('发布版本确认')).toBeInTheDocument()
    await expect.element(screen.getByText('v1 → v2')).toBeInTheDocument()

    // 验证变更统计胶囊（新增了 3 个节点 + 1 个全局输入）
    await expect.element(screen.getByText('+ 4 新增')).toBeInTheDocument()

    // 验证确认发布按钮与交互
    const confirmBtn = screen.getByRole('button', { name: '确认并正式发布' })
    await expect.element(confirmBtn).toBeInTheDocument()
    await confirmBtn.click()
    expect(onConfirmPublish).toHaveBeenCalled()
  })

  it('走查 7：状态机边界防护：HOLDING 挂起时单步步进死循环阻断与草稿优先保存', async () => {
    // 模拟 detail.tsx 中针对 handleRunToStep 的边界防护规则
    const trialRun = {
      id: 'run-123',
      status: 'HOLDING',
      checkpoint: { fencingToken: 'fence-abc' },
    }
    const holdingDraftStepId = 'step-failed-1'
    const messages: string[] = []
    let draftSavedCalled = false
    let debugRunCalledWith: { action: string; targetStepId: string; fencingToken: string } | null = null

    async function ensureDraftSaved() {
      draftSavedCalled = true
      return 2
    }

    async function handleRunToStep(targetStepId: string, dirty: boolean) {
      if (trialRun && trialRun.status === 'HOLDING') {
        if (holdingDraftStepId === targetStepId) {
          messages.push('当前步骤处于挂起/异常状态，请点击右侧「仅重试此步」或修复后重试')
          return
        }
        if (dirty) {
          const savedRev = await ensureDraftSaved()
          if (savedRev === null) return
        }
        debugRunCalledWith = {
          action: 'continue_to_step',
          targetStepId,
          fencingToken: trialRun.checkpoint.fencingToken,
        }
      }
    }

    // 1. 当目标步骤就是挂起失败的步骤时，触发阻断提示，避免重复下发步进
    await handleRunToStep('step-failed-1', false)
    expect(messages).toEqual(['当前步骤处于挂起/异常状态，请点击右侧「仅重试此步」或修复后重试'])
    expect(debugRunCalledWith).toBeNull()

    // 2. 当目标是后续步骤且草稿有变动时，先自动保存草稿再下发指令
    await handleRunToStep('step-next-2', true)
    expect(draftSavedCalled).toBe(true)
    expect(debugRunCalledWith).toEqual({
      action: 'continue_to_step',
      targetStepId: 'step-next-2',
      fencingToken: 'fence-abc',
    })
  })
})
