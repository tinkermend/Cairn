import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { analysisCandidateDtoSchema } from '@cairn/shared'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { CandidateReviewDialog } from './candidate-review'

const mocks = vi.hoisted(() => ({
  scenarios: vi.fn(),
  scenario: vi.fn(),
  review: vi.fn(),
}))
vi.mock('@/lib/scenarios-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/scenarios-api')>()),
  fetchScenarios: mocks.scenarios,
  fetchScenario: mocks.scenario,
}))
vi.mock('@/lib/knowledge-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/knowledge-api')>()),
  reviewAnalysisCandidate: mocks.review,
}))

describe('候选知识重新审阅', () => {
  it('缓存草稿不开放编辑；读取新基线后保留修改和失败输入', async () => {
    await page.viewport(390, 844)
    useAuthStore
      .getState()
      .auth.setUser({
        id: 'reviewer',
        displayName: '审阅人',
        email: null,
        roles: [],
        permissions: [
          'map:read',
          'map:analyze',
          'map:review',
          'workflow:read',
          'workflow:write',
          'target:read',
        ],
      })
    const scenarioId = '11111111-1111-4111-8111-111111111111'
    const targetId = '22222222-2222-4222-8222-222222222222'
    const document = (name: string) => ({
      schemaVersion: 1,
      inputs: [],
      steps: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          name,
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 'ok' },
        },
      ],
    })
    const cached = {
      id: scenarioId,
      targetId,
      draft: { revision: 1, document: document('旧草稿') },
    }
    const fresh = {
      ...cached,
      draft: { revision: 2, document: document('最新草稿') },
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(['candidate-scenario-baseline', scenarioId], cached)
    let finish!: (value: typeof fresh) => void
    mocks.scenario.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    mocks.scenarios.mockResolvedValue({
      items: [{ id: scenarioId, name: '订单核对' }],
    })
    mocks.review.mockRejectedValue(new Error('草稿已被其他人更新'))
    const candidate = analysisCandidateDtoSchema.parse({
      candidateId: '44444444-4444-4444-8444-444444444444',
      jobId: '55555555-5555-4555-8555-555555555555',
      kind: 'experience',
      title: '核对结果',
      summary: '请保留输出',
      sources: [],
      status: 'pending',
      revision: 1,
      createdAt: '2026-09-20T00:00:00.000Z',
    })
    await render(
      <QueryClientProvider client={client}>
        <CandidateReviewDialog
          candidate={candidate}
          targetId={targetId}
          onClose={() => {}}
        />
      </QueryClientProvider>
    )
    await page.getByLabelText('应用场景', { exact: true }).click()
    await page.getByRole('option', { name: '订单核对', exact: true }).click()
    await expect.element(page.getByText('正在读取当前草稿…')).toBeVisible()
    await expect
      .element(page.getByLabelText('步骤名称', { exact: true }))
      .not.toBeInTheDocument()
    finish(fresh)
    await expect
      .element(page.getByLabelText('步骤名称', { exact: true }))
      .toHaveValue('最新草稿')
    await page
      .getByLabelText('步骤名称', { exact: true })
      .fill('人工审阅后的步骤')
    await page
      .getByRole('button', { name: '保存为知识建议', exact: true })
      .click()
    await expect
      .poll(() => mocks.review.mock.calls[0]?.[1])
      .toMatchObject({
        expectedDraftRevision: 2,
        document: { steps: [{ name: '人工审阅后的步骤' }] },
      })
    await expect
      .element(page.getByText('草稿已被其他人更新', { exact: true }))
      .toBeVisible()
    await expect
      .element(page.getByLabelText('步骤名称', { exact: true }))
      .toHaveValue('人工审阅后的步骤')
  })
})
