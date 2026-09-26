import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { SafeEntriesCard } from './safe-entries-card'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const ENTRY_ID = '22222222-2222-4222-8222-222222222222'

const mocks = vi.hoisted(() => ({
  fetchMapSafeEntries: vi.fn(),
  createMapSafeEntry: vi.fn(),
  updateMapSafeEntry: vi.fn(),
  archiveMapSafeEntry: vi.fn(),
}))

vi.mock('@/lib/map-api', () => mocks)

function signIn(permissions = ['target:read', 'map:read', 'map:maintain']) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试用户',
    email: null,
    roles: [],
    permissions,
  })
}

async function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <SafeEntriesCard targetId={TARGET_ID} />
    </QueryClientProvider>,
  )
}

describe('安全进入路径管理卡片 (SafeEntriesCard)', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900)
    vi.clearAllMocks()
    signIn()
    mocks.fetchMapSafeEntries.mockResolvedValue({ items: [] })
    mocks.createMapSafeEntry.mockResolvedValue({ entryId: ENTRY_ID })
    mocks.updateMapSafeEntry.mockResolvedValue({ entryId: ENTRY_ID })
    mocks.archiveMapSafeEntry.mockResolvedValue({ entryId: ENTRY_ID })
  })

  it('空列表时显示引导状态与新增按钮', async () => {
    const screen = await renderCard()
    await expect.element(page.getByText('安全进入路径')).toBeVisible()
    await expect.element(page.getByText('暂未登记安全进入路径')).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '新增安全入口', exact: true })).toBeVisible()
  })

  it('展示已存在的安全入口列表及作业类型徽章', async () => {
    mocks.fetchMapSafeEntries.mockResolvedValue({
      items: [
        {
          targetId: TARGET_ID,
          entryId: ENTRY_ID,
          version: 1,
          name: '主控制台',
          url: 'https://app.example.com/console',
          arrivalName: '控制台概览',
          arrivalTarget: { framePath: [], candidates: [{ by: 'css', value: 'body' }] },
          safetyBasisKind: 'confirmed_path',
          summary: '已核实主控入口',
          jobKinds: ['map_probe', 'map_refresh'],
          createdAt: '2026-09-24T00:00:00.000Z',
        },
      ],
    })
    await renderCard()
    await expect.element(page.getByText('主控制台')).toBeVisible()
    await expect.element(page.getByText('https://app.example.com/console')).toBeVisible()
    await expect.element(page.getByText('定时与复查')).toBeVisible()
    await expect.element(page.getByText('已确认安全路径')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '编辑' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '归档' })).toBeVisible()
  })

  it('可通过弹窗新增安全进入路径并使用默认就绪断言', async () => {
    const screen = await renderCard()
    await screen.getByRole('button', { name: '新增安全入口', exact: true }).click()

    await expect.element(page.getByRole('heading', { name: '新增安全进入路径' })).toBeVisible()
    await page.getByPlaceholder('例如：用户控制台首页、商品列表管理').fill('订单后台')
    await page.getByPlaceholder('https://example.com/dashboard').fill('https://shop.example/orders')

    await screen.getByRole('button', { name: '确认新增' }).click()

    expect(mocks.createMapSafeEntry).toHaveBeenCalledWith(
      TARGET_ID,
      expect.objectContaining({
        name: '订单后台',
        url: 'https://shop.example/orders',
        arrivalName: '页面就绪',
        safetyBasisKind: 'confirmed_path',
        summary: '已核实进入路径',
        jobKinds: ['map_probe', 'map_refresh'],
      }),
    )
  })

  it('可通过编辑弹窗修改入口并携带 expectedVersion 进行乐观锁控制', async () => {
    mocks.fetchMapSafeEntries.mockResolvedValue({
      items: [
        {
          targetId: TARGET_ID,
          entryId: ENTRY_ID,
          version: 3,
          name: '旧名称',
          url: 'https://app.example.com/old',
          arrivalName: '页面就绪',
          arrivalTarget: { framePath: [], candidates: [{ by: 'css', value: 'body' }] },
          safetyBasisKind: 'confirmed_path',
          summary: '旧说明',
          jobKinds: ['map_probe', 'map_refresh'],
          createdAt: '2026-09-24T00:00:00.000Z',
        },
      ],
    })
    const screen = await renderCard()
    await screen.getByRole('button', { name: '编辑' }).click()

    await expect.element(page.getByRole('heading', { name: '编辑安全进入路径' })).toBeVisible()
    const nameInput = page.getByPlaceholder('例如：用户控制台首页、商品列表管理')
    await nameInput.fill('新名称')

    await screen.getByRole('button', { name: '保存修改' }).click()

    expect(mocks.updateMapSafeEntry).toHaveBeenCalledWith(
      TARGET_ID,
      ENTRY_ID,
      expect.objectContaining({
        expectedVersion: 3,
        name: '新名称',
      }),
    )
  })

  it('点击归档按钮会触发二次确认对话框并归档', async () => {
    mocks.fetchMapSafeEntries.mockResolvedValue({
      items: [
        {
          targetId: TARGET_ID,
          entryId: ENTRY_ID,
          version: 1,
          name: '待归档路径',
          url: 'https://app.example.com/delete-me',
          arrivalName: '页面就绪',
          arrivalTarget: { framePath: [], candidates: [{ by: 'css', value: 'body' }] },
          safetyBasisKind: 'confirmed_path',
          summary: '测试',
          jobKinds: ['map_probe', 'map_refresh'],
          createdAt: '2026-09-24T00:00:00.000Z',
        },
      ],
    })
    const screen = await renderCard()
    await screen.getByRole('button', { name: '归档' }).click()

    await expect.element(page.getByText('确认归档安全进入路径？')).toBeVisible()
    await screen.getByRole('button', { name: '确认归档' }).click()

    expect(mocks.archiveMapSafeEntry).toHaveBeenCalledWith(
      TARGET_ID,
      ENTRY_ID,
      expect.objectContaining({
        reason: '用户手动归档移除安全入口',
      }),
    )
  })
})
