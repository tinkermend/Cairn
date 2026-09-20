import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { useAuthStore } from '@/stores/auth-store'
import { AccountSessionHint } from './account-session-hint'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'

const mocks = vi.hoisted(() => ({
  fetchAccountSession: vi.fn(),
  fetchTarget: vi.fn(),
}))

vi.mock('@/lib/sessions-api', () => ({
  fetchAccountSession: mocks.fetchAccountSession,
}))
vi.mock('@/lib/targets-api', () => ({
  fetchTarget: mocks.fetchTarget,
}))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children }: { children: ReactNode }) => <a href='#'>{children}</a>,
  }
})

const account = {
  id: ACCOUNT_ID,
  targetId: TARGET_ID,
  displayName: '值班账号',
  username: 'ops',
  status: 'active' as const,
  usage: 'business' as const,
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z',
  hasPassword: true,
  expectedIdentity: null,
  authCapability: 'IDENTITY_VERIFIED' as const,
}

async function renderHint() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AccountSessionHint targetId={TARGET_ID} account={account} />
    </QueryClientProvider>,
  )
}

describe('AccountSessionHint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '测试',
      email: null,
      roles: [],
      permissions: ['session:read'],
    })
    mocks.fetchTarget.mockResolvedValue({
      id: TARGET_ID,
      authMethod: 'password',
      captchaMode: 'none',
    })
  })

  it('失联账号不得写成将准备新会话', async () => {
    mocks.fetchAccountSession.mockResolvedValue({
      status: 'lost',
      occupancy: null,
      retained: false,
      session: {
        id: '33333333-3333-4333-8333-333333333333',
        status: 'LOST',
      },
    })
    const screen = await renderHint()
    await expect.element(screen.getByText(/会话失联，处置并确认旧浏览器停止后才会继续/)).toBeInTheDocument()
    expect(document.body.innerText).not.toContain('将准备新会话')
  })

  it('就绪账号仍提示将复用现有会话', async () => {
    mocks.fetchAccountSession.mockResolvedValue({
      status: 'ready',
      occupancy: null,
      retained: false,
      session: {
        id: '33333333-3333-4333-8333-333333333333',
        status: 'OPEN',
      },
    })
    const screen = await renderHint()
    await expect.element(screen.getByText(/将复用现有会话/)).toBeInTheDocument()
    expect(document.body.innerText).not.toContain('运行可能等待手工登录')
  })

  it('有口令且可自动登录时不因未配置主动检测预告手工登录', async () => {
    mocks.fetchAccountSession.mockResolvedValue({
      status: 'unprepared',
      occupancy: null,
      retained: false,
      session: null,
    })
    const screen = await renderHint()
    await expect.element(screen.getByText(/将准备新会话/)).toBeInTheDocument()
    expect(document.body.innerText).not.toContain('运行可能等待手工登录')
  })
})
