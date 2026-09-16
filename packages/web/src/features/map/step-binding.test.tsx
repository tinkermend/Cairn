import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { useAuthStore } from '@/stores/auth-store'
import { MapStepBinding } from './step-binding'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const SCENARIO_ID = '22222222-2222-4222-8222-222222222222'
const STEP_ID = '33333333-3333-4333-8333-333333333333'

const mocks = vi.hoisted(() => ({
  fetchMapObjects: vi.fn(),
  fetchMapReferences: vi.fn(),
  bindMapScenario: vi.fn(),
  removeMapBinding: vi.fn(),
}))

vi.mock('@/lib/map-api', () => mocks)

function signIn() {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions: ['map:read', 'workflow:write'],
  })
}

describe('步骤地图绑定', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    signIn()
    mocks.fetchMapObjects.mockResolvedValue({
      items: [
        {
          assetRef: { targetId: TARGET_ID, objectId: STEP_ID },
          assetRefKey: 'p:x:o:33333333-3333-4333-8333-333333333333:i:x:d:0',
          name: '保存',
          lifecycle: 'VERIFIED',
          dimensions: [],
          unknownFields: [],
          changeCount: 0,
          evidenceAvailability: 'available',
        },
      ],
    })
    mocks.fetchMapReferences.mockResolvedValue({
      items: [],
      restricted: false,
      scanStatus: 'idle',
      scanCompleteness: 'unknown',
    })
  })

  it('绑定入口说明关联用于变更影响', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const screen = await render(
      <QueryClientProvider client={client}>
        <MapStepBinding
          targetId={TARGET_ID}
          scenarioId={SCENARIO_ID}
          stepId={STEP_ID}
          draftRevision={1}
        />
      </QueryClientProvider>
    )
    await expect
      .element(screen.getByText('地图对象', { exact: true }))
      .toBeVisible()
    await expect.element(screen.getByText(/便于查看变更影响/)).toBeVisible()
    await expect.element(screen.getByText(/相似扫描只给候选/)).toBeVisible()
  })
  it('仅加载当前步骤的草稿绑定，历史版本绑定不能被解除', async () => {
    mocks.fetchMapReferences.mockResolvedValue({
      items: [
        {
          grade: 'confirmed_reference',
          bindingId: STEP_ID,
          scenarioId: SCENARIO_ID,
          stepId: STEP_ID,
          assetRefKey: 'historical',
          scope: { kind: 'version', scenarioVersionId: TARGET_ID },
        },
      ],
      restricted: false,
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const screen = await render(
      <QueryClientProvider client={client}>
        <MapStepBinding
          targetId={TARGET_ID}
          scenarioId={SCENARIO_ID}
          stepId={STEP_ID}
          draftRevision={1}
        />
      </QueryClientProvider>
    )
    await expect.element(screen.getByText(/尚未绑定/)).toBeVisible()
    expect(mocks.fetchMapReferences).toHaveBeenCalledWith(TARGET_ID, {
      limit: 100,
      scenarioId: SCENARIO_ID,
      stepId: STEP_ID,
      scopeKind: 'draft',
    })
    await expect
      .element(screen.getByRole('button', { name: '解除绑定' }))
      .not.toBeInTheDocument()
    await screen.getByRole('combobox', { name: '选择地图对象' }).click()
    await screen.getByRole('option', { name: '保存' }).click()
    await expect.poll(() => mocks.bindMapScenario.mock.calls.length).toBe(1)
    expect(mocks.bindMapScenario).toHaveBeenCalledWith(
      TARGET_ID,
      expect.objectContaining({
        scenarioId: SCENARIO_ID,
        stepId: STEP_ID,
        scopeKind: 'draft',
        expectedDraftRevision: 1,
      })
    )
  })
})
