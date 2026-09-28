import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { EvidenceMetadata, ModuleManifest, RunDetailDto, Step, StepRunDto } from '@cairn/shared'
import { StepInspector } from './step-inspector'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, to }: { children: ReactNode; to?: string }) => <a href={to ?? '#'}>{children}</a>,
  }
})

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})

describe('StepInspector AI Heal & Repair Candidate Integration', () => {
  const baseRun = {
    id: 'run-100',
    scenarioId: 'scen-200',
    scenarioVersionId: 'ver-1',
    targetId: 'tgt-1',
    status: 'SUCCEEDED',
    outcomeStatus: 'PASS',
    evidenceStatus: 'COMPLETE',
    debugMode: 'runThrough',
    createdAt: '2026-09-26T00:00:00Z',
    snapshot: {
      steps: [
        {
          id: 'step-click-btn',
          name: '点击登录按钮',
          type: 'click',
        } as Step,
      ],
    } as RunDetailDto['snapshot'],
    stepRuns: [],
    context: {},
  } as unknown as RunDetailDto

  const healedStep: StepRunDto = {
    id: 'step-run-1',
    stepId: 'step-click-btn',
    name: '点击登录按钮',
    type: 'click',
    ordinal: 0,
    status: 'SUCCEEDED',
    outcomeStatus: 'PASS',
    startedAt: '2026-09-26T00:00:05Z',
    finishedAt: '2026-09-26T00:00:08Z',
    attempts: [
      {
        id: 'attempt-1',
        attemptNo: 1,
        status: 'SUCCEEDED',
        startedAt: '2026-09-26T00:00:05Z',
        finishedAt: '2026-09-26T00:00:08Z',
        output: {
          healerResolved: true,
          healerHypothesis: '按钮属性变化，已自愈成功',
        },
        error: null,
      },
    ],
  }

  it('顶层步骤救活时展示 AI 救活标签与场景修复候选引导横幅', async () => {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <StepInspector
          run={baseRun}
          step={healedStep}
          selectedAttemptId="attempt-1"
          evidenceItems={[]}
        />
      </QueryClientProvider>,
    )

    await expect.element(screen.getByText('AI 救活')).toBeVisible()
    await expect.element(screen.getByText('运行时已成功自愈，已生成受控修复候选 (Heal → Repair)')).toBeVisible()
    await expect.element(screen.getByText('按钮属性变化，已自愈成功')).toBeVisible()
    await expect.element(screen.getByText('前往场景采纳修复候选')).toBeVisible()
  })

  it('模块内步骤救活时展示 AI 救活标签与模块纳管只读提示，明确不产生场景候选', async () => {
    const moduleRun: RunDetailDto = {
      ...baseRun,
      snapshot: {
        ...baseRun.snapshot,
        moduleManifest: {
          entries: [
            {
              moduleId: 'mod-auth-99',
              name: '标准登录组件',
              expandedStepIds: ['step-click-btn'],
            } as ModuleManifest['entries'][number],
          ],
        },
      },
    }

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <StepInspector
          run={moduleRun}
          step={healedStep}
          selectedAttemptId="attempt-1"
          evidenceItems={[]}
        />
      </QueryClientProvider>,
    )

    await expect.element(screen.getByText('AI 救活')).toBeVisible()
    await expect.element(screen.getByText('此步骤已在运行时由 AI 自愈策略成功救活')).toBeVisible()
    await expect.element(screen.getByText(/该步骤属于动作模块.*标准登录组件.*由模块定义纳管/)).toBeVisible()
    await expect.element(screen.getByText('前往动作模块详情')).toBeVisible()
  })

  it('当 Attempt output 为普通结果，但证据链中有 AI 定位救活诊断时，同样识别为 AI 救活', async () => {
    const rawStep: StepRunDto = {
      ...healedStep,
      attempts: [
        {
          id: 'attempt-real',
          attemptNo: 1,
          status: 'SUCCEEDED',
          startedAt: '2026-09-26T00:00:05Z',
          finishedAt: '2026-09-26T00:00:08Z',
          output: {},
          error: null,
        },
      ],
    }
    const realEvidences = [
      {
        id: 'evi-diag',
        runId: baseRun.id,
        stepRunId: rawStep.id,
        attemptId: 'attempt-real',
        type: 'log',
        status: 'available',
        schemaVersion: 1,
        createdAt: '2026-09-26T00:00:07Z',
        payload: {
          outcome: 'FOUND',
          candidatesTried: [],
          resolvedVia: 'ai',
          suggestedCandidate: { by: 'role', value: 'button', name: '登录' },
          suggestedPatch: { kind: 'ADD_CANDIDATE', suggestedCandidate: { by: 'role', value: 'button', name: '登录' } },
        },
      } as EvidenceMetadata,
    ]

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <StepInspector
          run={baseRun}
          step={rawStep}
          selectedAttemptId="attempt-real"
          evidenceItems={realEvidences}
        />
      </QueryClientProvider>,
    )

    await expect.element(screen.getByText('AI 救活')).toBeVisible()
    await expect.element(screen.getByText('运行时已成功自愈，已生成受控修复候选 (Heal → Repair)')).toBeVisible()
  })
})
