import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { ConsumptionPolicyCard } from './consumption-policy'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => ({
  fetchMapConsumptionPolicy: vi.fn(),
  updateMapConsumptionPolicy: vi.fn(),
}))

vi.mock('@/lib/map-api', () => mocks)

function signIn(permissions = ['target:read', 'map:read', 'map:publish']) {
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
      <ConsumptionPolicyCard targetId={TARGET_ID} />
    </QueryClientProvider>,
  )
}

describe('知识页运行消费政策', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900)
    vi.clearAllMocks()
    signIn()
    mocks.fetchMapConsumptionPolicy.mockResolvedValue({
      targetId: TARGET_ID,
      revision: 0,
      policy: {
        schemaVersion: 1,
        policyVersion: 1,
        mode: 'off',
        allowedStepTypes: ['extract', 'assert'],
        allowedAssetRefs: [],
        maxCandidateCount: 2,
        maxResolveMs: 1000,
        maxExtraAiCalls: 0,
        onUnavailable: 'baseline',
      },
      eligibility: null,
      updatedAt: '1970-01-01T00:00:00.000Z',
    })
  })

  it('无资格时提示只读替换关闭', async () => {
    await renderCard()
    await expect.element(page.getByText('运行消费')).toBeVisible()
    await expect.element(page.getByText(/尚缺只读对照资格/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: '保存政策' })).toBeDisabled()
  })

  it('无资格不能打开只读步骤候选，仅比较可保存', async () => {
    const screen = await renderCard()
    await screen.getByLabelText('模式').selectOptions('read_only_fallback')
    await screen.getByLabelText('理由').fill('准备开放只读候选')
    await expect.element(screen.getByRole('button', { name: '保存政策' })).toBeDisabled()
    await expect.element(screen.getByText(/没有资格记录/)).toBeVisible()

    await screen.getByLabelText('模式').selectOptions('shadow')
    await expect.element(screen.getByRole('button', { name: '保存政策' })).toBeEnabled()
    await screen.getByRole('button', { name: '保存政策' }).click()
    expect(mocks.updateMapConsumptionPolicy).toHaveBeenCalledWith(
      TARGET_ID,
      expect.objectContaining({ mode: 'shadow', expectedRevision: 0 }),
    )
  })

  it('确认错配冻结后显示原因，并保持只读替换不可保存', async () => {
    mocks.fetchMapConsumptionPolicy.mockResolvedValue({
      targetId: TARGET_ID, revision: 2,
      policy: {
        schemaVersion: 1, policyVersion: 2, mode: 'read_only_fallback',
        allowedStepTypes: ['extract', 'assert'], allowedAssetRefs: [], maxCandidateCount: 2,
        maxResolveMs: 1000, maxExtraAiCalls: 0, onUnavailable: 'baseline',
      },
      eligibility: {
        reportId: 'omt-feedback-1', eligibleStepTypes: ['extract', 'assert'],
        recordedAt: '2026-09-16T00:00:00.000Z', suspendedAt: '2026-09-16T00:01:00.000Z',
        suspensionReason: '确认错配',
      },
      updatedAt: '2026-09-16T00:00:00.000Z',
    })
    const screen = await renderCard()
    await expect.element(screen.getByText(/确认错配冻结/)).toBeVisible()
    await screen.getByLabelText('理由').fill('尝试保存')
    await expect.element(screen.getByRole('button', { name: '保存政策' })).toBeDisabled()
  })

  it('无发布权限只读政策', async () => {
    signIn(['target:read', 'map:read'])
    await renderCard()
    await expect.element(page.getByText(/需要发布权限才能改消费政策/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: '保存政策' })).not.toBeInTheDocument()
  })
  it('失败后保留理由，重试同一请求复用幂等键', async () => {
    mocks.updateMapConsumptionPolicy.mockRejectedValue(new Error('network failure'))
    const screen = await renderCard()
    await screen.getByLabelText('模式').selectOptions('shadow')
    await screen.getByLabelText('理由').fill('对照观察')
    await screen.getByRole('button', { name: '保存政策' }).click()
    await expect.element(screen.getByRole('button', { name: '保存政策' })).toBeEnabled()
    await screen.getByRole('button', { name: '保存政策' }).click()
    await vi.waitFor(() => expect(mocks.updateMapConsumptionPolicy).toHaveBeenCalledTimes(2))
    expect(mocks.updateMapConsumptionPolicy.mock.calls[0]![1]).toEqual(mocks.updateMapConsumptionPolicy.mock.calls[1]![1])
    await expect.element(screen.getByLabelText('理由')).toHaveValue('对照观察')
    await page.viewport(390, 844)
    await page.screenshot({ path: '../../../../../.run/omf-review/policy-mobile.png' })
  })

})
