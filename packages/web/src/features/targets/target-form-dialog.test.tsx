import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { useAuthStore } from '@/stores/auth-store'
import { TargetFormDialog } from './target-form-dialog'

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
    await expect.element(getByText('小写字母开头的 slug，2–63 字符，创建后不可改。')).toBeInTheDocument()
    await expect.element(getByLabelText('显示名')).toBeInTheDocument()
    await expect.element(getByLabelText('登录名')).toBeInTheDocument()

    await getByRole('button', { name: /登录框定位（可选）/ }).click()
    await expect.element(getByText('用户名框', { exact: true })).toBeInTheDocument()
    await expect.element(getByText('密码框', { exact: true })).toBeInTheDocument()
    await expect.element(getByText('提交', { exact: true })).toBeInTheDocument()
    await expect.element(getByText(/知道输入框的 id 或 name 就填/)).toBeInTheDocument()

    expect(document.body.textContent).not.toMatch(/探测登录|打开录制|启发式管理|会话|插件/)
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
        <TargetFormDialog open onOpenChange={vi.fn()} current={currentTarget as any} />
      </QueryClientProvider>
    )

    await expect.element(getByRole('heading', { name: '编辑目标系统' })).toBeInTheDocument()
    await expect.element(getByText('系统身份与入口')).toBeInTheDocument()
    await expect.element(getByText('运行准入与装配')).toBeInTheDocument()
    await expect.element(getByLabelText(/编码/)).toBeDisabled()
    await expect.element(getByText('系统唯一标识，创建后不可修改。')).toBeInTheDocument()

    const nameInput = getByLabelText(/名称/)
    await nameInput.fill('更新后的系统')
    await getByRole('button', { name: '保存' }).click()

    await expect.poll(() => apiMocks.updateTarget.mock.calls[0]?.[1]).toMatchObject({
      name: '更新后的系统',
      entryUrl: 'https://existing.test',
    })
  })
})
