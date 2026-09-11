import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, type RenderResult } from 'vitest-browser-react'
import { type Locator, userEvent } from 'vitest/browser'
import { UserAuthForm } from './user-auth-form'

const FORM_MESSAGES = {
  emailEmpty: '请输入账号。',
  passwordEmpty: '请输入密码。',
} as const

const navigate = vi.fn()
const setUserMock = vi.fn()
const setAccessTokenMock = vi.fn()

const { login } = vi.hoisted(() => ({
  login: vi.fn(async () => ({
    accessToken: 'jwt-token',
    tokenType: 'Bearer' as const,
    expiresIn: 43200,
    account: {
      id: 'acc-1',
      displayName: 'Ada',
      email: 'a@b.com',
      status: 'active' as const,
      roles: [
        {
          id: 'r1',
          key: 'admin',
          name: 'Administrator',
          kind: 'system' as const,
        },
      ],
      permissions: ['account:read'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  })),
}))

vi.mock('@/lib/auth-api', () => ({ login }))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({
    auth: {
      setUser: setUserMock,
      setAccessToken: setAccessTokenMock,
    },
  }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    Link: ({
      children,
      to,
      className,
      ...rest
    }: {
      children?: React.ReactNode
      to: string
      className?: string
    }) => (
      <a href={to} className={className} {...rest}>
        {children}
      </a>
    ),
  }
})

function renderForm(ui: React.ReactNode): Promise<RenderResult> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('UserAuthForm', () => {
  describe('Rendering without redirectTo', () => {
    let screen: RenderResult
    let emailInput: Locator
    let passwordInput: Locator
    let signInButton: Locator

    beforeEach(async () => {
      vi.clearAllMocks()
      screen = await renderForm(<UserAuthForm />)
      emailInput = screen.getByRole('textbox', { name: /^账号$/ })
      passwordInput = screen.getByLabelText(/^密码$/)
      signInButton = screen.getByRole('button', { name: /^登录$/ })
    })

    it('renders fields and submit button', async () => {
      await expect.element(emailInput).toBeInTheDocument()
      await expect.element(passwordInput).toBeInTheDocument()
      await expect.element(signInButton).toBeInTheDocument()
    })

    it('shows validation messages when submitting empty form', async () => {
      await userEvent.click(signInButton)

      await expect
        .element(screen.getByText(FORM_MESSAGES.emailEmpty))
        .toBeInTheDocument()
      await expect
        .element(screen.getByText(FORM_MESSAGES.passwordEmpty))
        .toBeInTheDocument()
    })

    it('authenticates and navigates to default route on success', async () => {
      await userEvent.fill(emailInput, 'admin')
      await userEvent.fill(passwordInput, 'cairn-admin')

      await userEvent.click(signInButton)

      await vi.waitFor(() => expect(login).toHaveBeenCalledOnce())
      expect(login).toHaveBeenCalledWith({
        email: 'admin',
        password: 'cairn-admin',
      })
      await vi.waitFor(() => expect(setUserMock).toHaveBeenCalledOnce())
      expect(setUserMock).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'a@b.com',
          id: 'acc-1',
          displayName: 'Ada',
          roles: ['admin'],
        })
      )
      expect(setAccessTokenMock).toHaveBeenCalledWith('jwt-token')

      await vi.waitFor(() =>
        expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
      )
    })

    it('keeps entered values and shows a persistent error when login fails', async () => {
      login.mockRejectedValueOnce(new Error('offline'))
      await userEvent.fill(emailInput, 'a@b.com')
      await userEvent.fill(passwordInput, 'wrong-password')

      await userEvent.click(signInButton)

      await expect
        .element(screen.getByRole('alert'))
        .toHaveTextContent('登录失败，请稍后重试。')
      await expect.element(emailInput).toHaveValue('a@b.com')
      await expect.element(passwordInput).toHaveValue('wrong-password')
    })
  })

  it('navigates to redirectTo when provided', async () => {
    vi.clearAllMocks()

    const { getByRole, getByLabelText } = await renderForm(
      <UserAuthForm redirectTo='/settings' />
    )

    await userEvent.fill(getByRole('textbox', { name: /账号/ }), 'admin')
    await userEvent.fill(getByLabelText('密码'), 'cairn-admin')

    await userEvent.click(getByRole('button', { name: /登录/ }))

    await vi.waitFor(() => expect(setUserMock).toHaveBeenCalledOnce())
    expect(setAccessTokenMock).toHaveBeenCalledWith('jwt-token')

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: '/settings',
        replace: true,
      })
    )
  })
})
