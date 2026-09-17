import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { PERMISSIONS } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { sampleCustomRole } from '../data/roles'
import { RoleMembersSheet } from './role-members-sheet'

const { fetchRoleAccounts, addRoleAccounts, removeRoleAccounts, fetchAccounts } = vi.hoisted(() => ({
  fetchRoleAccounts: vi.fn(),
  addRoleAccounts: vi.fn(),
  removeRoleAccounts: vi.fn(),
  fetchAccounts: vi.fn(),
}))

vi.mock('@/lib/rbac-api', () => ({
  fetchRoleAccounts,
  addRoleAccounts,
  removeRoleAccounts,
  fetchAccounts,
}))

function renderSheet(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const mockMembers = [
  {
    id: 'user-1',
    displayName: 'Alice Engineer',
    email: 'alice@example.com',
    status: 'active' as const,
    assignedAt: '2026-03-01T10:00:00.000Z',
  },
  {
    id: 'user-2',
    displayName: 'Bob Tester',
    email: 'bob@example.com',
    status: 'active' as const,
    assignedAt: '2026-03-02T10:00:00.000Z',
  },
]

const mockAllAccounts = [
  {
    id: 'user-1',
    displayName: 'Alice Engineer',
    email: 'alice@example.com',
    status: 'active' as const,
    roles: [{ id: 'role-qa', key: 'qa_lead', name: 'QA Lead', kind: 'custom' as const }],
    permissions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'user-3',
    displayName: 'Charlie Developer',
    email: 'charlie@example.com',
    status: 'active' as const,
    roles: [],
    permissions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
]

describe('RoleMembersSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchRoleAccounts.mockResolvedValue({ items: mockMembers })
    fetchAccounts.mockResolvedValue({ items: mockAllAccounts, total: 2 })
    addRoleAccounts.mockResolvedValue({ addedCount: 1 })
    removeRoleAccounts.mockResolvedValue({ removedCount: 1 })

    useAuthStore.getState().auth.setUser({
      id: 'admin',
      displayName: 'Admin',
      email: 'admin@example.com',
      roles: ['admin'],
      permissions: [...PERMISSIONS],
    })
  })

  it('renders members list correctly', async () => {
    const { getByText } = await renderSheet(
      <RoleMembersSheet role={sampleCustomRole} open={true} onOpenChange={vi.fn()} />
    )

    await expect.element(getByText('QA Lead · 成员管理')).toBeInTheDocument()
    await expect.element(getByText('Alice Engineer')).toBeInTheDocument()
    await expect.element(getByText('alice@example.com')).toBeInTheDocument()
    await expect.element(getByText('Bob Tester')).toBeInTheDocument()
  })

  it('allows removing a member when authorized', async () => {
    const { getByRole } = await renderSheet(
      <RoleMembersSheet role={sampleCustomRole} open={true} onOpenChange={vi.fn()} />
    )

    const removeBtn = getByRole('button', { name: '移出 Alice Engineer' })
    await expect.element(removeBtn).toBeInTheDocument()

    await userEvent.click(removeBtn)

    await vi.waitFor(() => expect(removeRoleAccounts).toHaveBeenCalledOnce())
    expect(removeRoleAccounts).toHaveBeenCalledWith(sampleCustomRole.id, {
      accountIds: ['user-1'],
    })
  })

  it('allows adding a new member to the role', async () => {
    const { getByRole, getByText } = await renderSheet(
      <RoleMembersSheet role={sampleCustomRole} open={true} onOpenChange={vi.fn()} />
    )

    const addButton = getByRole('button', { name: /添加成员/ })
    await userEvent.click(addButton)

    await expect.element(getByText('添加成员 · QA Lead')).toBeInTheDocument()
    await expect.element(getByText('Charlie Developer')).toBeInTheDocument()

    // 选中 Charlie Developer
    const checkbox = getByRole('checkbox', { name: '选择 Charlie Developer' })
    await userEvent.click(checkbox)

    const submitAddButton = getByRole('button', { name: /确认添加/ })
    await userEvent.click(submitAddButton)

    await vi.waitFor(() => expect(addRoleAccounts).toHaveBeenCalledOnce())
    expect(addRoleAccounts).toHaveBeenCalledWith(sampleCustomRole.id, {
      accountIds: ['user-3'],
    })
  })
})
