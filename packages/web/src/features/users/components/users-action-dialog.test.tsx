import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import type { RoleDto } from '@cairn/shared'
import { type User } from '../data/schema'
import { UsersActionDialog } from './users-action-dialog'

const MOCK_ROLES: RoleDto[] = [
  {
    id: 'author',
    key: 'author',
    name: '编写者',
    kind: 'system',
    description: null,
    permissions: ['workflow:write'],
    accountCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'operator',
    key: 'operator',
    name: '执行者',
    kind: 'system',
    description: null,
    permissions: ['workflow:read'],
    accountCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
]

const MOCK_USER: User = {
  id: 'acc-1',
  displayName: 'Alex Smith',
  email: 'alex@cairn.dev',
  status: 'active',
  roles: [{ id: 'operator', key: 'operator', name: 'Operator', kind: 'system' }],
  permissions: ['workflow:read'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-02-02T00:00:00.000Z',
}

const { createAccount, updateAccount, assignAccountRoles, setAccountPassword } = vi.hoisted(() => ({
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  assignAccountRoles: vi.fn(),
  setAccountPassword: vi.fn(),
}))

vi.mock('@/lib/rbac-api', () => ({
  createAccount,
  updateAccount,
  assignAccountRoles,
  setAccountPassword,
}))

function renderDialog(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('UsersActionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createAccount.mockResolvedValue(MOCK_USER)
    updateAccount.mockResolvedValue(MOCK_USER)
    assignAccountRoles.mockResolvedValue(MOCK_USER)
    setAccountPassword.mockResolvedValue(undefined)
  })

  describe('add user', () => {
    it('renders title and description', async () => {
      const { getByRole, getByText } = await renderDialog(
        <UsersActionDialog open onOpenChange={vi.fn()} roles={MOCK_ROLES} />
      )

      await expect
        .element(getByRole('heading', { level: 2, name: /新增用户/ }))
        .toBeInTheDocument()
      await expect
        .element(getByText(/创建使用本地密码的控制台账号/))
        .toBeInTheDocument()
    })

    it('shows validation when display name is empty', async () => {
      const { getByRole, getByText } = await renderDialog(
        <UsersActionDialog open onOpenChange={vi.fn()} roles={MOCK_ROLES} />
      )
      await userEvent.click(getByRole('button', { name: /保存/ }))
      await expect.element(getByText('请填写显示名称。')).toBeInTheDocument()
    })

    it('submits display name, email, password and default author role', async () => {
      const onOpenChange = vi.fn()
      const { getByRole, getByLabelText } = await renderDialog(
        <UsersActionDialog open onOpenChange={onOpenChange} roles={MOCK_ROLES} />
      )

      await userEvent.fill(getByLabelText(/显示名称/), 'New Operator')
      await userEvent.fill(getByLabelText(/^账号$/), 'ops@cairn.dev')
      await userEvent.fill(getByLabelText(/^密码$/), 'password1')
      await userEvent.click(getByRole('button', { name: /保存/ }))

      await vi.waitFor(() => expect(createAccount).toHaveBeenCalledOnce())
      expect(createAccount).toHaveBeenCalledWith({
        displayName: 'New Operator',
        email: 'ops@cairn.dev',
        password: 'password1',
        status: 'active',
        roleIds: ['author'],
      })
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  describe('edit user', () => {
    it('renders title and description', async () => {
      const { getByRole, getByText } = await renderDialog(
        <UsersActionDialog
          open
          onOpenChange={vi.fn()}
          currentRow={MOCK_USER}
          roles={MOCK_ROLES}
        />
      )
      await expect
        .element(getByRole('heading', { level: 2, name: /编辑用户/ }))
        .toBeInTheDocument()
      await expect
        .element(getByText(/更新账号信息与角色分配/))
        .toBeInTheDocument()
    })

    it('submits updated display name', async () => {
      const onOpenChange = vi.fn()
      const screen = await renderDialog(
        <UsersActionDialog
          open
          onOpenChange={onOpenChange}
          currentRow={MOCK_USER}
          roles={MOCK_ROLES}
        />
      )

      await userEvent.fill(screen.getByLabelText(/显示名称/), 'Alex Updated')
      await userEvent.click(screen.getByRole('button', { name: /保存/ }))

      await vi.waitFor(() => expect(updateAccount).toHaveBeenCalledOnce())
      expect(updateAccount).toHaveBeenCalledWith(
        MOCK_USER.id,
        expect.objectContaining({
          displayName: 'Alex Updated',
          email: MOCK_USER.email,
        })
      )
      expect(assignAccountRoles).toHaveBeenCalledWith(MOCK_USER.id, {
        roleIds: ['operator'],
      })
      expect(setAccountPassword).not.toHaveBeenCalled()
    })
  })
})
