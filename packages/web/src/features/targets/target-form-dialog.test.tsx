import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { TargetFormDialog } from './target-form-dialog'

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TargetFormDialog open onOpenChange={vi.fn()} />
    </QueryClientProvider>
  )
}

describe('TargetFormDialog', () => {
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
})


