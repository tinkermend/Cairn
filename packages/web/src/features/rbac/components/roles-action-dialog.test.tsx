import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { PERMISSIONS } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { sampleCustomRole, systemRoles } from '../data/roles'
import { RolesActionDialog } from './roles-action-dialog'

const { createRole, updateRole } = vi.hoisted(() => ({
  createRole: vi.fn(),
  updateRole: vi.fn(),
}))

vi.mock('@/lib/rbac-api', () => ({ createRole, updateRole }))

function renderDialog(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('RolesActionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createRole.mockResolvedValue(sampleCustomRole)
    updateRole.mockResolvedValue(sampleCustomRole)
    useAuthStore.getState().auth.setUser({
      id: 'admin',
      displayName: 'Admin',
      email: 'admin',
      roles: ['admin'],
      permissions: [...PERMISSIONS],
    })
  })

  it('creates a custom role with catalog permissions', async () => {
    const onOpenChange = vi.fn()
    const { getByRole, getByLabelText } = await renderDialog(
      <RolesActionDialog open onOpenChange={onOpenChange} />
    )

    await expect
      .element(getByRole('heading', { level: 2, name: /创建角色/ }))
      .toBeInTheDocument()

    await userEvent.fill(getByLabelText(/^标识$/), 'qa_lead')
    await userEvent.fill(getByLabelText(/^名称$/), 'QA Lead')
    await userEvent.click(getByLabelText('workflow:read'))
    await userEvent.click(getByRole('button', { name: /保存/ }))

    await vi.waitFor(() => expect(createRole).toHaveBeenCalledOnce())
    expect(createRole).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'qa_lead',
        name: 'QA Lead',
        permissions: ['workflow:read'],
      })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('rejects an empty form', async () => {
    const { getByRole, getByText } = await renderDialog(
      <RolesActionDialog open onOpenChange={vi.fn()} />
    )
    await userEvent.click(getByRole('button', { name: /保存/ }))
    await expect.element(getByText('请填写名称。')).toBeInTheDocument()
  })

  it('locks system roles: no save, permissions disabled', async () => {
    const admin = systemRoles.find((r) => r.key === 'admin')!
    const { getByRole, getByLabelText } = await renderDialog(
      <RolesActionDialog open onOpenChange={vi.fn()} currentRow={admin} />
    )
    await expect
      .element(getByRole('heading', { level: 2, name: /查看角色/ }))
      .toBeInTheDocument()
    await expect.element(getByLabelText('account:write')).toBeDisabled()
    await expect
      .element(getByRole('button', { name: /保存/ }))
      .not.toBeInTheDocument()
  })

  it('allows editing a custom role name', async () => {
    const onOpenChange = vi.fn()
    const { getByRole, getByLabelText } = await renderDialog(
      <RolesActionDialog
        open
        onOpenChange={onOpenChange}
        currentRow={sampleCustomRole}
      />
    )
    await userEvent.fill(getByLabelText(/^名称$/), 'QA')
    await userEvent.click(getByRole('button', { name: /保存/ }))
    await vi.waitFor(() => expect(updateRole).toHaveBeenCalledOnce())
    expect(updateRole).toHaveBeenCalledWith(
      sampleCustomRole.id,
      expect.objectContaining({
        name: 'QA',
        permissions: sampleCustomRole.permissions,
      })
    )
  })
})
