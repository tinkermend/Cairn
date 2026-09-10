import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createTableMock } from '@/test-utils/tanstack-table'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { UsersMultiDeleteDialog } from './users-multi-delete-dialog'

const { deleteAccount } = vi.hoisted(() => ({
  deleteAccount: vi.fn(),
}))

vi.mock('@/lib/rbac-api', () => ({ deleteAccount }))

function renderDialog(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('UsersMultiDeleteDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deleteAccount.mockResolvedValue(undefined)
  })

  it('renders the dialog with the correct title, description, input and buttons', async () => {
    const { table } = createTableMock()

    const { getByRole, getByText } = await renderDialog(
      <UsersMultiDeleteDialog open onOpenChange={vi.fn()} table={table} />
    )

    const title = getByRole('heading', {
      level: 2,
      name: /删除 2 个用户/,
    })
    const desc = getByText(
      /确定删除所选用户吗/
    )
    const confirmDeleteInput = getByRole('textbox', {
      name: /请输入「DELETE」确认/,
    })
    const deleteButton = getByRole('button', { name: /^删除$/ })

    await expect.element(title).toBeInTheDocument()
    await expect.element(desc).toBeInTheDocument()
    await expect.element(confirmDeleteInput).toBeInTheDocument()
    await expect.element(deleteButton).toBeInTheDocument()
    await expect.element(deleteButton).toBeDisabled()
  })

  it('keeps the delete button disabled until the confirm delete input is filled correctly', async () => {
    const { table } = createTableMock()
    const { getByRole } = await renderDialog(
      <UsersMultiDeleteDialog open onOpenChange={vi.fn()} table={table} />
    )

    const confirmDeleteInput = getByRole('textbox', {
      name: /请输入「DELETE」确认/,
    })
    const deleteButton = getByRole('button', { name: /^删除$/ })

    await expect.element(deleteButton).toBeDisabled()

    await userEvent.fill(confirmDeleteInput, 'wrong-input')
    await expect.element(deleteButton).toBeDisabled()

    await userEvent.fill(confirmDeleteInput, 'DELETE')
    await expect.element(deleteButton).toBeEnabled()
  })

  it('closes the dialog when the cancel button is clicked', async () => {
    const { table } = createTableMock()
    const onOpenChange = vi.fn()
    const { getByRole } = await renderDialog(
      <UsersMultiDeleteDialog open onOpenChange={onOpenChange} table={table} />
    )

    const cancelButton = getByRole('button', { name: /取消/ })
    await userEvent.click(cancelButton)

    expect(onOpenChange).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('resets the confirm delete input when the dialog is closed and reopened', async () => {
    const { table } = createTableMock()

    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button type='button' onClick={() => setOpen(true)}>
            Reopen
          </button>
          {open ? (
            <UsersMultiDeleteDialog
              open={open}
              onOpenChange={setOpen}
              table={table}
            />
          ) : null}
        </>
      )
    }

    const { getByRole } = await renderDialog(<Harness />)

    const confirmDeleteInput = getByRole('textbox', {
      name: /请输入「DELETE」确认/,
    })
    await userEvent.fill(confirmDeleteInput, 'DELETE')
    await expect.element(confirmDeleteInput).toHaveValue('DELETE')

    const cancelButton = getByRole('button', { name: /取消/ })
    await userEvent.click(cancelButton)

    const reopenButton = getByRole('button', { name: /Reopen/i })
    await userEvent.click(reopenButton)
    await expect.element(confirmDeleteInput).toHaveValue('')
  })

  it('deletes selected accounts and closes', async () => {
    const { table, resetRowSelection } = createTableMock()
    const onOpenChange = vi.fn()
    const { getByRole } = await renderDialog(
      <UsersMultiDeleteDialog open onOpenChange={onOpenChange} table={table} />
    )

    const confirmDeleteInput = getByRole('textbox', {
      name: /请输入「DELETE」确认/,
    })
    const deleteButton = getByRole('button', { name: /^删除$/ })

    await expect.element(deleteButton).toBeDisabled()

    await userEvent.fill(confirmDeleteInput, 'DELETE')
    await expect.element(deleteButton).toBeEnabled()

    await userEvent.click(deleteButton)

    await vi.waitFor(() => expect(deleteAccount).toHaveBeenCalled())
    expect(onOpenChange).toHaveBeenCalledWith(false)
    await vi.waitFor(() => expect(resetRowSelection).toHaveBeenCalledOnce())
  })

  it('deletes successfully when press Enter key on the confirm delete input', async () => {
    const { table, resetRowSelection } = createTableMock()
    const onOpenChange = vi.fn()
    const { getByRole } = await renderDialog(
      <UsersMultiDeleteDialog open onOpenChange={onOpenChange} table={table} />
    )

    const confirmDeleteInput = getByRole('textbox', {
      name: /请输入「DELETE」确认/,
    })
    const deleteButton = getByRole('button', { name: /^删除$/ })

    await expect.element(deleteButton).toBeDisabled()

    await userEvent.fill(confirmDeleteInput, 'DELETE')
    await expect.element(deleteButton).toBeEnabled()

    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() => expect(deleteAccount).toHaveBeenCalled())
    expect(onOpenChange).toHaveBeenCalledWith(false)
    await vi.waitFor(() => expect(resetRowSelection).toHaveBeenCalledOnce())
  })
})
