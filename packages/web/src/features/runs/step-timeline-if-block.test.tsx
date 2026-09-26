import '@/styles/index.css'
import { page } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { describe, expect, it } from 'vitest'
import type { RunDetailDto, StepRunDto } from '@cairn/shared'
import { StepTimeline } from './step-timeline'

const DECIDE = '10000000-0000-4000-8000-000000000001'
const THEN_STEP = '10000000-0000-4000-8000-000000000002'
const AFTER = '10000000-0000-4000-8000-000000000003'

function stepRun(stepId: string, name: string, type: string, status: StepRunDto['status'], extra: Partial<StepRunDto> = {}): StepRunDto {
  return {
    id: `2${stepId.slice(1)}`,
    stepId,
    name,
    type,
    ordinal: 0,
    status,
    outcomeStatus: 'NOT_EVALUATED',
    startedAt: null,
    finishedAt: null,
    attempts: [],
    ...extra,
  } as StepRunDto
}

const run = {
  id: '44444444-4444-4444-8444-444444444444',
  snapshot: {
    controlFlow: {
      protocol: 'snapshot.controlFlow@1',
      blocks: [{ blockId: '30000000-0000-4000-8000-000000000001', kind: 'if', decideStepId: DECIDE, branches: [{ key: 'then', stepIds: [THEN_STEP] }] }],
    },
  },
  stepRuns: [
    stepRun(DECIDE, '判定：金额超过一万', 'decide', 'SUCCEEDED', {
      attempts: [
        { id: '50000000-0000-4000-8000-000000000001', attemptNo: 1, status: 'SUCCEEDED', startedAt: '2026-09-25T00:00:00.000Z', finishedAt: '2026-09-25T00:00:00.100Z', output: { branch: 'none', value: false }, error: null },
      ],
    } as Partial<StepRunDto>),
    stepRun(THEN_STEP, '提交复核', 'echo', 'SKIPPED', { skipReason: 'condition_not_met' }),
    stepRun(AFTER, '收尾', 'echo', 'SUCCEEDED'),
  ],
} as unknown as RunDetailDto

describe('运行详情的条件块分组', () => {
  it('标题显示判定结果，未走的分支默认折叠并写明跳过原因，展开后可见步骤', async () => {
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <StepTimeline run={run} evidenceItems={[]} />
      </QueryClientProvider>,
    )
    await expect.element(page.getByText('条件不成立 → 跳过 1 步')).toBeVisible()
    await expect.element(page.getByText('已跳过 1 步（条件不满足）')).toBeVisible()
    expect(page.getByText('提交复核').query()).toBeNull()
    await expect.element(page.getByText('收尾')).toBeVisible()

    await page.getByRole('button', { name: /满足条件时/ }).click()
    await expect.element(page.getByText('提交复核')).toBeVisible()
  })
})

describe('计算值步骤的结果徽标（复查修复）', () => {
  it('输出为数字时正常显示，不因取 value 属性而崩溃', async () => {
    const computeRun = {
      ...run,
      snapshot: { controlFlow: undefined },
      stepRuns: [
        stepRun('10000000-0000-4000-8000-000000000009', '金额转数字', 'compute', 'SUCCEEDED', {
          attempts: [
            { id: '50000000-0000-4000-8000-000000000009', attemptNo: 1, status: 'SUCCEEDED', startedAt: '2026-09-25T00:00:00.000Z', finishedAt: '2026-09-25T00:00:00.010Z', output: 1999, error: null },
          ],
        } as Partial<StepRunDto>),
      ],
    } as unknown as RunDetailDto
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <StepTimeline run={computeRun} evidenceItems={[]} />
      </QueryClientProvider>,
    )
    await expect.element(page.getByText('计算值: 1999')).toBeVisible()
  })
})
