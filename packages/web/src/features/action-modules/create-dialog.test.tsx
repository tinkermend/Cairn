import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import type { TargetListResponse } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { ActionModuleCreateDialog } from './create-dialog'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => ({
  createActionModule: vi.fn(),
  fetchTargets: vi.fn(),
  fetchTarget: vi.fn(),
}))

vi.mock('@/lib/action-modules-api', () => ({
  createActionModule: mocks.createActionModule,
}))
vi.mock('@/lib/targets-api', () => ({
  fetchTargets: mocks.fetchTargets,
  fetchTarget: mocks.fetchTarget,
}))

const targets: TargetListResponse = {
  items: [
    {
      id: TARGET_ID,
      code: 'demo-shop',
      name: '演示商城',
      entryUrl: 'https://shop.example.com',
      loginUrl: null,
      authMethod: 'password',
      captchaMode: 'none',
      status: 'active',
      loginFields: null,
      accountCount: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  ],
}

async function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ActionModuleCreateDialog
        open
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
      />
    </QueryClientProvider>
  )
}

describe('ActionModuleCreateDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchTargets.mockResolvedValue(targets)
    mocks.createActionModule.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
    })
  })

  it('渲染新建对话框核心字段：模块 Key、模块名称与目标系统', async () => {
    const screen = await renderDialog()
    await expect.element(screen.getByRole('dialog')).toBeInTheDocument()
    await expect.element(screen.getByText('新建动作模块')).toBeInTheDocument()
    await expect.element(screen.getByLabelText('模块 Key')).toBeInTheDocument()
    await expect.element(screen.getByLabelText('模块名称')).toBeInTheDocument()
  })
  it('提交合法创建请求并携带稳定幂等键', async () => {
    const screen = await renderDialog()
    await screen.getByLabelText('模块 Key').fill('order.query')
    await screen.getByLabelText('模块名称').fill('查询订单')
    await screen.getByRole('button', { name: '创建', exact: true }).click()
    await expect.poll(() => mocks.createActionModule.mock.calls.length).toBe(1)
    expect(mocks.createActionModule.mock.calls[0]?.[0]).toMatchObject({
      targetId: TARGET_ID,
      key: 'order.query',
      name: '查询订单',
      idempotencyKey: expect.any(String),
    })
  })
})
