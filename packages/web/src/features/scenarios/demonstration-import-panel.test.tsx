import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { parseDemonstrationFile, previewDemonstration } from '@cairn/authoring'
import type { Step } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { ApiRequestError } from '@/lib/api-client'
import { AiStepFields } from '@/features/authoring/fields/ai'
import { DemonstrationImportPanel } from './demonstration-import-panel'

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  apply: vi.fn(),
  source: vi.fn(),
  scenario: vi.fn(),
}))
vi.mock('@/lib/demonstrations-api', async (original) => ({
  ...(await original<typeof import('@/lib/demonstrations-api')>()),
  previewDemonstrationImport: mocks.preview,
  applyDemonstrationImport: mocks.apply,
  fetchDemonstration: mocks.source,
}))
vi.mock('@/lib/scenarios-api', async (original) => ({
  ...(await original<typeof import('@/lib/scenarios-api')>()),
  fetchScenario: mocks.scenario,
}))
const scenarioId = '00000000-0000-4000-8000-000000000001'
const recordingDraftId = '00000000-0000-4000-8000-000000000002'
const source = parseDemonstrationFile({
  profile: 'midscene-yaml-flow@1',
  targetId: scenarioId,
  captureId: recordingDraftId,
  text: 'web:\n  url: https://example.test\ntasks:\n  - flow:\n      - aiInput: 订单号\n        value: SO-1\n      - aiTap: 查询\n      - aiWaitFor: 出现结果',
})
const preview = previewDemonstration({
  scenarioId,
  recordingDraftId,
  source,
  baseRevision: 1,
  placement: { kind: 'start' },
  remainingCapacity: 100,
})
const onApplied = vi.fn()

function panel(canApply = true) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <DemonstrationImportPanel
        open
        scenarioId={scenarioId}
        recordingDraftId={recordingDraftId}
        revision={1}
        insertAnchor={{ kind: 'start' }}
        stepCount={1}
        inputs={[]}
        independentSteps={[{ id: scenarioId, name: '旧步骤' }]}
        canApply={canApply}
        hasLocalChanges={!canApply}
        onApplied={onApplied}
        onConflict={vi.fn()}
        onSelectDraft={vi.fn()}
        onOpenChange={vi.fn()}
      />
    </QueryClientProvider>
  )
}

describe('demonstration review and atomic editing', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    await page.viewport(1440, 900)
    mocks.preview.mockImplementation(async (_id, body) => ({
      ...preview,
      baseRevision: body.baseRevision,
      placement: body.placement,
    }))
    mocks.source.mockResolvedValue({ recordingDraftId, source, artifacts: [] })
    mocks.scenario.mockResolvedValue({ draft: { revision: 2 } })
    mocks.apply.mockResolvedValue({
      scenario: { id: scenarioId },
      receipt: { insertedStepIds: [scenarioId] },
    })
  })

  it('requires explicit decisions and preserves parameter bindings and discard reasons across OCC', async () => {
    mocks.apply.mockRejectedValueOnce(
      new ApiRequestError(409, {
        code: 'SCENARIO_DRAFT_CONFLICT',
        message: '草稿已变化',
        requestId: 'fixture',
      })
    )
    const screen = await panel()
    await expect
      .element(screen.getByText('4 项来源 · 已处理 0 项 · 尚需处理 4 项'))
      .toBeVisible()
    expect(mocks.apply).not.toHaveBeenCalled()
    for (let i = 0; i < 3; i++)
      await screen
        .getByRole('button', { name: '接受', exact: true })
        .nth(i)
        .click()
    await screen.getByText('将输入作为参数（可选）', { exact: true }).click()
    await screen.getByLabelText('参数键').fill('orderNo')
    await screen.getByLabelText('参数名称').fill('订单编号')
    await screen.getByRole('button', { name: '确认参数绑定' }).click()
    await screen
      .getByRole('button', { name: '舍弃', exact: true })
      .nth(3)
      .click()
    await screen.getByLabelText('舍弃原因').fill('另行配置受控等待')
    await screen.getByRole('button', { name: '确认回填 3 项' }).click()
    await expect
      .element(screen.getByText('草稿已变化', { exact: true }))
      .toBeVisible()
    await screen.getByRole('button', { name: '保留决定并重新预览' }).click()
    await expect
      .element(screen.getByLabelText('舍弃原因'))
      .toHaveValue('另行配置受控等待')
    await screen.getByRole('button', { name: '确认回填 3 项' }).click()
    await vi.waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1))
    expect(mocks.apply.mock.calls[1]![1]).toMatchObject({
      baseRevision: 2,
      decisions: expect.arrayContaining([
        {
          id: preview.suggestions[1]!.id,
          disposition: 'accept',
          parameter: { key: 'orderNo', label: '订单编号' },
        },
        {
          id: preview.suggestions[3]!.id,
          disposition: 'discard',
          reason: '另行配置受控等待',
        },
      ]),
    })
  })

  it('shows unsaved-change protection on a narrow screen without horizontal overflow', async () => {
    await page.viewport(390, 844)
    const screen = await panel(false)
    await expect
      .element(screen.getByText('请先保存当前场景的修改，再确认回填。'))
      .toBeVisible()
    const dialog = screen.getByRole('dialog').element()
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1)
    await expect
      .element(screen.getByRole('button', { name: '确认回填 0 项' }))
      .toBeDisabled()
  })

  it('switches input mode to clear without retaining a literal or context binding', async () => {
    const initial: Extract<Step, { type: 'ai_action' }> = {
      id: scenarioId,
      name: '订单',
      type: 'ai_action',
      effectType: 'SIDE_EFFECT',
      input: {
        operation: 'input',
        targetDescription: '订单号',
        mode: 'replace',
        from: 'orderNo',
      },
    }
    function Editor() {
      const [step, setStep] = useState(initial)
      return (
        <>
          <AiStepFields
            step={step}
            bindings={[{ key: 'orderNo', label: '订单编号' }]}
            onChange={(next) => setStep(next as typeof initial)}
          />
          <output>{JSON.stringify(step.input)}</output>
        </>
      )
    }
    const screen = await render(<Editor />)
    await screen.getByRole('combobox', { name: '输入模式' }).click()
    await screen.getByRole('option', { name: '清空', exact: true }).click()
    await expect
      .element(screen.getByRole('status'))
      .toHaveTextContent(
        '{"operation":"input","mode":"clear","targetDescription":"订单号"}'
      )
    await expect.element(screen.getByLabelText('内容')).not.toBeInTheDocument()
  })
})
