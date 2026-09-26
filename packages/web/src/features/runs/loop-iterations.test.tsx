import '@/styles/index.css'
import { page } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunDetailDto, StepRunDto } from '@cairn/shared'
import { LoopIterationsPanel } from './loop-iterations'

const RUN_ID = '44444444-4444-4444-8444-444444444444'
const BLOCK_ID = '55555555-5555-4555-8555-555555555555'
const HEADER_STEP_ID = '66666666-6666-4666-8666-666666666666'

const mocks = vi.hoisted(() => ({
  fetchRunIterations: vi.fn(),
  fetchRunIteration: vi.fn(),
}))
vi.mock('@/lib/runs-api', async (original) => ({ ...(await original<typeof import('@/lib/runs-api')>()), ...mocks }))

function iteration(index: number, status: 'SUCCEEDED' | 'FAILED') {
  return {
    id: `00000000-0000-4000-8000-00000000000${index}`,
    runId: RUN_ID,
    blockId: BLOCK_ID,
    headerStepId: HEADER_STEP_ID,
    scopePath: `L2#${index}`,
    iterationIndex: index,
    status,
    item: `告警-${index + 1}`,
    startedAt: '2026-09-25T00:00:00.000Z',
    finishedAt: '2026-09-25T00:00:01.000Z',
  }
}

const headerStepRun = {
  id: '77777777-7777-4777-8777-777777777777',
  stepId: HEADER_STEP_ID,
  name: '循环头: 逐项',
  type: 'loop',
  ordinal: 1,
  status: 'FAILED',
  outcomeStatus: 'NOT_EVALUATED',
  startedAt: null,
  finishedAt: null,
  attempts: [],
} as unknown as StepRunDto

const run = {
  id: RUN_ID,
  snapshot: {
    controlFlow: {
      protocol: 'snapshot.controlFlow@2',
      blocks: [{ blockId: BLOCK_ID, kind: 'for_each', headerStepId: HEADER_STEP_ID, bodyStepIds: [] }],
    },
  },
  iterationsSummary: {
    [BLOCK_ID]: { blockId: BLOCK_ID, kind: 'for_each', total: 3, succeeded: 2, failed: 1, skipped: 0, running: 0 },
  },
} as unknown as RunDetailDto

describe('LoopIterationsPanel', () => {
  beforeEach(() => {
    mocks.fetchRunIterations.mockResolvedValue({
      iterations: [iteration(0, 'SUCCEEDED'), iteration(1, 'FAILED'), iteration(2, 'SUCCEEDED')],
      total: 3,
    })
    mocks.fetchRunIteration.mockImplementation(async (_runId: string, iterationId: string) => ({
      iteration: iteration(Number(iterationId.slice(-1)), iterationId.endsWith('1') ? 'FAILED' : 'SUCCEEDED'),
      stepRuns: [
        {
          id: `88888888-8888-4888-8888-88888888888${iterationId.slice(-1)}`,
          stepId: '99999999-9999-4999-8999-999999999999',
          name: `查看告警 ${iterationId.slice(-1)}`,
          type: 'echo',
          ordinal: 2,
          status: iterationId.endsWith('1') ? 'FAILED' : 'SUCCEEDED',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: null,
          finishedAt: null,
          attempts: [],
        },
      ],
    }))
  })

  it('显示汇总，默认选中失败项并按需加载该项步骤；点其他项切换', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await render(
      <QueryClientProvider client={client}>
        <ol>
          <LoopIterationsPanel run={run} headerStepRun={headerStepRun} evidenceItems={[]} />
        </ol>
      </QueryClientProvider>,
    )
    await expect.element(page.getByText('逐项处理 3 项')).toBeVisible()
    await expect.element(page.getByText('成功 2 · 失败 1 · 未执行 0')).toBeVisible()
    await expect.element(page.getByText('第 2 项')).toBeVisible()
    await expect.element(page.getByText('当前项：告警-2')).toBeVisible()
    await expect.element(page.getByText('查看告警 1')).toBeVisible()
    expect(mocks.fetchRunIteration).toHaveBeenCalledTimes(1)

    await page.getByRole('option', { name: '3' }).click()
    await expect.element(page.getByText('查看告警 2')).toBeVisible()
  })
})
