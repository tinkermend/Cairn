import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { InsertModuleDialog } from './insert-module-dialog'

const moduleId = '11111111-1111-4111-8111-111111111111'
const versionId = '44444444-4444-4444-8444-444444444444'
const otherVersionId = '55555555-5555-4555-8555-555555555555'
const requestId = '66666666-6666-4666-8666-666666666666'
const scenarioId = '77777777-7777-4777-8777-777777777777'
const targetId = '22222222-2222-4222-8222-222222222222'

const mocks = vi.hoisted(() => ({
  fetchActionModules: vi.fn(),
  fetchActionModuleVersions: vi.fn(),
  fetchActionModuleVersion: vi.fn(),
  resolveActionModules: vi.fn(),
  closeModuleResolution: vi.fn(),
  acceptModuleResolution: vi.fn(),
  onSelect: vi.fn(),
  onAccepted: vi.fn(),
  onInsertAiStep: vi.fn(),
  onOpenChange: vi.fn(),
  onEnsureSaved: vi.fn(),
}))

vi.mock('@/lib/action-modules-api', () => ({
  fetchActionModules: mocks.fetchActionModules,
  fetchActionModuleVersions: mocks.fetchActionModuleVersions,
  fetchActionModuleVersion: mocks.fetchActionModuleVersion,
  resolveActionModules: mocks.resolveActionModules,
  closeModuleResolution: mocks.closeModuleResolution,
}))

vi.mock('@/lib/scenarios-api', () => ({
  acceptModuleResolution: mocks.acceptModuleResolution,
}))

async function renderDialog(options?: { ensureSaved?: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <InsertModuleDialog
        open
        onOpenChange={mocks.onOpenChange}
        targetId={targetId}
        scenarioId={scenarioId}
        draftRevision={3}
        onEnsureSaved={options?.ensureSaved ? mocks.onEnsureSaved : undefined}
        onSelect={mocks.onSelect}
        onAccepted={mocks.onAccepted}
        onInsertAiStep={mocks.onInsertAiStep}
      />
    </QueryClientProvider>,
  )
}

describe('插入动作模块', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchActionModules.mockResolvedValue({
      items: [{
        id: moduleId,
        targetId,
        key: 'order.query',
        name: '查询订单',
        tags: [],
        publicationStatus: 'deprecated',
        latestVersionNo: 1,
        health: {
          signal: 'degraded',
          sampleCount: 12,
          verifiedRate: 0.5,
          windowDays: 7,
          configRevision: 1,
          asOf: '2026-09-16T00:00:00.000Z',
        },
      }],
    })
    mocks.fetchActionModuleVersions.mockResolvedValue({
      items: [{
        id: versionId,
        versionNo: 1,
        publicationStatus: 'deprecated',
        executionMode: 'DETERMINISTIC',
        effectCeiling: 'READ_ONLY',
      }],
    })
    mocks.fetchActionModuleVersion.mockResolvedValue({
      id: versionId,
      content: {
        contract: {
          inputs: [{ key: 'orderNo', label: '订单号', valueType: 'string', required: true }],
        },
      },
    })
    mocks.closeModuleResolution.mockResolvedValue({ outcome: 'abandoned' })
    mocks.onEnsureSaved.mockResolvedValue(8)
    mocks.acceptModuleResolution.mockResolvedValue({
      request: { requestId, outcome: 'accepted' },
      scenario: { id: scenarioId, draft: { revision: 4, document: { nodes: [] } } },
      diagnostics: [],
    })
  })

  it('插入已弃用版本必须先确认', async () => {
    const screen = await renderDialog()
    await screen.getByRole('tab', { name: '从库中选择' }).click()
    await expect.element(screen.getByText('降级')).toBeInTheDocument()
    await screen.getByRole('button', { name: /查询订单/ }).click()
    await expect.element(screen.getByLabelText('确认插入已弃用版本')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '插入模块节点' })).toBeDisabled()
    await screen.getByLabelText('确认插入已弃用版本').click()
    await screen.getByRole('button', { name: '插入模块节点' }).click()
    expect(mocks.onSelect).toHaveBeenCalled()
  })

  it('AMD-02 歧义时不预选，必须由用户选择后再写入', async () => {
    mocks.resolveActionModules.mockResolvedValue({
      requestId,
      status: 'ambiguous',
      candidates: [
        {
          moduleId,
          moduleVersionId: versionId,
          key: 'order.query',
          name: '查询订单',
          versionNo: 1,
          executionMode: 'DETERMINISTIC',
          effectCeiling: 'READ_ONLY',
          publicationStatus: 'published',
          matchedBy: [{ field: 'alias', text: '查单' }],
          layer: 1,
          rank: 1,
          notes: [],
        },
        {
          moduleId: '88888888-8888-4888-8888-888888888888',
          moduleVersionId: otherVersionId,
          key: 'order.lookup',
          name: '查找订单',
          versionNo: 1,
          executionMode: 'DETERMINISTIC',
          effectCeiling: 'READ_ONLY',
          publicationStatus: 'published',
          matchedBy: [{ field: 'alias', text: '查单' }],
          layer: 1,
          rank: 2,
          notes: [],
        },
      ],
      inputSuggestions: {
        [versionId]: { orderNo: { kind: 'missing' } },
        [otherVersionId]: { orderNo: { kind: 'missing' } },
      },
      unknowns: [],
      outcome: 'pending',
    })
    const screen = await renderDialog()
    await screen.getByLabelText('业务说法').fill('查单')
    await screen.getByRole('button', { name: '查找' }).click()
    await expect.element(screen.getByText('有多个或不够确定的模块，请选择。')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '写入草稿' })).toBeDisabled()
    await screen.getByRole('button', { name: /查询订单/ }).click()
    await screen.getByRole('button', { name: '写入草稿' }).click()
    expect(mocks.acceptModuleResolution).toHaveBeenCalledWith(
      scenarioId,
      requestId,
      expect.objectContaining({ moduleVersionId: versionId, baseRevision: 3 }),
    )
  })

  it('AMD-05 无命中提供三个后续入口且不写入草稿', async () => {
    mocks.resolveActionModules.mockResolvedValue({
      requestId,
      status: 'no_match',
      aiSkipped: 'ai_layer_not_open',
      candidates: [],
      inputSuggestions: {},
      unknowns: [],
      outcome: 'pending',
    })
    const screen = await renderDialog()
    await screen.getByLabelText('业务说法').fill('煮咖啡')
    await screen.getByRole('button', { name: '查找' }).click()
    await expect.element(screen.getByText(/不会自动试跑/)).toBeInTheDocument()
    await expect.element(screen.getByRole('link', { name: '新建模块草稿' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '插入 AI Step 草稿' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '手工编写（从库中选择）' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '写入草稿' })).toBeDisabled()
    expect(mocks.acceptModuleResolution).not.toHaveBeenCalled()
    await screen.getByRole('button', { name: '取消' }).click()
    expect(mocks.closeModuleResolution).toHaveBeenCalledWith(requestId, { outcome: 'abandoned' })
  })

  it('写入前先落本地未保存草稿，并用新 revision 接受', async () => {
    mocks.resolveActionModules.mockResolvedValue({
      requestId,
      status: 'matched',
      candidates: [{
        moduleId,
        moduleVersionId: versionId,
        key: 'order.query',
        name: '查询订单',
        versionNo: 1,
        executionMode: 'DETERMINISTIC',
        effectCeiling: 'READ_ONLY',
        publicationStatus: 'published',
        matchedBy: [{ field: 'name', text: '查询订单' }],
        layer: 1,
        rank: 1,
        notes: [],
      }],
      inputSuggestions: {
        [versionId]: { orderNo: { kind: 'literal', value: 'SO123', span: [5, 10], source: 'rule' } },
      },
      unknowns: [],
      outcome: 'pending',
    })
    const screen = await renderDialog({ ensureSaved: true })
    await screen.getByLabelText('业务说法').fill('查询订单 SO123')
    await screen.getByRole('button', { name: '查找' }).click()
    await screen.getByRole('button', { name: '写入草稿' }).click()
    expect(mocks.onEnsureSaved).toHaveBeenCalled()
    expect(mocks.acceptModuleResolution).toHaveBeenCalledWith(
      scenarioId,
      requestId,
      expect.objectContaining({ moduleVersionId: versionId, baseRevision: 8 }),
    )
  })

  it('从库中选择按服务端别名检索，不只在当前页本地过滤', async () => {
    const screen = await renderDialog()
    await screen.getByRole('tab', { name: '从库中选择' }).click()
    await expect.poll(() => mocks.fetchActionModules).toHaveBeenCalled()
    await screen.getByPlaceholder('按名称、key 或别名搜索动作模块…').fill('撤单')
    await expect.poll(() => mocks.fetchActionModules.mock.lastCall?.[0]).toMatchObject({
      targetId,
      q: '撤单',
      pageSize: 100,
    })
  })
})
