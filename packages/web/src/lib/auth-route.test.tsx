import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { routeTree } from '@/routeTree.gen'
import '@/styles/index.css'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { useAuthStore } from '@/stores/auth-store'
import { ThemeProvider } from '@/context/theme-provider'
import { getLoginRedirect } from './auth'
import { getCookie } from './cookies'

// 进度条与认证无关，避免其动态依赖预构建重载浏览器测试。
vi.mock('@/components/navigation-progress', () => ({
  NavigationProgress: () => null,
}))

const token = 'still-valid-token'
const account = {
  id: 'acc-1',
  displayName: '会话测试',
  email: 'session@example.com',
  status: 'active',
  roles: [],
  permissions: [],
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:00.000Z',
}
const fetchMock = vi.fn<typeof fetch>()
let client: QueryClient

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function renderConsole(initialEntry = '/') {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createRouter({
    routeTree,
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  const screen = await render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  )
  return { screen, router }
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useAuthStore.getState().auth.reset()
  useAuthStore.getState().auth.setAccessToken(token)
})

afterEach(() => {
  client?.clear()
  useAuthStore.getState().auth.reset()
  vi.unstubAllGlobals()
})

describe('控制台会话恢复', () => {
  it('返回地址保留本站路径、查询与锚点，拒绝站外或无效地址', () => {
    expect(getLoginRedirect('/targets?view=all#recent')).toBe(
      '/targets?view=all#recent'
    )
    expect(getLoginRedirect('/sign-in/?redirect=%2Ftargets%3Fview%3Dall')).toBe(
      '/targets?view=all'
    )
    for (const destination of [
      undefined,
      '/sign-in',
      '//other.example',
      'http://[',
    ]) {
      expect(getLoginRedirect(destination)).toBe('/')
    }
  })

  it('登录返回地址嵌套了登录页时，只提交一次就进入平台', async () => {
    useAuthStore.getState().auth.reset()
    fetchMock.mockImplementation(async () =>
      response({
        accessToken: token,
        tokenType: 'Bearer',
        expiresIn: 43200,
        account,
      })
    )
    const { screen, router } = await renderConsole(
      '/sign-in?redirect=%2Fsign-in%3Fredirect%3D%252F'
    )
    await screen
      .getByRole('textbox', { name: '账号', exact: true })
      .fill('admin')
    await screen.getByLabelText('密码', { exact: true }).fill('test-password')
    await screen.getByRole('button', { name: '登录', exact: true }).click()

    await expect
      .element(screen.getByRole('heading', { name: '你好，会话测试' }))
      .toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([500, 502, 503, 'offline'] as const)(
    '%s 时保留凭证，服务恢复后返回首页无需登录',
    async (failure) => {
      if (failure === 'offline') {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
      } else {
        fetchMock.mockImplementation(async () =>
          response(
            {
              code: 'INTERNAL_ERROR',
              message: '服务暂时不可用',
              requestId: 'test',
            },
            failure
          )
        )
      }
      const { screen, router } = await renderConsole()
      await expect
        .element(screen.getByRole('heading', { name: '服务暂时不可用' }))
        .toBeInTheDocument()
      expect(router.state.location.pathname).toBe('/')
      expect(useAuthStore.getState().auth.accessToken).toBe(token)
      expect(getCookie('thisisjustarandomstring')).toBe(JSON.stringify(token))

      fetchMock.mockImplementation(async () => response({ account }))
      await screen.getByRole('button', { name: '返回首页' }).click()
      await expect
        .element(screen.getByRole('heading', { name: '你好，会话测试' }))
        .toBeInTheDocument()
      expect(useAuthStore.getState().auth.accessToken).toBe(token)
    }
  )

  it('401 才清除凭证并跳转登录页', async () => {
    fetchMock.mockImplementation(async () =>
      response(
        {
          code: 'UNAUTHENTICATED',
          message: '登录已过期或无效',
          requestId: 'test',
        },
        401
      )
    )
    const { screen, router } = await renderConsole()
    await expect
      .element(screen.getByRole('button', { name: '登录', exact: true }))
      .toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/sign-in')
    expect(useAuthStore.getState().auth.accessToken).toBe('')
    expect(getCookie('thisisjustarandomstring')).toBeUndefined()
  })
})
