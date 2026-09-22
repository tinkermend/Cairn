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
    await expect.element(getByLabelText('用途')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/选择器|会话|插件|录制/)
  })

  it('目标允许多开时显示并发上限，编辑时展示当前占用', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <AccountFormDialog
          open
          onOpenChange={vi.fn()}
          targetId='target-1'
          accountSessionMode='concurrent'
          liveCount={2}
          effectiveCap={3}
          current={{
            id: 'acc-1',
            targetId: 'target-1',
            displayName: '值班',
            username: 'ops',
            hasPassword: true,
            status: 'active',
            usage: 'business',
            maxConcurrentSessions: 3,
            createdAt: '2026-09-21T00:00:00.000Z',
            updatedAt: '2026-09-21T00:00:00.000Z',
          }}
        />
      </QueryClientProvider>,
    )
    await expect.element(screen.getByLabelText('最大并发会话')).toBeInTheDocument()
    await expect.element(screen.getByText(/当前活会话 2 \/ 上限 3/)).toBeInTheDocument()
  })
})
