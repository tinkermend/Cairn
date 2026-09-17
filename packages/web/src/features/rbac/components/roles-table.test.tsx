import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { PERMISSIONS } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { sampleCustomRole, systemRoles } from '../data/roles'
import { RolesProvider, useRoles } from './roles-provider'
import { RolesTable } from './roles-table'

function StateObserver() {
  const { open, currentRow } = useRoles()
  return (
    <div data-testid='roles-state'>
      <span data-testid='state-open'>{open ?? 'none'}</span>
      <span data-testid='state-role'>{currentRow?.key ?? 'none'}</span>
    </div>
  )
}

function renderTable(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RolesProvider>
        {ui}
        <StateObserver />
      </RolesProvider>
    </QueryClientProvider>
  )
}

describe('RolesTable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.getState().auth.setUser({
      id: 'admin',
      displayName: 'Admin',
      email: 'admin@example.com',
      roles: ['admin'],
      permissions: [...PERMISSIONS],
    })
  })

  it('renders roles and opens member sheet when clicking member count', async () => {
    const { getByText, getByTestId } = await renderTable(
      <RolesTable data={[systemRoles[0], sampleCustomRole]} />
    )

    await expect.element(getByText('QA Lead')).toBeInTheDocument()
    await expect.element(getByText('0 个成员')).toBeInTheDocument()

    await userEvent.click(getByText('0 个成员'))

    await expect.element(getByTestId('state-open')).toHaveTextContent('members')
    await expect.element(getByTestId('state-role')).toHaveTextContent('qa_lead')
  })

  it('triggers clone mode when clicking clone from dropdown menu', async () => {
    const { getByRole, getByTestId } = await renderTable(
      <RolesTable data={[sampleCustomRole]} />
    )

    const moreButton = getByRole('button', { name: /更多操作 QA Lead/ })
    await userEvent.click(moreButton)

    const cloneItem = getByRole('menuitem', { name: /克隆角色/ })
    await userEvent.click(cloneItem)

    await expect.element(getByTestId('state-open')).toHaveTextContent('clone')
    await expect.element(getByTestId('state-role')).toHaveTextContent('qa_lead')
  })
})
