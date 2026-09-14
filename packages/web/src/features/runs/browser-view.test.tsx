import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedBrowserMeta } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { BrowserView } from './browser-view'

const mocks = vi.hoisted(() => ({
  fetchManagedBrowser: vi.fn(),
  subscribeBrowserFrames: vi.fn(),
  acquireAuthControl: vi.fn(),
  heartbeatAuthControl: vi.fn(),
  inputAuthControl: vi.fn(),
  releaseAuthControl: vi.fn(),
  resumeRunAuth: vi.fn(),
}))

vi.mock('@/lib/runs-api', () => mocks)

const meta: ManagedBrowserMeta = {
  runId: '44444444-4444-4444-8444-444444444444',
  runStatus: 'WAITING_FOR_AUTH',
  sessionId: '55555555-5555-4555-8555-555555555555',
  sessionGeneration: 1,
  ownerWorkerId: 'local-worker',
  framesAvailable: false,
  viewingOtherPage: false,
  currentPage: null,
  pages: [],
  authHold: {
    expiresAt: '2026-09-13T00:01:00.000Z',
    bound: true,
    runId: '44444444-4444-4444-8444-444444444444',
  },
  authControl: { epoch: 0, actorId: null, expiresAt: null, heldByViewer: false },
  capabilities: {
    screencast: 'open',
    authInput: 'open',
    popupHandoff: 'open',
    chineseInsertText: 'open',
  },
  degradedReason: null,
}

function signIn(permissions: string[]) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions,
  })
}

async function renderView(status = 'WAITING_FOR_AUTH') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <BrowserView runId={meta.runId} runStatus={status} />
    </QueryClientProvider>,
  )
}

describe('BrowserView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchManagedBrowser.mockResolvedValue(meta)
    mocks.subscribeBrowserFrames.mockResolvedValue(undefined)
    mocks.releaseAuthControl.mockResolvedValue({ released: true })
    mocks.heartbeatAuthControl.mockResolvedValue({
      expiresAt: '2026-09-13T00:00:30.000Z',
      epoch: 1,
    })
    mocks.acquireAuthControl.mockResolvedValue({
      token: 't'.repeat(32),
      epoch: 1,
      expiresAt: '2026-09-13T00:00:30.000Z',
      pageRef: {
        sessionId: meta.sessionId,
        sessionGeneration: 1,
        pageId: '66666666-6666-4666-8666-666666666666',
        documentEpoch: 0,
      },
      meta: { ...meta, authControl: { ...meta.authControl!, heldByViewer: true, epoch: 1 } },
    })
  })

  it('没有画面权限时不渲染', async () => {
    signIn(['run:read'])
    const screen = await renderView()
    expect(screen.getByRole('region', { name: '受管浏览器' }).elements()).toHaveLength(0)
  })

  it('等待认证时折叠态主操作就是处理登录', async () => {
    signIn(['run:read', 'session:view', 'session:control', 'run:execute'])
    const screen = await renderView()
    await expect.element(screen.getByRole('button', { name: '处理登录' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认目标系统已登录' }).elements()).toHaveLength(0)
    await screen.getByRole('button', { name: '处理登录' }).click()
    expect(mocks.acquireAuthControl).toHaveBeenCalledWith(meta.runId)
    await expect.element(screen.getByRole('button', { name: '登录完成，继续运行' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '放弃控制' })).toBeInTheDocument()
  })

  it('他人持权时不能再申请输入', async () => {
    mocks.fetchManagedBrowser.mockResolvedValue({
      ...meta,
      authControl: { epoch: 2, actorId: 'other', expiresAt: '2026-09-13T00:00:30.000Z', heldByViewer: false },
    })
    signIn(['run:read', 'session:view', 'session:control', 'run:execute'])
    const screen = await renderView()
    await expect.element(screen.getByText('由其他用户处理登录')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '处理登录' }).element()).toBeDisabled()
  })
})
