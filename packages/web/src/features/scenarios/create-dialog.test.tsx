import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CreateScenarioBody, TargetListResponse } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { ScenarioCreateDialog } from './create-dialog'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => ({
  createScenario: vi.fn(),
  fetchTargets: vi.fn(),
}))

vi.mock('@/lib/scenarios-api', () => ({ createScenario: mocks.createScenario }))
vi.mock('@/lib/targets-api', () => ({ fetchTargets: mocks.fetchTargets }))

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
      <ScenarioCreateDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />
    </QueryClientProvider>
  )
}

describe('ScenarioCreateDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchTargets.mockResolvedValue(targets)
    mocks.createScenario.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
    })
  })

  it('创建时带上名称、目标系统和必填首步导航', async () => {
    const screen = await renderDialog()
    await screen.getByLabelText('名称', { exact: true }).fill('打开商城')
    await screen.getByRole('combobox', { name: '目标系统' }).click()
    await screen.getByRole('option', { name: '演示商城' }).click()
    await screen.getByLabelText('首步页面地址').fill('https://shop.example.com/login')
    await screen.getByRole('button', { name: '创建' }).click()
    await vi.waitFor(() => expect(mocks.createScenario).toHaveBeenCalledTimes(1))
    const body = mocks.createScenario.mock.calls[0]![0] as CreateScenarioBody
    expect(body.targetId).toBe(TARGET_ID)
    expect(body.name).toBe('打开商城')
    expect(body.steps).toHaveLength(1)
    expect(body.steps[0]).toMatchObject({
      type: 'navigate',
      input: { url: 'https://shop.example.com/login' },
    })
  })

  it('没选目标系统或没填地址时创建按钮不可用', async () => {
    const screen = await renderDialog()
    await screen.getByLabelText('名称', { exact: true }).fill('缺字段')
    await expect.element(screen.getByRole('button', { name: '创建' })).toBeDisabled()
    await screen.getByRole('combobox', { name: '目标系统' }).click()
    await screen.getByRole('option', { name: '演示商城' }).click()
    await expect.element(screen.getByRole('button', { name: '创建' })).toBeDisabled()
    expect(mocks.createScenario).not.toHaveBeenCalled()
  })

  it('保存失败保留名称、目标和地址', async () => {
    mocks.createScenario.mockRejectedValueOnce(new Error('offline'))
    const screen = await renderDialog()
    await screen.getByLabelText('名称', { exact: true }).fill('打开商城')
    await screen.getByRole('combobox', { name: '目标系统' }).click()
    await screen.getByRole('option', { name: '演示商城' }).click()
    await screen.getByLabelText('首步页面地址').fill('https://shop.example.com')
    await screen.getByRole('button', { name: '创建' }).click()
    await expect.element(screen.getByRole('alert')).toHaveTextContent('创建失败')
    await expect.element(screen.getByLabelText('名称', { exact: true })).toHaveValue('打开商城')
    await expect.element(screen.getByLabelText('首步页面地址')).toHaveValue('https://shop.example.com')
  })

  it('停用的目标系统不可选择', async () => {
    mocks.fetchTargets.mockResolvedValue({
      items: [{ ...targets.items[0], status: 'disabled' }],
    })
    const screen = await renderDialog()
    await expect.element(screen.getByRole('button', { name: '创建' })).toBeDisabled()
    await screen.getByRole('combobox', { name: '目标系统' }).click()
    await expect
      .element(screen.getByRole('option', { name: '演示商城（已停用）' }))
      .toHaveAttribute('aria-disabled', 'true')
  })
})
