import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { useAuthStore } from '@/stores/auth-store'
import { useAssistantStore } from '@/stores/assistant-store'
import { TargetFormDialog } from './target-form-dialog'
import type { TargetDto, TargetFormProposal } from '@cairn/shared'

const apiMocks = vi.hoisted(() => ({ createTarget: vi.fn(), updateTarget: vi.fn() }))
vi.mock('@/lib/targets-api', () => apiMocks)

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TargetFormDialog open onOpenChange={vi.fn()} />
    </QueryClientProvider>
  )
}

describe('TargetFormDialog', () => {
  beforeEach(() => {
    useAuthStore.getState().auth.setUser(null)
    apiMocks.createTarget.mockReset()
    apiMocks.updateTarget.mockReset()
    apiMocks.createTarget.mockResolvedValue({ id: 'new-target' })
    useAssistantStore.setState({ boundContext: null, adoptHandler: null })
  })

  it('提交时把所选图标和身份色写入新目标', async () => {
    const { getByRole, getByLabelText } = await renderDialog()
    await getByLabelText(/名称/).fill('业务系统')
    await getByLabelText(/编码/).fill('business-system')
    await getByLabelText('入口 URL').fill('https://example.com')
    await getByRole('button', { name: '工厂图标' }).click()
    await getByRole('button', { name: '青绿身份色' }).click()
    await getByRole('button', { name: '保存' }).click()
    await expect.poll(() => apiMocks.createTarget.mock.calls[0]?.[0]).toMatchObject({ iconKey: 'factory', accentKey: 'teal' })
  })
  it('可用键盘可达按钮选择图标和身份色，并恢复默认外观', async () => {
    const { getByRole } = await renderDialog()
    const factory = getByRole('button', { name: '工厂图标' })
    const teal = getByRole('button', { name: '青绿身份色' })
    await factory.click()
    await teal.click()
    await expect.element(factory).toHaveAttribute('aria-pressed', 'true')
    await expect.element(teal).toHaveAttribute('aria-pressed', 'true')
    await getByRole('button', { name: '恢复默认外观' }).click()
    await expect.element(getByRole('button', { name: '地球图标' })).toHaveAttribute('aria-pressed', 'true')
    await expect.element(getByRole('button', { name: '主蓝身份色' })).toHaveAttribute('aria-pressed', 'true')
  })
  it('新建可填首个账号与可选定位，不出现探测或录制', async () => {
    const { getByRole, getByLabelText, getByText } = await renderDialog()
    await expect.element(getByRole('heading', { name: '新建目标系统' })).toBeInTheDocument()
    await expect.element(getByLabelText('入口 URL')).toBeInTheDocument()
    await expect.element(getByLabelText('认证方式')).toBeInTheDocument()
    await expect.element(getByText('系统唯一标识；小写字母开头，2–63 字符，创建后不可修改。')).toBeInTheDocument()
    await expect.element(getByLabelText('显示名')).toBeInTheDocument()
    await expect.element(getByLabelText('登录名')).toBeInTheDocument()

    await getByRole('button', { name: /登录框定位（可选）/ }).click()
    await expect.element(getByText('用户名框', { exact: true })).toBeInTheDocument()
    await expect.element(getByText('密码框', { exact: true })).toBeInTheDocument()
    await expect.element(getByText('提交', { exact: true })).toBeInTheDocument()
    await expect.element(getByText(/知道输入框的 id 或 name 就填/)).toBeInTheDocument()

    expect(document.body.textContent).not.toMatch(/探测登录|打开录制|启发式管理|会话|插件/)
  })

  it('字段提示正确展示代码定义的字段说明', async () => {
    const screen = await renderDialog()
    await expect.element(screen.getByText('系统唯一标识；小写字母开头，2–63 字符，创建后不可修改。')).toBeInTheDocument()
  })

  it('仅有目标全范围管理权时允许登记账号，但隐藏首个账号的密码输入', async () => {
    const targetId = '11111111-1111-4111-8111-111111111111'
    useAuthStore.getState().auth.setUser({
      id: 'scoped', displayName: '受限管理员', email: null, roles: [],
      permissions: ['target:read', 'target:write', 'credential:read', 'credential:write'],
      targetScopes: [
        { roleId: 'target-manager', mode: 'all', targetIds: [] },
        { roleId: 'credential-manager', mode: 'selected', targetIds: [targetId] },
      ],
      targetScopePermissions: [
        { roleId: 'target-manager', permissions: ['target:read', 'target:write'] },
        { roleId: 'credential-manager', permissions: ['credential:read', 'credential:write'] },
      ],
    })
    const screen = await renderDialog()
    await expect.element(screen.getByLabelText('登录名')).toBeInTheDocument()
    await expect.element(screen.getByText('可先登记账号。密码由具备全范围凭据权限的成员补齐。')).toBeInTheDocument()
    expect(screen.getByLabelText('密码').query()).toBeNull()
  })

  it('选择图形验证码后展示图片与输入框定位，并说明自动识别', async () => {
    const { getByRole, getByLabelText, getByText } = await renderDialog()
    await getByLabelText('验证码').click()
    await getByRole('option', { name: '图形验证码' }).click()
    await getByRole('button', { name: /登录框定位（可选）/ }).click()
    await expect.element(getByText('验证码图片', { exact: true })).toBeInTheDocument()
    await expect.element(getByText('验证码输入框', { exact: true })).toBeInTheDocument()
    await expect.element(getByText(/进程内自动识别/)).toBeInTheDocument()
  })

  it('选择滑动验证码后展示滑块定位，并说明自动识别', async () => {
    const { getByRole, getByLabelText, getByText } = await renderDialog()
    await getByLabelText('验证码').click()
    await getByRole('option', { name: '滑动验证码' }).click()
    await getByRole('button', { name: /登录框定位（可选）/ }).click()
    await expect.element(getByText('滑块手柄', { exact: true })).toBeInTheDocument()
    await expect.element(getByText('滑块背景或轨道', { exact: true })).toBeInTheDocument()
    await expect.element(getByText(/进程内自动识别/)).toBeInTheDocument()
  })

  it('敏感区域选择器抽屉默认收起，点击展开后展示文本域', async () => {
    const { getByRole, getByText, getByPlaceholder } = await renderDialog()
    await expect.element(getByText('高级防护设置：敏感区域选择器')).toBeInTheDocument()
    await getByRole('button', { name: /高级防护设置/ }).click()
    await expect.element(getByPlaceholder('每行一个 CSS 选择器，例如 input[name=idCard]')).toBeInTheDocument()
    await expect.element(getByText(/截图与录像在这些元素可见时遮罩像素/)).toBeInTheDocument()
  })

  it('第一个目标账号展示状态徽章，填入登录名后联动显示已填信息', async () => {
    const { getByLabelText, getByText } = await renderDialog()
    await expect.element(getByText('未设置')).toBeInTheDocument()
    const usernameInput = getByLabelText('登录名')
    await usernameInput.fill('admin-test')
    await expect.element(getByText('已填：admin-test')).toBeInTheDocument()
  })

  it('双列并行架构清晰区分必填与选填，呈现整洁的模块化标题', async () => {
    const { getByText } = await renderDialog()
    await expect.element(getByText('系统准入')).toBeInTheDocument()
    await expect.element(getByText('运行时装配')).toBeInTheDocument()
    await expect.element(getByText('可选', { exact: true })).toBeInTheDocument()
  })

  it('编辑态下双列分别呈现身份入口与运行装配，无初始账号输入，可更新目标', async () => {
    const currentTarget = {
      id: 'target-1',
      code: 'target-one',
      name: '现有系统',
      status: 'active' as const,
      entryUrl: 'https://existing.test',
      loginUrl: 'https://existing.test/login',
      authMethod: 'password' as const,
      captchaMode: 'none' as const,
      iconKey: 'globe',
      accentKey: 'pine',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-20T00:00:00Z',
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { getByRole, getByLabelText, getByText } = await render(
      <QueryClientProvider client={client}>
        <TargetFormDialog open onOpenChange={vi.fn()} current={currentTarget as unknown as TargetDto} />
      </QueryClientProvider>
    )

    await expect.element(getByRole('heading', { name: '编辑目标系统' })).toBeInTheDocument()
    await expect.element(getByText('系统身份与入口')).toBeInTheDocument()
    await expect.element(getByText('运行准入与装配')).toBeInTheDocument()
    await expect.element(getByLabelText(/编码/)).toBeDisabled()
    await expect.element(getByText('系统唯一标识；小写字母开头，2–63 字符，创建后不可修改。')).toBeInTheDocument()

    const nameInput = getByLabelText(/名称/)
    await nameInput.fill('更新后的系统')
    await getByRole('button', { name: '保存' }).click()

    await expect.poll(() => apiMocks.updateTarget.mock.calls[0]?.[1]).toMatchObject({
      name: '更新后的系统',
      entryUrl: 'https://existing.test',
    })
  })

  it('打开新建弹窗时，向全局助手绑定目标配置上下文与推荐 Prompt', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'assistant-user', displayName: '配置员', email: null, roles: [],
      permissions: ['ai:assist', 'target:write'],
    })
    await renderDialog()
    const bound = useAssistantStore.getState().boundContext
    expect(bound?.page).toBe('target')
    expect(bound?.activeForm).toMatchObject({ formId: 'target-config', mode: 'create', targetId: undefined })
    expect(bound?.chips?.some((chip) => chip.label.includes('超时'))).toBe(true)
  })

  it('全局助手生成的 TargetFormProposal 可一键采纳至当前表单并成功保存', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'assistant-user', displayName: '配置员', email: null, roles: [],
      permissions: ['ai:assist', 'target:write'],
    })
    const screen = await renderDialog()
    const adoptHandler = useAssistantStore.getState().adoptHandler
    expect(adoptHandler).not.toBeNull()

    const proposal: TargetFormProposal = {
      kind: 'target_form',
      mode: 'create',
      summary: '推荐配置超时为 30 秒，系统名称为测试系统',
      changes: [
        { fieldId: 'name', value: '测试系统' },
        { fieldId: 'loginLeaveTimeoutSeconds', value: '30' },
      ],
    }

    const adoptResult = await adoptHandler!(proposal)
    expect(adoptResult.ok).toBe(true)

    await expect.element(screen.getByLabelText(/名称/)).toHaveValue('测试系统')
    await expect.element(screen.getByLabelText(/提交后等待离开登录页/)).toHaveValue(30)

    await screen.getByLabelText(/编码/).fill('test-system')
    await screen.getByLabelText('入口 URL').fill('https://example.com')
    await screen.getByRole('button', { name: '保存' }).click()

    await expect.poll(() => apiMocks.createTarget.mock.calls[0]?.[0]).toMatchObject({
      name: '测试系统',
      code: 'test-system',
      entryUrl: 'https://example.com',
      loginLeaveTimeoutMs: 30_000,
    })
  })

  it('在编辑模式下，采纳包含只读 code 的提案会被安全拦截', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'assistant-user', displayName: '配置员', email: null, roles: [],
      permissions: ['ai:assist', 'target:write'],
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await render(
      <QueryClientProvider client={client}>
        <TargetFormDialog
          open
          onOpenChange={vi.fn()}
          current={{ id: 'tgt-1', name: '原系统', code: 'orig-code', entryUrl: 'https://orig.com' } as TargetDto}
        />
      </QueryClientProvider>
    )

    const adoptHandler = useAssistantStore.getState().adoptHandler
    expect(adoptHandler).not.toBeNull()

    const invalidProposal: TargetFormProposal = {
      kind: 'target_form',
      mode: 'edit',
      targetId: 'tgt-1',
      summary: '尝试修改只读编码',
      changes: [
        { fieldId: 'code', value: 'new-code' },
      ],
    }

    const result = await adoptHandler!(invalidProposal)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('不可修改')
    }
  })

  it('全局助手生成的 TargetFormProposal 采纳后支持一键撤销并恢复原有字段值', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'assistant-user', displayName: '配置员', email: null, roles: [],
      permissions: ['ai:assist', 'target:write'],
    })
    const screen = await renderDialog()
    const adoptHandler = useAssistantStore.getState().adoptHandler
    const rollbackHandler = useAssistantStore.getState().rollbackHandler
    expect(adoptHandler).not.toBeNull()
    expect(rollbackHandler).not.toBeNull()

    // 1. 用户先手动填写表单初始值
    await screen.getByLabelText(/名称/).fill('用户手工名称')
    await screen.getByLabelText(/提交后等待离开登录页/).fill('15')

    const proposal: TargetFormProposal = {
      kind: 'target_form',
      mode: 'create',
      summary: '推荐配置超时为 30 秒，系统名称为推荐系统',
      changes: [
        { fieldId: 'name', value: '推荐系统' },
        { fieldId: 'loginLeaveTimeoutSeconds', value: '30' },
      ],
    }

    // 2. 采纳提案
    const adoptResult = await adoptHandler!(proposal)
    expect(adoptResult.ok).toBe(true)
    await expect.element(screen.getByLabelText(/名称/)).toHaveValue('推荐系统')
    await expect.element(screen.getByLabelText(/提交后等待离开登录页/)).toHaveValue(30)

    // 3. 执行撤销
    const rollbackResult = await rollbackHandler!(proposal)
    expect(rollbackResult.ok).toBe(true)

    // 4. 字段值恢复到采纳前的数值
    await expect.element(screen.getByLabelText(/名称/)).toHaveValue('用户手工名称')
    await expect.element(screen.getByLabelText(/提交后等待离开登录页/)).toHaveValue(15)

    // 5. 再次重复撤销应返回失败（无快照）
    const secondRollback = await rollbackHandler!(proposal)
    expect(secondRollback.ok).toBe(false)
    if (!secondRollback.ok) {
      expect(secondRollback.reason).toContain('没有可撤销的采纳记录')
    }
  })

  it('采纳包含 pendingFields 的草稿时，成功回填已知字段并自动将焦点定位于第一个 pending 字段', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'assistant-user', displayName: '配置员', email: null, roles: [],
      permissions: ['ai:assist', 'target:write'],
    })
    const screen = await renderDialog()
    const adoptHandler = useAssistantStore.getState().adoptHandler
    expect(adoptHandler).not.toBeNull()

    const proposal: TargetFormProposal = {
      kind: 'target_form',
      mode: 'create',
      summary: '规划名称、编码与超时，待补充入口地址',
      changes: [
        { fieldId: 'name', value: '财务系统' },
        { fieldId: 'code', value: 'finance-system' },
        { fieldId: 'loginLeaveTimeoutSeconds', value: '30' },
      ],
      pendingFields: ['entryUrl'],
      clarifyPrompt: '请提供入口地址',
    }

    const adoptResult = await adoptHandler!(proposal)
    expect(adoptResult.ok).toBe(true)

    await expect.element(screen.getByLabelText(/名称/)).toHaveValue('财务系统')
    await expect.element(screen.getByLabelText(/编码/)).toHaveValue('finance-system')
    await expect.element(screen.getByLabelText(/提交后等待离开登录页/)).toHaveValue(30)

    // Entry URL must be focused
    await expect.poll(() => document.activeElement?.getAttribute('name')).toBe('entryUrl')
  })
})

