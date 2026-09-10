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
})
