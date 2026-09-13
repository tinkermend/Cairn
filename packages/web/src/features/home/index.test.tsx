import { render } from 'vitest-browser-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PERMISSIONS, SYSTEM_ROLE_DEFINITIONS } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { HomePage } from './index'

vi.mock('@/components/layout/app-header', () => ({ AppHeader: () => null }))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  }
})

function signIn(permissions: readonly string[]) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions: [...permissions],
  })
}

describe('HomePage', () => {
  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
  })

  it('无治理权限时不出现用户 / 角色 / 审计卡片', async () => {
    signIn(SYSTEM_ROLE_DEFINITIONS.operator.permissions)
    const screen = await render(<HomePage />)
    await expect.element(screen.getByRole('heading', { name: '目标系统' })).toBeInTheDocument()
    await expect.element(screen.getByRole('heading', { name: '运行' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '用户' }).elements()).toHaveLength(0)
    expect(screen.getByRole('heading', { name: '角色' }).elements()).toHaveLength(0)
    expect(screen.getByRole('heading', { name: '审计' }).elements()).toHaveLength(0)
    expect(screen.getByRole('heading', { name: '平台配置' }).elements()).toHaveLength(0)
  })

  it('管理员能看见治理卡片', async () => {
    signIn(PERMISSIONS)
    const screen = await render(<HomePage />)
    await expect.element(screen.getByRole('heading', { name: '用户' })).toBeInTheDocument()
    await expect.element(screen.getByRole('heading', { name: '审计' })).toBeInTheDocument()
    await expect.element(screen.getByRole('heading', { name: '平台配置' })).toBeInTheDocument()
  })
})
