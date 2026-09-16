import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { AccessPolicyCard } from './access-policy-card'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => ({
  fetchTargetAccessPolicy: vi.fn(),
  updateTargetAccessPolicy: vi.fn(),
}))

vi.mock('@/lib/targets-api', () => mocks)

function signIn(permissions = ['target:read', 'target:write', 'map:read']) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions,
  })
}

async function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AccessPolicyCard targetId={TARGET_ID} />
    </QueryClientProvider>,
  )
}

describe('目标授权卡片', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900)
    vi.clearAllMocks()
    signIn()
    mocks.fetchTargetAccessPolicy.mockResolvedValue({
      targetId: TARGET_ID,
      revision: 0,
      policy: {
        schemaVersion: 1,
        policyVersion: 1,
        rules: [{ origin: 'https://shop.example', purpose: 'business_surface', effect: 'allow' }],
      },
      seeded: true,
      resourceLoadsUnrestricted: true,
      updatedAt: '1970-01-01T00:00:00.000Z',
    })
  })

  it('展示派生授权并标明资源域不授予操作', async () => {
    await renderCard()
    await expect.element(page.getByText('目标授权')).toBeVisible()
    await expect.element(page.getByText(/资源加载仍按现网不拦/)).toBeVisible()
    await expect.element(page.getByText(/允许 业务表面 https:\/\/shop.example/)).toBeVisible()
  })

  it('可追加规则并保存授权', async () => {
    const screen = await renderCard()
    await screen.getByLabelText('Origin').fill('https://idp.example')
    await screen.getByLabelText('用途').selectOptions('authentication')
    await screen.getByLabelText('理由').fill('补认证域')
    await screen.getByRole('button', { name: '保存授权' }).click()
    expect(mocks.updateTargetAccessPolicy).toHaveBeenCalledWith(
      TARGET_ID,
      expect.objectContaining({
        expectedRevision: 0,
        rules: expect.arrayContaining([
          expect.objectContaining({ origin: 'https://idp.example', purpose: 'authentication' }),
        ]),
      }),
    )
  })
})
