import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { TargetBusinessSourcesTab } from './target-business-sources-tab'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'

const businessMocks = vi.hoisted(() => ({
  fetchBusinessSource: vi.fn(),
  previewBusinessSource: vi.fn(),
  createBusinessSourceCandidate: vi.fn(),
  fetchBusinessSourceCandidate: vi.fn(),
  approveBusinessSourceCandidate: vi.fn(),
  revokeBusinessSource: vi.fn(),
  fetchBusinessRecords: vi.fn(),
}))

const datasetMocks = vi.hoisted(() => ({
  fetchDatasets: vi.fn(),
}))

vi.mock('@/lib/business-sources-api', () => businessMocks)
vi.mock('@/lib/datasets-api', () => datasetMocks)

function signIn(permissions = ['target:read', 'target:write', 'dataset:read', 'dataset:write']) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试管理员',
    email: 'admin@example.com',
    roles: [],
    permissions,
  })
}

async function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <TargetBusinessSourcesTab targetId={TARGET_ID} targetName='测试ERP' />
    </QueryClientProvider>,
  )
}

describe('AI 业务数据来源 Tab', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900)
    vi.clearAllMocks()
    signIn()

    datasetMocks.fetchDatasets.mockResolvedValue({
      items: [
        {
          id: 'ds-01',
          name: '供应商厂家清单.xlsx',
          targetId: TARGET_ID,
          rowCount: 200,
          createdAt: '2026-09-23T00:00:00.000Z',
          updatedAt: '2026-09-23T00:00:00.000Z',
        },
      ],
      total: 1,
    })

    businessMocks.fetchBusinessSource.mockResolvedValue({
      id: 'bs-1',
      targetId: TARGET_ID,
      entityType: 'manufacturer',
      sourceKind: 'dataset_snapshot',
      currentSnapshotId: 'snap-001',
      bindingRevision: 2,
      status: 'active',
      ownerAccountId: 'u1',
      approverAccountId: 'u1',
      approvedAt: '2026-09-23T10:00:00.000Z',
      declaredSourceAsOf: null,
      declaredByAccountId: null,
      declarationBasis: '全量核对无误',
      validUntil: null,
      completenessBasis: '快照全量扫描校验',
      completenessStatus: 'complete',
      createdAt: '2026-09-23T09:00:00.000Z',
      updatedAt: '2026-09-23T10:00:00.000Z',
    })

    businessMocks.fetchBusinessRecords.mockResolvedValue({
      items: [
        {
          id: 'rec-1',
          snapshotId: 'snap-001',
          targetId: TARGET_ID,
          entityType: 'manufacturer',
          recordKey: 'MFG-ALPHA',
          displayName: '阿尔法科技',
          recordStatus: 'active',
          originalDatasetId: 'ds-01',
          datasetRowId: 'row-1',
          datasetRowIndex: 0,
          payload: { code: 'MFG-ALPHA', name: '阿尔法科技' },
          createdAt: '2026-09-23T10:00:00.000Z',
        },
      ],
      snapshotId: 'snap-001',
      bindingRevision: 2,
      coverage: {
        status: 'complete',
        completenessBasis: '快照全量扫描校验',
        observedAt: null,
        importedAt: '2026-09-23T10:00:00.000Z',
      },
    })
  })

  it('展示当前生效数据源状态、修订版本与投影记录', async () => {
    await renderTab()

    // 检查标题与数据源状态
    await expect.element(page.getByText('「测试ERP」AI 业务数据来源与更新闭环')).toBeVisible()
    await expect.element(page.getByText('生效中')).toBeVisible()
    await expect.element(page.getByText('修订版本 v2')).toBeVisible()

    // 检查记录投影列表渲染
    await expect.element(page.getByRole('cell', { name: 'MFG-ALPHA', exact: true })).toBeVisible()
    await expect.element(page.getByRole('cell', { name: '阿尔法科技', exact: true })).toBeVisible()
  })

  it('支持选择数据集、配置映射并进行采样预览', async () => {
    businessMocks.previewBusinessSource.mockResolvedValueOnce({
      previewRows: [
        {
          rowIndex: 0,
          recordKey: 'MFG-TEST',
          displayName: '测试厂家',
          recordStatus: 'active',
          payload: { code: 'MFG-TEST', name: '测试厂家' },
          isValid: true,
        },
      ],
      validationDigest: {
        sampleCount: 1,
        sampleValidCount: 1,
        sampleRejectedCount: 0,
        potentialDuplicateKeys: [],
      },
    })

    await renderTab()

    // 选择源数据集
    const select = page.getByTestId('dataset-select')
    await select.selectOptions('ds-01')

    // 点击采样预览
    const previewBtn = page.getByRole('button', { name: '映射采样预览 (前10行)' })
    await previewBtn.click()

    // 预览弹窗
    await expect.element(page.getByText('映射采样校验预览 (前 10 行)')).toBeVisible()
    await expect.element(page.getByRole('cell', { name: 'MFG-TEST', exact: true })).toBeVisible()
  })
})
