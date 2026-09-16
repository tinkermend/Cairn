import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { AccountFormDialog } from './account-form-dialog'

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AccountFormDialog open onOpenChange={vi.fn()} targetId='target-1' />
    </QueryClientProvider>
  )
}

describe('AccountFormDialog', () => {
  it('只写密码，不出现选择器或会话入口', async () => {
    const { getByRole, getByLabelText } = await renderDialog()
    await expect.element(getByRole('heading', { name: '添加目标账号' })).toBeInTheDocument()
    await expect.element(getByLabelText('登录名')).toBeInTheDocument()
    await expect.element(getByLabelText('期望身份')).toBeInTheDocument()
    await expect.element(getByLabelText('密码', { exact: true })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/选择器|会话|插件|录制/)
  })
})
