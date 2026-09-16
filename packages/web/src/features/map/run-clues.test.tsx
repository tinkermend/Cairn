import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { RunMapClues } from './run-clues'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '22222222-2222-4222-8222-222222222222'

const mocks = vi.hoisted(() => ({
  fetchMapRunClues: vi.fn(),
}))

vi.mock('@/lib/map-api', () => mocks)

function signIn() {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions: ['map:read', 'run:read'],
  })
}

describe('运行地图线索', () => {
  beforeEach(() => {
    signIn()
    mocks.fetchMapRunClues.mockResolvedValue({
      runId: RUN_ID,
      targetId: TARGET_ID,
      clues: [
        { dimension: 'locator', verdict: 'confirmed', count: 1, notes: [] },
        { dimension: 'business', verdict: 'rejected', count: 1, notes: ['库存不足'] },
      ],
      hypotheses: [],
      counterExamples: ['定位成功但业务结果被拒绝，不能据此宣称页面改版或对象失效'],
      gaps: [],
    })
  })

  it('OMD09 分列定位与业务结果，不宣称改版', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <RunMapClues targetId={TARGET_ID} runId={RUN_ID} />
      </QueryClientProvider>,
    )
    await expect.element(screen.getByText('地图线索')).toBeVisible()
    await expect.element(screen.getByText(/定位：confirmed/)).toBeVisible()
    await expect.element(screen.getByText(/业务结果：rejected/)).toBeVisible()
    await expect.element(screen.getByText(/不能据此宣称页面改版/)).toBeVisible()
  })
})
