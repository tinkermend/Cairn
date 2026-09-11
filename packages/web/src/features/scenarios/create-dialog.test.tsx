import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateScenarioBody, TargetListResponse } from '@cairn/shared'
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ScenarioCreateDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />
    </QueryClientProvider>,
  )
}

describe('ScenarioCreateDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchTargets.mockResolvedValue(targets)
    mocks.createScenario.mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222' })
  })

  /**
   * 验收 32：能建出一条绑定目标系统的 Echo → Delay → Echo。
   * 顺序、类型、echo 的 value / from 二选一都必须按填的来，不能被表单悄悄改写。
   */
  it('建出 Echo → Delay → Echo，步骤顺序与输入按填的来', async () => {
    const screen = await renderDialog()

    await screen.getByLabelText('名称').fill('下单巡检')

    // 目标系统是第一个 Select；没绑 Target 的场景不得执行，所以这里必须选
    await screen.getByRole('combobox').nth(0).click()
    await screen.getByRole('option', { name: '演示商城' }).click()

    await screen.getByRole('button', { name: '添加步骤' }).click()
    await screen.getByRole('button', { name: '添加步骤' }).click()

    const names = screen.getByPlaceholder('步骤名称')
    await names.nth(0).fill('写入问候')
    await names.nth(1).fill('等一会')
    await names.nth(2).fill('读回问候')

    // 第 1 步：echo + value + outputKey
    await screen.getByPlaceholder('value').nth(0).fill('hello')
    await screen.getByPlaceholder('可选 outputKey').nth(0).fill('greeting')

    // 第 2 步改成等待。combobox 顺序：0 目标系统，之后每步两个（类型、副作用）
    await screen.getByRole('combobox').nth(3).click()
    await screen.getByRole('option', { name: '等待' }).click()
    await screen.getByPlaceholder('等待毫秒').fill('250')

    // 第 3 步：echo 读 context。填了 from 就不该再带 value
    await screen.getByPlaceholder('或 from（context 键）').nth(1).fill('greeting')

    await screen.getByRole('button', { name: '创建' }).click()

    await vi.waitFor(() => expect(mocks.createScenario).toHaveBeenCalledTimes(1))
    const body = mocks.createScenario.mock.calls[0]![0] as CreateScenarioBody
    expect(body.targetId).toBe(TARGET_ID)
    expect(body.name).toBe('下单巡检')
    expect(body.steps.map((step) => step.type)).toEqual(['echo', 'delay', 'echo'])
    expect(body.steps.map((step) => step.name)).toEqual(['写入问候', '等一会', '读回问候'])
    expect(body.steps[0]).toMatchObject({ input: { value: 'hello' }, outputKey: 'greeting' })
    expect(body.steps[1]).toMatchObject({ input: { durationMs: 250 } })
    expect(body.steps[2]).toMatchObject({ input: { from: 'greeting' } })
    // 每个步骤都要有自己的 id，否则 StepRun 对不上定义
    expect(new Set(body.steps.map((step) => step.id)).size).toBe(3)
  })

  it('没选目标系统时创建按钮不可用', async () => {
    const screen = await renderDialog()
    await screen.getByLabelText('名称').fill('缺目标')
    await expect.element(screen.getByRole('button', { name: '创建' })).toBeDisabled()
    expect(mocks.createScenario).not.toHaveBeenCalled()
  })
})
