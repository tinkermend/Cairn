import '@/styles/index.css'
import type { AssistantProposal, AssistantResult } from '@cairn/shared'
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

  it('展示紧凑首行（图标+标题+状态小圆点）、截断文本与进入按钮', async () => {
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
      summary: '在 Studio 中可以配置每个确定性步骤的最大重试次数与退避延迟。',
      claims: [
        {
          factKind: 'human_confirmed' as const,
          text: '确定性步骤支持配置 maxAttempts',
          citations: ['help:studio-retry'],
        },
        {
          factKind: 'observed' as const,
          text: '当前运行状态为 COMPLETED',
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
    await expect.element(screen.getByText(/在 Studio 中可以配置每个确定性步骤/)).toBeInTheDocument()
    await expect.element(screen.getByText('已确认资料')).toBeInTheDocument()
    await expect.element(screen.getByText('系统观测')).toBeInTheDocument()
    await expect.element(screen.getByText('帮助资料 · studio-r')).toBeInTheDocument()
    await expect.element(screen.getByText('运行记录 · 01920000')).toBeInTheDocument()
    await expect.element(screen.getByTestId('knowledge-missing-list')).toBeInTheDocument()
    await expect.element(screen.getByText('该步骤未配置显式超时时间')).toBeInTheDocument()
    await expect.element(screen.getByText(/step_timeout/)).not.toBeVisible()
    await expect.element(screen.getByRole('button', { name: '前往场景工作室' })).toBeInTheDocument()
  })
})

describe('AssistantResultView 面向用户的状态与差异标签', () => {
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
})
