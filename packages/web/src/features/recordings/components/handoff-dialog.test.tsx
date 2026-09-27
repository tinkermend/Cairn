import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { RecordingHandoffDialog } from './handoff-dialog'

const mocks = vi.hoisted(() => ({
  fetchScenarios: vi.fn(),
  fetchScenario: vi.fn(),
  fetchRecording: vi.fn(),
  previewDemonstrationImport: vi.fn(),
  applyDemonstrationImport: vi.fn(),
  previewRecordingImport: vi.fn(),
  applyRecordingImport: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@/lib/scenarios-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/scenarios-api')>()),
  fetchScenarios: mocks.fetchScenarios,
  fetchScenario: mocks.fetchScenario,
  previewRecordingImport: mocks.previewRecordingImport,
  applyRecordingImport: mocks.applyRecordingImport,
}))
vi.mock('@/lib/recordings-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/recordings-api')>()),
  fetchRecording: mocks.fetchRecording,
}))
vi.mock('@/lib/demonstrations-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/demonstrations-api')>()),
  previewDemonstrationImport: mocks.previewDemonstrationImport,
  applyDemonstrationImport: mocks.applyDemonstrationImport,
  newDemonstrationId: () => 'handoff-attempt-1',
}))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mocks.navigate,
}))

async function mount(sourceProtocol: 'recording@1' | 'demonstration@1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RecordingHandoffDialog
        open
        onOpenChange={vi.fn()}
        recordingId='recording-a'
        recordingName='录制 A'
        targetId='target-a'
        targetName='系统 A'
        sourceProtocol={sourceProtocol}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.fetchScenarios.mockResolvedValue({ items: [{ id: 'scenario-a', name: '场景 A', stepCount: 2 }] })
  mocks.fetchScenario.mockResolvedValue({ name: '场景 A', steps: [{ id: 'step-1', name: '打开页面' }, { id: 'step-2', name: '查询' }], draft: { revision: 3 } })
  mocks.fetchRecording.mockResolvedValue({ items: [{ name: '录制步骤' }], unresolvedCount: 0 })
  mocks.applyDemonstrationImport.mockResolvedValue({ receipt: { insertedStepIds: ['step-new'] } })
  mocks.applyRecordingImport.mockResolvedValue({ receipt: { insertedStepIds: ['step-new'] } })
})

it('示教草稿直接回填提交当前契约要求的规则版本和判定', async () => {
  mocks.previewDemonstrationImport.mockResolvedValue({
    baseRevision: 3,
    factDigest: 'fact-digest',
    suggestionDigest: 'suggestion-digest',
    adapterVersion: 'demonstration-adapter@1',
    ruleVersion: 'demonstration-rules@1',
    suggestions: [
      { id: 'source-1', status: 'mapped' },
      { id: 'source-2', status: 'unresolved' },
    ],
  })
  const screen = await mount('demonstration@1')
  await screen.getByRole('button', { name: /直接回填至场景/ }).click()
  await vi.waitFor(() => expect(mocks.applyDemonstrationImport).toHaveBeenCalledOnce())
  expect(mocks.applyDemonstrationImport).toHaveBeenCalledWith('scenario-a', expect.objectContaining({
    ruleVersion: 'demonstration-rules@1',
    decisions: [
      { id: 'source-1', disposition: 'accept' },
      { id: 'source-2', disposition: 'discard', reason: '待处理项已在就地回填中忽略' },
    ],
  }))
  expect(mocks.applyDemonstrationImport.mock.calls[0]?.[1]).not.toHaveProperty('dispositions')
})

it('普通录制只允许插入，未确认的成功条件不自动接受', async () => {
  mocks.previewRecordingImport.mockResolvedValue({
    currentRevision: 3,
    sourceDigest: 'source-digest',
    items: [
      { sourceIndexes: [0], ready: true, outcomeCandidate: { meaning: '完成' } },
      { sourceIndexes: [1], ready: true },
    ],
  })
  const screen = await mount('recording@1')
  await expect.element(screen.getByRole('button', { name: /替换已有特定步骤/ })).toBeDisabled()
  await screen.getByRole('button', { name: /直接回填至场景/ }).click()
  await vi.waitFor(() => expect(mocks.applyRecordingImport).toHaveBeenCalledOnce())
  expect(mocks.applyRecordingImport).toHaveBeenCalledWith('scenario-a', expect.objectContaining({
    baseRevision: 3,
    dispositions: [
      { sourceIndexes: [0], disposition: 'discard', reason: '未确认为成功条件' },
      { sourceIndexes: [1], disposition: 'accept' },
    ],
  }))
})

it('进入 Studio 时传递已选择的插入锚点', async () => {
  const screen = await mount('demonstration@1')
  await screen.getByRole('button', { name: /插入到指定步骤后/ }).click()
  await screen.getByRole('button', { name: /在 Studio 中深度微调/ }).click()
  expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({
    to: '/scenarios/$scenarioId',
    search: { import: 'recording-a', importPlacement: 'after', importNodeId: 'step-2' },
  }))
})
