import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import type { TargetAccountDto } from '@cairn/shared'
import { TargetAccountPasswordDialog } from './account-password-dialog'

const mockAccount: TargetAccountDto = {
  id: 'acc-1',
  targetId: 'tgt-1',
  displayName: '测试操作员',
  username: 'test_operator',
  hasPassword: true,
  hasTotp: false,
  hasStorageState: false,
  status: 'active',
  usage: 'business',
  configRevision: 3,
  maxConcurrentSessions: 1,
  validityPolicy: {
    mode: 'days',
    amount: 90,
    timeZone: 'Asia/Shanghai',
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('TargetAccountPasswordDialog', () => {
  it('展示系统名称与账号信息，包含新密码与有效期控件', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <TargetAccountPasswordDialog
          targetId='tgt-1'
          targetName='ERP测试系统'
          account={mockAccount}
          open
          onOpenChange={vi.fn()}
        />
      </QueryClientProvider>,
    )

    await expect.element(screen.getByRole('heading', { name: '更新目标账号密码' })).toBeInTheDocument()
    await expect.element(screen.getByText('ERP测试系统')).toBeInTheDocument()
    await expect.element(screen.getByText('测试操作员 (test_operator)')).toBeInTheDocument()
    await expect.element(screen.getByLabelText('新密码')).toBeInTheDocument()
    await expect.element(screen.getByText('维护有效期')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '保存新密码' })).toBeInTheDocument()
  })
})
