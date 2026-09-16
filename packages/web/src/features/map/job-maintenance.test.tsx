import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { JobMaintenanceCard } from './job-maintenance'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'

const mocks = vi.hoisted(() => ({
  fetchMapJobPolicy: vi.fn(),
  updateMapJobPolicy: vi.fn(),
  fetchMapSafeEntries: vi.fn(),
  createMapSafeEntry: vi.fn(),
  previewMapJob: vi.fn(),
  createMapJob: vi.fn(),
}))

const targetMocks = vi.hoisted(() => ({
  fetchTargetAccounts: vi.fn(),
}))

vi.mock('@/lib/map-api', () => mocks)
vi.mock('@/lib/targets-api', () => targetMocks)

function signIn(permissions = ['target:read', 'map:read', 'map:maintain']) {
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
      <JobMaintenanceCard targetId={TARGET_ID} />
    </QueryClientProvider>,
  )
}

describe('知识页地图维护', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900)
    vi.clearAllMocks()
    signIn()
    mocks.fetchMapJobPolicy.mockResolvedValue({
      targetId: TARGET_ID,
      revision: 0,
      policy: {
        schemaVersion: 1,
        policyVersion: 1,
        manualJobsEnabled: false,
        maxProbePages: 1,
        maxProbeObjects: 8,
        maxProbeActions: 8,
        maxProbeSeconds: 300,
        maxRefreshPages: 5,
        maxRefreshObjects: 20,
        maxRefreshActions: 20,
        maxRefreshSeconds: 900,
        sliceWorkSeconds: 20,
        defaultDepth: 'structure',
        staticRefreshDays: 7,
      },
      updatedAt: '1970-01-01T00:00:00.000Z',
    })
    mocks.fetchMapSafeEntries.mockResolvedValue({ items: [] })
    targetMocks.fetchTargetAccounts.mockResolvedValue({
      items: [{ id: ACCOUNT_ID, targetId: TARGET_ID, displayName: '值班账号', username: 'ops', status: 'active' }],
    })
  })

  it('默认关闭且不能创建作业', async () => {
    const screen = await renderCard()
    await expect.element(page.getByText('地图维护')).toBeVisible()
    await expect.element(page.getByText('手工作业关闭')).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '探查入口' })).toBeDisabled()
  })

  it('可开放政策并登记进入路径', async () => {
    const screen = await renderCard()
    await screen.getByLabelText('政策理由').fill('受控环境可探查')
    await screen.getByRole('button', { name: '开放手工作业' }).click()
    expect(mocks.updateMapJobPolicy).toHaveBeenCalledWith(
      TARGET_ID,
      expect.objectContaining({ manualJobsEnabled: true, expectedRevision: 0 }),
    )
    await screen.getByLabelText('路径名称').fill('订单入口')
    await screen.getByLabelText('进入 URL').fill('https://shop.example/orders')
    await screen.getByLabelText('到达断言').fill('订单标题')
    await screen.getByLabelText('安全依据').fill('只读复查已确认')
    await screen.getByRole('button', { name: '登记进入路径' }).click()
    expect(mocks.createMapSafeEntry).toHaveBeenCalledWith(
      TARGET_ID,
      expect.objectContaining({ name: '订单入口', url: 'https://shop.example/orders' }),
    )
  })

  it('无维护权限只读政策', async () => {
    signIn(['target:read', 'map:read'])
    await renderCard()
    await expect.element(page.getByText(/需要地图维护权限才能触发作业/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: '开放手工作业' })).not.toBeInTheDocument()
  })
})
