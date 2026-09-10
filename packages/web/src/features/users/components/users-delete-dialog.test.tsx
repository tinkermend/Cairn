import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { type User } from '../data/schema'
import { UsersDeleteDialog } from './users-delete-dialog'

const { deleteAccount } = vi.hoisted(() => ({
  deleteAccount: vi.fn(async () => undefined),
}))
vi.mock('@/lib/rbac-api', () => ({ deleteAccount }))

const MOCK_USER: User = {
  id: 'user-delete-test',
  displayName: 'John Doe',
  email: 'john@cairn.dev',
  status: 'active',
  roles: [{ id: 'operator', key: 'operator', name: 'Operator', kind: 'system' }],
  permissions: ['workflow:read'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-02-02T00:00:00.000Z',
}

function renderDialog(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('UsersDeleteDialog', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the dialog with the correct title, description, input and buttons', async () => {
    const { getByText, getByRole } = await renderDialog(
      <UsersDeleteDialog open onOpenChange={vi.fn()} currentRow={MOCK_USER} />
    )

    await expect
      .element(getByRole('heading', { level: 2, name: /删除用户/ }))
      .toBeInTheDocument()
    await expect
      .element(
        getByText(
          new RegExp(`确定删除 ${MOCK_USER.displayName}`)
        )
      )
      .toBeInTheDocument()
    await expect.element(getByRole('textbox', { name: /显示名称/ })).toBeInTheDocument()
    await expect.element(getByRole('button', { name: /取消/ })).toBeInTheDocument()
    await expect.element(getByRole('button', { name: /^删除$/ })).toBeDisabled()
  })

  it('keeps the delete button disabled until the display name is filled correctly', async () => {
    const { getByRole } = await renderDialog(
      <UsersDeleteDialog open onOpenChange={vi.fn()} currentRow={MOCK_USER} />
    )

    const nameInput = getByRole('textbox', { name: /显示名称/ })
    const deleteButton = getByRole('button', { name: /^删除$/ })

    await expect.element(deleteButton).toBeDisabled()
    await userEvent.fill(nameInput, 'wrong-name')
    await expect.element(deleteButton).toBeDisabled()
    await userEvent.fill(nameInput, MOCK_USER.displayName)
    await expect.element(deleteButton).toBeEnabled()
  })

  it('closes the dialog when the cancel button is clicked', async () => {
    const onOpenChange = vi.fn()
    const { getByRole } = await renderDialog(
      <UsersDeleteDialog
        open
        onOpenChange={onOpenChange}
        currentRow={MOCK_USER}
      />
    )

    await userEvent.click(getByRole('button', { name: /取消/ }))
    expect(onOpenChange).toHaveBeenCalled()
  })
})
