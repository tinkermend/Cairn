import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { ModuleReplacePreviewDialog } from './replace-preview-dialog'

const scenarioId = '33333333-3333-4333-8333-333333333333'
const stepId = '55555555-5555-4555-8555-555555555555'
const versionId = '44444444-4444-4444-8444-444444444444'

const mocks = vi.hoisted(() => ({
  previewScenarioModuleReplace: vi.fn(),
  replaceScenarioModule: vi.fn(),
  onReplaced: vi.fn(),
}))

vi.mock('@/lib/scenarios-api', () => ({
  previewScenarioModuleReplace: mocks.previewScenarioModuleReplace,
  replaceScenarioModule: mocks.replaceScenarioModule,
}))

async function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ModuleReplacePreviewDialog
        open
        onOpenChange={() => {}}
        scenarioId={scenarioId}
        stepIds={[stepId]}
        moduleVersionId={versionId}
        baseRevision={2}
        onReplaced={mocks.onReplaced}
      />
    </QueryClientProvider>,
  )
}

describe('替换预览', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.previewScenarioModuleReplace.mockResolvedValue({
      equal: true,
      steps: [
        {
          index: 0,
          equal: true,
          original: { name: '回显输入', type: 'echo', effectType: 'READ_ONLY' },
          expanded: { name: '回显输入', type: 'echo', effectType: 'READ_ONLY' },
          differences: [],
        },
      ],
    })
    mocks.replaceScenarioModule.mockResolvedValue({ ok: true })
  })

  it('语义一致时可写入草稿，窄屏仍能看到写入', async () => {
    await page.viewport(390, 844)
    const screen = await renderDialog()
    await expect.element(screen.getByText('展开结果与原步骤语义一致。')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '写入草稿' })).toBeVisible()
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(391)
    await screen.getByRole('button', { name: '写入草稿' }).click()
    await vi.waitFor(() => expect(mocks.replaceScenarioModule).toHaveBeenCalledTimes(1))
    expect(mocks.onReplaced).toHaveBeenCalled()
  })
})
