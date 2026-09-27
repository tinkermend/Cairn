import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordingImportPreview } from '@cairn/shared'
import { RecordingImportPanel } from './recording-import-panel'

const mocks = vi.hoisted(() => ({
  fetchRecording: vi.fn(),
  fetchRecordingImports: vi.fn(),
  previewRecordingImport: vi.fn(),
  applyRecordingImport: vi.fn(),
}))

vi.mock('@/lib/recordings-api', () => ({
  fetchRecording: mocks.fetchRecording,
}))

vi.mock('@/lib/scenarios-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/scenarios-api')>()
  return {
    ...actual,
    fetchRecordingImports: mocks.fetchRecordingImports,
    previewRecordingImport: mocks.previewRecordingImport,
    applyRecordingImport: mocks.applyRecordingImport,
  }
})

const scenarioId = 'sc-100'
const draftId = 'rec-200'

const mockPreview: RecordingImportPreview = {
  recordingDraftId: draftId,
  recordingName: '订单创建流程录制',
  normalizerVersion: 'recording-normalizer@4',
  sourceVersion: 'playwright-crx@0.15.0',
  sourceDigest: 'digest-abc-123',
  eventCount: 3,
  remainingStepCapacity: 50,
  currentRevision: 1,
  insertAnchor: { kind: 'start' },
  diagnostics: [],
  metrics: {
    totalCount: 3,
    mappedCount: 1,
    parameterizedCount: 1,
    unresolvedCount: 1,
    hasAssertions: true,
  },
  items: [
    {
      index: 0,
      status: 'mapped',
      sourceIndexes: [0],
      sourceAction: 'navigate',
      name: '打开页面',
      ready: true,
      sensitive: false,
      candidateStep: {
        id: 'step-0',
        name: '打开页面',
        type: 'navigate',
        effectType: 'READ_ONLY',
        input: { url: 'https://example.com' },
      },
      diagnostics: [],
    },
    {
      index: 1,
      status: 'parameterized',
      sourceIndexes: [1],
      sourceAction: 'fill',
      name: '输入密码',
      candidateStepType: 'fill',
      ready: false,
      sensitive: true,
      input: {
        target: {
          framePath: [],
          candidates: [{ by: 'css', value: 'input#pwd' }],
        },
      },
      diagnostics: ['需绑定参数'],
    },
    {
      index: 2,
      status: 'unresolved',
      sourceIndexes: [2],
      sourceAction: 'custom',
      name: '未知动作',
      ready: false,
      sensitive: false,
      diagnostics: ['未识别'],
    },
  ],
}

function renderPanel(props?: Partial<Parameters<typeof RecordingImportPanel>[0]>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RecordingImportPanel
        open
        scenarioId={scenarioId}
        recordingDraftId={draftId}
        revision={1}
        insertAnchor={{ kind: 'start' }}
        stepCount={0}
        inputs={[]}
        canApply={true}
        onOpenChange={vi.fn()}
        onSelectDraft={vi.fn()}
        onConflict={vi.fn()}
        onApplied={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  )
}

describe('录制草稿回填面板 (LegacyRecordingImportPanel)', () => {
  beforeEach(() => {
    mocks.fetchRecording.mockResolvedValue({
      id: draftId,
      name: '订单创建流程录制',
      sourceProtocol: 'recording@1',
    })
    mocks.fetchRecordingImports.mockResolvedValue({ drafts: [] })
    mocks.previewRecordingImport.mockResolvedValue(mockPreview)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('展示导入指标看板条与批量决策工具栏，默认无死锁可直接回填', async () => {
    const screen = await renderPanel()

    await expect.element(screen.getByText('录制回填预览')).toBeVisible()
    await expect.element(screen.getByText('订单创建流程录制')).toBeVisible()

    // 看板指标
    await expect.element(screen.getByText('总计 3 步')).toBeVisible()
    await expect.element(screen.getByText('已就绪 1')).toBeVisible()
    await expect.element(screen.getByText('待补参 1')).toBeVisible()
    await expect.element(screen.getByText('待处理 1')).toBeVisible()

    // 批量决策按钮
    await expect.element(screen.getByRole('button', { name: '一键采纳所有就绪项' })).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '一键舍弃所有待处理项' })).toBeVisible()

    // 未就绪项自动默认舍弃（且附带默认原因），因此不产生阻塞输入，主回填按钮立即可用
    const submitBtn = screen.getByRole('button', { name: '回填 1 项' })
    await expect.element(submitBtn).toBeVisible()
    await expect.element(submitBtn).not.toBeDisabled()
  })

  it('支持一键采纳与一键舍弃批量决策', async () => {
    const screen = await renderPanel()

    await expect.element(screen.getByRole('button', { name: '一键采纳所有就绪项' })).toBeVisible()

    // 点击一键舍弃所有待处理项
    await screen.getByRole('button', { name: '一键舍弃所有待处理项' }).click()

    // 就绪项依然被接受，未就绪项已舍弃，可回填 1 项
    await expect.element(screen.getByRole('button', { name: '回填 1 项' })).toBeVisible()

    // 点击一键采纳所有就绪项
    await screen.getByRole('button', { name: '一键采纳所有就绪项' }).click()
    await expect.element(screen.getByRole('button', { name: '回填 1 项' })).toBeVisible()
  })

  it('当场景无预设输入参数时，支持直接输入自定义参数名绑定，消除死锁', async () => {
    const screen = await renderPanel({ inputs: [] })

    // 输入密码步骤提示绑定参数，直接展示输入框（无参数时不展示死胡同文本）
    await expect.element(screen.getByText('先在场景输入中声明参数，或舍弃此项。')).not.toBeInTheDocument()

    const paramInput = screen.getByRole('textbox', { name: '输入密码 输入参数键名' })
    await expect.element(paramInput).toBeVisible()

    // 输入自定义参数名
    await paramInput.fill('login_password')

    // 提示已绑定成功
    await expect.element(screen.getByText('✓ 已绑定参数: login_password')).toBeVisible()

    // 回填项变为 2 项（打开页面 + 输入密码）
    await expect.element(screen.getByRole('button', { name: '回填 2 项' })).toBeVisible()
  })

  it('当场景存在预设输入时，默认下拉选择，并支持切换至自定义参数输入', async () => {
    const existingInputs = [
      { key: 'user_pwd', label: '用户密码', required: true, secret: true },
    ]
    const screen = await renderPanel({ inputs: existingInputs })

    // 展示已有参数选择下拉框
    await expect.element(screen.getByLabelText('输入密码 绑定参数')).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '＋ 自定义参数名' })).toBeVisible()

    // 点击切换为自定义参数名
    await screen.getByRole('button', { name: '＋ 自定义参数名' }).click()
    const customInput = screen.getByRole('textbox', { name: '输入密码 输入参数键名' })
    await expect.element(customInput).toBeVisible()

    // 再次点击切回已有参数
    await screen.getByRole('button', { name: '选择已有参数' }).click()
    await expect.element(screen.getByLabelText('输入密码 绑定参数')).toBeVisible()
  })

  it('当 recordingDraftId 为 null 时，展示优雅的录制批次微卡片列表与元数据，支持即时搜索与选择', async () => {
    const onSelectDraft = vi.fn()
    const mockDrafts = [
      {
        id: 'draft-order-01',
        name: '订单创建流程录制-批次A',
        targetId: 'target-01',
        targetName: '电商后台系统',
        recordingId: 'rec-01',
        sourceVersion: 'v1',
        eventCount: 28,
        itemCount: 9,
        unresolvedCount: 0,
        createdBy: { kind: 'user' as const, id: 'u1', name: '测试员' },
        imported: false,
        createdAt: '2026-09-25T10:00:00Z',
        updatedAt: '2026-09-25T10:00:00Z',
      },
      {
        id: 'draft-login-02',
        name: '统一登录与权限校验',
        targetId: 'target-01',
        targetName: '电商后台系统',
        recordingId: 'rec-02',
        sourceVersion: 'v1',
        eventCount: 15,
        itemCount: 4,
        unresolvedCount: 1,
        createdBy: { kind: 'user' as const, id: 'u1', name: '测试员' },
        imported: true,
        createdAt: '2026-09-24T08:00:00Z',
        updatedAt: '2026-09-24T08:00:00Z',
      },
    ]
    mocks.fetchRecordingImports.mockResolvedValue({ drafts: mockDrafts })

    const screen = await renderPanel({
      recordingDraftId: null,
      onSelectDraft,
    })

    // 抽屉主标题与所属系统上下文
    await expect.element(screen.getByText('导入已有录制')).toBeVisible()
    await expect.element(screen.getByText(/所属系统：/)).toBeVisible()
    await expect.element(screen.getByText('电商后台系统', { exact: true })).toBeVisible()

    // 录制列表卡片与元数据
    await expect.element(screen.getByText('订单创建流程录制-批次A')).toBeVisible()
    await expect.element(screen.getByText('9 个步骤')).toBeVisible()
    await expect.element(screen.getByText('28 原始事件')).toBeVisible()
    await expect.element(screen.getByText('待回填')).toBeVisible()

    await expect.element(screen.getByText('统一登录与权限校验')).toBeVisible()
    await expect.element(screen.getByText('4 个步骤')).toBeVisible()
    await expect.element(screen.getByText('已导入过')).toBeVisible()
    await expect.element(screen.getByText('1 项需人工确认')).toBeVisible()

    // 搜索过滤测试
    const searchInput = screen.getByRole('textbox', { name: '搜索录制批次' })
    await searchInput.fill('统一登录')

    // 只有匹配项可见，非匹配项被过滤
    await expect.element(screen.getByText('统一登录与权限校验')).toBeVisible()
    expect(screen.getByText('订单创建流程录制-批次A').elements()).toHaveLength(0)

    // 点击卡片选择该草稿进入预览
    const card = screen.getByTestId('recording-draft-item-draft-login-02')
    await card.click()
    expect(onSelectDraft).toHaveBeenCalledWith('draft-login-02')
  })

  it('在预览状态下，点击重新选择录制批次按钮可触发 onSelectDraft("") 返回列表', async () => {
    const onSelectDraft = vi.fn()
    const screen = await renderPanel({
      recordingDraftId: draftId,
      onSelectDraft,
    })

    const backBtn = screen.getByRole('button', { name: '重新选择录制批次' })
    await expect.element(backBtn).toBeVisible()

    await backBtn.click()
    expect(onSelectDraft).toHaveBeenCalledWith('')
  })
})
