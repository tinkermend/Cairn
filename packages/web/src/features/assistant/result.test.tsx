import '@/styles/index.css'
import type { AssistantProposal, AssistantResult, TargetFormProposal } from '@cairn/shared'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { assistantHrefTo, AssistantResultView } from './result'

const navigateMock = vi.fn()

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigateMock,
  }
})

describe('assistantHrefTo', () => {
  it('正确解析带 search 参数的 /runs/:runId 路由', () => {
    const res = assistantHrefTo(
      '/runs/11111111-1111-4111-8111-111111111111?tab=logs&view=compact'
    )
    expect(res).toEqual({
      to: '/runs/$runId',
      params: { runId: '11111111-1111-4111-8111-111111111111' },
      search: { tab: 'logs', view: 'compact' },
    })
  })

  it('正确解析带 deepLink 参数的 /scenarios/:scenarioId 路由', () => {
    const res = assistantHrefTo(
      '/scenarios/22222222-2222-4222-8222-222222222222?action=inspect-step&step_id=step-xyz'
    )
    expect(res).toEqual({
      to: '/scenarios/$scenarioId',
      params: { scenarioId: '22222222-2222-4222-8222-222222222222' },
      search: { action: 'inspect-step', step_id: 'step-xyz' },
    })
  })

  it('正确解析带 create-account 的 /targets/:targetId 路由', () => {
    const res = assistantHrefTo(
      '/targets/33333333-3333-4333-8333-333333333333?action=create-account&prefill_username=admin_ops'
    )
    expect(res).toEqual({
      to: '/targets/$targetId',
      params: { targetId: '33333333-3333-4333-8333-333333333333' },
      search: { action: 'create-account', prefill_username: 'admin_ops' },
    })
  })

  it('正确解析 /platform-config 与常规兜底路由', () => {
    const configRes = assistantHrefTo('/platform-config?section=llm')
    expect(configRes).toEqual({
      to: '/platform-config',
      search: { section: 'llm' },
    })

    const otherRes = assistantHrefTo('/settings')
    expect(otherRes).toEqual({
      to: '/settings',
    })
  })
})

describe('同名场景发现结果', () => {
  it('显示各自目标，并把第二个候选准确打开到第二个场景', async () => {
    navigateMock.mockClear()
    const alphaId = '11111111-1111-4111-8111-111111111111'
    const betaId = '22222222-2222-4222-8222-222222222222'
    const result = {
      kind: 'discovery',
      candidates: [
        { id: alphaId, name: '订单对账场景', targetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', targetName: '系统-甲', kind: 'scenario' },
        { id: betaId, name: '订单对账场景', targetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', targetName: '系统-乙', kind: 'scenario' },
      ],
      scope: { entityType: 'scenario' },
      coverage: { totalVisible: 2, hasMore: false, observedAt: '2026-09-28T00:00:00.000Z' },
      message: '已检索到 2 个可用场景候选：',
    } as AssistantResult
    const screen = await render(<AssistantResultView result={result} />)
    await expect.element(screen.getByText('系统-甲')).toBeVisible()
    await expect.element(screen.getByText('系统-乙')).toBeVisible()
    const buttons = screen.getByRole('button', { name: '查看' }).elements()
    expect(buttons).toHaveLength(2)
    await (buttons[1] as HTMLButtonElement).click()
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/scenarios/$scenarioId',
      params: { scenarioId: betaId },
    })
  })
})

describe('AssistantResultView 结构化提案比对与采纳', () => {
  const proposal = {
    kind: 'proposal',
    proposalId: 'prop-123',
    scenarioId: 'sc-1',
    stepId: 'step-click-submit',
    reason: '登录按钮选择器更新为精确文本定位',
    executable: true,
    riskLevel: 'LOW',
    suggestedVerification: '重新执行该步骤验证点击是否生效',
    diffs: [
      {
        fieldPath: ['selector', 'value'],
        from: '#old-btn',
        to: 'button:has-text("登录")',
        changeType: 'modify',
      },
      {
        fieldPath: ['timeoutMs'],
        from: undefined,
        to: 5000,
        changeType: 'add',
      },
      {
        fieldPath: ['legacyAttr'],
        from: 'deprecated',
        to: undefined,
        changeType: 'remove',
      },
    ],
  } as unknown as AssistantProposal

  it('完整呈现字段级差异与语义颜色 Token 类名', async () => {
    const screen = await render(<AssistantResultView result={proposal} />)

    await expect
      .element(screen.getByText('登录按钮选择器更新为精确文本定位'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText(/建议修改步骤 · step-cli…/))
      .toBeInTheDocument()

    // 主视图使用字段含义，未知技术字段可按需展开核对
    await expect.element(screen.getByText('页面元素定位 · 匹配内容')).toBeInTheDocument()
    await expect.element(screen.getByText('超时时间（毫秒）')).toBeInTheDocument()
    await expect.element(screen.getByText('其他设置')).toBeInTheDocument()
    await screen.getByText('查看技术字段').click()
    await expect.element(screen.getByText('legacyAttr')).toBeVisible()

    // 检查新旧值呈现
    await expect.element(screen.getByText('- #old-btn')).toBeInTheDocument()
    await expect
      .element(screen.getByText('+ button:has-text("登录")'))
      .toBeInTheDocument()
    await expect.element(screen.getByText('+ 5000')).toBeInTheDocument()
    await expect.element(screen.getByText('- deprecated')).toBeInTheDocument()

    // 静态预检状态
    await expect
      .element(screen.getByText(/语法有效，满足依赖/))
      .toBeInTheDocument()
  })

  it('支持点击“在 Studio 中定位”与“采纳到本地草稿”', async () => {
    const onPreviewStep = vi.fn()
    const onAdopt = vi.fn()

    const screen = await render(
      <AssistantResultView
        result={proposal}
        onPreviewStep={onPreviewStep}
        onAdopt={onAdopt}
      />
    )

    const previewBtn = screen.getByRole('button', { name: /在 Studio 中定位/ })
    await previewBtn.click()
    expect(onPreviewStep).toHaveBeenCalledWith('step-click-submit')

    const adoptBtn = screen.getByRole('button', { name: /采纳到本地草稿/ })
    await adoptBtn.click()
    expect(onAdopt).toHaveBeenCalledWith(proposal)
  })

  it('采纳后展示已放入草稿徽章与可用的撤销采纳按钮', async () => {
    const onRollback = vi.fn()

    const screen = await render(
      <AssistantResultView
        result={proposal}
        isAdopted={true}
        canRollback={true}
        onRollback={onRollback}
      />
    )

    await expect.element(screen.getByText('已放入草稿')).toBeInTheDocument()
    const rollbackBtn = screen.getByRole('button', { name: /撤销采纳/ })
    await expect.element(rollbackBtn).toBeEnabled()

    await rollbackBtn.click()
    expect(onRollback).toHaveBeenCalledWith(proposal)
  })

  it('草稿被进一步手动修改时，撤销采纳按钮被禁用并提示防护说明', async () => {
    const onRollback = vi.fn()

    const screen = await render(
      <AssistantResultView
        result={proposal}
        isAdopted={true}
        canRollback={false}
        onRollback={onRollback}
      />
    )

    const rollbackBtn = screen.getByRole('button', { name: /撤销采纳/ })
    await expect.element(rollbackBtn).toBeDisabled()
    expect(rollbackBtn.element().getAttribute('title')).toBe(
      '草稿已有后续修改，请在画布中使用快捷键撤销'
    )
  })

  it('正确渲染 target_form 提案卡并支持点击采纳到表单', async () => {
    const onAdopt = vi.fn()
    const targetProposal: TargetFormProposal = {
      kind: 'target_form',
      mode: 'create',
      summary: '建议设置名称为业务系统，超时 30 秒',
      changes: [
        { fieldId: 'name', value: '业务系统' },
        { fieldId: 'loginLeaveTimeoutSeconds', value: '30' },
      ],
    }

    const screen = await render(
      <AssistantResultView
        result={targetProposal}
        onAdopt={onAdopt}
      />
    )

    await expect.element(screen.getByTestId('target-form-proposal-card')).toBeInTheDocument()
    await expect.element(screen.getByText('建议设置名称为业务系统，超时 30 秒')).toBeInTheDocument()
    await expect.element(screen.getByText('业务系统', { exact: true })).toBeInTheDocument()

    const adoptBtn = screen.getByRole('button', { name: /采纳到表单/ })
    await adoptBtn.click()
    expect(onAdopt).toHaveBeenCalledWith(targetProposal)
  })

  it('target_form 包含不合法修改（如编辑模式修改系统编码）时展示校验错误并禁用采纳按钮', async () => {
    const onAdopt = vi.fn()
    const invalidProposal: TargetFormProposal = {
      kind: 'target_form',
      mode: 'edit',
      targetId: 'tgt-1',
      summary: '尝试在编辑模式修改编码',
      changes: [
        { fieldId: 'code', value: 'new-code' },
      ],
    }

    const screen = await render(
      <AssistantResultView
        result={invalidProposal}
        onAdopt={onAdopt}
      />
    )

    await expect.element(screen.getByText('编码在编辑时不可修改')).toBeInTheDocument()
    const adoptBtn = screen.getByRole('button', { name: /采纳到表单/ })
    await expect.element(adoptBtn).toBeDisabled()
  })
})

describe('AssistantResultView 诊断结果与已确认事实呈现', () => {
  it('正确呈现结构化事实、时效状态与依据展开', async () => {
    const diagnosis = {
      kind: 'diagnosis',
      focus: 'overview',
      observedAt: '2026-09-23T12:00:00.000Z',
      facts: [
        {
          id: 'fact-1',
          text: '当前基础服务与 Worker 进程运行正常',
          scope: 'platform',
          observedAt: '2026-09-23T12:00:00.000Z',
          validUntil: new Date(Date.now() + 60_000).toISOString(),
          citations: ['run:11111111-1111-4111-8111-111111111111'],
        },
        {
          id: 'fact-2',
          text: '用户中心登录接口返回 401 凭据失效',
          scope: 'target',
          observedAt: '2026-09-20T10:00:00.000Z',
          validUntil: '2026-09-20T10:05:00.000Z',
          citations: [
            'attempt:22222222-2222-4222-8222-222222222222',
            'monitoring:auth.failure_rate_high',
          ],
        },
      ],
      hypotheses: [
        {
          text: '凭据已在目标系统被管理员轮换，需更新机密配置',
          citations: ['monitoring:auth.failure_rate_high'],
        },
      ],
      missingInformation: ['近期目标系统是否有发布变更'],
      nextActions: [
        {
          kind: 'target.credentials',
          label: '更新凭据',
          href: '/credentials',
          citations: [],
        },
      ],
    } as unknown as AssistantResult

    const screen = await render(<AssistantResultView result={diagnosis} />)

    await expect
      .element(screen.getByText('当前基础服务与 Worker 进程运行正常'))
      .toBeInTheDocument()
    await expect.element(screen.getByText('平台系统事实')).toBeInTheDocument()
    await expect.element(screen.getByText('时效有效')).toBeInTheDocument()

    await expect
      .element(screen.getByText('用户中心登录接口返回 401 凭据失效'))
      .toBeInTheDocument()
    await expect.element(screen.getByText('目标业务事实')).toBeInTheDocument()
    await expect.element(screen.getByText('时效已过期')).toBeInTheDocument()

    // 展开事实依据链
    const expandBtn = screen.getByRole('button', { name: '1 处依据 展开' })
    await expandBtn.click()
    await expect.element(screen.getByText('事实证据链：')).toBeInTheDocument()
    const runCitation = screen.getByRole('button', { name: '打开运行记录 · 11111111' })
    await expect.element(runCitation).toBeInTheDocument()
    await runCitation.click()
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/runs/$runId',
      params: { runId: '11111111-1111-4111-8111-111111111111' },
    })

    await screen.getByRole('button', { name: '2 处依据 展开' }).click()
    await expect.element(screen.getByText('执行尝试 · 22222222')).toBeVisible()
    await expect.element(screen.getByRole('button', { name: /打开执行尝试/ })).not.toBeInTheDocument()
  })
})

describe('AssistantResultView 功能导览 Guide 紧凑微卡与自适应双列布局', () => {
  const guideResult = {
    kind: 'guide',
    items: [
      {
        topic: 'targets',
        title: '目标系统',
        steps: '打开工作台「目标系统」，选择要仿真的系统。',
        href: '/targets',
        availability: 'available',
      },
      {
        topic: 'accounts',
        title: '目标账号',
        steps: '查看维护账号与凭据。',
        href: '/targets?action=accounts',
        availability: 'available',
      },
      {
        topic: 'browser',
        title: '受管浏览器画面',
        steps: '入口在运行详情，不是独立侧栏菜单。',
        href: null,
        availability: 'available',
      },
    ],
  } as unknown as AssistantResult

  it('展示标题、完整操作说明与进入按钮', async () => {
    navigateMock.mockClear()
    const onNavigate = vi.fn()
    const screen = await render(
      <AssistantResultView result={guideResult} onNavigate={onNavigate} />
    )

    await expect
      .element(screen.getByText('目标系统', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('目标账号', { exact: true }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('受管浏览器画面', { exact: true }))
      .toBeInTheDocument()

    // 检查状态点与文本
    const statusDots = screen.getByText('可用').elements()
    expect(statusDots.length).toBe(3)

    // 检查按钮名称保持“打开入口”兼容测试与可访问性，视觉上包含“进入”
    const enterButtons = screen
      .getByRole('button', { name: '打开入口' })
      .elements()
    expect(enterButtons.length).toBe(2)
    expect(enterButtons[0].textContent).toContain('进入')

    // 点击按钮跳转
    await (enterButtons[0] as HTMLElement).click()
    expect(navigateMock).toHaveBeenCalledWith({ to: '/targets' })
    expect(onNavigate).toHaveBeenCalled()
  })

  it('支持点击整卡表面直接触发跳转', async () => {
    navigateMock.mockClear()
    const onNavigate = vi.fn()
    const screen = await render(
      <AssistantResultView result={guideResult} onNavigate={onNavigate} />
    )

    const accountCard = screen.getByTestId('guide-item-accounts')
    await accountCard.click()
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/targets',
      search: { action: 'accounts' },
    })
    expect(onNavigate).toHaveBeenCalled()
  })

  it('无 href 的项不呈现操作按钮且不可点击', async () => {
    const screen = await render(<AssistantResultView result={guideResult} />)
    const browserCard = screen.getByTestId('guide-item-browser')
    expect(browserCard.element().querySelector('button')).toBeNull()
  })

  it('在窄容器（<=440px）呈现单列，宽容器（>440px）自适应双列且不超过两列', async () => {
    const screen = await render(
      <div style={{ width: '400px' }} data-testid='container-narrow'>
        <AssistantResultView result={guideResult} />
      </div>
    )
    const grid = screen.getByTestId('guide-grid').element()
    expect(grid.className).toContain('grid-cols-1')
    expect(grid.className).toContain('@[440px]:grid-cols-2')

    // 检查计算样式：在 400px 宽度下单列布局
    const computedNarrow = window.getComputedStyle(grid)
    const colsNarrow = computedNarrow.gridTemplateColumns.split(' ')
    expect(colsNarrow.length).toBe(1)
  })

  it('在宽容器（600px）下计算样式呈现双列', async () => {
    const screen = await render(
      <div style={{ width: '600px' }} data-testid='container-wide'>
        <AssistantResultView result={guideResult} />
      </div>
    )
    const grid = screen.getByTestId('guide-grid').element()
    const computedWide = window.getComputedStyle(grid)
    const colsWide = computedWide.gridTemplateColumns.split(' ')
    expect(colsWide.length).toBe(2)
  })

  it('正确渲染页面内操作指引 in_page_guidance 卡片与视觉动线', async () => {
    const inPageGuidanceResult = {
      kind: 'in_page_guidance' as const,
      directAnswer: '在当前场景工作室左侧步骤列表最底部，点击【+ 添加步骤】按钮即可追加新步骤。',
      visualPath: [
        '1. 视线移至页面【左侧步骤编排列表】',
        '2. 定位到【添加步骤】交互区域',
        '3. 弹出步骤类型菜单，可向当前编排追加新操作',
      ],
      shortcutHint: 'Cmd/Ctrl + S',
      actionChip: {
        label: '展开添加步骤',
        actionKey: 'open-add-step-menu',
      },
    }

    const screen = await render(<AssistantResultView result={inPageGuidanceResult} />)
    await expect.element(screen.getByText(/在当前场景工作室左侧步骤列表最底部/)).toBeInTheDocument()
    await expect.element(screen.getByText(/视线移至页面【左侧步骤编排列表】/)).toBeInTheDocument()
    await expect.element(screen.getByText(/快捷键：Cmd\/Ctrl \+ S/)).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '展开添加步骤' })).toBeInTheDocument()
  })

  it('正确渲染有源问答 knowledge_answer 卡片、事实类别与引用', async () => {
    const knowledgeResult = {
      kind: 'knowledge_answer' as const,
      summary: '在场景工作区选中步骤，可在执行与容错策略中配置重试上限（0~10 次）；0 表示不自动重试。',
      claims: [
        {
          factKind: 'human_confirmed' as const,
          text: '当前配置字段为 policy.retryLimit；界面没有 maxAttempts 或退避延迟输入项。',
          citations: ['help:studio-retry'],
        },
        {
          factKind: 'observed' as const,
          text: '当前运行状态为 SUCCEEDED',
          citations: ['run:01920000-0000-7000-8000-000000000100'],
        },
      ],
      missing: [
        {
          key: 'step_timeout',
          reason: 'not_configured',
          description: '该步骤未配置显式超时时间',
        },
      ],
      asOf: '2026-09-23T12:00:00.000Z',
      nextActions: [
        {
          kind: 'studio.step' as const,
          label: '前往场景工作室',
          href: '/scenarios',
          citations: [],
        },
      ],
    }

    const screen = await render(<AssistantResultView result={knowledgeResult} />)
    await expect.element(screen.getByTestId('knowledge-answer-card')).toBeInTheDocument()
    await expect.element(screen.getByText(/在场景工作区选中步骤.*重试上限/)).toBeInTheDocument()
    await expect.element(screen.getByText('已确认资料')).toBeInTheDocument()
    await expect.element(screen.getByText('系统观测')).toBeInTheDocument()
    await expect.element(screen.getByText('帮助资料 · 步骤重试')).toBeInTheDocument()
    await expect.element(screen.getByText('运行记录 · 01920000')).toBeInTheDocument()
    await expect.element(screen.getByTestId('knowledge-missing-list')).toBeInTheDocument()
    await expect.element(screen.getByText('该步骤未配置显式超时时间')).toBeInTheDocument()
    await expect.element(screen.getByText(/step_timeout/)).not.toBeVisible()
    await expect.element(screen.getByRole('button', { name: '前往场景工作室' })).toBeInTheDocument()
    await expect.element(screen.getByTestId('knowledge-source-as-of')).not.toBeInTheDocument()
  })

  it('区分来源数据查询时间和旧回答里含义不明的 asOf', async () => {
    const screen = await render(<AssistantResultView result={{
      kind: 'knowledge_answer',
      summary: '该账号目前没有可用会话。',
      claims: [{ factKind: 'observed', text: '活跃会话 0/1', citations: ['target:target-1'] }],
      missing: [],
      asOf: '2026-09-28T02:00:00.000Z',
      sourceAsOf: '2026-09-27T12:00:00.000Z',
    }} />)
    await expect.element(screen.getByTestId('knowledge-source-as-of')).toHaveTextContent('来源数据查询基准时间：')
    await expect.element(screen.getByTestId('knowledge-source-as-of')).toHaveTextContent(/2026-09-27|2026-09-28/)
    await expect.element(screen.getByTestId('knowledge-source-as-of')).toHaveTextContent(/GMT|UTC/)
  })

  it('旧推断需重新核验时不误显示为权限不足', async () => {
    const screen = await render(<AssistantResultView result={{
      kind: 'inaccessible',
      reasonCode: 'UNVERIFIED_HISTORY',
      message: '这条历史推断未按当前证据规则核验，请重新提问',
    }} />)
    await expect.element(screen.getByText('历史回答需复核')).toBeVisible()
    await expect.element(screen.getByText('这条历史推断未按当前证据规则核验，请重新提问')).toBeVisible()
    await expect.element(screen.getByText('无访问权限')).not.toBeInTheDocument()
  })
})

describe('AssistantResultView 面向用户的状态与差异标签', () => {
  it('知识辅助编写缺少输入时说明尚无可编辑变更，不暗示已生成步骤', async () => {
    const screen = await render(<AssistantResultView result={{
      kind: 'knowledge_proposal', proposalId: '11111111-1111-4111-8111-111111111111',
      status: 'needs_input', reason: '请先声明模型唯一标识', diagnostics: [], diffs: [],
      sources: [], unknowns: ['model_name'], executable: false,
      draftRevision: 3, documentDigest: 'a'.repeat(64),
    } as AssistantResult} />)
    await expect.element(screen.getByText(/尚未生成可编辑变更/)).toBeInTheDocument()
    await expect.element(screen.getByText(/请求记录编号/)).toBeInTheDocument()
    await expect.element(screen.getByText(/可编辑建议已生成/)).not.toBeInTheDocument()
  })

  it('知识建议确有可编辑差异时说明尚未应用', async () => {
    const screen = await render(<AssistantResultView result={{
      kind: 'knowledge_proposal', proposalId: '11111111-1111-4111-8111-111111111111',
      status: 'proposed', reason: '已生成建议', diagnostics: [],
      diffs: [{ fieldPath: ['steps', '2'], to: { name: '检查状态' } }],
      sources: [{ kind: 'module_version' }], unknowns: [], executable: true,
      draftRevision: 3, documentDigest: 'a'.repeat(64),
    } as AssistantResult} />)
    await expect.element(screen.getByText(/可编辑建议已生成，尚未应用/)).toBeInTheDocument()
    await expect.element(screen.getByText(/建议编号/)).toBeInTheDocument()
  })

  it.each([
    ['TASK_CANCELLED', '本次任务已取消'],
    ['PERMISSION_DENIED', '无访问权限'],
    ['TURN_FAILED', '处理失败'],
    ['TASK_UNSUPPORTED', '暂不支持此操作'],
  ])('%s 显示对应原因', async (reasonCode, expectedTitle) => {
    const screen = await render(
      <AssistantResultView result={{ kind: 'unsupported', reasonCode, message: '请稍后重试' }} />,
    )
    await expect.element(screen.getByText(expectedTitle)).toBeInTheDocument()
  })

  it('新增步骤使用中文类型名称，并保留差异内容', async () => {
    const screen = await render(
      <AssistantResultView result={{
        kind: 'authoring_proposal',
        operations: [{ kind: 'insert_step', step: { id: 'step-1', name: '打开详情' } }],
        diffs: [{ type: 'add', stepName: '打开详情', stepType: 'click', detail: '点击详情按钮' }],
        executable: true,
      } as unknown as AssistantResult} />,
    )
    await expect.element(screen.getByText('+ 新增节点：打开详情 (点击)')).toBeInTheDocument()
    await expect.element(screen.getByText('点击详情按钮')).toBeInTheDocument()
  })

  it('步骤提案将静态预检与现场试跑区分，并允许查看定位警告', async () => {
    const screen = await render(
      <AssistantResultView result={{
        kind: 'authoring_proposal',
        operations: [{ kind: 'insert_step', step: { id: 'step-1', name: '等待 Name 列' } }],
        diffs: [{ type: 'add', stepName: '等待 Name 列', stepType: 'wait' }],
        executable: true,
        diagnostics: [{ code: 'SCENARIO_WEAK_LOCATOR', severity: 'warning',
          message: '步骤「查询」只用 CSS 定位', stepId: 'existing-step' },
        { code: 'MAP_SOURCE_NEEDS_REVIEW', severity: 'warning',
          message: '地图元素「Name」：原始证据不可回看；采纳前请核对定位并试跑。' }],
      } as unknown as AssistantResult} />,
    )
    await expect.element(screen.getByText(/尚未验证当前页面定位和业务结果，采纳后请核对并试跑/)).toBeVisible()
    await expect.element(screen.getByText(/地图来源待核对：.*原始证据不可回看/)).toBeVisible()
    await expect.element(screen.getByText('场景还有 2 条校验提示，展开核对')).toBeVisible()
    await screen.getByText('场景还有 2 条校验提示，展开核对').click()
    await expect.element(screen.getByText('步骤「查询」只用 CSS 定位')).toBeVisible()
  })

  it('运行对比把步骤状态转为业务标签', async () => {
    const screen = await render(
      <AssistantResultView result={{
        kind: 'compare',
        summary: '两次运行存在差异',
        differences: [{ stepName: '打开页面', baseStatus: 'FAILED', targetStatus: 'SUCCEEDED' }],
        nextActions: [],
      } as unknown as AssistantResult} />,
    )
    await expect.element(screen.getByText('失败')).toBeInTheDocument()
    await expect.element(screen.getByText('成功')).toBeInTheDocument()
    await expect.element(screen.getByText('FAILED')).not.toBeInTheDocument()
  })

  it('运行对比把业务结果差异显示为可读标签', async () => {
    const screen = await render(
      <AssistantResultView result={{
        kind: 'compare', summary: '业务结果发生变化',
        differences: [{ stepName: '业务结果', baseStatus: 'PASS', targetStatus: 'FAIL' }],
        nextActions: [],
      } as unknown as AssistantResult} />,
    )
    await expect.element(screen.getByText('业务通过')).toBeInTheDocument()
    await expect.element(screen.getByText('业务异常')).toBeInTheDocument()
    await expect.element(screen.getByText('状态待确认')).not.toBeInTheDocument()
  })

  it('跨场景运行对比展示不可比原因，不显示空差异框', async () => {
    const screen = await render(
      <AssistantResultView result={{
        kind: 'compare',
        summary: '两次运行属于不同场景，不能逐步比较。',
        comparability: {
          comparable: false,
          incomparableFactors: ['SCENARIO_MISMATCH: 场景定义不同', 'TARGET_MISMATCH: 目标系统不同'],
        },
        differences: [],
        missingInformation: ['运行对比存在不可比因素：SCENARIO_MISMATCH: 场景定义不同'],
        facts: [],
        nextActions: [],
      } as unknown as AssistantResult} />,
    )
    await expect.element(screen.getByText('场景定义不同')).toBeVisible()
    await expect.element(screen.getByText('目标系统不同')).toBeVisible()
    await expect.element(screen.getByText('对比差异')).not.toBeInTheDocument()
    await expect.element(screen.getByText(/运行对比存在不可比因素/)).not.toBeInTheDocument()
  })
})
