import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { RunMapConsumption, RunMapDecisions } from './map-decisions'

const mocks = vi.hoisted(() => ({
  fetchRunMapDecisions: vi.fn(),
}))

vi.mock('@/lib/runs-api', () => mocks)

function signIn(permissions = ['run:read', 'target:read']) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions,
  })
}

async function renderDecisions() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RunMapDecisions runId='00000000-0000-4000-8000-000000000021' />
    </QueryClientProvider>,
  )
}

describe('运行页地图选择', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900)
    vi.clearAllMocks()
    signIn()
  })

  it('未冻结时说明按关闭解释', async () => {
    const view = await render(
      <QueryClientProvider client={new QueryClient()}>
        <RunMapConsumption />
      </QueryClientProvider>,
    )
    await expect.element(page.getByText('历史运行未冻结地图消费，按关闭解释。')).toBeVisible()
    view.unmount()
  })

  it('OMF12 展示 shadow 与 skip 原因', async () => {
    mocks.fetchRunMapDecisions.mockResolvedValue({
      items: [
        {
          decisionId: '00000000-0000-4000-8000-000000000031',
          runId: '00000000-0000-4000-8000-000000000021',
          stepRunId: '00000000-0000-4000-8000-000000000022',
          attemptId: '00000000-0000-4000-8000-000000000023',
          decisionOrdinal: 0,
          targetId: '00000000-0000-4000-8000-000000000024',
          baselineOutcome: 'TARGET_NOT_FOUND',
          candidatesEvaluated: [{ objectId: '00000000-0000-4000-8000-000000000025', matches: 1, outcome: 'FOUND' }],
          mode: 'shadow',
          decision: 'shadow_only',
          reasonCode: 'SHADOW_WOULD_USE',
          spentMs: 12,
          extraAiCalls: 0,
          evidenceRefs: [],
        },
      ],
    })
    await renderDecisions()
    await expect.element(page.getByText(/比较后未替换/)).toBeVisible()
    await expect.element(page.getByText(/若开放会使用该候选/)).toBeVisible()
    await expect.element(page.getByText(/12 ms/)).toBeVisible()
    await page.getByText('查看候选、条件与证据').click()
    await expect.element(page.getByText(/原结果 TARGET_NOT_FOUND/)).toBeVisible()
    await expect.element(page.getByText(/候选 1/)).toBeVisible()
    await page.screenshot({ path: '../../../../../.run/omf-review/decisions-desktop.png' })
    await page.viewport(390, 844)
    await page.screenshot({ path: '../../../../../.run/omf-review/decisions-mobile.png' })
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390)
  })

  it('窄屏空态仍可读', async () => {
    await page.viewport(390, 844)
    mocks.fetchRunMapDecisions.mockResolvedValue({ items: [] })
    await renderDecisions()
    await expect.element(page.getByText('本次运行没有地图选择记录。')).toBeVisible()
  })
  it('分页只请求对应游标，SSE 提示触发重新读取', async () => {
    mocks.fetchRunMapDecisions.mockResolvedValue({ items: [], nextCursor: '00000000-0000-4000-8000-000000000050' })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(<QueryClientProvider client={client}><RunMapDecisions runId='run' eventSeq={1} /></QueryClientProvider>)
    await page.getByRole('button', { name: '下一页' }).click()
    await vi.waitFor(() => expect(mocks.fetchRunMapDecisions).toHaveBeenCalledWith('run', expect.objectContaining({ cursor: '00000000-0000-4000-8000-000000000050' })))
    const before = mocks.fetchRunMapDecisions.mock.calls.length
    await screen.rerender(<QueryClientProvider client={client}><RunMapDecisions runId='run' eventSeq={2} /></QueryClientProvider>)
    await vi.waitFor(() => expect(mocks.fetchRunMapDecisions.mock.calls.length).toBeGreaterThan(before))
  })

})
