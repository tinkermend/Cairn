import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { sampleCustomRole, systemRoles } from '../data/roles'
import { RolesDeleteDialog } from './roles-delete-dialog'

vi.mock('@/lib/rbac-api', () => ({
  deleteRole: vi.fn(async () => undefined),
}))

function renderDialog(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('RolesDeleteDialog', () => {
  it('blocks deleting a system role', async () => {
    const admin = systemRoles.find((r) => r.key === 'admin')!
    const { getByText, getByRole } = await renderDialog(
      <RolesDeleteDialog open onOpenChange={vi.fn()} currentRow={admin} />
    )
    await expect.element(getByText(/System roles cannot be deleted/i)).toBeInTheDocument()
    await expect.element(getByRole('button', { name: /Delete/i })).toBeDisabled()
  })

  it('allows deleting an unused custom role', async () => {
    const { getByText, getByRole } = await renderDialog(
      <RolesDeleteDialog
        open
        onOpenChange={vi.fn()}
        currentRow={sampleCustomRole}
      />
    )
    await expect
      .element(getByText(/Delete custom role "QA Lead"/i))
      .toBeInTheDocument()
    await expect.element(getByRole('button', { name: /Delete/i })).toBeEnabled()
  })
})
