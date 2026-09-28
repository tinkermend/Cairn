import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DEFAULT_REPORT_CONFIG, type ReportDto } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { ReportPanel } from './panel'

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  create: vi.fn(),
  revise: vi.fn(),
  list: vi.fn(),
  export: vi.fn(),
  stream: vi.fn(),
  job: vi.fn(),
  canExport: true,
}))
vi.mock('@/lib/reports-api', () => ({
  previewReport: mocks.preview,
  previewReportRevision: vi.fn(async () => ({ title: '修订预览' })),
  previewMemberReport: vi.fn(async () => ({ title: '成员预览' })),
  createReport: mocks.create,
  createReportRevision: mocks.revise,
  fetchReports: mocks.list,
  exportReport: mocks.export,
  fetchExportJob: mocks.job,
  deleteReport: vi.fn(),
  previewDeleteReport: vi.fn(),
  downloadArtifact: vi.fn(),
  uploadReportLogo: vi.fn(),
  fetchReportSourceOptions: vi.fn(async () => ({
    targetId: 'target-1',
    config: DEFAULT_REPORT_CONFIG,
    screenshots: [],
    canGenerateFinal: true,
  })),
  fetchReport: vi.fn(async () => report),
  fetchReportRevisions: vi.fn(async () => ({
    items: [report.currentRevision],
    nextCursor: null,
  })),
  fetchReportJobs: vi.fn(async () => ({ items: [], nextCursor: null })),
  fetchReportRevision: vi.fn(async () => ({
    report,
    revision: report.currentRevision,
    document: null,
  })),
  cancelReportJob: vi.fn(),
  retryReportJob: vi.fn(),
  retryReportAi: vi.fn(),
  createReportBundle: vi.fn(),
  deriveMemberReport: vi.fn(),
}))
vi.mock('@/lib/observation-stream', () => ({
  subscribeObservation: mocks.stream,
}))
vi.mock('@/hooks/use-permissions', () => ({
  useCan: (permission: string) =>
    permission !== 'report:export' || mocks.canExport,
}))
const subject = {
  kind: 'RUN' as const,
  runId: '11111111-1111-4111-8111-111111111111',
}
const report = {
  id: 'report-1',
  targetId: 'target-1',
  subject,
  currentRevision: {
    id: 'revision-1',
    title: '商城巡检',
    revisionNo: 1,
    stage: 'final',
    contentCompleteness: 'partial',
  },
  createdAt: '2026-09-26T00:00:00Z',
} as ReportDto

describe('报告生成与导出', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.canExport = true
    mocks.list.mockResolvedValue({ items: [], nextCursor: undefined })
    mocks.preview.mockResolvedValue({
      canGenerateFinal: false,
      issues: ['证据仍在收集'],
    })
    mocks.create.mockResolvedValue(report)
    mocks.stream.mockResolvedValue(undefined)
    mocks.job.mockResolvedValue({
      id: 'job-1',
      kind: 'report_render',
      status: 'queued',
      contentCompleteness: null,
      progress: null,
      error: null,
      artifactIds: [],
    })
  })
  const setup = (props?: { initialReport?: ReportDto }) =>
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ReportPanel subject={subject} initialReport={props?.initialReport} />
      </QueryClientProvider>
    )

  it('运行未就绪时阻止终稿创建，允许用户选择阶段报告并保留自定义标题', async () => {
    const screen = await setup()
    await screen.getByRole('combobox', { name: '报告标题' }).fill('我的巡检报告')
    await screen.getByRole('button', { name: '生成报告', exact: true }).click()
    await expect.poll(() => mocks.preview.mock.calls.length).toBe(1)
    expect(mocks.create).not.toHaveBeenCalled()
    await screen.getByRole('combobox', { name: '报告类型' }).click()
    await screen.getByRole('option', { name: '阶段报告' }).click()
    await screen.getByRole('button', { name: '生成报告', exact: true }).click()
    await expect.poll(() => mocks.create.mock.calls.length).toBe(1)
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({
      stage: 'phase',
      config: { title: '我的巡检报告' },
    })
  })

  it('通过实时快照呈现导出缺项，不把部分内容显示为完整交付', async () => {
    mocks.list.mockResolvedValue({ items: [report], nextCursor: undefined })
    const queued = {
      id: 'job-1',
      kind: 'report_render',
      status: 'queued',
      contentCompleteness: null,
      progress: null,
      error: null,
      artifactIds: [],
    }
    mocks.export.mockResolvedValue(queued)
    mocks.stream.mockImplementation(async ({ onObservation }) => {
      onObservation({
        ...queued,
        status: 'partial',
        contentCompleteness: 'partial',
      })
    })
    const screen = await setup()
    await screen.getByRole('button', { name: '导出 HTML 交互报告' }).click()
    await expect
      .element(screen.getByText('部分文件已交付', { exact: true }))
      .toBeVisible()
    expect(mocks.stream.mock.calls[0]![0].path).toBe(
      '/api/export-jobs/job-1/events'
    )
    mocks.revise.mockResolvedValue(report)
    await screen.getByRole('button', { name: '新修订', exact: true }).click()
    await expect
      .element(screen.getByText('部分文件已交付', { exact: true }))
      .not.toBeInTheDocument()
  })

  it('展示 AI 辅助解读独立状态并在失败时提供重试入口', async () => {
    const failedReport = {
      ...report,
      aiJob: {
        id: 'ai-job-1',
        reportId: report.id,
        baseRevisionId: report.currentRevision!.id,
        status: 'failed' as const,
        error: '模型网关超时 504',
        model: 'deepseek-v3',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }
    mocks.list.mockResolvedValue({ items: [failedReport], nextCursor: undefined })
    const { fetchReport } = await import('@/lib/reports-api')
    ;vi.mocked(fetchReport).mockResolvedValue(failedReport)

    const screen = await setup({ initialReport: failedReport })
    await expect.element(screen.getByText('AI 总结暂未生成')).toBeVisible()
    await expect.element(screen.getByText('失败原因：模型网关超时 504')).toBeVisible()
    const retryBtn = screen.getByRole('button', { name: '重试 AI 总结' })
    await expect.element(retryBtn).toBeVisible()
  })

  it('只读角色不显示生成及下载入口', async () => {
    mocks.canExport = false
    mocks.list.mockResolvedValue({ items: [report], nextCursor: undefined })
    const screen = await setup()
    await expect
      .element(screen.getByText('商城巡检修订', { exact: false }).first())
      .toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: '导出 HTML 交互报告' }))
      .not.toBeInTheDocument()
  })

  it('可选章节关闭后提交显式覆盖，并提示必选结果仍保留', async () => {
    mocks.preview.mockResolvedValue({ canGenerateFinal: true, issues: [] })
    const screen = await setup()
    await screen.getByText('高级报告配置', { exact: true }).click()
    await screen.getByRole('checkbox', { name: '完整证据索引', exact: true }).click()
    await screen.getByRole('checkbox', { name: '成功步骤的尝试历史', exact: true }).click()
    await expect.element(screen.getByText('执行范围、异常结果、失败尝试和缺项说明始终保留。')).toBeVisible()
    await screen.getByRole('button', { name: '生成报告', exact: true }).click()
    await expect.poll(() => mocks.create.mock.calls[0]?.[0]?.config).toMatchObject({ includeEvidenceIndex: false, includeAttemptHistory: false })
  })

  it('切换运行后不沿用上一来源的标题和报告类型', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const screen = await render(
      <QueryClientProvider client={client}>
        <ReportPanel subject={subject} />
      </QueryClientProvider>
    )
    await screen
      .getByRole('combobox', { name: '报告标题' })
      .fill('上一运行的标题')
    await screen.getByRole('combobox', { name: '报告类型' }).click()
    await screen.getByRole('option', { name: '阶段报告' }).click()
    await screen.rerender(
      <QueryClientProvider client={client}>
        <ReportPanel
          subject={{
            kind: 'SUITE_RUN',
            suiteRunId: '22222222-2222-4222-8222-222222222222',
          }}
        />
      </QueryClientProvider>
    )
    await expect
      .element(screen.getByRole('combobox', { name: '报告标题' }))
      .toHaveValue('')
    await expect
      .element(screen.getByRole('combobox', { name: '报告类型' }))
      .toHaveTextContent('终稿')
  })
})
