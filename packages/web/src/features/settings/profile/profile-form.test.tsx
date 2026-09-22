import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { useAuthStore } from '@/stores/auth-store'
import { ProfileForm } from './profile-form'

const { updateMe } = vi.hoisted(() => ({
  updateMe: vi.fn(),
}))

vi.mock('@/lib/auth-api', () => ({
  updateMe,
}))

function renderProfileForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ProfileForm />
    </QueryClientProvider>
  )
}

describe('ProfileForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.getState().auth.setUser({
      id: 'acc-1',
      displayName: 'Alex Admin',
      email: 'alex@cairn.dev',
      avatar: 'bottts:cairn-bot-1',
      roles: ['admin'],
      permissions: [],
    })
  })

  afterEach(() => {
    useAuthStore.getState().auth.reset()
  })

  it('渲染头像选择区与显示名称输入框', async () => {
    const screen = await renderProfileForm()
    expect(screen.getByText('用户头像')).toBeDefined()
    expect(screen.getByRole('button', { name: '选择头像' })).toBeDefined()
    expect(screen.getByRole('textbox', { name: '显示名称' })).toBeDefined()
  })

  it('提交时包含所选头像并调用 updateMe', async () => {
    updateMe.mockResolvedValue({
      account: {
        id: 'acc-1',
        displayName: 'Alex Admin',
        email: 'alex@cairn.dev',
        avatar: 'bottts:cairn-bot-1',
        status: 'active',
        roles: [],
        permissions: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    const screen = await renderProfileForm()
    await screen.getByRole('button', { name: '保存个人资料' }).click()
    expect(updateMe).toHaveBeenCalledWith({
      displayName: 'Alex Admin',
      avatar: 'bottts:cairn-bot-1',
    })
  })
})
