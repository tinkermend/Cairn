import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { ResourceDeleteDialog } from './resource-delete-dialog'

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('ResourceDeleteDialog', () => {
  it('当未提供 previewFn 时（如录制草稿），确认删除按钮应处于可用状态且可成功删除', async () => {
    const deleteFn = vi.fn().mockResolvedValue(undefined)
    const onSuccess = vi.fn()
    const onOpenChange = vi.fn()

    const screen = await renderWithClient(
      <ResourceDeleteDialog
        open
        onOpenChange={onOpenChange}
        resourceId='rec-123'
        resourceName='录制示例草稿'
        resourceType='recording'
        deleteFn={deleteFn}
        onSuccess={onSuccess}
      />,
    )

    await expect.element(screen.getByRole('heading', { name: '删除录制草稿' })).toBeVisible()
    await expect.element(screen.getByText('确定删除「录制示例草稿」吗？此操作不可逆。')).toBeVisible()
    await expect.element(screen.getByText('录制草稿删除后，已导入至场景的步骤不会受到影响。')).toBeVisible()

    const confirmButton = screen.getByRole('button', { name: '确认删除' })
    await expect.element(confirmButton).toBeVisible()
    await expect.element(confirmButton).toBeEnabled()

    await userEvent.click(confirmButton)

    expect(deleteFn).toHaveBeenCalledWith(undefined)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSuccess).toHaveBeenCalled()
  })

  it('当提供 previewFn 且存在 blockers 时，确认删除按钮呈禁用且文案为无法删除', async () => {
    const deleteFn = vi.fn()
    const previewFn = vi.fn().mockResolvedValue({
      previewToken: 'tok-1',
      counts: {},
      blockers: [{ id: 'b-1', code: 'BUSY', message: '资源正在执行中，不可删除' }],
    })

    const screen = await renderWithClient(
      <ResourceDeleteDialog
        open
        onOpenChange={vi.fn()}
        resourceId='sc-1'
        resourceName='进行中场景'
        resourceType='scenario'
        previewFn={previewFn}
        deleteFn={deleteFn}
        onSuccess={vi.fn()}
      />,
    )

    await expect.element(screen.getByText('资源正在执行中，不可删除')).toBeVisible()
    const disabledButton = screen.getByRole('button', { name: '无法删除' })
    await expect.element(disabledButton).toBeVisible()
    await expect.element(disabledButton).toBeDisabled()
    expect(deleteFn).not.toHaveBeenCalled()
  })

  it('当提供 previewFn 且检查出错时，确认删除按钮呈禁用状态', async () => {
    const deleteFn = vi.fn()
    const previewFn = vi.fn().mockRejectedValue(new Error('网络超时'))

    const screen = await renderWithClient(
      <ResourceDeleteDialog
        open
        onOpenChange={vi.fn()}
        resourceId='sc-1'
        resourceName='出错场景'
        resourceType='scenario'
        previewFn={previewFn}
        deleteFn={deleteFn}
        onSuccess={vi.fn()}
      />,
    )

    await expect.element(screen.getByText('无法检查删除影响范围')).toBeVisible()
    const confirmButton = screen.getByRole('button', { name: '确认删除' })
    await expect.element(confirmButton).toBeDisabled()
    expect(deleteFn).not.toHaveBeenCalled()
  })
})
