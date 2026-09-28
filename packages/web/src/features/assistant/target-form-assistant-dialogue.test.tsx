import '@/styles/index.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AssistantTurn, TargetDto, TargetFormProposal } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { useAssistantStore } from '@/stores/assistant-store'
import { useAuthStore } from '@/stores/auth-store'
import { AssistantHost } from './host'
import { TargetFormDialog } from '@/features/targets/target-form-dialog'

const { navigate } = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    useRouterState: () => ({ location: { pathname: '/targets' } }),
  }
})

const apiMocks = vi.hoisted(() => ({
  createTarget: vi.fn(async (body) => ({
    id: 'tgt-crm-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...body,
  })),
  updateTarget: vi.fn(async (id, body) => ({
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...body,
  })),
}))

vi.mock('@/lib/targets-api', () => ({
  createTarget: apiMocks.createTarget,
  updateTarget: apiMocks.updateTarget,
}))

let nextTurnToDeliver: AssistantTurn | null = null

vi.mock('@/lib/assistant-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/assistant-api')>()
  return {
    ...actual,
    fetchAssistantCapabilities: vi.fn(async () => ({
      items: [
        {
          id: 'knowledge.answer',
          label: '知识问答',
          available: true,
          missingPermissions: [],
          requiredContext: [],
        },
        {
          id: 'target.propose-form',
          label: '目标配置建议',
          available: true,
          missingPermissions: [],
          requiredContext: ['target_id'],
        },
      ],
      modelEnabled: true,
    })),
    createAssistantConversation: vi.fn(async () => ({
      id: 'conv-target-form-sim-1',
      title: '目标配置对话',
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
    })),
    createAssistantTurn: vi.fn(async (_cid: string, _body: { question: string }) => ({
      turnId: 'turn-target-form-1',
      taskId: 'turn-target-form-1',
      state: 'RUNNING',
      stage: 'accepted',
      eventSeq: 1,
      queuePosition: null,
    })),
    cancelAssistantTurn: vi.fn(async () => ({ canceled: true })),
    fetchAssistantConversations: vi.fn(async () => ({ items: [], nextCursor: null })),
    fetchAssistantTurns: vi.fn(async () => ({ items: [] })),
    fetchAssistantTurn: vi.fn(async () => nextTurnToDeliver),
    observeAssistantTurn: vi.fn(
      (_cid: string, _tid: string, callbacks: Parameters<typeof actual.observeAssistantTurn>[2]) => {
        if (nextTurnToDeliver) {
          const toSend = nextTurnToDeliver
          setTimeout(() => {
            callbacks.onTurn?.(toSend)
          }, 15)
        }
        return () => {}
      },
    ),
  }
})

describe('用户视角全流程走查：识途助手自然语言表单修改提案（LLM Form Proposal）', () => {
  let queryClient: QueryClient

  beforeEach(async () => {
    await page.viewport(1440, 900)
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    useAuthStore.getState().auth.setUser({
      id: 'u-operator-1',
      displayName: '系统集成工程师',
      email: null,
      roles: [],
      permissions: ['ai:assist', 'target:read', 'target:write'],
    })

    useAssistantStore.setState({
      open: false,
      boundContext: null,
      routeContext: null,
      pageContext: null,
      question: '',
      busy: false,
      turns: [],
      lastAdoptedProposalId: null,
      lastAdoptedDigest: null,
    })

    nextTurnToDeliver = null
    vi.clearAllMocks()
  })

  it('场景 1（新建目标·正常采纳）：用户手填基础信息，向助手发问获取超时与整理建议，一键采纳自动展开折叠区且保留原输入', async () => {
    // 1. 用户打开新建目标弹窗与助手浮窗
    await render(
      <QueryClientProvider client={queryClient}>
        <div>
          <TargetFormDialog open onOpenChange={vi.fn()} />
          <AssistantHost showFloatingLauncher={false} />
        </div>
      </QueryClientProvider>,
    )

    const dialog = page.getByRole('dialog', { name: '新建目标系统' })
    await expect.element(dialog).toBeVisible()

    // 2. 用户手动在表单输入名称、编码与入口地址
    const nameInput = dialog.getByLabelText(/名称/)
    const codeInput = dialog.getByLabelText(/编码/)
    const entryUrlInput = dialog.getByLabelText('入口 URL')
    const timeoutInput = dialog.getByLabelText(/提交后等待离开登录页/)

    await nameInput.fill('CRM客户管理系统')
    await codeInput.fill('crm-system')
    await entryUrlInput.fill('https://crm.corp.internal')
    await timeoutInput.fill('10')

    // 3. 打开助手面板，验证上下文感知正常（胶囊显示「新建目标」）
    useAssistantStore.getState().openPanel({ mode: 'floating' })
    await expect.element(page.getByTestId('context-capsule')).toBeVisible()
    await expect.element(page.getByTestId('context-capsule')).toHaveTextContent('新建目标')

    // 4. 模拟助手生成表单修改提案
    const simulatedProposal: TargetFormProposal = {
      kind: 'target_form',
      mode: 'create',
      summary: '针对企业级 CRM 系统，推荐登录页停留超时为 45 秒，并开启登录后整理（预算 15 秒）',
      changes: [
        { fieldId: 'loginLeaveTimeoutSeconds', value: '45' },
        { fieldId: 'landingSettleMode', value: 'default' },
        { fieldId: 'landingSettleTimeoutSeconds', value: '15' },
      ],
    }

    nextTurnToDeliver = {
      id: 'turn-crm-proposal-1',
      conversationId: 'conv-target-form-sim-1',
      clientTurnId: 'client-turn-1',
      parentTurnId: null,
      question: '帮我推荐登录超时与整理配置',
      status: 'COMPLETED',
      createdAt: '2026-09-28T00:00:01.000Z',
      updatedAt: '2026-09-28T00:00:02.000Z',
      result: simulatedProposal,
    }

    const questionInput = page.getByRole('textbox', { name: '向助手提问' })
    await questionInput.fill('帮我推荐登录超时与整理配置')
    const submitBtn = page.getByRole('button', { name: '发送' })
    await userEvent.click(submitBtn)

    useAssistantStore.setState({
      turns: [
        {
          id: 'turn-crm-proposal-1',
          conversationId: 'conv-target-form-sim-1',
          clientTurnId: 'client-turn-1',
          parentTurnId: null,
          question: '帮我推荐登录超时与整理配置',
          capabilityId: 'target.propose-form',
          status: 'COMPLETED',
          createdAt: '2026-09-28T00:00:01.000Z',
          updatedAt: '2026-09-28T00:00:02.000Z',
          result: simulatedProposal,
        },
      ],
      activeTurnId: null,
      busy: false,
    })

    // 5. 验证助手 UI 呈现
    const proposalCard = page.getByTestId('target-form-proposal-card')
    await expect.element(proposalCard).toBeVisible()
    await expect.element(proposalCard.getByText('目标系统配置建议')).toBeVisible()
    await expect.element(proposalCard.getByText('新建模式')).toBeVisible()
    await expect.element(proposalCard.getByText(/推荐登录页停留超时为 45 秒/)).toBeVisible()
    await expect.element(proposalCard.getByText('提交后等待离开登录页')).toBeVisible()
    await expect.element(proposalCard.getByText('45', { exact: true })).toBeVisible()
    await expect.element(proposalCard.getByText('整理预算')).toBeVisible()
    await expect.element(proposalCard.getByText('15', { exact: true })).toBeVisible()

    // 6. 用户点击「采纳到表单」
    const adoptBtn = page.getByRole('button', { name: /采纳到表单/ })
    await expect.element(adoptBtn).toBeVisible()
    await adoptBtn.click()

    // 验证超时已被采纳更新为 45 秒
    await expect.element(timeoutInput).toHaveValue(45)

    // 核心安全验证：用户先前手填的名称、编码、入口地址完好无损
    await expect.element(nameInput).toHaveValue('CRM客户管理系统')
    await expect.element(codeInput).toHaveValue('crm-system')
    await expect.element(entryUrlInput).toHaveValue('https://crm.corp.internal')

    // 7. 用户点击「撤销采纳」
    const rollbackBtn = page.getByTestId('target-form-rollback-btn')
    await expect.element(rollbackBtn).toBeVisible()
    await rollbackBtn.click()

    // 验证超时平滑恢复为用户最初输入的 10 秒
    await expect.element(timeoutInput).toHaveValue(10)

    // 8. 用户再次点击采纳并保存
    await page.getByRole('button', { name: /采纳到表单/ }).click()
    await expect.element(timeoutInput).toHaveValue(45)

    // 用户收起助手面板，在表单弹窗中点击「保存」按钮
    useAssistantStore.getState().closePanel()
    const saveBtn = dialog.getByRole('button', { name: '保存' })
    await saveBtn.click()

    // 验证提交到 API 的完整有效载荷
    await expect.poll(() => apiMocks.createTarget.mock.calls[0]?.[0]).toMatchObject({
      name: 'CRM客户管理系统',
      code: 'crm-system',
      entryUrl: 'https://crm.corp.internal',
      loginLeaveTimeoutMs: 45_000,
      landingSettleMode: 'default',
      landingSettleTimeoutMs: 15_000,
    })
  })

  it('场景 2（编辑模式·只读字段防护）：用户要求修改已存在的系统编码时，前端 UI 标红提示且禁止非法采纳', async () => {
    const existingTarget: TargetDto = {
      id: 'a0000000-0000-4000-8000-000000000001',
      name: '财务管理系统',
      code: 'finance-system',
      entryUrl: 'https://finance.internal',
      loginUrl: null,
      loginLeaveTimeoutMs: 30_000,
      landingSettleMode: 'default',
      landingSettleTimeoutMs: null,
      authMethod: 'password',
      captchaMode: 'none',
      status: 'active',
      iconKey: null,
      accentKey: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      probeStatus: 'READY',
      probeHttpCode: 200,
      probeCheckedAt: new Date().toISOString(),
      probeLatencyMs: 50,
      loginFields: [],
      sensitiveSelectors: [],
    }

    await render(
      <QueryClientProvider client={queryClient}>
        <div>
          <TargetFormDialog open onOpenChange={vi.fn()} current={existingTarget} />
          <AssistantHost showFloatingLauncher={false} />
        </div>
      </QueryClientProvider>,
    )

    useAssistantStore.getState().openPanel({ mode: 'floating' })

    // 模拟恶意或幻觉模型输出了针对编辑模式只读 code 字段的修改项
    const illegalEditProposal: TargetFormProposal = {
      kind: 'target_form',
      mode: 'edit',
      targetId: existingTarget.id,
      summary: '尝试将系统编码改为 finance-v2，并将超时设为 60 秒',
      changes: [
        { fieldId: 'code', value: 'finance-v2' },
        { fieldId: 'loginLeaveTimeoutSeconds', value: '60' },
      ],
    }

    useAssistantStore.setState({
      turns: [
        {
          id: 'turn-illegal-code-1',
          conversationId: 'conv-target-form-sim-1',
          clientTurnId: 'client-turn-2',
          parentTurnId: null,
          question: '帮我把编码改成 finance-v2',
          status: 'COMPLETED',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          result: illegalEditProposal,
        },
      ],
      busy: false,
    })

    const proposalCard = page.getByTestId('target-form-proposal-card')
    await expect.element(proposalCard).toBeVisible()
    await expect.element(proposalCard.getByText('编辑模式')).toBeVisible()

    // 核心安全验证：前端卡片逐项标红展示只读错误信息
    await expect.element(proposalCard.getByText('编码在编辑时不可修改')).toBeVisible()

    // 采纳按钮被强制禁用并呈现安全提示 Tooltip
    const adoptBtn = page.getByTestId('target-form-adopt-btn')
    await expect.element(adoptBtn).toBeDisabled()
    expect(adoptBtn.element().getAttribute('title')).toBe('提案中包含不合法的字段修改，无法采纳')
  })

  it('场景 3（权限隔离·只读用户拦截）：无写权限用户打开表单时，推荐卡片自动隐藏写操作，且无法执行写提议', async () => {
    // 将用户权限降级为只有只读权限
    useAuthStore.getState().auth.setUser({
      id: 'u-auditor-1',
      displayName: '系统审计员',
      email: null,
      roles: [],
      permissions: ['ai:assist', 'target:read'], // 无 target:write 权限！
    })

    await render(
      <QueryClientProvider client={queryClient}>
        <div>
          <TargetFormDialog open onOpenChange={vi.fn()} />
          <AssistantHost showFloatingLauncher={false} />
        </div>
      </QueryClientProvider>,
    )

    useAssistantStore.getState().openPanel({ mode: 'floating' })

    // 验证场景推荐 Chips：严格只展示只读解释类，绝不推荐「将登录等待设为30秒」写提案
    await expect.element(page.getByTestId('prompt-card-target-form-timeout-help')).toBeVisible()
    await expect.element(page.getByTestId('prompt-card-target-form-settle-help')).toBeVisible()
    await expect.element(page.getByText(/将登录等待设为30秒/)).not.toBeInTheDocument()

    // 若只读用户尝试手敲发问修改，后端返回无权限拒绝结果
    useAssistantStore.setState({
      turns: [
        {
          id: 'turn-denied-1',
          conversationId: 'conv-target-form-sim-1',
          clientTurnId: 'client-turn-3',
          parentTurnId: null,
          question: '帮我把超时改成30秒',
          status: 'COMPLETED',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          result: {
            kind: 'unsupported',
            reasonCode: 'PERMISSION_DENIED',
            message: '需要 target:write 权限才能生成目标配置提案。',
          },
        },
      ],
      busy: false,
    })

    // 验证界面呈现清晰的安全拒答提示，绝不渲染 TargetFormProposal 采纳卡片
    await expect.element(page.getByText(/需要 target:write 权限才能生成目标配置提案/)).toBeVisible()
    await expect.element(page.getByTestId('target-form-proposal-card')).not.toBeInTheDocument()
  })

  it('场景 4（不完整意图·极速通道联动）：用户意图缺少 URL 时输出带黄色警告草稿，点击「采纳并前往补齐」将焦点捕获至 URL 输入框', async () => {
    await render(
      <QueryClientProvider client={queryClient}>
        <div>
          <TargetFormDialog open onOpenChange={vi.fn()} />
          <AssistantHost showFloatingLauncher={false} />
        </div>
      </QueryClientProvider>,
    )

    const dialog = page.getByRole('dialog', { name: '新建目标系统' })
    const entryUrlInput = dialog.getByLabelText('入口 URL')

    useAssistantStore.getState().openPanel({ mode: 'floating' })

    // 模拟不完整意图输出带 pendingFields 的草稿
    const proposalWithPending: TargetFormProposal = {
      kind: 'target_form',
      mode: 'create',
      summary: '已为您规划好「进销存后台」的基础配置，但目前缺少最关键的入口地址。',
      changes: [
        { fieldId: 'name', value: '进销存后台' },
        { fieldId: 'code', value: 'jxc-admin' },
        { fieldId: 'loginLeaveTimeoutSeconds', value: '30' },
      ],
      pendingFields: ['entryUrl'],
      clarifyPrompt: '请提供系统的业务入口地址（URL）：',
    }

    useAssistantStore.setState({
      turns: [
        {
          id: 'turn-pending-url-1',
          conversationId: 'conv-target-form-sim-1',
          clientTurnId: 'client-turn-4',
          parentTurnId: null,
          question: '帮我配一个进销存后台',
          status: 'COMPLETED',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          result: proposalWithPending,
        },
      ],
      busy: false,
    })

    const proposalCard = page.getByTestId('target-form-proposal-card')
    await expect.element(proposalCard).toBeVisible()

    // 验证待补充警告与黄色引导
    await expect.element(page.getByTestId('target-form-pending-warning')).toBeVisible()
    await expect.element(page.getByText(/待补充核心必填项：入口 URL/)).toBeVisible()

    // 验证采纳按钮切换为极速通道「采纳并前往补齐 ➔」
    const patchBtn = page.getByRole('button', { name: /采纳并前往补齐/ })
    await expect.element(patchBtn).toBeVisible()

    // 用户点击「采纳并前往补齐 ➔」
    await patchBtn.click()

    // 验证已知字段成功回填至表单
    await expect.element(dialog.getByLabelText(/名称/)).toHaveValue('进销存后台')
    await expect.element(dialog.getByLabelText(/编码/)).toHaveValue('jxc-admin')

    // 核心 UX 验证：焦点自动落入待补齐的入口 URL 输入框，实现原生焦点捕获（Focus Trapping）闭环！
    await expect.element(entryUrlInput).toHaveFocus()
  })
})
